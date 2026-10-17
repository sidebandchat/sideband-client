import type { PrivateTransferAdmission } from "../domain.js";
import type {
  PrivateConversationId,
  PrivateTransferId,
  UserId,
} from "../entity-id.js";
import { entityRef, requestRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import {
  decodePrivateConversation,
  decodePrivateTransfer,
} from "../sbp/records.js";
import {
  bytesValue,
  mapValue,
  required,
  textValue,
  timestampValue,
} from "../sbp/value.js";

export type PrivateConversationAction =
  "accept" | "decline" | "signal" | "end" | "reconnect";
export type PrivateTransferAction =
  "accept" | "decline" | "cancel" | "complete";

export class SbpPrivateConversationsClient {
  constructor(private readonly transport: SbpCommandTransport) {}

  async start(peerId: UserId, encryptedOffer: Uint8Array) {
    return decodePrivateConversation(
      await this.transport.command(
        420,
        wireMap([
          [0, entityRef("user", peerId)],
          [1, ownedBytes(encryptedOffer)],
        ]),
      ),
    );
  }

  async act(
    privateConversationId: PrivateConversationId,
    action: PrivateConversationAction,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  ) {
    await this.transport.command(
      421,
      wireMap([
        [0, entityRef("private-conversation", privateConversationId)],
        [1, privateActionId(action)],
        [2, ownedBytes(payload)],
      ]),
    );
  }

  accept(id: PrivateConversationId, encryptedAnswer: Uint8Array) {
    return this.act(id, "accept", encryptedAnswer);
  }
  decline(id: PrivateConversationId) {
    return this.act(id, "decline");
  }
  signal(id: PrivateConversationId, ciphertext: Uint8Array) {
    return this.act(id, "signal", ciphertext);
  }
  end(id: PrivateConversationId) {
    return this.act(id, "end");
  }
  reconnect(id: PrivateConversationId, encryptedOffer: Uint8Array) {
    return this.act(id, "reconnect", encryptedOffer);
  }

  async offerTransfer(input: {
    privateConversationId: PrivateConversationId;
    byteSize: number;
  }) {
    return decodePrivateTransfer(
      await this.transport.command(
        422,
        wireMap([
          [0, entityRef("private-conversation", input.privateConversationId)],
          [1, input.byteSize],
        ]),
      ),
    );
  }

  async admitTransfer(
    privateConversationId: PrivateConversationId,
    transferId: PrivateTransferId,
  ): Promise<PrivateTransferAdmission> {
    const response = mapValue(
      await this.transport.command(
        423,
        wireMap([
          [0, entityRef("private-conversation", privateConversationId)],
          [1, requestRef(transferId)],
        ]),
      ),
    );
    return {
      credential: bytesValue(required(response, 0)),
      expiresAt: timestampValue(required(response, 1)),
      room: textValue(required(response, 2)),
    };
  }

  async actOnTransfer(
    privateConversationId: PrivateConversationId,
    transferId: PrivateTransferId,
    action: PrivateTransferAction,
  ) {
    return decodePrivateTransfer(
      await this.transport.command(
        424,
        wireMap([
          [0, entityRef("private-conversation", privateConversationId)],
          [1, requestRef(transferId)],
          [2, transferActionId(action)],
        ]),
      ),
    );
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

function privateActionId(action: PrivateConversationAction) {
  return {
    accept: 1,
    decline: 2,
    signal: 3,
    end: 5,
    reconnect: 6,
  }[action];
}

function transferActionId(action: PrivateTransferAction) {
  return { accept: 1, decline: 2, cancel: 3, complete: 4 }[action];
}
