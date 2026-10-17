import { describe, expect, it } from "vitest";
import { entityId, orderedId } from "../entity-id.js";
import { initialAccountState } from "../client/state.js";
import {
  conversationName,
  friendshipLists,
  publicPresence,
  unreadInboxEntries,
  unreadCounts,
  userActivities,
} from "./selectors.js";

const OWN = entityId<"user">("11111111-1111-4111-8111-111111111111");
const ALICE = entityId<"user">("22222222-2222-4222-8222-222222222222");
const BOB = entityId<"user">("33333333-3333-4333-8333-333333333333");
const CONVERSATION = entityId<"conversation">(
  "44444444-4444-4444-8444-444444444444",
);

function state() {
  return {
    ...initialAccountState(),
    ownUserId: OWN,
    users: new Map([
      [OWN, profile(OWN, "owner")],
      [ALICE, profile(ALICE, "Alice")],
      [BOB, profile(BOB, "Bob")],
    ]),
    friendships: new Map([
      [
        entityId<"friendship">("55555555-5555-4555-8555-555555555555"),
        {
          friendshipId: entityId<"friendship">(
            "55555555-5555-4555-8555-555555555555",
          ),
          userId: ALICE,
          requesterId: ALICE,
          name: "Alice",
          state: "pending" as const,
          createdAt: "2026-01-01T00:00:00Z",
          revision: 1,
        },
      ],
      [
        entityId<"friendship">("66666666-6666-4666-8666-666666666666"),
        {
          friendshipId: entityId<"friendship">(
            "66666666-6666-4666-8666-666666666666",
          ),
          userId: BOB,
          requesterId: OWN,
          name: "Bob",
          state: "accepted" as const,
          createdAt: "2026-01-01T00:00:00Z",
          revision: 1,
        },
      ],
    ]),
    conversations: new Map([
      [
        CONVERSATION,
        {
          id: CONVERSATION,
          kind: "direct" as const,
          participantIds: [OWN, ALICE],
          revision: 1,
        },
      ],
    ]),
  };
}

describe("native workspace selectors", () => {
  it("derives friendship sections and direct-message names from IDs", () => {
    const account = state();
    const friendships = friendshipLists(account);

    expect(friendships.received.map((item) => item.userId)).toEqual([ALICE]);
    expect(friendships.accepted.map((item) => item.userId)).toEqual([BOB]);
    expect(conversationName(account, CONVERSATION)).toBe("Alice");
  });

  it("counts unread inbox records per conversation", () => {
    const account = {
      ...state(),
      inbox: new Map([
        [
          orderedId<"notification">(1n),
          {
            id: orderedId<"notification">(1n),
            kind: "unread" as const,
            conversationId: CONVERSATION,
            createdAt: "2026-01-01T00:00:00Z",
            read: false,
            unreadCount: 5,
          },
        ],
        [
          orderedId<"notification">(2n),
          {
            id: orderedId<"notification">(2n),
            kind: "mention" as const,
            conversationId: CONVERSATION,
            createdAt: "2026-01-01T00:00:01Z",
            read: false,
          },
        ],
      ]),
    };

    expect(unreadCounts(account).get(CONVERSATION)).toBe(5);
  });

  it("does not expose stale inbox records at or before the read cursor", () => {
    const readThrough = orderedId<"message">(10n);
    const stale = orderedId<"notification">(1n);
    const unread = orderedId<"notification">(2n);
    const base = state();
    const account = {
      ...base,
      conversations: new Map([
        [
          CONVERSATION,
          {
            ...base.conversations.get(CONVERSATION)!,
            readThroughMessageId: readThrough,
          },
        ],
      ]),
      inbox: new Map([
        [
          stale,
          {
            id: stale,
            kind: "unread" as const,
            conversationId: CONVERSATION,
            messageId: orderedId<"message">(9n),
            createdAt: "2026-01-01T00:00:00Z",
            read: false,
          },
        ],
        [
          unread,
          {
            id: unread,
            kind: "unread" as const,
            conversationId: CONVERSATION,
            messageId: orderedId<"message">(11n),
            createdAt: "2026-01-01T00:00:01Z",
            read: false,
          },
        ],
      ]),
    };

    expect(unreadInboxEntries(account).map((entry) => entry.id)).toEqual([
      unread,
    ]);
    expect(unreadCounts(account).get(CONVERSATION)).toBe(1);
  });

  it("projects expiring presence and activities by user ID", () => {
    const activity = {
      userId: ALICE,
      deviceId: entityId<"device">("77777777-7777-4777-8777-777777777777"),
      activity: {
        id: entityId<"activity">("88888888-8888-4888-8888-888888888888"),
        kind: "music" as const,
        startedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        expiresAt: "2026-01-01T00:02:00Z",
        payload: { title: "Track" },
      },
    };
    const ephemeral = {
      presence: new Map([
        [
          ALICE,
          {
            userId: ALICE,
            availability: "online" as const,
            observedAt: "2026-01-01T00:01:00Z",
            expiresAt: "2026-01-01T00:02:00Z",
          },
        ],
      ]),
      activities: new Map([["activity", activity]]),
      typing: new Map(),
    };

    expect(publicPresence(ephemeral, ALICE)).toBe("online");
    expect(userActivities(ephemeral, ALICE)).toEqual([activity]);
  });
});

function profile(id: typeof OWN, displayName: string) {
  return {
    id,
    username: displayName.toLowerCase(),
    displayName,
    bio: "",
    revision: 1,
  };
}
