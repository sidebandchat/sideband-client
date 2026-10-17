import { describe, expect, it, vi } from "vitest";
import { InstanceHttpClient } from "./instance-access.js";

const access = () => ({
  endpoint: {
    domain: "chat.example.test",
    baseUrl: "https://chat.example.test/",
  },
  authorization: "Sideband token",
});

describe("InstanceHttpClient", () => {
  it("owns instance URL, authorization, and client identity headers", async () => {
    const request = vi.fn().mockResolvedValue(new Response());
    const http = new InstanceHttpClient(
      access,
      { name: "desktop", version: "0.5.0" },
      request,
    );

    await http.fetch("/api/example", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    expect(request.mock.calls[0][0]).toBe(
      "https://chat.example.test/api/example",
    );
    expect(Object.fromEntries(request.mock.calls[0][1].headers)).toEqual({
      authorization: "Sideband token",
      "content-type": "application/json",
      "x-sideband-client": "desktop",
      "x-sideband-client-version": "0.5.0",
    });
  });

  it("supports public instance requests without leaking authorization", async () => {
    const request = vi.fn().mockResolvedValue(new Response());
    const http = new InstanceHttpClient(
      access,
      { name: "mobile", version: "1.2.3" },
      request,
    );

    await http.fetch("/api/invites/token", {}, { authenticated: false });

    expect(
      (request.mock.calls[0][1].headers as Headers).has("authorization"),
    ).toBe(false);
    expect(
      (request.mock.calls[0][1].headers as Headers).get("x-sideband-client"),
    ).toBe("mobile");
  });

  it("rejects client identity values that could inject headers", () => {
    const http = new InstanceHttpClient(access, {
      name: "desktop\r\nx-forged: yes",
      version: "0.5.0",
    });

    expect(() => http.fetch("/api/example")).toThrow(
      "Invalid Sideband client identity",
    );
  });
});
