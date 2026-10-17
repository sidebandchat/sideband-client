import type { CallTarget, MediaAdmission } from "../domain.js";
import type { CallId } from "../entity-id.js";
import { entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import { decodeCall } from "../sbp/records.js";
import {
  bytesValue,
  mapValue,
  required,
  textValue,
  timestampValue,
} from "../sbp/value.js";

export type CallAction = "join" | "media-connected" | "decline" | "leave";

export class SbpCallsClient {
  constructor(private readonly transport: SbpCommandTransport) {}

  async start(target: CallTarget, media: "voice" | "video") {
    return decodeCall(
      await this.transport.command(
        400,
        wireMap([
          [0, encodeTarget(target)],
          [1, media === "voice" ? 0 : 1],
        ]),
      ),
    );
  }

  async act(callId: CallId, action: CallAction, signaling?: Uint8Array) {
    await this.transport.command(
      401,
      wireMap([
        [0, entityRef("call", callId)],
        [1, actionId(action)],
        ...(signaling === undefined
          ? []
          : [[2, signaling] as [number, unknown]]),
      ]),
    );
  }

  join(callId: CallId) {
    return this.act(callId, "join");
  }
  mediaConnected(callId: CallId, signaling?: Uint8Array) {
    return this.act(callId, "media-connected", signaling);
  }
  decline(callId: CallId) {
    return this.act(callId, "decline");
  }
  leave(callId: CallId) {
    return this.act(callId, "leave");
  }

  async admit(callId: CallId): Promise<MediaAdmission> {
    const response = mapValue(
      await this.transport.command(
        402,
        wireMap([[0, entityRef("call", callId)]]),
      ),
    );
    return {
      credential: bytesValue(required(response, 0)),
      expiresAt: timestampValue(required(response, 1)),
      room: textValue(required(response, 2)),
    };
  }
}

function encodeTarget(target: CallTarget) {
  if (target.kind === "user") return [0, entityRef("user", target.userId)];
  if (target.kind === "conversation")
    return [1, entityRef("conversation", target.conversationId)];
  return [2, entityRef("channel", target.channelId)];
}

function actionId(action: CallAction) {
  return { join: 2, "media-connected": 3, decline: 4, leave: 5 }[action];
}
