import { describe, expect, it } from "vitest";
import { parseMediaServerIdentity } from "./media-server-identity.js";

describe("parseMediaServerIdentity", () => {
  it("accepts authoritative native SBP user identities", () => {
    expect(
      parseMediaServerIdentity({
        endpointId: "endpoint-1",
        userId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      endpointId: "endpoint-1",
      userId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it.each([
    undefined,
    {},
    { endpointId: 3, userId: "11111111-1111-4111-8111-111111111111" },
    { endpointId: "endpoint-1", userId: null },
    { endpointId: "endpoint-1", userId: "invalid" },
  ])("rejects invalid media metadata", (value) => {
    expect(parseMediaServerIdentity(value)).toBeUndefined();
  });
});
