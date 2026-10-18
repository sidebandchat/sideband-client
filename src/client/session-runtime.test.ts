import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { entityRef, requestRef } from "../sbp/codec.js";
import type { SbpFrame } from "../sbp/frame.js";
import { SbpProtocolError } from "../sbp/session.js";
import type { CallMediaEvent } from "./platform-adapters.js";
import { SessionRuntime } from "./session-runtime.js";

const ENDPOINT = { domain: "example.test", baseUrl: "https://example.test" };

describe("SessionRuntime", () => {
  it("replaces the scoped community call roster and hydrates its participants", () => {
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
    const channelId = entityId<"channel">(
      "55555555-5555-4555-8555-555555555555",
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const onCallUsers = vi.fn();
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      {} as never,
      ENDPOINT,
      ownUserId,
      undefined,
      undefined,
      undefined,
      undefined,
      { onCallUsers },
    );
    runtime.start();

    controls[0]!({
      kind: "control",
      opcode: 45,
      payload: new Map([
        [0, null],
        [1, [channelCallRecord(callId, channelId, ownUserId, peerId)]],
      ]),
    });

    expect(runtime.state.calls.get(callId)?.target).toEqual({
      kind: "channel",
      channelId,
    });
    expect(onCallUsers).toHaveBeenCalledWith([peerId]);

    controls[0]!({
      kind: "control",
      opcode: 45,
      payload: new Map([
        [0, null],
        [1, []],
      ]),
    });
    expect(runtime.state.calls.has(callId)).toBe(false);
  });

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

  it("keeps the active call current while exposing a separate incoming call", () => {
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
    const firstPeer = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const secondPeer = entityId<"user">("55555555-5555-4555-8555-555555555555");
    const currentId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const incomingId = entityId<"call">("22222222-2222-4222-8222-222222222222");
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [
          2,
          [
            callRecord(currentId, firstPeer, ownUserId, 2, 2, ownUserId),
            callRecord(incomingId, ownUserId, secondPeer, 0, 1),
          ],
        ],
        [3, []],
      ]),
    });

    expect(runtime.callView().current?.id).toBe(currentId);
    expect(runtime.callView().incoming?.id).toBe(incomingId);
    expect(runtime.state.currentCallId).toBe(currentId);
  });

  it("filters terminal calls and emits structured lifecycle changes", () => {
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
    const conversationId = entityId<"conversation">(
      "77777777-7777-4777-8777-777777777777",
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    const events = vi.fn();
    runtime.subscribeCallEvents(events);
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [2, [conversationCallRecord(callId, conversationId, ownUserId, 2)]],
        [3, []],
      ]),
    });
    expect(runtime.callView().joinable.has(callId)).toBe(true);

    controls[0]!({
      kind: "control",
      opcode: 400,
      payload: conversationCallRecord(callId, conversationId, ownUserId, 5),
    });

    expect(runtime.callView().joinable.has(callId)).toBe(false);
    expect(runtime.callView().current).toBeUndefined();
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: "call-ended" }),
    );
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ type: "current-changed", call: undefined }),
    );
  });

  it("exposes group proposal recipients until the session is established", () => {
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
    const pendingUserId = entityId<"user">(
      "44444444-4444-4444-8444-444444444444",
    );
    const secondPendingUserId = entityId<"user">(
      "55555555-5555-4555-8555-555555555555",
    );
    const conversationId = entityId<"conversation">(
      "77777777-7777-4777-8777-777777777777",
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const runtime = new SessionRuntime(
      session as never,
      {} as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [
          2,
          [
            conversationCallRecord(callId, conversationId, ownUserId, 1, {
              participants: [
                [ownUserId, 3],
                [pendingUserId, 1],
                [secondPendingUserId, 1],
              ],
            }),
          ],
        ],
        [3, []],
      ]),
    });

    expect(runtime.callView()).toMatchObject({
      phase: "proposal",
      pendingParticipantIds: [pendingUserId, secondPendingUserId],
    });

    controls[0]!({
      kind: "control",
      opcode: 400,
      payload: conversationCallRecord(callId, conversationId, ownUserId, 1, {
        participants: [
          [ownUserId, 3],
          [pendingUserId, 4],
          [secondPendingUserId, 1],
        ],
      }),
    });

    expect(runtime.callView()).toMatchObject({
      phase: "proposal",
      pendingParticipantIds: [secondPendingUserId],
    });

    controls[0]!({
      kind: "control",
      opcode: 400,
      payload: conversationCallRecord(callId, conversationId, ownUserId, 2, {
        established: true,
        participants: [
          [ownUserId, 3],
          [pendingUserId, 3],
          [secondPendingUserId, 1],
        ],
      }),
    });

    expect(runtime.callView()).toMatchObject({
      phase: "session",
      pendingParticipantIds: [secondPendingUserId],
    });
  });

  it("keeps a direct caller ringing until the recipient answers", async () => {
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const events: Array<(frame: Extract<SbpFrame, { kind: "event" }>) => void> =
      [];
    const ownUserId = entityId<"user">("33333333-3333-4333-8333-333333333333");
    const peerId = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const call = {
      id: callId,
      target: { kind: "user" as const, userId: peerId },
      originatorId: ownUserId,
      media: "voice" as const,
      state: "ringing" as const,
      startedAt: new Date().toISOString(),
      participants: [
        { userId: ownUserId, state: "joining" as const },
        { userId: peerId, state: "ringing" as const },
      ],
    };
    const session = {
      subscribeEvents: (listener: (typeof events)[number]) => {
        events.push(listener);
        return () => {};
      },
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
      subscribeStatus: () => () => {},
    };
    const calls = {
      start: vi.fn(async () => call),
      join: vi.fn(async () => {}),
      admit: vi.fn(async () => ({
        credential: new Uint8Array(32),
        expiresAt: new Date().toISOString(),
        room: "direct-call",
      })),
      mediaConnected: vi.fn(async () => {}),
      leave: vi.fn(async () => {}),
    };
    const mediaEvents: Array<(event: CallMediaEvent) => void> = [];
    const media = {
      state: { participants: [], remoteTracks: [] },
      subscribe: vi.fn(() => () => {}),
      subscribeEvents: vi.fn((listener: (typeof mediaEvents)[number]) => {
        mediaEvents.push(listener);
        return () => {};
      }),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
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
      ownUserId,
      media,
    );
    runtime.start();

    await runtime.startCall({ kind: "user", userId: peerId }, "voice");
    expect(runtime.callView().connection).toBe("ringing");
    expect(media.connect).not.toHaveBeenCalled();

    events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date(),
      opcode: 401,
      payload: new Map([
        [0, entityRef("call", callId)],
        [1, entityRef("user", peerId)],
        [2, 3],
      ]),
    });

    await vi.waitFor(() => expect(media.connect).toHaveBeenCalledOnce());
    expect(runtime.callView().connection).toBe("active");
  });

  it("joins an existing group call instead of starting a competing call", async () => {
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
    const originatorId = entityId<"user">(
      "44444444-4444-4444-8444-444444444444",
    );
    const conversationId = entityId<"conversation">(
      "77777777-7777-4777-8777-777777777777",
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const calls = {
      start: vi.fn(),
      join: vi.fn(async () => {}),
    };
    const runtime = new SessionRuntime(
      session as never,
      calls as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [
          2,
          [
            conversationCallRecord(callId, conversationId, originatorId, 1, {
              established: true,
              participants: [
                [originatorId, 3],
                [ownUserId, 1],
              ],
            }),
          ],
        ],
        [3, []],
      ]),
    });

    const result = await runtime.beginCall(
      { kind: "conversation", conversationId },
      "voice",
    );

    expect(result.id).toBe(callId);
    expect(calls.start).not.toHaveBeenCalled();
    expect(calls.join).toHaveBeenCalledWith(callId);
    expect(runtime.state.currentCallId).toBe(callId);
  });

  it("silently discards a stale group invitation", async () => {
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
    const originatorId = entityId<"user">(
      "44444444-4444-4444-8444-444444444444",
    );
    const conversationId = entityId<"conversation">(
      "77777777-7777-4777-8777-777777777777",
    );
    const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const calls = {
      join: vi.fn(async () => {
        throw new SbpProtocolError(4, "Call ended");
      }),
      leave: vi.fn(),
    };
    const runtime = new SessionRuntime(
      session as never,
      calls as never,
      {} as never,
      ENDPOINT,
      ownUserId,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [
          2,
          [
            conversationCallRecord(callId, conversationId, originatorId, 0, {
              participants: [
                [originatorId, 2],
                [ownUserId, 1],
              ],
            }),
          ],
        ],
        [3, []],
      ]),
    });

    await expect(runtime.acceptCall(callId)).resolves.toBeUndefined();
    expect(runtime.state.calls.has(callId)).toBe(false);
    expect(runtime.callView().connection).toBe("idle");
    expect(calls.leave).not.toHaveBeenCalled();
  });

  it("disconnects and leaves the current call before joining a replacement", async () => {
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
    const firstPeer = entityId<"user">("44444444-4444-4444-8444-444444444444");
    const secondPeer = entityId<"user">("55555555-5555-4555-8555-555555555555");
    const currentId = entityId<"call">("11111111-1111-4111-8111-111111111111");
    const incomingId = entityId<"call">("22222222-2222-4222-8222-222222222222");
    const order: string[] = [];
    const calls = {
      leave: vi.fn(async () => order.push("leave-current")),
      join: vi.fn(async () => order.push("join-incoming")),
      admit: vi.fn(async () => ({
        credential: new Uint8Array(),
        expiresAt: new Date().toISOString(),
        room: "replacement-room",
      })),
      mediaConnected: vi.fn(async () => order.push("media-ready")),
    };
    const media = {
      state: { participants: [], remoteTracks: [] },
      subscribe: vi.fn(() => () => {}),
      connect: vi.fn(async () => order.push("connect-incoming")),
      disconnect: vi.fn(async () => order.push("disconnect-current")),
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
      ownUserId,
      media,
    );
    runtime.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [0, []],
        [1, []],
        [
          2,
          [
            callRecord(currentId, firstPeer, ownUserId, 2, 3, ownUserId),
            callRecord(incomingId, ownUserId, secondPeer, 0, 1),
          ],
        ],
        [3, []],
      ]),
    });

    await runtime.acceptCall(incomingId);

    expect(order).toEqual([
      "disconnect-current",
      "leave-current",
      "join-incoming",
      "connect-incoming",
      "media-ready",
    ]);
    expect(runtime.state.currentCallId).toBe(incomingId);
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

  it("reconnects unexpected media loss with a fresh admission", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();
    fixture.mediaEvents[0]!({ type: "disconnected", callId: fixture.callId });

    await vi.waitFor(() =>
      expect(fixture.media.connect).toHaveBeenCalledTimes(2),
    );
    expect(fixture.calls.admit).toHaveBeenCalledTimes(2);
    expect(fixture.calls.mediaConnected).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.callView().connection).toBe("active");
  });

  it("cleans up the direct call when its initial media join fails", async () => {
    const fixture = callMediaFixture();
    fixture.media.connect.mockRejectedValueOnce(new Error("Microphone denied"));

    await expect(fixture.connect()).rejects.toThrow("Microphone denied");

    expect(fixture.media.disconnect).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.calls.leave).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.runtime.callView().connection).toBe("idle");
    expect(fixture.runtime.callView().current).toBeUndefined();
  });

  it("leaves after media reconnection is exhausted", async () => {
    const onError = vi.fn();
    const fixture = callMediaFixture({ reconnectAttempts: 2, onError });
    await fixture.connect();
    fixture.media.connect.mockRejectedValue(new Error("media unavailable"));
    fixture.mediaEvents[0]!({ type: "disconnected", callId: fixture.callId });

    await vi.waitFor(() => expect(fixture.calls.leave).toHaveBeenCalled());
    expect(fixture.calls.admit).toHaveBeenCalledTimes(3);
    expect(fixture.runtime.callView()).toMatchObject({ connection: "idle" });
    expect(fixture.runtime.callView().current).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The call could not be reconnected.",
      }),
    );
  });

  it.each([
    ["replaced", "This call was opened in another Sideband window."],
    ["authorization_revoked", "You no longer have access to this call."],
    [
      "policy_violation",
      "The call was ended because of invalid media activity.",
    ],
  ] as const)("does not reconnect after %s", async (reason, message) => {
    const onError = vi.fn();
    const fixture = callMediaFixture({ onError });
    await fixture.connect();
    fixture.mediaEvents[0]!({
      type: "disconnected",
      callId: fixture.callId,
      reason,
    });

    await vi.waitFor(() => expect(fixture.calls.leave).toHaveBeenCalled());
    expect(fixture.calls.admit).toHaveBeenCalledOnce();
    expect(fixture.runtime.callView().connection).toBe("idle");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message }));
  });

  it("tears down the selected call when its media room ends", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();
    fixture.mediaEvents[0]!({ type: "room-ended", callId: fixture.callId });

    await vi.waitFor(() => expect(fixture.calls.leave).toHaveBeenCalled());
    expect(fixture.runtime.callView().connection).toBe("idle");
    expect(fixture.runtime.callView().current).toBeUndefined();
  });

  it("tears down media when an authoritative call update ends the call", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();
    fixture.events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date(),
      opcode: 400,
      payload: callRecord(
        fixture.callId,
        fixture.ownUserId,
        fixture.peerId,
        3,
        5,
        fixture.ownUserId,
      ),
    });

    expect(fixture.media.disconnect).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.runtime.callView().connection).toBe("idle");
    expect(fixture.runtime.callView().current).toBeUndefined();
  });

  it("tears down media when the local participant loses call access", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();
    fixture.events[0]!({
      kind: "event",
      stream: { kind: "account" },
      eventId: 1n,
      timestamp: new Date(),
      opcode: 400,
      payload: callRecord(
        fixture.callId,
        fixture.ownUserId,
        fixture.peerId,
        2,
        5,
        fixture.ownUserId,
      ),
    });

    expect(fixture.media.disconnect).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.runtime.callView().connection).toBe("idle");
    expect(fixture.runtime.callView().current).toBeUndefined();
  });

  it("tears down calls on account disconnect without a private session", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();
    fixture.statuses[0]!({ state: "offline" });

    expect(fixture.media.disconnect).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.runtime.state.calls.size).toBe(0);
    expect(fixture.runtime.callView().connection).toBe("idle");
  });

  it("tears down media and subscriptions when the account runtime stops", async () => {
    const fixture = callMediaFixture();
    await fixture.connect();

    fixture.runtime.stop();

    expect(fixture.media.disconnect).toHaveBeenCalledWith(fixture.callId);
    expect(fixture.runtime.state.calls.size).toBe(0);
    expect(fixture.runtime.callView().connection).toBe("idle");
  });
});

