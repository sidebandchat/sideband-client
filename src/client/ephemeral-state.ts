import type {
  ActivityView,
  CustomStatus,
  PresenceView,
  UserActivity,
  UserSummary,
  UserTune,
} from "../domain.js";
import type { ChannelId, ConversationId, UserId } from "../entity-id.js";
import { entityId } from "../entity-id.js";
import { decodeEntityRef, decodeRequestRef } from "../sbp/codec.js";
import { decodeUserSummary } from "../sbp/records.js";
import type { SbpFrame } from "../sbp/frame.js";
import type { SbpSession } from "../sbp/session.js";
import {
  arrayValue,
  mapValue,
  optional,
  required,
  timestampValue,
  unsignedValue,
} from "../sbp/value.js";

export type EphemeralState = {
  presence: ReadonlyMap<UserId, PresenceView>;
  activities: ReadonlyMap<string, ActivityView>;
  typing: ReadonlyMap<ConversationId, ReadonlySet<UserId>>;
  typingUsers: ReadonlyMap<UserId, UserSummary>;
};

export function initialEphemeralState(): EphemeralState {
  return {
    presence: new Map(),
    activities: new Map(),
    typing: new Map(),
    typingUsers: new Map(),
  };
}

export class EphemeralStateController {
  private current: EphemeralState = initialEphemeralState();
  private globalPresence = new Map<UserId, PresenceView>();
  private channelPresence = new Map<UserId, PresenceView>();
  private globalActivities = new Map<string, ActivityView>();
  private channelActivities = new Map<string, ActivityView>();
  private channelId?: ChannelId;
  private pendingChannelPresence = new Map<UserId, boolean>();
  private pendingChannelOnlineCount?: number;
  private channelPublishTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe?: () => void;
  constructor(
    private readonly session: SbpSession,
    private readonly now = () => Date.now(),
    private readonly onTypingUser?: (
      userId: UserId,
      summary?: UserSummary,
    ) => void,
    private readonly onCommunityPresence?: (
      channelId: ChannelId,
      changes: ReadonlyMap<UserId, boolean>,
      onlineCount?: number,
    ) => void,
  ) {}
  get state() {
    return this.current;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  start() {
    this.unsubscribe ??= this.session.subscribeControls((frame) =>
      this.receive(frame),
    );
  }
  stop() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.globalPresence.clear();
    this.channelPresence.clear();
    this.globalActivities.clear();
    this.channelActivities.clear();
    this.channelId = undefined;
    this.pendingChannelPresence.clear();
    this.pendingChannelOnlineCount = undefined;
    if (this.channelPublishTimer) clearTimeout(this.channelPublishTimer);
    this.channelPublishTimer = undefined;
    this.current = initialEphemeralState();
  }

  private receive(frame: Extract<SbpFrame, { kind: "control" }>) {
    if (frame.opcode === 33)
      this.putPresence(decodePresence(frame.payload), "global");
    else if (frame.opcode === 35) this.putTyping(frame.payload);
    else if (frame.opcode === 37) this.putActivity(frame.payload, "global");
    else if (frame.opcode === 38) this.replaceSnapshot(frame.payload);
    else if (frame.opcode === 39) this.putCommunityPresence(frame.payload);
    else if (frame.opcode === 40) this.putCommunityActivity(frame.payload);
    else if (frame.opcode === 41) this.replaceCommunitySnapshot(frame.payload);
    else if (frame.opcode === 42) this.mergeCommunitySnapshot(frame.payload);
    else if (frame.opcode === 43) this.putCommunityBatch(frame.payload);
  }

  private putCommunityPresence(payload: unknown) {
    const map = mapValue(payload);
    const channelId = decodeEntityRef(required(map, 0), "channel");
    if (this.channelId !== channelId) return;
    const presence = decodePresence(required(map, 1));
    this.pendingChannelOnlineCount = optional(map, 2, unsignedValue);
    this.putPresence(presence, "channel", false);
    this.pendingChannelPresence.set(
      presence.userId,
      presence.availability !== "offline",
    );
    this.scheduleChannelPublish();
  }

  private putCommunityActivity(payload: unknown) {
    const map = mapValue(payload);
    const channelId = decodeEntityRef(required(map, 0), "channel");
    if (this.channelId !== channelId) return;
    this.putActivity(
      new Map([
        [0, required(map, 1)],
        [1, required(map, 2)],
        [2, required(map, 3)],
        [3, required(map, 4)],
      ]),
      "channel",
      false,
    );
    this.scheduleChannelPublish();
  }

