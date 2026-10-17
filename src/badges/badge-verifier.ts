import type { UserBadge, UserProfile } from "../domain.js";

const allowedBadges = new Set<UserBadge>([
  "early-adopter",
  "supporter",
  "developer",
]);
const maximumAssertionBytes = 16_384;
type IssuerJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export class BadgeVerifier {
  private readonly issuerKeys = new Map<string, Promise<IssuerJwk[]>>();

  constructor(
    private readonly trustedIssuer?: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async verify(profile: UserProfile): Promise<UserProfile> {
    const badgeAssertion = profile.badgeAssertion;
    const verified = badgeAssertion
      ? await this.verifyAssertion(badgeAssertion).catch(() => [])
      : [];
    const publicProfile = { ...profile };
    delete publicProfile.badgeAssertion;
    return {
      ...publicProfile,
      ...(verified.length ? { badges: verified } : {}),
    };
  }

  private async verifyAssertion(
    assertion: NonNullable<UserProfile["badgeAssertion"]>,
  ) {
    if (!this.trustedIssuer) return [];
    if (new TextEncoder().encode(assertion).byteLength > maximumAssertionBytes)
      return [];
    const segments = assertion.split(".");
    if (segments.length !== 3) return [];
    const [protectedSegment, payloadSegment, signatureSegment] = segments;
    const header = decodeJson(protectedSegment);
    const claims = decodeJson(payloadSegment);
    if (
      header.typ !== "sideband-badges+jwt" ||
      typeof header.kid !== "string" ||
      !["ES256", "RS256", "EdDSA"].includes(String(header.alg))
    )
      return [];
    if (
      claims.iss !== this.trustedIssuer ||
      typeof claims.sub !== "string" ||
      claims.sub === ""
    )
      return [];

    const keys = await this.loadIssuerKeys(this.trustedIssuer);
    const key = keys.find(
      (candidate) =>
        candidate.kid === header.kid &&
        (!candidate.alg || candidate.alg === header.alg) &&
        (!candidate.use || candidate.use === "sig"),
    );
    if (!key) return [];
    const algorithm = verificationAlgorithm(String(header.alg));
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      algorithm.import,
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        algorithm.verify,
        cryptoKey,
        decodeBase64Url(signatureSegment),
        new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`),
      ))
    )
      return [];

    const now = Math.floor(Date.now() / 1_000);
    if (
      claims.version !== 1 ||
      typeof claims.iat !== "number" ||
      claims.iat > now + 60 ||
      typeof claims.nbf !== "number" ||
      claims.nbf > now ||
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      !Array.isArray(claims.badges)
    )
      return [];
    const badges = claims.badges
      .filter((badge): badge is string => typeof badge === "string")
      .map((badge) => badge.replace(/^sideband\./u, ""))
      .filter((badge): badge is UserBadge =>
        allowedBadges.has(badge as UserBadge),
      );
    return badges.length === claims.badges.length &&
      new Set(badges).size === badges.length
      ? badges
      : [];
  }

  private loadIssuerKeys(issuer: string) {
    const existing = this.issuerKeys.get(issuer);
    if (existing) return existing;
    const request = fetchJson(
      this.request,
      transportUrl(`${issuer}/.well-known/openid-configuration`),
    ).then(async (discovery) => {
      if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== "string")
        throw new Error("Invalid badge issuer discovery document");
      const keys = await fetchJson(
        this.request,
        transportUrl(discovery.jwks_uri),
      );
      if (!Array.isArray(keys.keys))
        throw new Error("Invalid badge issuer keys");
      return keys.keys as IssuerJwk[];
    });
    this.issuerKeys.set(issuer, request);
    request.catch(() => this.issuerKeys.delete(issuer));
    return request;
  }
}

async function fetchJson(request: typeof fetch, url: string) {
  const response = await request(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Badge issuer is unavailable");
  return (await response.json()) as Record<string, unknown>;
}

function transportUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol === "https:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    url.protocol = "http:";
  return url.toString();
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(decodeBase64Url(segment)),
  ) as Record<string, unknown>;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function verificationAlgorithm(algorithm: string): {
  import: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams;
  verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
} {
  if (algorithm === "ES256")
    return {
      import: { name: "ECDSA", namedCurve: "P-256" },
      verify: { name: "ECDSA", hash: "SHA-256" },
    };
  if (algorithm === "RS256")
    return {
      import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      verify: { name: "RSASSA-PKCS1-v1_5" },
    };
  return { import: { name: "Ed25519" }, verify: { name: "Ed25519" } };
}