function callMediaFixture(
  options: {
    reconnectAttempts?: number;
    onError?: (reason: unknown) => void;
  } = {},
) {
  const controls: Array<
    (frame: Extract<SbpFrame, { kind: "control" }>) => void
  > = [];
  const events: Array<(frame: Extract<SbpFrame, { kind: "event" }>) => void> =
    [];
  const mediaEvents: Array<(event: CallMediaEvent) => void> = [];
  const statuses: Array<(status: { state: "offline" }) => void> = [];
  const session = {
    subscribeEvents: (listener: (typeof events)[number]) => {
      events.push(listener);
      return () => {};
    },
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
  const peerId = entityId<"user">("44444444-4444-4444-8444-444444444444");
  const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
  const calls = {
    join: vi.fn(async () => {}),
    admit: vi.fn(async () => ({
      credential: new Uint8Array(32),
      expiresAt: new Date().toISOString(),
      room: "call-room",
    })),
    mediaConnected: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
  };
  const media = {
    state: { participants: [], remoteTracks: [] },
    subscribe: vi.fn(() => () => {}),
    subscribeEvents: vi.fn((listener: (typeof mediaEvents)[number]) => {
      mediaEvents.push(listener);
      return () => {};
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
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
    ownUserId,
    media,
    undefined,
    undefined,
    undefined,
    {
      reconnectAttempts: options.reconnectAttempts,
      reconnectDelay: async () => {},
      onError: options.onError,
    },
  );
  runtime.start();
  controls[0]!({
    kind: "control",
    opcode: 38,
    payload: new Map([
      [0, []],
      [1, []],
      [2, [callRecord(callId, ownUserId, peerId, 0, 1, ownUserId)]],
      [3, []],
    ]),
  });
  return {
    runtime,
    calls,
    media,
    mediaEvents,
    events,
    statuses,
    callId,
    ownUserId,
    peerId,
    connect: () => runtime.acceptCall(callId),
  };
}

function callRecord(
  callId: ReturnType<typeof entityId<"call">>,
  targetUserId: ReturnType<typeof entityId<"user">>,
  originatorId = targetUserId,
  callState = 0,
  participantState = 2,
  participantUserId = targetUserId,
) {
  return new Map([
    [0, entityRef("call", callId)],
    [1, [0, entityRef("user", targetUserId)]],
    [2, entityRef("user", originatorId)],
    [3, 0],
    [4, callState],
    [5, new Date()],
    [
      7,
      [
        new Map([
          [0, entityRef("user", participantUserId)],
          [1, participantState],
        ]),
      ],
    ],
  ]);
}

function conversationCallRecord(
  callId: ReturnType<typeof entityId<"call">>,
  conversationId: ReturnType<typeof entityId<"conversation">>,
  userId: ReturnType<typeof entityId<"user">>,
  callState: number,
  options: {
    established?: boolean;
    participants?: Array<
      readonly [ReturnType<typeof entityId<"user">>, number]
    >;
  } = {},
) {
  const record = new Map<number, unknown>([
    [0, entityRef("call", callId)],
    [1, [1, entityRef("conversation", conversationId)]],
    [2, entityRef("user", userId)],
    [3, 0],
    [4, callState],
    [5, new Date()],
    [
      7,
      (options.participants ?? [[userId, 3]]).map(
        ([participantUserId, state]) =>
          new Map([
            [0, entityRef("user", participantUserId)],
            [1, state],
          ]),
      ),
    ],
  ]);
  if (options.established) record.set(9, new Date());
  return record;
}

function channelCallRecord(
  callId: ReturnType<typeof entityId<"call">>,
  channelId: ReturnType<typeof entityId<"channel">>,
  originatorId: ReturnType<typeof entityId<"user">>,
  participantId: ReturnType<typeof entityId<"user">>,
) {
  return new Map([
    [0, entityRef("call", callId)],
    [1, [2, entityRef("channel", channelId)]],
    [2, entityRef("user", originatorId)],
    [3, 0],
    [4, 1],
    [5, new Date()],
    [
      7,
      [
        new Map([
          [0, entityRef("user", participantId)],
          [1, 3],
          [2, new Date()],
        ]),
      ],
    ],
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