  private replaceCommunitySnapshot(payload: unknown) {
    const map = mapValue(payload);
    this.channelPresence.clear();
    this.channelActivities.clear();
    this.clearSourceTimers("channel");

    this.channelId =
      map.get(0) === null
        ? undefined
        : decodeEntityRef(required(map, 0), "channel");
    this.pendingChannelPresence.clear();
    this.pendingChannelOnlineCount = undefined;
    if (this.channelPublishTimer) clearTimeout(this.channelPublishTimer);
    this.channelPublishTimer = undefined;

    if (this.channelId) {
      arrayValue(required(map, 1))
        .map(decodePresence)
        .forEach((value) => this.putPresence(value, "channel", false));
      arrayValue(required(map, 2)).forEach((value) =>
        this.putActivity(value, "channel", false),
      );
    }

    this.publishMerged();
  }

  private mergeCommunitySnapshot(payload: unknown) {
    const map = mapValue(payload);
    const channelId = decodeEntityRef(required(map, 0), "channel");
    if (this.channelId !== channelId) return;

    arrayValue(required(map, 1))
      .map(decodePresence)
      .forEach((value) => this.putPresence(value, "channel", false));
    arrayValue(required(map, 2)).forEach((value) =>
      this.putActivity(value, "channel", false),
    );
    this.publishMerged();
  }

  private putCommunityBatch(payload: unknown) {
    for (const operation of arrayValue(payload)) {
      const [opcode, value, ...rest] = arrayValue(operation);
      if (rest.length || (opcode !== 39 && opcode !== 40))
        throw new TypeError("Invalid channel realtime batch");
      if (opcode === 39) this.putCommunityPresence(value);
      else this.putCommunityActivity(value);
    }
  }

  private replaceSnapshot(payload: unknown) {
    const map = mapValue(payload);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.globalPresence.clear();
    this.channelPresence.clear();
    this.globalActivities.clear();
    this.channelActivities.clear();
    this.current = initialEphemeralState();
    arrayValue(required(map, 0))
      .map(decodePresence)
      .forEach((value) => this.putPresence(value, "global"));
    arrayValue(required(map, 1))
      .map(decodeActivityView)
      .forEach((value) => this.storeActivity(value, "global"));
  }

  private putPresence(
    value: PresenceView,
    source: "global" | "channel",
    publish = true,
  ) {
    const presence =
      source === "global" ? this.globalPresence : this.channelPresence;
    if (value.availability === "offline") presence.delete(value.userId);
    else presence.set(value.userId, value);
    if (publish) this.publishMerged();
  }

  private putTyping(payload: unknown) {
    const map = mapValue(payload);
    const conversationId = decodeEntityRef(required(map, 0), "conversation");
    const userId = decodeEntityRef(required(map, 1), "user");
    const typing = required(map, 2) === true;
    const summary = optional(map, 4, decodeUserSummary);
    const all = new Map(this.current.typing);
    const users = new Set(all.get(conversationId) ?? []);
    if (typing) users.add(userId);
    else users.delete(userId);
    if (users.size) all.set(conversationId, users);
    else all.delete(conversationId);
    const typingUsers = new Map(this.current.typingUsers);
    if (typing && summary) typingUsers.set(userId, summary);
    else if (!typing && !typingUserActive(all, userId))
      typingUsers.delete(userId);
    if (typing) this.onTypingUser?.(userId, summary);
    this.set({ ...this.current, typing: all, typingUsers });
    const observedAt = timestampValue(required(map, 3));
    // The server normally broadcasts an explicit false on expiry. The maximum
    // protocol lease is also a client-side fail-safe for a lost clear frame.
    if (typing)
      this.expire(
        `typing:${conversationId}:${userId}`,
        new Date(Date.parse(observedAt) + 15_000).toISOString(),
        () => this.removeTyping(conversationId, userId),
      );
  }

  private putActivity(
    payload: unknown,
    source: "global" | "channel",
    publish = true,
  ) {
    const map = mapValue(payload);
    const userId = decodeEntityRef(required(map, 0), "user");
    const deviceId = decodeEntityRef(required(map, 1), "device");
    const kind = unsignedValue(required(map, 2));
    const value = map.get(3);
    if (value === null)
      this.removeActivity(`${userId}:${deviceId}:${kind}`, source, publish);
    else
      this.storeActivity(
        { userId, deviceId, activity: decodeActivity(value) },
        source,
        publish,
      );
  }

  private storeActivity(
    value: ActivityView,
    source: "global" | "channel",
    publish = true,
  ) {
    const key = `${value.userId}:${value.deviceId}:${activityKindId(value.activity.kind)}`;
    const activities =
      source === "global" ? this.globalActivities : this.channelActivities;
    activities.set(key, value);
    if (publish) this.publishMerged();
    this.expire(`activity:${source}:${key}`, value.activity.expiresAt, () =>
      this.removeActivity(key, source),
    );
  }
  private removeActivity(
    key: string,
    source: "global" | "channel",
    publish = true,
  ) {
    const activities =
      source === "global" ? this.globalActivities : this.channelActivities;
    activities.delete(key);
    if (publish) this.publishMerged();
  }

