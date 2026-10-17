import { describe, expect, it } from "vitest";
import { entityId } from "../entity-id.js";
import {
  decodeEntityRef,
  decodeSbp,
  encodeSbp,
  entityRef,
  wireMap,
} from "./codec.js";
import { decodeFrame, encodeCommand, encodeControl } from "./frame.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("SBP codec", () => {
  it("round trips typed entity references", () => {
    const encoded = encodeSbp(entityRef("user", entityId(UUID)));
    expect(decodeEntityRef(decodeSbp(encoded), "user")).toBe(UUID);
    expect(() => decodeEntityRef(decodeSbp(encoded), "community")).toThrow();
  });

  it("orders integer map keys for deterministic encoding", () => {
    expect([
      ...wireMap([
        [3, "c"],
        [0, "a"],
        [2, "b"],
      ]).keys(),
    ]).toEqual([0, 2, 3]);
  });

  it("encodes timestamps as integer seconds accepted by SBP", () => {
    expect([...encodeSbp(new Date("2026-10-17T18:00:00.123Z"))]).toEqual([
      ...decodeHex("c11a6ad3b7a0"),
    ]);
  });

  it("round trips command frames", () => {
    const payload = wireMap([[0, entityRef("user", entityId(UUID))]]);
    expect(decodeFrame(encodeCommand(UUID, 20, payload))).toMatchObject({
      kind: "command",
      requestId: UUID,
      opcode: 20,
    });
  });

  it("round trips control frames", () => {
    expect(decodeFrame(encodeControl(5, 99))).toEqual({
      kind: "control",
      opcode: 5,
      payload: 99,
    });
  });

  it("decodes the canonical account-snapshot fixture", () => {
    const bytes = decodeHex(
      "8300d82550000000000000000000000000000000008201a10001",
    );
    expect(decodeFrame(bytes)).toEqual({
      kind: "command",
      requestId: "00000000-0000-0000-0000-000000000000",
      opcode: 1,
      payload: new Map([[0, 1]]),
    });
  });
});

function decodeHex(value: string) {
  return Uint8Array.from(
    value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}
