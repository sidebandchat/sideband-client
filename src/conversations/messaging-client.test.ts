import { describe, expect, it, vi } from "vitest";
import { Tag } from "cbor-x";
import { entityId, orderedId } from "../entity-id.js";
import { decodeEntityRef, entityRef } from "../sbp/codec.js";
import { SbpMessagingClient } from "./messaging-client.js";
import type { AccountStateController } from "../client/state.js";

const conversationId = entityId<"conversation">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = entityId<"user">("22222222-2222-4222-8222-222222222222");

describe("SbpMessagingClient", () => {
  it("projects a send immediately and reconciles it with the authoritative response", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const commandWithHandle = vi.fn(() => ({
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      response,
    }));
    const state = {
      state: { ownUserId: userId },
      addPendingMessage: vi.fn(),
      confirmPendingMessage: vi.fn().mockResolvedValue(undefined),
      failPendingMessage: vi.fn(),
    } as unknown as AccountStateController;
    const client = new SbpMessagingClient(
      { command: vi.fn(), commandWithHandle },
      undefined,
      state,
    );

    const sending = client.send({ conversationId, text: "hello" });

    expect(state.addPendingMessage).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        conversationId,
        body: "hello",
        pending: {
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          state: "sending",
        },
      }),
    );
    expect(state.confirmPendingMessage).not.toHaveBeenCalled();

    resolveResponse?.(messageRecord());
    await expect(sending).resolves.toBe(7n);
    expect(state.confirmPendingMessage).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ id: 7n, body: "hello" }),
    );
  });

  it("keeps rejected sends available for retry with the same request ID", async () => {
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const commandWithHandle = vi
      .fn()
      .mockReturnValueOnce({
        requestId,
        response: Promise.reject(new Error("offline")),
      })
      .mockReturnValueOnce({
        requestId,
        response: Promise.resolve(messageRecord()),
      });
    const state = {
      state: { ownUserId: userId },
      addPendingMessage: vi.fn(),
      failPendingMessage: vi.fn(),
      markPendingMessageSending: vi.fn(),
      confirmPendingMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as AccountStateController;
    const client = new SbpMessagingClient(
      { command: vi.fn(), commandWithHandle },
      undefined,
      state,
    );

    await expect(
      client.send({ conversationId, text: "hello" }),
    ).rejects.toThrow("offline");
    expect(state.failPendingMessage).toHaveBeenCalledWith(
      requestId,
      expect.any(Error),
    );

    await expect(client.retry(requestId)).resolves.toBe(7n);
    expect(commandWithHandle).toHaveBeenLastCalledWith(
      100,
      expect.any(Map),
      requestId,
    );
    expect(state.markPendingMessageSending).toHaveBeenCalledWith(requestId);
  });

  it("encodes a message send using domain IDs", async () => {
    const command = vi.fn().mockResolvedValue(messageRecord());
    const client = new SbpMessagingClient({ command });

    const message = await client.send({
      conversationId,
      text: "hello",
      mentions: [{ userId, begin: 0, end: 5 }],
    });

    expect(command).toHaveBeenCalledOnce();
    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(100);
    expect(decodeEntityRef(payload.get(0), "conversation")).toBe(
      conversationId,
    );
    expect(payload.get(1)).toBe("hello");
    expect(decodeEntityRef(payload.get(5)[0].get(0), "user")).toBe(userId);
    expect(message).toBe(7n);
  });

  it("encodes attachments and mentions in the same message", async () => {
    const command = vi.fn().mockResolvedValue(messageRecord());
    const client = new SbpMessagingClient({ command });
    const attachmentId = entityId<"attachment">(
      "33333333-3333-4333-8333-333333333333",
    );

    await client.send({
      conversationId,
      text: "@Alice see this",
      attachmentIds: [attachmentId],
      mentions: [{ userId, begin: 0, end: 6 }],
    });

    const [, payload] = command.mock.calls[0]!;
    expect(decodeEntityRef(payload.get(3)[0], "attachment")).toBe(attachmentId);
    expect(decodeEntityRef(payload.get(5)[0].get(0), "user")).toBe(userId);
  });

  it("rejects contentless sends before touching the transport", async () => {
    const command = vi.fn();
    const client = new SbpMessagingClient({ command });
    await expect(client.send({ conversationId, text: "  " })).rejects.toThrow(
      "must contain",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("sends a community invitation as a first-class message", async () => {
    const command = vi.fn().mockResolvedValue(messageRecord());
    const client = new SbpMessagingClient({ command });

    await client.sendInvitation(conversationId, "invite-token");

    expect(command).toHaveBeenCalledWith(
      113,
      new Map([
        [0, entityRef("conversation", conversationId)],
        [1, "invite-token"],
      ]),
    );
  });

  it("omits empty optional attachment and mention collections", async () => {
    const command = vi.fn().mockResolvedValue(messageRecord());
    const client = new SbpMessagingClient({ command });

    await client.send({
      conversationId,
      text: "hello",
      attachmentIds: [],
      mentions: [],
    });

    const [, payload] = command.mock.calls[0]!;
    expect(payload.has(3)).toBe(false);
    expect(payload.has(5)).toBe(false);
  });

  it("does not resend an acknowledged conversation read position", async () => {
    const command = vi
      .fn()
      .mockResolvedValue(new Map([[0, orderedId<"message">(10n)]]));
    const client = new SbpMessagingClient({ command });

    await expect(
      client.markRead(conversationId, orderedId<"message">(10n)),
    ).resolves.toBe(10n);
    await expect(
      client.markRead(conversationId, orderedId<"message">(10n)),
    ).resolves.toBe(10n);
    await expect(
      client.markRead(conversationId, orderedId<"message">(9n)),
    ).resolves.toBe(10n);

    expect(command).toHaveBeenCalledOnce();
  });

  it("treats a successfully sent message as already read", async () => {
    const command = vi.fn().mockResolvedValue(messageRecord());
    const client = new SbpMessagingClient({ command });

    const messageId = await client.send({ conversationId, text: "hello" });
    await expect(client.markRead(conversationId, messageId)).resolves.toBe(
      messageId,
    );

    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(100, expect.any(Map));
  });

  it("reserves the sent read position before publishing message confirmation", async () => {
    const command = vi.fn(async (opcode: number) => {
      if (opcode === 100) return messageRecord();
      if (opcode === 105) return new Map([[0, orderedId<"message">(7n)]]);
      throw new Error(`Unexpected opcode ${opcode}`);
    });
    const holder: { client?: SbpMessagingClient } = {};
    const state = {
      state: { ownUserId: userId },
      addPendingMessage: vi.fn(),
      confirmPendingMessage: vi.fn(async (_requestId, message) => {
        await holder.client?.markRead(message.conversationId, message.id);
      }),
      failPendingMessage: vi.fn(),
    } as unknown as AccountStateController;
    const client = new SbpMessagingClient({ command }, undefined, state);
    holder.client = client;

    await expect(client.send({ conversationId, text: "hello" })).resolves.toBe(
      7n,
    );

    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(100, expect.any(Map));
  });

  it("notifies realtime state after a successful send only", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(messageRecord())
      .mockRejectedValueOnce(new Error("rejected"));
    const onMessageSent = vi.fn();
    const client = new SbpMessagingClient({ command }, onMessageSent);

    await client.send({ conversationId, text: "first" });
    await expect(
      client.send({ conversationId, text: "second" }),
    ).rejects.toThrow("rejected");

    expect(onMessageSent).toHaveBeenCalledOnce();
    expect(onMessageSent).toHaveBeenCalledWith(conversationId);
  });

  it("coalesces concurrent acknowledgements and retries a failed one", async () => {
    let resolveCommand: ((value: Map<number, unknown>) => void) | undefined;
    const command = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Map<number, unknown>>((resolve) => {
            resolveCommand = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Map([[0, orderedId<"message">(11n)]]));
    const client = new SbpMessagingClient({ command });

    const first = client.markRead(conversationId, orderedId<"message">(10n));
    await expect(
      client.markRead(conversationId, orderedId<"message">(10n)),
    ).resolves.toBe(10n);
    resolveCommand?.(new Map([[0, orderedId<"message">(10n)]]));
    await expect(first).resolves.toBe(10n);

    await expect(
      client.markRead(conversationId, orderedId<"message">(11n)),
    ).rejects.toThrow("offline");
    await expect(
      client.markRead(conversationId, orderedId<"message">(11n)),
    ).resolves.toBe(11n);

    expect(command).toHaveBeenCalledTimes(3);
  });

  it("decodes GIF search results and preserves the signed selection token", async () => {
    const command = vi.fn().mockResolvedValue(
      new Map([
        [
          0,
          [
            new Map([
              [
                0,
                new Map([
                  [0, "klipy"],
                  [1, "reaction"],
                  [2, "Reaction"],
                  [
                    3,
                    new Map([
                      [0, new Tag("https://static.klipy.com/original.gif", 32)],
                      [1, "image/gif"],
                      [2, 640],
                      [3, 360],
                    ]),
                  ],
                  [
                    4,
                    new Map([
                      [0, new Tag("https://static.klipy.com/preview.gif", 32)],
                      [1, "image/gif"],
                      [2, 320],
                      [3, 180],
                    ]),
                  ],
                ]),
              ],
              [1, "signed-selection"],
            ]),
          ],
        ],
        [1, 1],
      ]),
    );
    const client = new SbpMessagingClient({ command });

    await expect(client.searchGifs("hello")).resolves.toEqual([
      {
        id: "reaction",
        title: "Reaction",
        url: "https://static.klipy.com/original.gif",
        width: 640,
        height: 360,
        previewUrl: "https://static.klipy.com/preview.gif",
        previewWidth: 320,
        previewHeight: 180,
        blurhash: undefined,
        selectionToken: "signed-selection",
      },
    ]);
    expect(command).toHaveBeenCalledWith(
      112,
      new Map([
        [0, "hello"],
        [1, 1],
      ]),
    );
  });

  it("loads reactor profiles lazily with offset pagination", async () => {
    const command = vi.fn().mockResolvedValue(
      new Map([
        [
          0,
          [
            new Map([
              [0, entityRef("user", userId)],
              [1, "alice"],
              [2, "Alice"],
              [5, new Date("2026-01-01T00:00:00.000Z")],
              [6, 2],
            ]),
          ],
        ],
        [1, 53],
      ]),
    );
    const client = new SbpMessagingClient({ command });

    await expect(
      client.reactors(conversationId, orderedId<"message">(7), "🔥", {
        offset: 3,
        limit: 50,
      }),
    ).resolves.toEqual({
      users: [
        expect.objectContaining({
          id: userId,
          username: "alice",
          displayName: "Alice",
        }),
      ],
      nextOffset: 53,
    });
    expect(command).toHaveBeenCalledWith(
      114,
      new Map([
        [0, entityRef("conversation", conversationId)],
        [1, orderedId<"message">(7)],
        [2, "🔥"],
        [3, 3],
        [4, 50],
      ]),
    );
  });
});

function messageRecord() {
  return new Map([
    [0, orderedId<"message">(7)],
    [1, entityRef("conversation", conversationId)],
    [2, 0],
    [3, entityRef("user", userId)],
    [4, "hello"],
    [8, new Date("2026-01-01T00:00:00.000Z")],
    [11, 1],
  ]);
}
