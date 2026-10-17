import type { ConversationId } from "../entity-id.js";
import { entityRef, wireMap } from "../sbp/codec.js";
import {
  decodeAccountSnapshot,
  decodeConversationSnapshot,
} from "../sbp/records.js";
import type { SbpSession } from "../sbp/session.js";

export class SnapshotClient {
  constructor(private readonly session: SbpSession) {}

  async account(schemaVersion = 1) {
    return decodeAccountSnapshot(
      await this.session.command(1, wireMap([[0, schemaVersion]])),
    );
  }

  async conversation(conversationId: ConversationId, schemaVersion = 1) {
    return decodeConversationSnapshot(
      await this.session.command(
        6,
        wireMap([
          [0, entityRef("conversation", conversationId)],
          [1, schemaVersion],
        ]),
      ),
    );
  }
}
