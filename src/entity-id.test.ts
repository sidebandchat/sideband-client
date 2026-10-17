import { describe, expect, it } from "vitest";
import { entityId, idKey, orderedId } from "./entity-id.js";

describe("entity IDs", () => {
  it("normalizes UUID-backed identities", () => {
    expect(entityId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("rejects malformed UUIDs", () => {
    expect(() => entityId("someone@example.com")).toThrow("Invalid entity ID");
  });

  it("preserves ordered IDs beyond JavaScript's safe integer range", () => {
    const id = orderedId("9223372036854775807");
    expect(id).toBe(9_223_372_036_854_775_807n);
    expect(idKey(id)).toBe("9223372036854775807");
  });
});
