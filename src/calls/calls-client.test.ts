import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeEntityRef, entityRef } from "../sbp/codec.js";
import { SbpCallsClient } from "./calls-client.js";

const callId = entityId<"call">("11111111-1111-4111-8111-111111111111");
const userId = entityId<"user">("22222222-2222-4222-8222-222222222222");

describe("SbpCallsClient", () => {
  it("starts a direct video call with a typed target", async () => {
    const command = vi.fn().mockResolvedValue(callRecord());
    const client = new SbpCallsClient({ command });

    const call = await client.start({ kind: "user", userId }, "video");

    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(400);
    expect(payload.get(0)[0]).toBe(0);
    expect(decodeEntityRef(payload.get(0)[1], "user")).toBe(userId);
    expect(payload.get(1)).toBe(1);
    expect(call).toMatchObject({
      id: callId,
      media: "video",
      state: "ringing",
    });
  });

  it("obtains opaque one-use SFU admission data", async () => {
    const credential = new Uint8Array(32).fill(9);
    const command = vi.fn().mockResolvedValue(
      new Map([
        [0, credential],
        [1, new Date("2026-01-01T00:01:00Z")],
        [2, "room-opaque"],
      ]),
    );
    const client = new SbpCallsClient({ command });

    const admission = await client.admit(callId);

    expect(decodeEntityRef(command.mock.calls[0]![1].get(0), "call")).toBe(
      callId,
    );
    expect(admission).toEqual({
      credential,
      expiresAt: "2026-01-01T00:01:00.000Z",
      room: "room-opaque",
    });
  });

  it("maps lifecycle actions to closed protocol values", async () => {
    const command = vi.fn().mockResolvedValue(new Map());
    const client = new SbpCallsClient({ command });
    await client.join(callId);
    await client.mediaConnected(callId, new Uint8Array([1, 2]));
    await client.decline(callId);
    await client.leave(callId);
    expect(command.mock.calls.map((call) => call[1].get(1))).toEqual([
      2, 3, 4, 5,
    ]);
  });
});

function callRecord() {
  return new Map([
    [0, entityRef("call", callId)],
    [1, [0, entityRef("user", userId)]],
    [2, entityRef("user", userId)],
    [3, 1],
    [4, 0],
    [5, new Date("2026-01-01T00:00:00Z")],
    [
      7,
      [
        new Map([
          [0, entityRef("user", userId)],
          [1, 1],
        ]),
      ],
    ],
  ]);
}
