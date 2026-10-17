import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeRequestRef, entityRef, requestRef } from "../sbp/codec.js";
import { SbpPrivateConversationsClient } from "./private-conversations-client.js";

const sessionId = entityId<"private-conversation">(
  "11111111-1111-4111-8111-111111111111",
);
const transferId = entityId<"private-transfer">(
  "22222222-2222-4222-8222-222222222222",
);
const userId = entityId<"user">("33333333-3333-4333-8333-333333333333");
describe("SbpPrivateConversationsClient", () => {
  it("starts a session with an opaque encrypted offer", async () => {
    const command = vi.fn().mockResolvedValue(sessionRecord());
    const client = new SbpPrivateConversationsClient({ command });
    const offer = new Uint8Array([8, 9]);
    const session = await client.start(userId, offer);
    expect(command.mock.calls[0]![0]).toBe(420);
    expect(command.mock.calls[0]![1].get(1)).toStrictEqual(offer);
    expect(session).toMatchObject({ id: sessionId, state: "ringing" });
  });

  it("keeps transfer identity as a UUID rather than an entity reference", async () => {
    const command = vi.fn().mockResolvedValue(transferRecord());
    const client = new SbpPrivateConversationsClient({ command });
    const transfer = await client.offerTransfer({
      privateConversationId: sessionId,
      byteSize: 45,
    });
    expect(transfer.id).toBe(transferId);
    expect(command.mock.calls[0]![1]).toEqual(
      new Map([
        [0, entityRef("private-conversation", sessionId)],
        [1, 45],
      ]),
    );

    command.mockResolvedValue(
      new Map([
        [0, new Uint8Array(32)],
        [1, new Date("2026-01-01T00:01:00Z")],
        [2, "transfer-room"],
      ]),
    );
    await client.admitTransfer(sessionId, transferId);
    expect(decodeRequestRef(command.mock.calls[1]![1].get(1))).toBe(transferId);
  });

  it("maps private and transfer actions to closed values", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(transferRecord());
    const client = new SbpPrivateConversationsClient({ command });
    await client.signal(sessionId, new Uint8Array([1]));
    await client.actOnTransfer(sessionId, transferId, "cancel");
    expect(command.mock.calls[0]![1].get(1)).toBe(3);
    expect(command.mock.calls[1]![1].get(2)).toBe(3);
  });
});

function sessionRecord() {
  return new Map([
    [0, entityRef("private-conversation", sessionId)],
    [1, entityRef("user", userId)],
    [2, entityRef("user", userId)],
    [3, 0],
    [4, new Date("2026-01-01T00:00:00Z")],
  ]);
}

function transferRecord() {
  return new Map([
    [0, requestRef(transferId)],
    [1, entityRef("private-conversation", sessionId)],
    [2, entityRef("user", userId)],
    [3, 45],
    [4, 0],
  ]);
}