  private clearSourceTimers(source: "global" | "channel") {
    const prefix = `activity:${source}:`;
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private publishMerged() {
    this.set({
      ...this.current,
      presence: new Map([...this.globalPresence, ...this.channelPresence]),
      activities: new Map([
        ...this.globalActivities,
        ...this.channelActivities,
      ]),
    });
  }

  private scheduleChannelPublish() {
    if (this.channelPublishTimer) return;
    this.channelPublishTimer = setTimeout(() => {
      this.channelPublishTimer = undefined;
      const changes = new Map(this.pendingChannelPresence);
      const onlineCount = this.pendingChannelOnlineCount;
      this.pendingChannelPresence.clear();
      this.pendingChannelOnlineCount = undefined;
      this.publishMerged();
      if (this.channelId)
        this.onCommunityPresence?.(this.channelId, changes, onlineCount);
    }, 250);
  }
  private removeTyping(conversationId: ConversationId, userId: UserId) {
    const typing = new Map(this.current.typing);
    const users = new Set(typing.get(conversationId) ?? []);
    users.delete(userId);
    if (users.size) typing.set(conversationId, users);
    else typing.delete(conversationId);
    const typingUsers = new Map(this.current.typingUsers);
    if (!typingUserActive(typing, userId)) typingUsers.delete(userId);
    this.set({ ...this.current, typing, typingUsers });
  }
  private expire(key: string, expiresAt: string, callback: () => void) {
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    this.timers.set(
      key,
      setTimeout(
        () => {
          this.timers.delete(key);
          callback();
        },
        Math.max(0, Date.parse(expiresAt) - this.now()),
      ),
    );
  }
  private set(state: EphemeralState) {
    this.current = state;
    this.listeners.forEach((listener) => listener());
  }
}

function typingUserActive(
  typing: ReadonlyMap<ConversationId, ReadonlySet<UserId>>,
  userId: UserId,
) {
  return [...typing.values()].some((users) => users.has(userId));
}

function decodePresence(value: unknown): PresenceView {
  const map = mapValue(value);
  const states = ["offline", "online", "idle", "dnd"] as const;
  const availability = states[unsignedValue(required(map, 1))];
  if (!availability) throw new TypeError("Invalid public availability");
  return {
    userId: decodeEntityRef(required(map, 0), "user"),
    availability,
    customStatus: optional(map, 2, decodeCustomStatus),
    observedAt: timestampValue(required(map, 3)),
    idleSince: optional(map, 5, timestampValue),
  };
}
function decodeCustomStatus(value: unknown): CustomStatus {
  const map = mapValue(value);
  return {
    text: optional(map, 0, String),
    emoji: optional(map, 1, String),
    expiresAt: optional(map, 2, timestampValue),
  };
}
function decodeActivityView(value: unknown): ActivityView {
  const map = mapValue(value);
  return {
    userId: decodeEntityRef(required(map, 0), "user"),
    deviceId: decodeEntityRef(required(map, 1), "device"),
    activity: decodeActivity(required(map, 2)),
  };
}
function decodeActivity(value: unknown): UserActivity {
  const map = mapValue(value);
  const kinds = ["music", "game"] as const;
  const raw = unsignedValue(required(map, 1));
  const kind = raw === 255 ? "custom" : kinds[raw];
  if (!kind) throw new TypeError("Invalid activity kind");
  return {
    id: entityId<"activity">(decodeRequestRef(required(map, 0))),
    kind,
    startedAt: timestampValue(required(map, 2)),
    updatedAt: timestampValue(required(map, 3)),
    expiresAt: timestampValue(required(map, 4)),
    payload: decodeActivityPayload(kind, required(map, 5)),
  };
}
function decodeActivityPayload(kind: UserActivity["kind"], value: unknown) {
  if (kind !== "music") return value;
  const [variant, fields] = arrayValue(value);
  if (variant !== 0) throw new TypeError("Invalid music activity");
  const map = mapValue(fields);
  const artists = optional(map, 1, arrayValue);
  const states: UserTune["playbackState"][] = ["stopped", "paused", "playing"];
  const playbackState = states[unsignedValue(required(map, 3))];
  if (!playbackState) throw new TypeError("Invalid playback state");
  return {
    title: String(required(map, 0)),
    artist: artists?.map(String).join(", "),
    album: optional(map, 2, String),
    playbackState,
    durationMs: optional(map, 4, unsignedValue),
    positionMs: optional(map, 5, unsignedValue),
    applicationName: optional(map, 8, String),
    applicationId: optional(map, 9, String),
    trackId: optional(map, 10, (identifiers) => {
      const first = arrayValue(identifiers)[0];
      return first ? String(arrayValue(first)[1]) : undefined;
    }),
    trackUri: optional(map, 11, String),
  } satisfies UserTune;
}
function activityKindId(kind: UserActivity["kind"]) {
  return { music: 0, game: 1, custom: 255 }[kind];
}
