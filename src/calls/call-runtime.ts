import type { CallSession } from "../domain.js";
import type { CallId, UserId } from "../entity-id.js";
import type { MediaDisconnectReason } from "./media-types.js";

export type CallConnectionState =
  | "idle"
  | "ringing"
  | "connecting"
  | "active"
  | "reconnecting"
  | "replacing"
  | "disconnecting";

export type CallLifecycleEvent =
  | {
      type: "current-changed";
      call?: CallSession;
      previous?: CallSession;
    }
  | {
      type: "call-updated";
      call: CallSession;
      previous?: CallSession;
    }
  | {
      type: "participant-state-changed";
      call: CallSession;
      userId: UserId;
      state: CallSession["participants"][number]["state"];
      previousState?: CallSession["participants"][number]["state"];
    }
  | { type: "call-ended"; call: CallSession }
  | {
      type: "connection-state-changed";
      state: CallConnectionState;
      previousState: CallConnectionState;
      call?: CallSession;
      reason?: MediaDisconnectReason | "room-ended" | "reconnect-failed";
    };

export type CallRuntimeView = {
  connection: CallConnectionState;
  phase?: "proposal" | "session";
  current?: CallSession;
  incoming?: CallSession;
  joinable: ReadonlyMap<CallId, CallSession>;
  pendingParticipantIds: readonly UserId[];
};
