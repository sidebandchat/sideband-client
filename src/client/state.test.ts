import { describe, expect, it, vi } from "vitest";
import { entityId, orderedId } from "../entity-id.js";
import type { AccountSnapshot, ConversationSnapshot } from "../domain.js";
import { AccountStateController } from "./state.js";
import { decodeSbp, encodeSbp, entityRef, wireMap } from "../sbp/codec.js";

const USER_ID = entityId<"user">("550e8400-e29b-41d4-a716-446655440000");
const OTHER_USER_ID = entityId<"user">("770e8400-e29b-41d4-a716-446655440000");
const CONVERSATION_ID = entityId<"conversation">(
  "660e8400-e29b-41d4-a716-446655440000",
);

const profile = {
  id: USER_ID,
  username: "burger",
  displayName: "Burger",
  bio: "",
  createdAt: "2026-10-13T20:00:00.000Z",
  revision: 0,
};

const conversation = {
  id: CONVERSATION_ID,
  kind: "direct" as const,
  participantIds: [USER_ID],
  revision: 0,
};

const account: AccountSnapshot = {
  schemaVersion: 1,
  ownUser: profile,
  users: [],
  friendships: [],
  conversations: [conversation],
  communities: [],
  realtimeSettings: {
    presenceVisibility: "everyone",
    activityVisibility: "relationships",
    activitySharingEnabled: false,
    revision: 0,
  },
  inbox: [],
  blocks: [],
  notificationSettings: [],
  devices: [],
};

