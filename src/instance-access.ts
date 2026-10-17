import type { InstanceEndpoint } from "./instance-endpoint.js";

export type InstanceAccess = {
  endpoint: InstanceEndpoint;
  authorization?: string;
};

export type SidebandClientIdentity = {
  name: string;
  version: string;
};

export type AuthenticatedInstanceAccess = InstanceAccess & {
  authorization: string;
  clientIdentity?: SidebandClientIdentity;
};

export type InstanceAccessProvider = () => InstanceAccess | undefined;

export function requireInstanceAccess(
  provider: InstanceAccessProvider,
): InstanceAccess & { authorization: string } {
  const access = provider();
  if (!access?.endpoint.baseUrl || !access.authorization)
    throw new Error("No session credential is available. Sign in again.");
  return {
    endpoint: {
      ...access.endpoint,
      baseUrl: access.endpoint.baseUrl.replace(/\/$/u, ""),
    },
    authorization: access.authorization,
  };
}

export function requireInstanceEndpoint(provider: InstanceAccessProvider) {
  const endpoint = provider()?.endpoint;
  if (!endpoint?.baseUrl) throw new Error("The instance is unavailable");
  return {
    ...endpoint,
    baseUrl: endpoint.baseUrl.replace(/\/$/u, ""),
  };
}

export class InstanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InstanceApiError";
  }
}

export type InstanceRequestOptions = {
  authenticated?: boolean;
};

export class InstanceHttpClient {
  constructor(
    private readonly getAccess: InstanceAccessProvider,
    private readonly clientIdentity?: SidebandClientIdentity,
    private readonly request: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  get available() {
    const access = this.getAccess();
    return Boolean(access?.endpoint.baseUrl && access.authorization);
  }

  endpoint() {
    return requireInstanceEndpoint(this.getAccess);
  }

  access() {
    return {
      ...requireInstanceAccess(this.getAccess),
      clientIdentity: this.clientIdentity,
    };
  }

  fetch(
    path: string,
    init: RequestInit = {},
    options: InstanceRequestOptions = {},
  ) {
    const authenticated = options.authenticated !== false;
    const access = authenticated ? this.access() : this.getAccess();
    const endpoint = access?.endpoint ?? this.endpoint();
    const headers = new Headers(init.headers);
    if (authenticated && access?.authorization)
      headers.set("authorization", access.authorization);
    addClientIdentityHeaders(headers, this.clientIdentity);
    return this.request(new URL(path, endpoint.baseUrl).toString(), {
      ...init,
      headers,
    });
  }
}

export function addClientIdentityHeaders(
  headers: Headers,
  identity?: SidebandClientIdentity,
) {
  if (!identity) return;
  headers.set("x-sideband-client", headerValue(identity.name));
  headers.set("x-sideband-client-version", headerValue(identity.version));
}

function headerValue(value: string) {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/u.test(normalized))
    throw new TypeError("Invalid Sideband client identity");
  return normalized;
}

export async function instanceApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: unknown } | undefined;
  return new InstanceApiError(
    typeof payload?.error === "string"
      ? payload.error
      : `${fallback} (${response.status})`,
    response.status,
  );
}
