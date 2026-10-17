import { afterEach, describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeEntityRef } from "../sbp/codec.js";
import { SbpRealtimeClient } from "./realtime-client.js";

describe("SbpRealtimeClient", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes presence and typing as ephemeral controls", () => {
    const control = vi.fn();
    const client = new SbpRealtimeClient({ control, command: vi.fn() });
    const conversationId = entityId<"conversation">(
      "11111111-1111-4111-8111-111111111111",
    );
    client.publishPresence({ availability: "invisible" });
    client.publishTyping(conversationId, true, 8_000);
    expect(control.mock.calls[0]![0]).toBe(32);
    expect(control.mock.calls[0]![1].get(0)).toBe(4);
    expect(
      decodeEntityRef(control.mock.calls[1]![1].get(0), "conversation"),
    ).toBe(conversationId);
  });

  it("publishes typing transitions immediately and refreshes an active lease at most twice per lease", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const control = vi.fn();
    const client = new SbpRealtimeClient({ control, command: vi.fn() });
    const conversationId = entityId<"conversation">(
      "11111111-1111-4111-8111-111111111111",
    );

    client.publishTyping(conversationId, false, 10_000);
    client.publishTyping(conversationId, true, 10_000);
    client.publishTyping(conversationId, true, 10_000);
    vi.advanceTimersByTime(4_999);
    client.publishTyping(conversationId, true, 10_000);
    expect(control).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    client.publishTyping(conversationId, true, 10_000);
    client.publishTyping(conversationId, false, 10_000);
    client.publishTyping(conversationId, false, 10_000);

    expect(control).toHaveBeenCalledTimes(3);
    expect(control.mock.calls.map(([, payload]) => payload.get(1))).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("allows typing to restart immediately after a successful message", () => {
    const control = vi.fn();
    const client = new SbpRealtimeClient({ control, command: vi.fn() });
    const conversationId = entityId<"conversation">(
      "11111111-1111-4111-8111-111111111111",
    );

    client.publishTyping(conversationId, true, 10_000);
    client.messageSent(conversationId);
    client.publishTyping(conversationId, true, 10_000);

    expect(control).toHaveBeenCalledTimes(2);
    expect(control.mock.calls.map(([, payload]) => payload.get(1))).toEqual([
      true,
      true,
    ]);
  });

  it("encodes music using the native activity schema", () => {
    const control = vi.fn();
    const client = new SbpRealtimeClient({ control, command: vi.fn() });

    client.publishActivity({
      id: entityId<"activity">("11111111-1111-4111-8111-111111111111"),
      kind: "music",
      startedAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 90_000),
      payload: {
        title: "Glass Signals",
        artist: "Aster Harbor",
        playbackState: "playing",
      },
    });

    const [variant, tune] = control.mock.calls[0]![1].get(5);
    expect(variant).toBe(0);
    expect(tune.get(0)).toBe("Glass Signals");
    expect(tune.get(1)).toEqual(["Aster Harbor"]);
    expect(tune.get(3)).toBe(2);
  });

  it("renews an activity without republishing its metadata", () => {
    const control = vi.fn();
    const client = new SbpRealtimeClient({ control, command: vi.fn() });

    client.renewActivity({
      id: entityId<"activity">("11111111-1111-4111-8111-111111111111"),
      kind: "music",
      sampledAt: new Date("2026-10-17T12:00:00Z"),
      expiresAt: new Date("2026-10-17T12:01:30Z"),
      positionMs: 42_000,
    });

    expect(control).toHaveBeenCalledWith(44, expect.any(Map));
    const payload = control.mock.calls[0]![1];
    expect(payload.get(1)).toBe(0);
    expect(payload.get(4)).toBe(42_000);
    expect(payload.has(5)).toBe(false);
  });

  it("uses the protocol visibility ordering", async () => {
    const command = vi
      .fn()
      .mockImplementation((_opcode, payload) => payload.get(0));
    const client = new SbpRealtimeClient({ control: vi.fn(), command });
    const result = await client.updateSettings({
      presenceVisibility: "nobody",
      activityVisibility: "shared-context",
      activitySharingEnabled: true,
      revision: 2,
    });
    const encoded = command.mock.calls[0]![1].get(0);
    expect([encoded.get(0), encoded.get(1)]).toEqual([0, 2]);
    expect(result.activityVisibility).toBe("shared-context");
  });
});
