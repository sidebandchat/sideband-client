import type {
  CallSession,
  MediaAdmission,
  PrivateConversationRealtimeEvent,
  PrivateConversationMessage,
  PrivateConversationSession,
  PrivateTransfer,
  PrivateTransferAdmission,
} from "../domain.js";
import type { CallId, PrivateTransferId, UserId } from "../entity-id.js";
import type { InstanceEndpoint } from "../instance-endpoint.js";

export type CallMediaParticipant = {
  endpointId: string;
  userId?: UserId;
  displayName?: string;
  muted: boolean;
  deafened: boolean;
};

export type CallMediaRemoteTrack = {
  id: string;
  endpointId: string;
  kind: "audio" | "video";
  source?: "microphone" | "camera" | "screen" | "screen-audio";
  /** Platform-owned stream handle, such as a browser MediaStream. */
  stream: unknown;
};

export type CallMediaState = {
  connectedCallId?: CallId;
  participants: readonly CallMediaParticipant[];
  remoteTracks: readonly CallMediaRemoteTrack[];
  localStream?: unknown;
  localPresentation?: {
    kind: "camera" | "screen";
    stream: unknown;
  };
};

export type CallMediaAdapter = {
  readonly state: CallMediaState;
  subscribe(listener: () => void): () => void;
  connect(input: {
    endpoint: InstanceEndpoint;
    localUserId: UserId;
    call: CallSession;
    admission: MediaAdmission;
  }): Promise<void>;
  disconnect(callId: CallId): Promise<void>;
  enumerateDevices(): Promise<CallMediaDevice[]>;
  subscribeDevices(listener: () => void): () => void;
  setMuted(muted: boolean): void | Promise<void>;
  setDeafened(deafened: boolean): void | Promise<void>;
  selectInput(deviceId: string): Promise<void>;
  selectOutput(deviceId: string): void | Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  startScreenShare(sourceId: string, applicationAudio: boolean): Promise<void>;
  stopScreenShare(): Promise<void>;
  setRemoteVolume(endpointId: string, volume: number): void;
};

export type CallMediaDevice = {
  id: string;
  groupId?: string;
  kind: "audio-input" | "audio-output" | "video-input";
  label: string;
};

export type CallMediaPreferences = {
  load(): Promise<{
    muted: boolean;
    deafened: boolean;
    inputDeviceId: string;
    outputDeviceId: string;
  }>;
  saveAudio(muted: boolean, deafened: boolean): Promise<void>;
  saveDevice(kind: "input" | "output", deviceId: string): Promise<void>;
};

export type PrivateCryptoHandle = unknown;
export type PrivateCryptoAdapter = {
  createOffer(
    peerId: UserId,
  ): Promise<{ payload: Uint8Array; handle: PrivateCryptoHandle }>;
  acceptOffer(input: {
    session: PrivateConversationSession;
    payload: Uint8Array;
  }): Promise<{ payload: Uint8Array; handle: PrivateCryptoHandle }>;
  receive(
    handle: PrivateCryptoHandle,
    event: PrivateConversationRealtimeEvent,
  ): Promise<{
    outbound?: Uint8Array[];
    messages?: Array<
      Pick<
        PrivateConversationMessage,
        "id" | "body" | "timestamp" | "transferIds"
      >
    >;
    transferOffers?: Array<{
      transferId: PrivateTransferId;
      key: Uint8Array;
      filename: string;
      mediaType: string;
      byteSize: number;
      sha256: Uint8Array;
    }>;
  }>;
  encrypt(
    handle: PrivateCryptoHandle,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  close(handle: PrivateCryptoHandle): Promise<void>;
};

export type PrivateTransferAdapter = {
  prepare(input: {
    resource: unknown;
    filename: string;
    mediaType: string;
    byteSize: number;
  }): Promise<{ sha256: Uint8Array; key: Uint8Array }>;
  registerSource(
    transferId: PrivateTransferId,
    resource: unknown,
  ): void | Promise<void>;
  connect(input: {
    endpoint: InstanceEndpoint;
    transfer: PrivateTransfer & {
      filename: string;
      mediaType: string;
      sha256: Uint8Array;
    };
    admission: PrivateTransferAdmission;
    key: Uint8Array;
    direction: "send" | "receive";
    onProgress(progress: number): void;
    onComplete(): void;
    onError(reason: unknown): void;
  }): Promise<void>;
  disconnect(transferId: PrivateTransferId): Promise<void>;
  showInFolder(transferId: PrivateTransferId): Promise<void>;
};
