import { describe, expect, it, vi } from "vitest";
import {
  discoverInstanceEndpoint,
  instanceEndpoint,
  loadCommunityInvitationPreview,
  parseCommunityInvitationPreview,
  parseInstanceDocument,
} from "./instance-endpoint.js";

describe("instanceEndpoint", () => {
  it("derives production and local connection endpoints", () => {
    expect(instanceEndpoint("Chat.Example.COM")).toEqual({
      domain: "chat.example.com",
      baseUrl: "https://chat.example.com",
    });
    expect(instanceEndpoint("localhost")).toEqual({
      domain: "localhost",
      baseUrl: "http://127.0.0.1:4000",
    });
  });

  it("rejects invalid domains", () => {
    expect(instanceEndpoint("-invalid.example")).toBeUndefined();
    expect(instanceEndpoint("example..com")).toBeUndefined();
    expect(instanceEndpoint("alice@example.com/device")).toBeUndefined();
  });
});

describe("community invitation preview", () => {
  it("resolves a same-instance public invitation without credentials", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        community: { name: "Garden Club" },
        instance: { name: "Crisp Otter" },
      }),
    });
    const endpoint = instanceEndpoint("chat.example.test")!;
    await expect(
      loadCommunityInvitationPreview(
        endpoint,
        "https://chat.example.test/invite/abc%20123",
        request,
      ),
    ).resolves.toEqual({
      communityName: "Garden Club",
      instanceName: "Crisp Otter",
    });
    expect(request).toHaveBeenCalledWith(
      "https://chat.example.test/api/invites/abc%20123",
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
  });

  it("allows equivalent local loopback origins", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        community: { name: "Local" },
        instance: { name: "Development" },
      }),
    });
    await expect(
      loadCommunityInvitationPreview(
        instanceEndpoint("localhost")!,
        "http://localhost:4000/invite/local",
        request,
      ),
    ).resolves.toMatchObject({ communityName: "Local" });
  });

  it("rejects another instance and malformed responses", async () => {
    const endpoint = instanceEndpoint("chat.example.test")!;
    await expect(
      loadCommunityInvitationPreview(
        endpoint,
        "https://other.example.test/invite/token",
        vi.fn(),
      ),
    ).rejects.toThrow("another Sideband instance");
    expect(() => parseCommunityInvitationPreview({ community: {} })).toThrow(
      "invalid invitation",
    );
  });
});

describe("instance discovery", () => {
  const document = {
    version: 1,
    name: "Example Sideband",
    authentication: {
      type: "oidc",
      issuer: "https://id.example.test",
      resource: "https://chat.example.test/",
    },
    registration: { enabled: true },
    sbp: {
      websocket_path: "/sbp",
      subprotocols: ["sideband.cbor.v1"],
      authentication_mechanisms: ["opaque-credential"],
    },
  };

  it("loads and normalizes public instance metadata", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(document),
    });
    await expect(
      discoverInstanceEndpoint("chat.example.test", request),
    ).resolves.toEqual({
      domain: "chat.example.test",
      baseUrl: "https://chat.example.test",
      name: "Example Sideband",
      authentication: document.authentication,
      registrationEnabled: true,
      sbp: {
        websocketPath: "/sbp",
        subprotocols: ["sideband.cbor.v1"],
        authenticationMechanisms: ["opaque-credential"],
      },
    });
  });

  it("rejects incompatible documents", () => {
    expect(() => parseInstanceDocument({ version: 2 })).toThrow(
      "not a compatible Sideband instance",
    );
  });
});
