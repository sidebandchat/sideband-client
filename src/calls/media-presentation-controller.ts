import type {
  MediaCallbacks,
  MediaDisconnectReason,
  RemoteEndpointState,
  TrackMetadata,
} from "./media-types.js";
import type { UserId } from "../entity-id.js";

export type RemoteMedia = {
  endpointId: string;
  stream: MediaStream;
  source?: TrackMetadata["source"];
  displayName?: string;
};

export type MediaPresentationState = {
  participants: number;
  remoteStreams: Record<string, RemoteMedia>;
  remoteEndpointStates: Record<string, RemoteEndpointState>;
  localStream?: MediaStream;
  localScreen?: MediaStream;
  localScreenSource?: "camera" | "screen";
};

export type MediaPresentationControllerOptions = {
  onScreenShareStarted?: (remote: boolean) => void;
  onScreenShareStopped?: (remote: boolean) => void;
  onEndpointDeparted?: (userId: UserId) => void;
  onGroupEnded: () => void;
  onError: (message: string) => void;
  onDisconnected: (sessionId: string, reason?: MediaDisconnectReason) => void;
};

const initialState: MediaPresentationState = {
  participants: 0,
  remoteStreams: {},
  remoteEndpointStates: {},
};

export class MediaPresentationController {
  private current: MediaPresentationState = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly remoteScreenTracks = new Map<string, string>();

  constructor(private readonly options: MediaPresentationControllerOptions) {}

  get state() {
    return this.current;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  callbacks: MediaCallbacks = {
    onLocalStream: (localStream) => this.update({ localStream }),
    onLocalScreen: (localScreen, localScreenSource) => {
      const wasSharingScreen = this.current.localScreenSource === "screen";
      const sharingScreen = localScreenSource === "screen";
      this.update({ localScreen, localScreenSource });
      if (sharingScreen && !wasSharingScreen)
        this.options.onScreenShareStarted?.(false);
      if (!sharingScreen && wasSharingScreen)
        this.options.onScreenShareStopped?.(false);
    },
    onRemoteStream: (trackId, endpointId, stream, metadata) => {
      if (
        metadata.source === "screen" &&
        !this.remoteScreenTracks.has(trackId)
      ) {
        this.remoteScreenTracks.set(trackId, endpointId);
        this.options.onScreenShareStarted?.(true);
      }
      this.update({
        remoteStreams: {
          ...this.current.remoteStreams,
          [trackId]: {
            endpointId,
            stream,
            source: metadata.source,
            displayName: metadata.displayName,
          },
        },
      });
    },
    onRemoteTrackRemoved: (trackId) => {
      if (this.remoteScreenTracks.delete(trackId))
        this.options.onScreenShareStopped?.(true);
      const remoteStreams = { ...this.current.remoteStreams };
      delete remoteStreams[trackId];
      this.update({ remoteStreams });
    },
    onRemoteEndpoint: (endpointId, endpointState) => {
      this.update({
        remoteEndpointStates: {
          ...this.current.remoteEndpointStates,
          [endpointId]: endpointState,
        },
      });
    },
    onEndpointRemoved: (endpointId) => {
      const departedState = this.current.remoteEndpointStates[endpointId];
      if (departedState?.userId)
        this.options.onEndpointDeparted?.(departedState.userId);

      const remoteEndpointStates = { ...this.current.remoteEndpointStates };
      delete remoteEndpointStates[endpointId];
      const remoteStreams = Object.fromEntries(
        Object.entries(this.current.remoteStreams).filter(
          ([trackId, stream]) => {
            if (stream.endpointId !== endpointId) return true;
            if (this.remoteScreenTracks.delete(trackId))
              this.options.onScreenShareStopped?.(true);
            return false;
          },
        ),
      );
      this.update({ remoteEndpointStates, remoteStreams });
    },
    onParticipants: (participants) => this.update({ participants }),
    onGroupEnded: () => this.options.onGroupEnded(),
    onError: (message) => this.options.onError(message),
    onDisconnected: (sessionId, reason) =>
      this.options.onDisconnected(sessionId, reason),
  };

  clearRemoteState() {
    this.remoteScreenTracks.clear();
    this.update({
      remoteStreams: {},
      remoteEndpointStates: {},
    });
  }

  reset() {
    this.remoteScreenTracks.clear();
    this.set(initialState);
  }

  private update(update: Partial<MediaPresentationState>) {
    this.set({ ...this.current, ...update });
  }

  private set(state: MediaPresentationState) {
    if (state === this.current) return;
    this.current = state;
    this.listeners.forEach((listener) => listener());
  }
}
