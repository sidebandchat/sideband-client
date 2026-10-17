import type { InstanceCapabilities } from "./instance-capabilities.js";

export type InstanceAuthentication = {
  type: "oidc";
  issuer: string;
  resource: string;
};

export type InstanceEndpoint = {
  domain: string;
  baseUrl: string;
  name?: string;
  authentication?: InstanceAuthentication;
  registrationEnabled?: boolean;
  capabilities?: InstanceCapabilities;
  sbp?: {
    websocketPath: string;
    subprotocols: string[];
    authenticationMechanisms: string[];
  };
};

export type InstanceEndpointInput = { domain: string } | string;

export type CommunityInvitationPreview = {
  communityName: string;
  instanceName: string;
};

export function instanceEndpoint(
  input: InstanceEndpointInput,
): InstanceEndpoint | undefined {
  let domain: string;
  try {
    domain = normalizeDomain(typeof input === "string" ? input : input.domain);
  } catch {
    return undefined;
  }

  if (domain === "localhost")
    return {
      domain,
      baseUrl: "http://127.0.0.1:4000",
    };

  return {
    domain,
    baseUrl: `https://${domain}`,
  };
}

export async function discoverInstanceEndpoint(
  input: InstanceEndpointInput,
  request: typeof fetch = fetch,
): Promise<InstanceEndpoint> {
  const endpoint = instanceEndpoint(input);
  if (!endpoint) throw new Error("Enter a valid Sideband instance.");
  const response = await request(`${endpoint.baseUrl}/.well-known/sideband`, {
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error("Could not connect to that instance.");
  return { ...endpoint, ...parseInstanceDocument(payload) };
}

export async function loadCommunityInvitationPreview(
  endpoint: InstanceEndpoint,
  inviteUrl: string,
  request: typeof fetch = fetch,
): Promise<CommunityInvitationPreview> {
  const token = invitationToken(endpoint, inviteUrl);
  const response = await request(
    `${endpoint.baseUrl}/api/invites/${encodeURIComponent(token)}`,
    {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error("This invitation is unavailable.");
  return parseCommunityInvitationPreview(payload);
}

export function parseCommunityInvitationPreview(
  payload: unknown,
): CommunityInvitationPreview {
  const value = payload as
    | { community?: { name?: unknown }; instance?: { name?: unknown } }
    | undefined;
  if (
    typeof value?.community?.name !== "string" ||
    !value.community.name.trim() ||
    typeof value.instance?.name !== "string" ||
    !value.instance.name.trim()
  )
    throw new Error("The instance returned an invalid invitation.");
  return {
    communityName: value.community.name.trim(),
    instanceName: value.instance.name.trim(),
  };
}

export function parseInstanceDocument(
  payload: unknown,
): Pick<
  InstanceEndpoint,
  "name" | "authentication" | "registrationEnabled" | "sbp"
> {
  const document = payload as Record<string, unknown> | undefined;
  const authentication = document?.authentication as
    Record<string, unknown> | undefined;
  const registration = document?.registration as
    Record<string, unknown> | undefined;
  const sbp = document?.sbp as Record<string, unknown> | undefined;
  if (
    document?.version !== 1 ||
    authentication?.type !== "oidc" ||
    typeof authentication.issuer !== "string" ||
    !validUrl(authentication.issuer) ||
    typeof authentication.resource !== "string" ||
    !validUrl(authentication.resource) ||
    typeof registration?.enabled !== "boolean" ||
    typeof sbp?.websocket_path !== "string" ||
    !sbp.websocket_path.startsWith("/") ||
    !stringArray(sbp.subprotocols)?.includes("sideband.cbor.v1") ||
    !stringArray(sbp.authentication_mechanisms)?.includes(
      "opaque-credential",
    ) ||
    (document.name !== undefined && typeof document.name !== "string")
  )
    throw new Error("That server is not a compatible Sideband instance.");
  return {
    ...(typeof document.name === "string" && document.name.trim()
      ? { name: document.name.trim() }
      : {}),
    authentication: {
      type: "oidc",
      issuer: authentication.issuer,
      resource: authentication.resource,
    },
    registrationEnabled: registration.enabled,
    sbp: {
      websocketPath: sbp.websocket_path,
      subprotocols: stringArray(sbp.subprotocols)!,
      authenticationMechanisms: stringArray(sbp.authentication_mechanisms)!,
    },
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function normalizeDomain(value: string) {
  const domain = value.trim().toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain
      .split(".")
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  )
    throw new TypeError("Invalid instance domain");
  return domain;
}

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function invitationToken(endpoint: InstanceEndpoint, value: string) {
  let invite: URL;
  let instance: URL;
  try {
    invite = new URL(value);
    instance = new URL(endpoint.baseUrl);
  } catch {
    throw new TypeError("Invalid community invitation");
  }
  if (!sameInstanceOrigin(invite, instance))
    throw new Error("This invitation belongs to another Sideband instance.");
  const match = /^\/invite\/([^/]+)\/?$/u.exec(invite.pathname);
  if (!match) throw new TypeError("Invalid community invitation");
  const token = decodeURIComponent(match[1]);
  if (!token || token.length > 512)
    throw new TypeError("Invalid community invitation");
  return token;
}

function sameInstanceOrigin(left: URL, right: URL) {
  if (left.origin === right.origin) return true;
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  return (
    loopback.has(left.hostname) &&
    loopback.has(right.hostname) &&
    left.port === right.port &&
    left.protocol === right.protocol
  );
}
