import { Tag } from "cbor-x";
import { describe, expect, it } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeSbp, encodeSbp, entityRef, wireMap } from "./codec.js";
import {
  decodeAccountSnapshot,
  decodeConversationSnapshot,
  decodeMessage,
} from "./records.js";

const USER_ID = entityId<"user">("550e8400-e29b-41d4-a716-446655440000");
const DEVICE_ID = entityId<"device">("660e8400-e29b-41d4-a716-446655440000");
const CONVERSATION_ID = entityId<"conversation">(
  "770e8400-e29b-41d4-a716-446655440000",
);
const COMMUNITY_ID = entityId<"community">(
  "880e8400-e29b-41d4-a716-446655440000",
);
const PRIVATE_CONVERSATION_ID = entityId<"private-conversation">(
  "990e8400-e29b-41d4-a716-446655440000",
);
const NOW = new Date("2026-10-13T20:00:00.000Z");

function throughWire(value: unknown) {
  return decodeSbp(encodeSbp(value));
}

function userRecord() {
  return wireMap([
    [0, entityRef("user", USER_ID)],
    [1, "burger"],
    [2, "Burger"],
    [3, "hello"],
    [5, NOW],
    [6, 2],
    [7, "signed.assertion.value"],
  ]);
}

function conversationRecord() {
  return wireMap([
    [0, entityRef("conversation", CONVERSATION_ID)],
    [1, 0],
    [4, [entityRef("user", USER_ID)]],
    [7, 50n],
    [8, 40n],
    [9, 3],
    [11, NOW],
  ]);
}

function messageRecord() {
  return wireMap([
    [0, 42n],
    [1, entityRef("conversation", CONVERSATION_ID)],
    [2, 0],
    [3, entityRef("user", USER_ID)],
    [4, "hello"],
    [8, NOW],
    [11, 0],
    [
      13,
      [
        wireMap([
          [0, "👍"],
          [1, 1],
          [2, true],
        ]),
      ],
    ],
    [
      14,
      [
        wireMap([
          [0, entityRef("user", USER_ID)],
          [1, 0],
          [2, 5],
        ]),
      ],
    ],
  ]);
}

describe("SBP record decoding", () => {
  it("decodes messages using UUID and ordered domain IDs", () => {
    expect(decodeMessage(throughWire(messageRecord()))).toMatchObject({
      id: 42n,
      conversationId: CONVERSATION_ID,
      authorId: USER_ID,
      kind: "user",
      body: "hello",
      reactions: [{ emoji: "👍", count: 1, own: true }],
      mentions: [{ userId: USER_ID, begin: 0, end: 5 }],
    });
  });

  it("decodes structured community invitation messages", () => {
    const record = messageRecord();
    record.set(2, 3);
    record.set(
      7,
      wireMap([
        [0, new Tag("https://chat.example.test/invite/token", 32)],
        [1, "Garden Club"],
        [2, entityRef("community", COMMUNITY_ID)],
      ]),
    );

    expect(decodeMessage(throughWire(record))).toMatchObject({
      kind: "invitation",
      communityInvite: {
        url: "https://chat.example.test/invite/token",
        communityName: "Garden Club",
        communityId: COMMUNITY_ID,
      },
    });
  });

  it("decodes community system messages", () => {
    const record = messageRecord();
    record.set(2, 1);
    record.delete(3);
    record.set(4, "");
    record.set(7, [
      0,
      wireMap([
        [0, entityRef("community", COMMUNITY_ID)],
        [1, entityRef("user", USER_ID)],
      ]),
    ]);

    expect(decodeMessage(throughWire(record))).toMatchObject({
      id: 42n,
      kind: "system",
      communityEvent: {
        id: 42n,
        type: "member-joined",
        communityId: COMMUNITY_ID,
        userId: USER_ID,
      },
    });
  });

  it("decodes private conversation lifecycle messages", () => {
    const record = messageRecord();
    record.set(2, 2);
    record.set(4, "");
    record.set(7, [
      5,
      wireMap([
        [0, entityRef("private-conversation", PRIVATE_CONVERSATION_ID)],
        [1, entityRef("user", USER_ID)],
        [2, 74],
        [3, 1],
      ]),
    ]);

    expect(decodeMessage(throughWire(record))).toMatchObject({
      kind: "call",
      privateEvent: {
        sessionId: PRIVATE_CONVERSATION_ID,
        initiatorId: USER_ID,
        duration: 74,
        type: "completed",
      },
    });
  });

  it("decodes direct call lifecycle messages", () => {
    const callId = entityId<"call">("88888888-8888-4888-8888-888888888888");
    const record = messageRecord();
    record.set(2, 2);
    record.set(4, "");
    record.set(7, [
      4,
      wireMap([
        [0, entityRef("call", callId)],
        [1, entityRef("user", USER_ID)],
        [2, 74],
        [3, 1],
        [4, false],
      ]),
    ]);

    expect(decodeMessage(throughWire(record))).toMatchObject({
      kind: "call",
      callEvent: {
        callId,
        initiatorId: USER_ID,
        duration: 74,
        type: "completed",
        group: false,
      },
    });
  });

  it("decodes a complete account snapshot", () => {
    const snapshot = wireMap([
      [0, 1],
      [1, 50n],
      [2, userRecord()],
      [3, []],
      [4, []],
      [5, [conversationRecord()]],
      [6, []],
      [
        7,
        wireMap([
          [0, 0],
          [1, 1],
          [2, true],
          [4, 0],
        ]),
      ],
      [8, []],
      [9, []],
      [10, []],
      [
        11,
        [
          wireMap([
            [0, entityRef("device", DEVICE_ID)],
            [1, "Desktop"],
            [2, "windows"],
            [3, "0.3.0"],
            [4, NOW],
            [5, NOW],
            [7, true],
            [8, 0],
          ]),
        ],
      ],
    ]);

    expect(decodeAccountSnapshot(throughWire(snapshot))).toMatchObject({
      schemaVersion: 1,
      ownUser: {
        id: USER_ID,
        username: "burger",
        displayName: "Burger",
        badgeAssertion: "signed.assertion.value",
      },
      conversations: [{ id: CONVERSATION_ID, kind: "direct" }],
      realtimeSettings: {
        presenceVisibility: "nobody",
        activityVisibility: "friends",
        activitySharingEnabled: true,
      },
      devices: [{ id: DEVICE_ID, current: true }],
    });
  });

  it("decodes conversation snapshots", () => {
    const snapshot = wireMap([
      [0, 1],
      [1, 50n],
      [2, conversationRecord()],
      [3, [messageRecord()]],
      [4, true],
      [7, [userRecord()]],
    ]);
    expect(decodeConversationSnapshot(throughWire(snapshot))).toMatchObject({
      schemaVersion: 1,
      conversation: { id: CONVERSATION_ID },
      messages: [{ id: 42n }],
      profiles: [{ id: USER_ID }],
      reachedBeginning: true,
    });
  });

  it("rejects records with the wrong typed entity reference", () => {
    const invalid = messageRecord();
    invalid.set(1, entityRef("user", USER_ID));
    expect(() => decodeMessage(throughWire(invalid))).toThrow(
      "Expected an SBP conversation reference",
    );
  });
});
