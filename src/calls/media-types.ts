import type { UserId } from "../entity-id.js";

export type ManagedMediaCapture = {
  stream: MediaStream;
  cleanup: () => void | Promise<void>;
};

export type MediaCaptureAdapter = {
  captureLocalAudio: (inputDeviceId?: string) => Promise<ManagedMediaCapture>;
  captureApplicationAudio: (sourceId: string) => Promise<ManagedMediaCapture>;
  captureCamera: (deviceId?: string) => Promise<ManagedMediaCapture>;
  captureScreen: (sourceId: string) => Promise<ManagedMediaCapture>;
};

export type MediaCallbacks = {
  onLocalStream: (stream?: MediaStream) => void;
  onLocalScreen: (stream?: MediaStream, source?: "camera" | "screen") => void;
  onRemoteStream: (
    trackId: string,
    endpointId: string,
    stream: MediaStream,
    metadata: TrackMetadata,
  ) => void;
  onRemoteTrackRemoved: (trackId: string) => void;
  onRemoteEndpoint: (endpointId: string, state: RemoteEndpointState) => void;
  onEndpointRemoved: (endpointId: string) => void;
  onParticipants: (count: number) => void;
  onGroupEnded: () => void;
  onError: (message: string) => void;
  onWarning?: (message: string, cause?: unknown) => void;
  onDisconnected: (sessionId: string, reason?: MediaDisconnectReason) => void;
};

export type MediaDisconnectReason =
  "authorization_revoked" | "policy_violation" | "replaced";

export type TrackMetadata = {
  kind?: string;
  source?: "microphone" | "camera" | "screen" | "screen-audio";
  displayName?: string;
};

export type RemoteEndpointState = {
  userId?: UserId;
  displayName?: string;
  muted: boolean;
  deafened: boolean;
};
