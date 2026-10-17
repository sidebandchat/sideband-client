import { describe, expect, it, vi } from "vitest";
import { IdentityClient, type IdentityAuthAdapter } from "./identity-client.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function adapter(): IdentityAuthAdapter {
  return {
    start: vi.fn().mockResolvedValue({
      status: "account_selection_required",
      exchange_token: "exchange",
      accounts: [
        {
          selectionId: "one",
          instanceDomain: "example.test",
          userId: USER_ID,
          username: "alice",
        },
      ],
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    selectAccount: vi.fn().mockResolvedValue({
      status: "authenticated",
      account: {
        instanceDomain: "example.test",
        userId: USER_ID,
        username: "alice",
      },
    }),
    provisionAccount: vi.fn().mockResolvedValue({
      status: "authenticated",
      account: {
        instanceDomain: "example.test",
        userId: USER_ID,
        username: "created",
      },
    }),
  };
}

describe("IdentityClient", () => {
  it("resolves instances and normalizes platform auth results", async () => {
    const platform = adapter();
    const identity = new IdentityClient(platform);

    await expect(identity.start("example.test")).resolves.toEqual({
      status: "account_selection_required",
      exchangeToken: "exchange",
      accounts: [
        {
          selectionId: "one",
          instanceDomain: "example.test",
          userId: USER_ID,
          username: "alice",
        },
      ],
    });
    expect(platform.start).toHaveBeenCalledWith(
      { domain: "example.test", baseUrl: "https://example.test" },
      undefined,
    );
    await expect(
      identity.selectAccount("example.test", "exchange", "one"),
    ).resolves.toEqual({
      status: "authenticated",
      account: {
        instanceDomain: "example.test",
        userId: USER_ID,
        username: "alice",
      },
    });
  });

  it("uses the loopback endpoint and rejects invalid instances", async () => {
    const platform = adapter();
    const identity = new IdentityClient(platform);
    await identity.start("localhost", "create_account");
    expect(platform.start).toHaveBeenCalledWith(
      { domain: "localhost", baseUrl: "http://127.0.0.1:4000" },
      "create_account",
    );
    await expect(identity.start("not a host")).rejects.toThrow("valid");
  });
});
