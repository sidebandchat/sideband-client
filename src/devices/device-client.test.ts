import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { entityRef } from "../sbp/codec.js";
import { SbpDevicesClient } from "./device-client.js";

describe("SbpDevicesClient", () => {
  it("lists and revokes authoritative device IDs", async () => {
    const deviceId = entityId<"device">("11111111-1111-4111-8111-111111111111");
    const record = new Map([
      [0, entityRef("device", deviceId)],
      [4, new Date("2026-01-01T00:00:00Z")],
      [5, new Date("2026-01-01T00:00:01Z")],
      [7, true],
      [8, 3],
    ]);
    const command = vi
      .fn()
      .mockResolvedValueOnce(new Map([[0, [record]]]))
      .mockResolvedValueOnce(new Map([[0, entityRef("device", deviceId)]]));
    const client = new SbpDevicesClient({ command });
    expect((await client.list())[0]?.id).toBe(deviceId);
    expect(await client.revoke(deviceId, 3)).toBe(deviceId);
    expect(command.mock.calls.map(([opcode]) => opcode)).toEqual([2, 3]);
  });
});
