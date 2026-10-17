import type { UserTune } from "../domain.js";
import type { UserId } from "../entity-id.js";

export const PAUSED_ACTIVITY_GRACE_MS = 15_000;
export const ACTIVITY_REFRESH_MS = 30_000;
const SEEK_REFRESH_THRESHOLD_MS = 3_000;

export type MediaPlaybackState = "playing" | "paused" | "stopped" | "unknown";

export type MediaActivitySession = {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  positionMs?: number;
  playbackState: MediaPlaybackState;
  applicationId: string;
  applicationName?: string;
  trackId?: string;
  trackUri?: string;
  platform: string;
  platformValues: Array<{ key: string; value: string }>;
};

export type MediaActivityCapabilities = {
  platform: string;
  supported: boolean;
  availability: "available" | "unsupported";
  sessionEnumeration: boolean;
  eventNotifications: boolean;
  artwork: boolean;
  trackIds: boolean;
  trackUris: boolean;
  positionNotifications: boolean;
  notes: string[];
};

export type MediaActivityChange =
  | {
      kind: "added" | "changed";
      sessionId?: string;
      session: MediaActivitySession;
    }
  | { kind: "removed"; sessionId: string }
  | { kind: "reset"; sessions: MediaActivitySession[] }
  | { kind: "error"; message: string };

export type ActivitySharingPreference = {
  enabled: boolean;
  applicationId: string;
};

export type ActivitySharingPlatform = {
  loadPreference: (account: UserId) => Promise<ActivitySharingPreference>;
  savePreference: (
    account: UserId,
    preference: ActivitySharingPreference,
  ) => Promise<unknown>;
  startSessions: () => Promise<{
    capabilities: MediaActivityCapabilities;
    sessions: MediaActivitySession[];
  }>;
  stopSessions: () => Promise<unknown>;
  subscribe: (listener: (change: MediaActivityChange) => void) => () => void;
};

export type ActivitySharingContext = {
  account: UserId;
  connected: boolean;
};

export type ActivitySharingState = {
  enabled: boolean;
  loading: boolean;
  applicationId: string;
  sessions: MediaActivitySession[];
  tune?: UserTune;
  capabilities?: MediaActivityCapabilities;
  error?: string;
};

