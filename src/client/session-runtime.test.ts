import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { entityRef, requestRef } from "../sbp/codec.js";
import type { SbpFrame } from "../sbp/frame.js";
import { SessionRuntime } from "./session-runtime.js";

const ENDPOINT = { domain: "example.test", baseUrl: "https://example.test" };

describe("SessionRuntime", () => {
  it("serializes ending a private conversation before accepting a call", async () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeEvents: vi.fn(() => () => {}),
      subscribeControls: vi.fn((listener) => {
        controls.push(listener);
        return () => {};
      }),
    };
    const order: string[] = [];
    const calls = {
      join: vi.fn(async () => {
        order.push("join-call");
      }),
    };
    const privateConversations = {
      end: vi.fn(async () => {
        order.push("end-private");
      }),
    };
    const userId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const runtime = new SessionRuntime(
      session as never,
      calls as never,
      privateConversations as never,
      ENDPOINT,
      userId,
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [2, [callRecord(callId, userId)]],
        [3, [privateRecord(privateId, userId)]],
      ]),
    });

    await runtime.acceptCall(callId);

    expect(order).toEqual(["end-private", "join-call"]);
  });

  it("surfaces each encrypted private signal and updates authoritative state", () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeEvents: () => () => {},
      subscribeControls: (
        listener: (frame: Extract<SbpFrame, { kind: "control" }>) => void,
      ) => {
        controls.push(listener);
        return () => {};
      },
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const senderId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    const received = vi.fn();
    runtime.subscribePrivateEvents(received);
    runtime.start();
    const ciphertext = new Uint8Array([4, 5, 6]);
    controls[0]!({
      kind: "control",
      opcode: 420,
      payload: new Map([
        [0, entityRef("private-conversation", privateId)],
        [1, entityRef("user", senderId)],
        [2, 3],
        [3, ciphertext],
        [4, 2],
      ]),
    });
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ action: "signal", payload: ciphertext }),
    );
    expect(runtime.state.privateConversations.get(privateId)).toMatchObject({
      peerId: senderId,
      state: "active",
    });
  });

  it("ends an interrupted private conversation instead of restoring it after reconnect", () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const statuses: Array<(status: { state: "offline" }) => void> = [];
    const session = {
      subscribeEvents: () => () => {},
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
      subscribeStatus: (listener: (typeof statuses)[number]) => {
        statuses.push(listener);
        return () => {};
      },
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const privateConversations = { end: vi.fn(async () => {}) };
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      privateConversations as never,
      ENDPOINT,
      ownUserId,
    );
    runtime.start();
    const snapshot = {
      kind: "control" as const,
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [2, []],
        [3, [privateRecord(privateId, ownUserId)]],
      ]),
    };

    controls[0]!(snapshot);
    expect(runtime.privateConversationView().status).toBe("active");

    statuses[0]!({ state: "offline" });
    expect(runtime.privateConversationView().status).toBe("idle");

    controls[0]!(snapshot);
    expect(privateConversations.end).toHaveBeenCalledWith(privateId);
    expect(runtime.privateConversationView().status).toBe("idle");
  });

  it("connects admitted media before acknowledging media readiness", async () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeEvents: () => () => {},
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
    };
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const userId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const order: string[] = [];
    const admission = {
      credential: new Uint8Array(32),
      expiresAt: new Date().toISOString(),
      room: "room",
    };
    const calls = {
      join: vi.fn(async () => {
        order.push("join");
      }),
      admit: vi.fn(async () => {
        order.push("admit");
        return admission;
      }),
      mediaConnected: vi.fn(async () => {
        order.push("ready");
      }),
      leave: vi.fn(async () => {
        order.push("leave");
      }),
    };
    const media = {
      state: { participants: [], remoteTracks: [] },
      subscribe: vi.fn(() => () => {}),
      connect: vi.fn(async () => {
        order.push("connect");
      }),
      disconnect: vi.fn(async () => {
        order.push("disconnect");
      }),
      enumerateDevices: vi.fn(async () => []),
      subscribeDevices: vi.fn(() => () => {}),
      setMuted: vi.fn(),
      setDeafened: vi.fn(),
      selectInput: vi.fn(),
      selectOutput: vi.fn(),
      setCameraEnabled: vi.fn(),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      setRemoteVolume: vi.fn(),
    };
    const runtime = new SessionRuntime(
      session as never,
      calls as never,
      {} as never,
      ENDPOINT,
      userId,
      media,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [2, [callRecord(callId, userId)]],
        [3, []],
      ]),
    });
    await runtime.acceptCall(callId);
    expect(order).toEqual(["join", "admit", "connect", "ready"]);
    expect(media.connect).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      localUserId: userId,
      call: runtime.state.calls.get(callId),
      admission,
    });
  });

  it("accepts an incoming private invite through the crypto adapter", async () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeEvents: () => () => {},
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const senderId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const answer = new Uint8Array([9]);
    const handle = {};
    const crypto = {
      createOffer: vi.fn(),
      acceptOffer: vi.fn(async () => ({ payload: answer, handle })),
      receive: vi.fn(async () => ({})),
      encrypt: vi.fn(),
      close: vi.fn(),
    };
    const privateConversations = { accept: vi.fn(async () => {}) };
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      privateConversations as never,
      ENDPOINT,
      ownUserId,
      undefined,
      crypto,
    );
    runtime.start();
    const offer = new Uint8Array([1, 2]);
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [2, []],
        [
          3,
          [
            new Map([
              [0, entityRef("private-conversation", privateId)],
              [1, entityRef("user", senderId)],
              [2, entityRef("user", ownUserId)],
              [3, 0],
              [4, new Date()],
              [6, offer],
            ]),
          ],
        ],
      ]),
    });
    await runtime.acceptPrivateConversation(privateId);
    expect(crypto.acceptOffer).toHaveBeenCalledWith({
      session: runtime.state.privateConversations.get(privateId),
      payload: offer,
    });
    expect(privateConversations.accept).toHaveBeenCalledWith(privateId, answer);
  });

  it("encrypts, signals, and records an outgoing private message", async () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeEvents: () => () => {},
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const peerId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const messageId = entityId<"private-message">(
      "66666666-6666-4666-8666-666666666666",
    );
    const handle = {};
    const ciphertext = new Uint8Array([7, 8, 9]);
    const crypto = {
      createOffer: vi.fn(async () => ({
        payload: new Uint8Array([1]),
        handle,
      })),
      acceptOffer: vi.fn(),
      receive: vi.fn(async () => ({})),
      encrypt: vi.fn(async () => ciphertext),
      close: vi.fn(),
    };
    const privateConversations = {
      start: vi.fn(async () => ({
        id: privateId,
        initiatorId: ownUserId,
        peerId,
        state: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
      })),
      signal: vi.fn(async () => {}),
    };
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      privateConversations as never,
      ENDPOINT,
      ownUserId,
      undefined,
      crypto,
    );
    runtime.start();
    await runtime.startPrivateConversation(peerId);

    expect(
      await runtime.sendPrivateMessage(
        privateId,
        messageId,
        " hello ",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBe(true);
    expect(privateConversations.signal).toHaveBeenCalledWith(
      privateId,
      ciphertext,
    );
    expect(runtime.state.privateMessages.get(privateId)).toEqual([
      {
        id: messageId,
        privateConversationId: privateId,
        senderId: ownUserId,
        body: "hello",
        timestamp: "2026-01-01T00:00:01.000Z",
        transferIds: [],
      },
    ]);
    expect(runtime.privateConversationView(privateId)).toMatchObject({
      status: "active",
      session: { id: privateId, peerId },
      messages: [{ id: messageId, body: "hello" }],
    });
  });

  it("records decrypted private messages and sends crypto replies", async () => {
    const events: Array<(frame: Extract<SbpFrame, { kind: "event" }>) => void> =
      [];
    const session = {
      subscribeEvents: (listener: (typeof events)[number]) => {
        events.push(listener);
        return () => {};
      },
      subscribeControls: () => () => {},
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const peerId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const messageId = entityId<"private-message">(
      "66666666-6666-4666-8666-666666666666",
    );
    const handle = {};
    const reply = new Uint8Array([5]);
    const crypto = {
      createOffer: vi.fn(async () => ({
        payload: new Uint8Array([1]),
        handle,
      })),
      acceptOffer: vi.fn(),
      receive: vi.fn(async () => ({
        outbound: [reply],
        messages: [
          {
            id: messageId,
            body: "secret",
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        ],
      })),
      encrypt: vi.fn(),
      close: vi.fn(),
    };
    const privateConversations = {
      start: vi.fn(async () => ({
        id: privateId,
        initiatorId: ownUserId,
        peerId,
        state: "ringing",
        startedAt: "2026-01-01T00:00:00.000Z",
      })),
      signal: vi.fn(async () => {}),
    };
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      privateConversations as never,
      ENDPOINT,
      ownUserId,
      undefined,
      crypto,
    );
    runtime.start();
    await runtime.startPrivateConversation(peerId);
    events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date("2026-01-01T00:00:01.000Z"),
      opcode: 420,
      payload: new Map([
        [0, entityRef("private-conversation", privateId)],
        [1, entityRef("user", peerId)],
        [2, 3],
        [3, new Uint8Array([4])],
        [4, 2],
      ]),
    });

    await vi.waitFor(() =>
      expect(privateConversations.signal).toHaveBeenCalledWith(
        privateId,
        reply,
      ),
    );
    expect(runtime.state.privateMessages.get(privateId)?.[0]).toMatchObject({
      id: messageId,
      senderId: peerId,
      body: "secret",
    });
  });

  it("connects both transfer participants after acceptance", async () => {
    const events: Array<(frame: Extract<SbpFrame, { kind: "event" }>) => void> =
      [];
    const session = {
      subscribeEvents: (listener: (typeof events)[number]) => {
        events.push(listener);
        return () => {};
      },
      subscribeControls: () => () => {},
    };
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const privateId = entityId<"private-conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const peerId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const transferId = entityId<"private-transfer">(
      "55555555-5555-4555-8555-555555555555",
    );
    const admission = {
      credential: new Uint8Array(32),
      expiresAt: new Date().toISOString(),
      room: "transfer-room",
    };
    const privateConversations = {
      start: vi.fn(async () => ({
        id: privateId,
        initiatorId: ownUserId,
        peerId,
        state: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
      })),
      signal: vi.fn(async () => {}),
      admitTransfer: vi.fn(async () => admission),
      actOnTransfer: vi.fn(),
    };
    const handle = {};
    const crypto = {
      createOffer: vi.fn(async () => ({
        payload: new Uint8Array([1]),
        handle,
      })),
      acceptOffer: vi.fn(),
      receive: vi.fn(async () => ({
        transferOffers: [
          {
            transferId,
            filename: "file.bin",
            mediaType: "application/octet-stream",
            byteSize: 12,
            sha256: new Uint8Array(32),
            key: new Uint8Array(32),
          },
        ],
      })),
      encrypt: vi.fn(),
      close: vi.fn(),
    };
    const transferAdapter = {
      prepare: vi.fn(),
      registerSource: vi.fn(),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      showInFolder: vi.fn(async () => {}),
    };
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      privateConversations as never,
      ENDPOINT,
      ownUserId,
      undefined,
      crypto,
      transferAdapter,
    );
    runtime.start();
    await runtime.startPrivateConversation(peerId);
    events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date(),
      opcode: 420,
      payload: new Map([
        [0, entityRef("private-conversation", privateId)],
        [1, entityRef("user", peerId)],
        [2, 3],
        [3, new Uint8Array([7])],
        [4, 2],
      ]),
    });
    await vi.waitFor(() => expect(crypto.receive).toHaveBeenCalled());
    events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date(),
      opcode: 422,
      payload: new Map([
        [0, requestRef(transferId)],
        [1, entityRef("private-conversation", privateId)],
        [2, entityRef("user", ownUserId)],
        [3, 12],
        [4, 1],
      ]),
    });
    await vi.waitFor(() => expect(transferAdapter.connect).toHaveBeenCalled());
    expect(transferAdapter.connect).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT }),
    );
    expect(privateConversations.admitTransfer).toHaveBeenCalledWith(
      privateId,
      transferId,
    );
    expect(runtime.state.transfers.get(transferId)?.state).toBe("transferring");
  });
});

function callRecord(
  callId: ReturnType<typeof entityId<"call">>,
  userId: ReturnType<typeof entityId<"user">>,
) {
  return new Map([
    [0, entityRef("call", callId)],
    [1, [0, entityRef("user", userId)]],
    [2, entityRef("user", userId)],
    [3, 0],
    [4, 0],
    [5, new Date()],
    [7, []],
  ]);
}

function privateRecord(
  id: ReturnType<typeof entityId<"private-conversation">>,
  userId: ReturnType<typeof entityId<"user">>,
) {
  return new Map([
    [0, entityRef("private-conversation", id)],
    [1, entityRef("user", userId)],
    [2, entityRef("user", userId)],
    [3, 2],
    [4, new Date()],
  ]);
}
