import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import type { UserProfile } from "../domain.js";
import { BadgeVerifier } from "./badge-verifier.js";

const issuer = "https://id.example.test";
const subject = "identity-subject";

describe("BadgeVerifier", () => {
  it("exposes only badges from an assertion signed by the trusted identity issuer", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    Object.assign(publicKey, { kid: "badge-key", alg: "ES256", use: "sig" });
    const now = Math.floor(Date.now() / 1_000);
    const header = segment({
      alg: "ES256",
      kid: "badge-key",
      typ: "sideband-badges+jwt",
    });
    const payload = segment({
      iss: issuer,
      sub: subject,
      version: 1,
      iat: now,
      nbf: now,
      exp: now + 3_600,
      badges: ["sideband.early-adopter", "sideband.developer"],
    });
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(signingInput),
    );
    const token = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    const request = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/.well-known/openid-configuration"))
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks` });
      return Response.json({ keys: [publicKey] });
    });

    const verified = await new BadgeVerifier(
      issuer,
      request as typeof fetch,
    ).verify(profile(token));

    expect(verified.badges).toEqual(["early-adopter", "developer"]);
    expect(verified.badgeAssertion).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects an assertion whose issuer is not the authenticated instance issuer", async () => {
    const request = vi.fn();
    const verified = await new BadgeVerifier(
      issuer,
      request as typeof fetch,
    ).verify({
      ...profile("untrusted.token.value"),
      badgeAssertion: `${segment({ alg: "ES256", kid: "attacker", typ: "sideband-badges+jwt" })}.${segment({ iss: "https://attacker.example", sub: subject })}.signature`,
    });

    expect(verified.badges).toBeUndefined();
    expect(verified.badgeAssertion).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

function profile(token: string): UserProfile {
  return {
    id: entityId<"user">("550e8400-e29b-41d4-a716-446655440000"),
    username: "alice",
    displayName: "Alice",
    bio: "",
    revision: 0,
    badgeAssertion: token,
  };
}

function segment(value: object) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}