export type ActivitySharingControllerOptions = {
  context: ActivitySharingContext;
  platform: ActivitySharingPlatform;
  setSharingEnabled?: (enabled: boolean) => Promise<void>;
  publishTune: (tune?: UserTune) => Promise<unknown>;
  renewTune?: (tune: UserTune) => Promise<unknown>;
  formatError: (reason: unknown) => string;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export class ActivitySharingController {
  private current: ActivitySharingState = {
    enabled: false,
    loading: true,
    applicationId: "",
    sessions: [],
  };
  private context: ActivitySharingContext;
  private readonly listeners = new Set<() => void>();
  private sessionUnsubscribe?: () => void;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastPlayingTune?: UserTune;
  private lastPlayingObservedAt = 0;
  private lastPublished = "";
  private lastPublishedActivity = "";
  private generation = 0;
  private started = false;

  constructor(private readonly options: ActivitySharingControllerOptions) {
    this.context = options.context;
  }

  get state() {
    return this.current;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start() {
    if (this.started) return;
    this.started = true;
    void this.loadPreference();
  }

  updateContext(context: ActivitySharingContext) {
    const accountChanged = context.account !== this.context.account;
    const connectionChanged = context.connected !== this.context.connected;
    if (!accountChanged && !connectionChanged) return;
    this.context = context;
    if (accountChanged) {
      this.stopSessionObservation();
      this.clearPublicationState();
      this.setState({
        enabled: false,
        loading: true,
        applicationId: "",
        sessions: [],
      });
      void this.loadPreference();
      return;
    }
    if (!context.connected) this.clearPublicationState();
    this.publishCurrentActivity();
    this.refreshPublicationTimer();
  }

  async setEnabled(enabled: boolean) {
    const previous = this.current.enabled;
    this.setState({ ...this.current, error: undefined });
    try {
      await this.options.setSharingEnabled?.(enabled);
      this.setState({ ...this.current, enabled });
      this.refreshSessionObservation();
      this.recomputeTune();
      await this.options.platform.savePreference(this.context.account, {
        enabled,
        applicationId: this.current.applicationId,
      });
    } catch (reason) {
      this.setState({
        ...this.current,
        enabled: previous,
        error: this.options.formatError(reason),
      });
      this.refreshSessionObservation();
      this.recomputeTune();
    }
  }

  async setApplication(applicationId: string) {
    const previous = this.current.applicationId;
    this.setState({ ...this.current, applicationId });
    this.recomputeTune();
    try {
      await this.options.platform.savePreference(this.context.account, {
        enabled: this.current.enabled,
        applicationId,
      });
    } catch (reason) {
      this.setState({
        ...this.current,
        applicationId: previous,
        error: this.options.formatError(reason),
      });
      this.recomputeTune();
    }
  }

  dispose() {
    this.started = false;
    this.generation += 1;
    this.stopSessionObservation();
    this.cancelPauseTimer();
    this.cancelRefreshTimer();
    this.listeners.clear();
  }

  private async loadPreference() {
    const generation = ++this.generation;
    this.setState({ ...this.current, loading: true, error: undefined });
    try {
      const preference = await this.options.platform.loadPreference(
        this.context.account,
      );
      if (!this.started || generation !== this.generation) return;
      await this.options.setSharingEnabled?.(preference.enabled);
      if (!this.started || generation !== this.generation) return;
      this.setState({
        ...this.current,
        enabled: preference.enabled,
        applicationId: preference.applicationId,
        loading: false,
      });
      this.refreshSessionObservation();
    } catch (reason) {
      if (!this.started || generation !== this.generation) return;
      this.setState({
        ...this.current,
        loading: false,
        error: this.options.formatError(reason),
      });
    }
  }

  private refreshSessionObservation() {
    if (!this.started || !this.current.enabled) {
      this.stopSessionObservation();
      if (this.current.sessions.length || this.current.capabilities) {
        this.setState({
          ...this.current,
          sessions: [],
          capabilities: undefined,
        });
      }
      return;
    }
    if (this.sessionUnsubscribe) return;
    const generation = ++this.generation;
    this.sessionUnsubscribe = this.options.platform.subscribe((change) => {
      if (change.kind === "error") {
        this.setState({ ...this.current, error: change.message });
      } else if (change.kind === "reset") {
        this.setSessions(change.sessions);
      } else if (change.kind === "removed") {
        this.setSessions(
          this.current.sessions.filter(
            (session) => session.id !== change.sessionId,
          ),
        );
      } else {
        this.setSessions(upsertSession(this.current.sessions, change.session));
      }
    });
    void this.options.platform
      .startSessions()
      .then(({ capabilities, sessions }) => {
        if (!this.started || generation !== this.generation) return;
        this.setState({
          ...this.current,
          capabilities,
          sessions,
          error: capabilities.supported
            ? this.current.error
            : "Music sharing is not available on this platform.",
        });
        this.recomputeTune();
      })
      .catch((reason) => {
        if (this.started && generation === this.generation)
          this.setState({
            ...this.current,
            error: this.options.formatError(reason),
          });
      });
  }

  private stopSessionObservation() {
    this.generation += 1;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = undefined;
    void this.options.platform.stopSessions().catch(() => undefined);
  }

  private setSessions(sessions: MediaActivitySession[]) {
    this.setState({ ...this.current, sessions });
    this.recomputeTune();
  }

  private recomputeTune() {
    const selected = this.current.enabled
      ? selectActivitySession(this.current.sessions, this.current.applicationId)
      : undefined;
    if (selected?.playbackState === "playing") {
      this.cancelPauseTimer();
      const observedAt = this.now();
      const tune = sessionTune(selected);
      const previous = currentTune(
        this.lastPlayingTune,
        this.lastPlayingObservedAt,
        observedAt,
      );
      const seeked = positionDiscontinuity(previous, tune);
      this.lastPlayingTune = tune;
      this.lastPlayingObservedAt = observedAt;
      this.setTune(tune);
      if (seeked) this.renewCurrentActivity(tune);
      return;
    }
    if (selected?.playbackState === "paused" && this.lastPlayingTune) {
      if (this.pauseTimer === undefined)
        this.pauseTimer = this.setTimer(() => {
          this.pauseTimer = undefined;
          this.setTune(undefined);
        }, PAUSED_ACTIVITY_GRACE_MS);
      return;
    }
    this.cancelPauseTimer();
    this.setTune(undefined);
  }

  private setTune(tune?: UserTune) {
    if (!tune) {
      this.lastPlayingTune = undefined;
      this.lastPlayingObservedAt = 0;
    }
    this.setState({ ...this.current, tune });
    this.publishCurrentActivity();
    this.refreshPublicationTimer();
  }

  private publishCurrentActivity() {
    if (!this.context.connected) return;
    const tune = this.current.enabled ? this.current.tune : undefined;
    const activity = activitySignature(tune);
    if (activity === this.lastPublishedActivity) return;
    this.lastPublishedActivity = activity;
    this.publish(tune);
  }

  private publish(tune?: UserTune) {
    const signature = JSON.stringify(tune ?? null);
    if (signature === this.lastPublished) return;
    this.lastPublished = signature;
    void this.options.publishTune(tune).catch((reason) => {
      this.clearPublicationState();
      this.setState({
        ...this.current,
        error: this.options.formatError(reason),
      });
    });
  }

  private refreshPublicationTimer() {
    if (!this.started || !this.context.connected || !this.current.enabled) {
      this.cancelRefreshTimer();
      return;
    }
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = this.setInterval(() => {
      const tune = currentTune(
        this.lastPlayingTune,
        this.lastPlayingObservedAt,
        this.now(),
      );
      if (!tune) return;
      this.lastPublished = JSON.stringify(tune);
      void (this.options.renewTune ?? this.options.publishTune)(tune).catch(
        (reason) => {
          this.clearPublicationState();
          this.setState({
            ...this.current,
            error: this.options.formatError(reason),
          });
        },
      );
    }, ACTIVITY_REFRESH_MS);
  }

  private renewCurrentActivity(tune: UserTune) {
    if (!this.context.connected || !this.current.enabled) return;
    this.lastPublished = JSON.stringify(tune);
    void (this.options.renewTune ?? this.options.publishTune)(tune).catch(
      (reason) => {
        this.clearPublicationState();
        this.setState({
          ...this.current,
          error: this.options.formatError(reason),
        });
      },
    );
  }

  private clearPublicationState() {
    this.lastPublished = "";
    this.lastPublishedActivity = "";
  }

  private cancelPauseTimer() {
    if (this.pauseTimer !== undefined) this.clearTimer(this.pauseTimer);
    this.pauseTimer = undefined;
  }

  private cancelRefreshTimer() {
    if (this.refreshTimer !== undefined) this.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private setTimer(callback: () => void, delay: number) {
    return this.options.setTimer
      ? this.options.setTimer(callback, delay)
      : setTimeout(callback, delay);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>) {
    if (this.options.clearTimer) this.options.clearTimer(timer);
    else clearTimeout(timer);
  }

  private setInterval(callback: () => void, delay: number) {
    return (this.options.setInterval ?? setInterval)(callback, delay);
  }

  private clearInterval(timer: ReturnType<typeof setInterval>) {
    (this.options.clearInterval ?? clearInterval)(timer);
  }

  private setState(state: ActivitySharingState) {
    this.current = state;
    this.listeners.forEach((listener) => listener());
  }
}

export function selectActivitySession(
  sessions: MediaActivitySession[],
  applicationId: string,
) {
  const candidates = applicationId
    ? sessions.filter((session) => session.applicationId === applicationId)
    : sessions;
  return (
    candidates.find((session) => session.playbackState === "playing") ??
    candidates.find((session) => session.playbackState === "paused") ??
    candidates[0]
  );
}

function sessionTune(session: MediaActivitySession): UserTune {
  return {
    title: session.title,
    artist: session.artist,
    album: session.album,
    durationMs: session.durationMs,
    positionMs: session.positionMs,
    playbackState: session.playbackState,
    applicationId: session.applicationId,
    applicationName: session.applicationName,
    trackId: session.trackId,
    trackUri: session.trackUri,
  };
}

function upsertSession(
  sessions: MediaActivitySession[],
  session: MediaActivitySession,
) {
  return sessions.some((item) => item.id === session.id)
    ? sessions.map((item) => (item.id === session.id ? session : item))
    : [...sessions, session];
}

function activitySignature(tune?: UserTune) {
  if (!tune) return "null";
  const activity = { ...tune };
  delete activity.positionMs;
  return JSON.stringify(activity);
}

function currentTune(
  tune: UserTune | undefined,
  observedAt: number,
  now: number,
) {
  if (!tune) return undefined;
  if (tune.positionMs === undefined || tune.playbackState !== "playing")
    return tune;
  return {
    ...tune,
    positionMs: Math.min(
      tune.durationMs ?? Infinity,
      tune.positionMs + Math.max(0, now - observedAt),
    ),
  };
}

function positionDiscontinuity(previous: UserTune | undefined, next: UserTune) {
  if (
    !previous ||
    activitySignature(previous) !== activitySignature(next) ||
    previous.positionMs === undefined ||
    next.positionMs === undefined
  )
    return false;
  return (
    Math.abs(previous.positionMs - next.positionMs) >= SEEK_REFRESH_THRESHOLD_MS
  );
}
