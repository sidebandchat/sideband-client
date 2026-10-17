import { describe, expect, it, vi } from "vitest";
import { entityId, orderedId } from "../entity-id.js";
import { initialAccountState } from "../client/state.js";
import { RepliesController } from "./replies-controller.js";

const CONVERSATION_ID = entityId<"conversation">(
  "11111111-1111-4111-8111-111111111111",
);
const MESSAGE_ID = orderedId<"message">(10n);

describe("RepliesController", () => {
  it("uses authoritative messages for previews without a request", async () => {
    const message = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      kind: "user" as const,
      body: "hello",
      outgoing: false,
      timestamp: "2026-10-13T00:00:00Z",
      revision: 1,
    };
    const account = {
      ...initialAccountState(),
      messages: new Map([[CONVERSATION_ID, new Map([[MESSAGE_ID, message]])]]),
    };
    const messaging = { context: vi.fn() };
    const replies = new RepliesController(messaging as never, () => account);

    expect(await replies.loadPreview(CONVERSATION_ID, MESSAGE_ID)).toEqual({
      messageId: MESSAGE_ID,
      authorId: undefined,
      text: "hello",
      unavailable: false,
    });
    expect(messaging.context).not.toHaveBeenCalled();
  });

  it("owns and expands a focused context window", async () => {
    const messaging = {
      context: vi
        .fn()
        .mockResolvedValueOnce({
          conversationId: CONVERSATION_ID,
          messages: [],
          reachedBeginning: false,
          reachedPresent: false,
          olderBefore: orderedId<"message">(9n),
          newerAfter: orderedId<"message">(11n),
        })
        .mockResolvedValueOnce({
          conversationId: CONVERSATION_ID,
          messages: [],
          reachedBeginning: true,
          reachedPresent: false,
        }),
    };
    const replies = new RepliesController(messaging as never, () => undefined);

    await replies.open(CONVERSATION_ID, MESSAGE_ID);
    await replies.loadOlder();

    expect(messaging.context).toHaveBeenNthCalledWith(
      1,
      CONVERSATION_ID,
      MESSAGE_ID,
      30,
      30,
    );
    expect(messaging.context).toHaveBeenNthCalledWith(
      2,
      CONVERSATION_ID,
      MESSAGE_ID,
      25,
      0,
      { olderBefore: orderedId<"message">(9n) },
    );
  });

  it("pages newer context from its independent forward cursor", async () => {
    const messaging = {
      context: vi
        .fn()
        .mockResolvedValueOnce({
          conversationId: CONVERSATION_ID,
          messages: [],
          reachedBeginning: false,
          reachedPresent: false,
          olderBefore: orderedId<"message">(9n),
          newerAfter: orderedId<"message">(11n),
        })
        .mockResolvedValueOnce({
          conversationId: CONVERSATION_ID,
          messages: [],
          reachedBeginning: false,
          reachedPresent: true,
        }),
    };
    const replies = new RepliesController(messaging as never, () => undefined);

    await replies.open(CONVERSATION_ID, MESSAGE_ID);
    await replies.loadNewer();

    expect(messaging.context).toHaveBeenNthCalledWith(
      2,
      CONVERSATION_ID,
      MESSAGE_ID,
      0,
      25,
      { newerAfter: orderedId<"message">(11n) },
    );
    expect(replies.state?.reachedPresent).toBe(true);
  });

  it("caches a fetched preview and notifies subscribers", async () => {
    const message = {
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      kind: "user" as const,
      body: "loaded from context",
      outgoing: false,
      timestamp: "2026-10-13T00:00:00Z",
      revision: 1,
    };
    const messaging = {
      context: vi.fn().mockResolvedValue({ messages: [message] }),
    };
    const replies = new RepliesController(messaging as never, () => undefined);
    const listener = vi.fn();
    replies.subscribe(listener);

    const initialVersion = replies.previewsVersion;
    await replies.loadPreview(CONVERSATION_ID, MESSAGE_ID);

    expect(replies.get(CONVERSATION_ID, MESSAGE_ID)?.text).toBe(
      "loaded from context",
    );
    expect(replies.previewsVersion).toBe(initialVersion + 1);
    expect(listener).toHaveBeenCalledOnce();
  });
});
