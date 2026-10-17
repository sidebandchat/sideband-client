import { afterEach, describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { entityRef, requestRef } from "../sbp/codec.js";
import type { SbpFrame } from "../sbp/frame.js";
import { EphemeralStateController } from "./ephemeral-state.js";

afterEach(() => vi.useRealTimers());

describe("EphemeralStateController", () => {
  it("hydrates session-bound presence and expires activity leases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const controls: Array<
      (frame: Extract<SbpFrame, { kind: "control" }>) => void
    > = [];
    const session = {
      subscribeControls: (listener: (typeof controls)[number]) => {
        controls.push(listener);
        return () => {};
      },
    };
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");
    const deviceId = entityId<"device">("22222222-2222-4222-8222-222222222222");
    const activityId = entityId<"activity">(
      "33333333-3333-4333-8333-333333333333",
    );
    const controller = new EphemeralStateController(session as never);
    controller.start();
    controls[0]!({
      kind: "control",
      opcode: 38,
      payload: new Map([
        [
          0,
          [
            new Map([
              [0, entityRef("user", userId)],
              [1, 1],
              [3, new Date()],
            ]),
          ],
        ],
        [
          1,
          [
            new Map([
              [0, entityRef("user", userId)],
              [1, entityRef("device", deviceId)],
              [
                2,
                new Map([
                  [0, requestRef(activityId)],
                  [1, 0],
                  [2, new Date()],
                  [3, new Date()],
                  [4, new Date(Date.now() + 2_000)],
                  [
                    5,
                    [
                      0,
                      new Map([
                        [0, "Song"],
                        [1, ["Artist"]],
                        [3, 2],
                      ]),
                    ],
                  ],
                ]),
              ],
            ]),
          ],
        ],
        [2, []],
        [3, []],
      ]),
    });
    expect(controller.state.presence.get(userId)?.availability).toBe("online");
    expect(controller.state.activities.size).toBe(1);
    expect(
      [...controller.state.activities.values()][0]?.activity.payload,
    ).toEqual({
      title: "Song",
      artist: "Artist",
      playbackState: "playing",
    });
    vi.advanceTimersByTime(2_001);
    expect(controller.state.presence.get(userId)?.availability).toBe("online");
    expect(controller.state.activities.size).toBe(0);
  });

  it("clears a stuck typing lease locally", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");
    const conversationId = entityId<"conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const controller = new EphemeralStateController(session as never);
    controller.start();
    receive({
      kind: "control",
      opcode: 35,
      payload: new Map([
        [0, entityRef("conversation", conversationId)],
        [1, entityRef("user", userId)],
        [2, true],
        [3, new Date()],
      ]),
    });
    expect(controller.state.typing.get(conversationId)?.has(userId)).toBe(true);
    vi.advanceTimersByTime(15_001);
    expect(controller.state.typing.has(conversationId)).toBe(false);
  });

  it("reports typing users so their identities can be resolved", () => {
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");
    const conversationId = entityId<"conversation">(
      "22222222-2222-4222-8222-222222222222",
    );
    const onTypingUser = vi.fn();
    const controller = new EphemeralStateController(
      session as never,
      undefined,
      onTypingUser,
    );
    controller.start();

    receive({
      kind: "control",
      opcode: 35,
      payload: new Map([
        [0, entityRef("conversation", conversationId)],
        [1, entityRef("user", userId)],
        [2, true],
        [3, new Date()],
        [
          4,
          new Map([
            [0, entityRef("user", userId)],
            [1, "alice"],
            [2, "Alice"],
            [6, 0],
          ]),
        ],
      ]),
    });

    expect(onTypingUser).toHaveBeenCalledWith(userId, {
      id: userId,
      username: "alice",
      displayName: "Alice",
      revision: 0,
    });
  });

  it("forwards server-pushed channel presence changes", () => {
    vi.useFakeTimers();
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const channelId = entityId<"channel">(
      "33333333-3333-4333-8333-333333333333",
    );
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");
    const onCommunityPresence = vi.fn();
    const controller = new EphemeralStateController(
      session as never,
      undefined,
      undefined,
      onCommunityPresence,
    );
    controller.start();

    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [1, []],
        [2, []],
      ]),
    });
    receive({
      kind: "control",
      opcode: 39,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [
          1,
          new Map([
            [0, entityRef("user", userId)],
            [1, 2],
            [3, new Date()],
          ]),
        ],
        [2, 1],
      ]),
    });

    vi.advanceTimersByTime(250);
    expect(onCommunityPresence).toHaveBeenCalledWith(
      channelId,
      new Map([[userId, true]]),
      1,
    );
    expect(controller.state.presence.get(userId)?.availability).toBe("idle");
    controller.stop();
    vi.useRealTimers();
  });

  it("applies batched channel realtime controls", () => {
    vi.useFakeTimers();
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const channelId = entityId<"channel">(
      "33333333-3333-4333-8333-333333333333",
    );
    const firstUserId = entityId<"user">(
      "11111111-1111-4111-8111-111111111111",
    );
    const secondUserId = entityId<"user">(
      "22222222-2222-4222-8222-222222222222",
    );
    const controller = new EphemeralStateController(session as never);
    controller.start();

    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [1, []],
        [2, []],
      ]),
    });
    receive({
      kind: "control",
      opcode: 43,
      payload: [
        [
          39,
          new Map([
            [0, entityRef("channel", channelId)],
            [
              1,
              new Map([
                [0, entityRef("user", firstUserId)],
                [1, 1],
                [3, new Date()],
              ]),
            ],
          ]),
        ],
        [
          39,
          new Map([
            [0, entityRef("channel", channelId)],
            [
              1,
              new Map([
                [0, entityRef("user", secondUserId)],
                [1, 3],
                [3, new Date()],
              ]),
            ],
          ]),
        ],
      ],
    });

    vi.advanceTimersByTime(250);
    expect(controller.state.presence.get(firstUserId)?.availability).toBe(
      "online",
    );
    expect(controller.state.presence.get(secondUserId)?.availability).toBe(
      "dnd",
    );
  });

  it("ignores channel updates queued before the watch was cleared", () => {
    vi.useFakeTimers();
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const channelId = entityId<"channel">(
      "33333333-3333-4333-8333-333333333333",
    );
    const userId = entityId<"user">("11111111-1111-4111-8111-111111111111");
    const controller = new EphemeralStateController(session as never);
    controller.start();

    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [1, []],
        [2, []],
      ]),
    });
    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, null],
        [1, []],
        [2, []],
      ]),
    });
    receive({
      kind: "control",
      opcode: 43,
      payload: [
        [
          39,
          new Map([
            [0, entityRef("channel", channelId)],
            [
              1,
              new Map([
                [0, entityRef("user", userId)],
                [1, 1],
                [3, new Date()],
              ]),
            ],
          ]),
        ],
      ],
    });

    vi.advanceTimersByTime(250);
    expect(controller.state.presence.has(userId)).toBe(false);
  });

  it("replaces channel-scoped presence and activity without clearing global state", () => {
    let receive!: (frame: Extract<SbpFrame, { kind: "control" }>) => void;
    const session = {
      subscribeControls: (listener: typeof receive) => {
        receive = listener;
        return () => {};
      },
    };
    const globalUserId = entityId<"user">(
      "11111111-1111-4111-8111-111111111111",
    );
    const channelUserId = entityId<"user">(
      "22222222-2222-4222-8222-222222222222",
    );
    const nextChannelUserId = entityId<"user">(
      "66666666-6666-4666-8666-666666666666",
    );
    const deviceId = entityId<"device">("33333333-3333-4333-8333-333333333333");
    const channelId = entityId<"channel">(
      "44444444-4444-4444-8444-444444444444",
    );
    const activityId = entityId<"activity">(
      "55555555-5555-4555-8555-555555555555",
    );
    const controller = new EphemeralStateController(session as never);
    controller.start();

    receive({
      kind: "control",
      opcode: 33,
      payload: new Map([
        [0, entityRef("user", globalUserId)],
        [1, 1],
        [3, new Date()],
      ]),
    });
    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [
          1,
          [
            new Map([
              [0, entityRef("user", channelUserId)],
              [1, 3],
              [3, new Date()],
            ]),
          ],
        ],
        [
          2,
          [
            new Map([
              [0, entityRef("user", channelUserId)],
              [1, entityRef("device", deviceId)],
              [2, 0],
              [
                3,
                new Map([
                  [0, requestRef(activityId)],
                  [1, 0],
                  [2, new Date()],
                  [3, new Date()],
                  [4, new Date(Date.now() + 30_000)],
                  [
                    5,
                    [
                      0,
                      new Map([
                        [0, "Channel song"],
                        [3, 2],
                      ]),
                    ],
                  ],
                ]),
              ],
            ]),
          ],
        ],
      ]),
    });

    expect(controller.state.presence.get(globalUserId)?.availability).toBe(
      "online",
    );
    expect(controller.state.presence.get(channelUserId)?.availability).toBe(
      "dnd",
    );
    expect(
      [...controller.state.activities.values()][0]?.activity.payload,
    ).toMatchObject({ title: "Channel song" });

    receive({
      kind: "control",
      opcode: 42,
      payload: new Map([
        [0, entityRef("channel", channelId)],
        [
          1,
          [
            new Map([
              [0, entityRef("user", nextChannelUserId)],
              [1, 2],
              [3, new Date()],
            ]),
          ],
        ],
        [2, []],
      ]),
    });

    expect(controller.state.presence.has(channelUserId)).toBe(true);
    expect(controller.state.presence.get(nextChannelUserId)?.availability).toBe(
      "idle",
    );

    receive({
      kind: "control",
      opcode: 41,
      payload: new Map([
        [0, null],
        [1, []],
        [2, []],
      ]),
    });

    expect(controller.state.presence.has(globalUserId)).toBe(true);
    expect(controller.state.presence.has(channelUserId)).toBe(false);
    expect(controller.state.presence.has(nextChannelUserId)).toBe(false);
    expect(controller.state.activities.size).toBe(0);
  });
});