describe("AccountStateController", () => {
  it("normalizes account and conversation snapshots by UUID", async () => {
    const messageId = orderedId<"message">(1n);
    const conversationSnapshot: ConversationSnapshot = {
      schemaVersion: 1,
      conversation,
      reachedBeginning: true,
      profiles: [profile],
      messages: [
        {
          id: messageId,
          conversationId: CONVERSATION_ID,
          kind: "user",
          authorId: USER_ID,
          body: "hello",
          outgoing: false,
          timestamp: "2026-10-13T20:00:00.000Z",
          revision: 0,
        },
      ],
    };
    const snapshots = {
      account: vi.fn().mockResolvedValue(account),
      conversation: vi.fn().mockResolvedValue(conversationSnapshot),
    };
    const state = new AccountStateController(snapshots);
    const listener = vi.fn();
    state.subscribe(listener);

    await state.loadAccount();
    await state.loadConversation(CONVERSATION_ID);

    expect(state.state.ownUserId).toBe(USER_ID);
    expect(state.state.users.get(USER_ID)).toBe(profile);
    expect(state.state.conversations.get(CONVERSATION_ID)).toBe(conversation);
    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(messageId)?.body,
    ).toBe("hello");
    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(messageId)?.outgoing,
    ).toBe(true);
    expect(state.state.reachedBeginning.get(CONVERSATION_ID)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("applies each live conversation event once", async () => {
    const snapshots = {
      account: vi.fn().mockResolvedValue(account),
      conversation: vi.fn(),
    };
    const state = new AccountStateController(snapshots);
    await state.loadAccount();
    const payload = decodeSbp(
      encodeSbp(
        wireMap([
          [0, 9n],
          [1, entityRef("conversation", CONVERSATION_ID)],
          [2, 0],
          [3, entityRef("user", USER_ID)],
          [4, "replayed"],
          [8, new Date("2026-10-13T20:00:00.000Z")],
          [11, 0],
        ]),
      ),
    );
    const event = {
      kind: "event" as const,
      stream: {
        kind: "conversation" as const,
        conversationId: CONVERSATION_ID,
      },
      eventId: 20n,
      timestamp: new Date("2026-10-13T20:00:00.000Z"),
      opcode: 100,
      payload,
    };

    await expect(state.applyEvent(event)).resolves.toBe(true);
    await expect(state.applyEvent(event)).resolves.toBe(false);

    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(9n as never)?.body,
    ).toBe("replayed");
    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(9n as never)?.outgoing,
    ).toBe(true);
  });

  it("coalesces remote event notifications without delaying state updates", async () => {
    vi.useFakeTimers();

    try {
      const state = new AccountStateController({
        account: vi.fn().mockResolvedValue(account),
        conversation: vi.fn(),
      });
      await state.loadAccount();
      const listener = vi.fn();
      state.subscribe(listener);

      const event = (messageId: bigint, eventId: bigint) => ({
        kind: "event" as const,
        stream: {
          kind: "conversation" as const,
          conversationId: CONVERSATION_ID,
        },
        eventId,
        timestamp: new Date("2026-10-13T20:00:00.000Z"),
        opcode: 100,
        payload: decodeSbp(
          encodeSbp(
            wireMap([
              [0, messageId],
              [1, entityRef("conversation", CONVERSATION_ID)],
              [2, 0],
              [3, entityRef("user", OTHER_USER_ID)],
              [4, `message ${messageId}`],
              [8, new Date("2026-10-13T20:00:00.000Z")],
              [11, 0],
            ]),
          ),
        ),
      });

      await state.applyEvent(event(10n, 20n));
      await state.applyEvent(event(11n, 21n));

      expect(state.state.messages.get(CONVERSATION_ID)?.size).toBe(2);
      expect(listener).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects live community messages into one local unread aggregate", async () => {
    const communityConversation = {
      ...conversation,
      kind: "community-channel" as const,
    };
    const snapshots = {
      account: vi.fn().mockResolvedValue({
        ...account,
        users: [
          {
            id: OTHER_USER_ID,
            username: "alice",
            displayName: "Alice",
            revision: 0,
          },
        ],
        conversations: [communityConversation],
      }),
      conversation: vi.fn(),
    };
    const onNotification = vi.fn();
    const state = new AccountStateController(
      snapshots,
      undefined,
      undefined,
      undefined,
      onNotification,
    );
    await state.loadAccount();

    for (const [messageId, eventId] of [
      [9n, 20n],
      [10n, 21n],
    ] as const) {
      await state.applyEvent({
        kind: "event",
        stream: {
          kind: "conversation",
          conversationId: CONVERSATION_ID,
        },
        eventId,
        timestamp: new Date("2026-10-13T20:00:00.000Z"),
        opcode: 100,
        payload: decodeSbp(
          encodeSbp(
            wireMap([
              [0, messageId],
              [1, entityRef("conversation", CONVERSATION_ID)],
              [2, 0],
              [3, entityRef("user", OTHER_USER_ID)],
              [4, `message ${messageId}`],
              [8, new Date("2026-10-13T20:00:00.000Z")],
              [11, 0],
            ]),
          ),
        ),
      });
    }

    const [unread] = [...state.state.inbox.values()];
    expect(unread).toMatchObject({
      conversationId: CONVERSATION_ID,
      messageId: 10n,
      unreadCount: 2,
    });
    expect(onNotification).toHaveBeenCalledTimes(2);
  });

  it("does not resolve identities for an incomplete live message", async () => {
    const resolveProfiles = vi.fn().mockResolvedValue([]);
    const state = new AccountStateController(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveProfiles,
    );
    const payload = decodeSbp(
      encodeSbp(
        wireMap([
          [0, 10n],
          [1, entityRef("conversation", CONVERSATION_ID)],
          [2, 0],
          [3, entityRef("user", OTHER_USER_ID)],
          [4, "hello"],
          [8, new Date("2026-10-13T20:00:00.000Z")],
          [11, 0],
        ]),
      ),
    );

    await state.applyEvent({
      kind: "event",
      stream: { kind: "conversation", conversationId: CONVERSATION_ID },
      eventId: 21n as never,
      timestamp: new Date("2026-10-13T20:00:00.000Z"),
      opcode: 100,
      payload,
    });

    expect(resolveProfiles).not.toHaveBeenCalled();
    expect(state.state.users.has(OTHER_USER_ID)).toBe(false);
    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(10n as never)?.body,
    ).toBe("hello");
  });

  it("uses an embedded live author without requesting their profile", async () => {
    const resolveProfiles = vi.fn().mockResolvedValue([]);
    const state = new AccountStateController(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveProfiles,
    );

    await state.applyEvent({
      kind: "event",
      stream: { kind: "conversation", conversationId: CONVERSATION_ID },
      eventId: 21n as never,
      timestamp: new Date("2026-10-13T20:00:00.000Z"),
      opcode: 100,
      payload: decodeSbp(
        encodeSbp(
          wireMap([
            [0, 10n],
            [1, entityRef("conversation", CONVERSATION_ID)],
            [2, 0],
            [3, entityRef("user", OTHER_USER_ID)],
            [4, "hello"],
            [8, new Date("2026-10-13T20:00:00.000Z")],
            [11, 0],
            [
              16,
              wireMap([
                [0, entityRef("user", OTHER_USER_ID)],
                [1, "alice"],
                [2, "Alice"],
                [6, 0],
              ]),
            ],
          ]),
        ),
      ),
    });

    expect(
      state.state.messages.get(CONVERSATION_ID)?.get(10n as never)?.author
        ?.displayName,
    ).toBe("Alice");
    expect(resolveProfiles).not.toHaveBeenCalled();
    expect(state.state.users.get(OTHER_USER_ID)?.displayName).toBe("Alice");
  });

  it("does not block later live messages on a pending cache write", async () => {
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = {
      load: vi.fn().mockResolvedValue(undefined),
      put: vi
        .fn()
        .mockImplementationOnce(() => firstWrite)
        .mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const state = new AccountStateController({} as never, cache);
    const event = (id: bigint, eventId: bigint) => ({
      kind: "event" as const,
      stream: {
        kind: "conversation" as const,
        conversationId: CONVERSATION_ID,
      },
      eventId: eventId as never,
      timestamp: new Date("2026-10-13T20:00:00.000Z"),
      opcode: 100,
      payload: decodeSbp(
        encodeSbp(
          wireMap([
            [0, id],
            [1, entityRef("conversation", CONVERSATION_ID)],
            [2, 0],
            [3, entityRef("user", USER_ID)],
            [4, `message ${id}`],
            [8, new Date("2026-10-13T20:00:00.000Z")],
            [11, 0],
          ]),
        ),
      ),
    });

    await state.applyEvent(event(10n, 20n));
    await state.applyEvent(event(11n, 21n));

    expect(state.state.messages.get(CONVERSATION_ID)?.size).toBe(2);
    expect(cache.put).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(2));
  });

  it("deduplicates concurrent user profile resolution", async () => {
    vi.useFakeTimers();
    let release!: (profiles: (typeof profile)[]) => void;
    const resolveProfiles = vi.fn(
      () =>
        new Promise<(typeof profile)[]>((resolve) => {
          release = resolve;
        }),
    );
    const state = new AccountStateController(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveProfiles,
    );

    const first = state.ensureUserProfiles([USER_ID]);
    const second = state.ensureUserProfiles([USER_ID]);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(resolveProfiles).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    release([profile]);
    await Promise.all([first, second]);

    expect(state.state.users.get(USER_ID)).toBe(profile);
    vi.useRealTimers();
  });

  it("batches user profile resolution", async () => {
    vi.useFakeTimers();
    const secondUserId = "22222222-2222-4222-8222-222222222222" as UserId;
    const resolveProfiles = vi.fn().mockResolvedValue([]);
    const state = new AccountStateController(
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      resolveProfiles,
    );

    const first = state.ensureUserProfiles([USER_ID]);
    const second = state.ensureUserProfiles([secondUserId]);
    expect(resolveProfiles).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    await Promise.all([first, second]);

    expect(resolveProfiles).toHaveBeenCalledTimes(1);
    expect(resolveProfiles).toHaveBeenCalledWith([USER_ID, secondUserId]);
    vi.useRealTimers();
  });

  it("emits notifications only for new live inbox events", async () => {
    const snapshots = {
      account: vi.fn().mockResolvedValue(account),
      conversation: vi.fn(),
    };
    const onNotification = vi.fn();
    const state = new AccountStateController(
      snapshots,
      undefined,
      undefined,
      undefined,
      onNotification,
    );
    await state.loadAccount();
    expect(onNotification).not.toHaveBeenCalled();

    const event = {
      kind: "event" as const,
      stream: { kind: "account" as const },
      eventId: 21n,
      timestamp: new Date("2026-10-13T20:00:01.000Z"),
      opcode: 30,
      payload: decodeSbp(
        encodeSbp(
          wireMap([
            [0, 21n],
            [1, 1],
            [2, entityRef("conversation", CONVERSATION_ID)],
            [3, 9n],
            [4, entityRef("user", USER_ID)],
            [5, "mentioned you"],
            [6, new Date("2026-10-13T20:00:01.000Z")],
            [7, false],
          ]),
        ),
      ),
    };

    await expect(state.applyEvent(event)).resolves.toBe(true);
    await expect(state.applyEvent(event)).resolves.toBe(false);

    expect(onNotification).toHaveBeenCalledOnce();
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mention", preview: "mentioned you" }),
    );
  });

  it("merges older history into authoritative conversation state", async () => {
    const state = new AccountStateController({} as never);
    const newerId = orderedId<"message">(20n);
    const olderId = orderedId<"message">(10n);
    await state.mergeHistory({
      conversationId: CONVERSATION_ID,
      messages: [message(newerId, "newer")],
      profiles: [],
      reachedBeginning: false,
      reachedPresent: true,
      olderBefore: newerId,
    });
    await state.mergeHistory({
      conversationId: CONVERSATION_ID,
      messages: [message(olderId, "older")],
      profiles: [],
      reachedBeginning: true,
      reachedPresent: false,
    });

    expect([
      ...(state.state.messages.get(CONVERSATION_ID)?.keys() ?? []),
    ]).toEqual([newerId, olderId]);
    expect(state.state.reachedBeginning.get(CONVERSATION_ID)).toBe(true);
  });

  it("hydrates cached history before merging the latest server window", async () => {
    const cached = message(orderedId<"message">(1n), "cached");
    const latest = message(orderedId<"message">(20n), "latest");
    const cache = {
      load: vi.fn().mockResolvedValue({
        messages: [cached],
        reachedBeginning: true,
      }),
      put: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const snapshots = {
      account: vi.fn(),
      conversation: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        conversation,
        messages: [latest],
        profiles: [],
        reachedBeginning: false,
      }),
    };
    const state = new AccountStateController(snapshots, cache);

    await state.loadConversation(CONVERSATION_ID);

    expect([...state.state.messages.get(CONVERSATION_ID)!.values()]).toEqual([
      cached,
      latest,
    ]);
    expect(state.state.reachedBeginning.get(CONVERSATION_ID)).toBe(true);
    expect(cache.put).toHaveBeenCalledWith(CONVERSATION_ID, [latest], {
      reachedBeginning: true,
    });
  });

  it("reconciles stale inbox entries through a conversation read event", async () => {
    const readThrough = orderedId<"message">(10n);
    const notificationId = orderedId<"notification">(20n);
    const snapshots = {
      account: vi.fn().mockResolvedValue({
        ...account,
        inbox: [
          {
            id: notificationId,
            kind: "unread" as const,
            conversationId: CONVERSATION_ID,
            messageId: orderedId<"message">(9n),
            createdAt: "2026-10-13T20:00:00.000Z",
            read: false,
          },
        ],
      }),
      conversation: vi.fn(),
    };
    const state = new AccountStateController(snapshots);
    await state.loadAccount();

    await state.applyEvent({
      kind: "event",
      stream: { kind: "account" },
      eventId: 30n,
      timestamp: new Date("2026-10-13T20:00:01.000Z"),
      opcode: 104,
      payload: decodeSbp(
        encodeSbp(
          wireMap([
            [0, entityRef("conversation", CONVERSATION_ID)],
            [1, entityRef("user", USER_ID)],
            [2, readThrough],
          ]),
        ),
      ),
    });

    expect(
      state.state.conversations.get(CONVERSATION_ID)?.readThroughMessageId,
    ).toBe(readThrough);
    expect(state.state.inbox.get(notificationId)?.read).toBe(true);
  });
});

function message(id: ReturnType<typeof orderedId<"message">>, body: string) {
  return {
    id,
    conversationId: CONVERSATION_ID,
    kind: "user" as const,
    authorId: USER_ID,
    body,
    outgoing: false,
    timestamp: "2026-10-13T20:00:00.000Z",
    revision: 0,
  };
}
