import {
  instanceEndpoint,
  type InstanceEndpoint,
  type InstanceEndpointInput,
} from "../instance-endpoint.js";
import { entityId, type UserId } from "../entity-id.js";

export type IdentityAccount = {
  instanceDomain: string;
  userId: UserId;
  username: string;
};

export type PlatformIdentityAccount = {
  instanceDomain: string;
  userId: string;
  username: string;
};

export type IdentityAuthenticatedResult = {
  status: "authenticated";
  account: IdentityAccount;
};

export type IdentityAuthResult =
  | IdentityAuthenticatedResult
  | { status: "cancelled" }
  | { status: "registration_disabled" }
  | { status: "provisioning_required"; exchangeToken: string }
  | {
      status: "account_selection_required";
      exchangeToken: string;
      accounts: Array<IdentityAccount & { selectionId: string }>;
    };

export type PlatformIdentityAuthResult =
  | { status: "authenticated"; account: PlatformIdentityAccount }
  | { status: "cancelled" }
  | { status: "registration_disabled" }
  | { status: "provisioning_required"; exchange_token: string }
  | {
      status: "account_selection_required";
      exchange_token: string;
      accounts: Array<PlatformIdentityAccount & { selectionId: string }>;
    };

export type IdentityAuthAdapter = {
  start: (
    endpoint: InstanceEndpoint,
    intent?: "create_account",
  ) => Promise<PlatformIdentityAuthResult>;
  cancel: () => Promise<void>;
  selectAccount: (
    endpoint: InstanceEndpoint,
    exchangeToken: string,
    accountId: string,
  ) => Promise<PlatformIdentityAuthResult>;
  provisionAccount: (
    endpoint: InstanceEndpoint,
    exchangeToken: string,
    username: string,
  ) => Promise<PlatformIdentityAuthResult>;
};

export class IdentityClient {
  constructor(private readonly adapter?: IdentityAuthAdapter) {}

  start(instance: InstanceEndpointInput, intent?: "create_account") {
    return this.request(instance, (adapter, endpoint) =>
      adapter.start(endpoint, intent),
    );
  }

  cancel() {
    return this.requireAdapter().cancel();
  }

  selectAccount(
    instance: InstanceEndpointInput,
    exchangeToken: string,
    accountId: string,
  ) {
    return this.request(instance, (adapter, endpoint) =>
      adapter.selectAccount(endpoint, exchangeToken, accountId),
    );
  }

  provisionAccount(
    instance: InstanceEndpointInput,
    exchangeToken: string,
    username: string,
  ) {
    return this.request(instance, (adapter, endpoint) =>
      adapter.provisionAccount(endpoint, exchangeToken, username),
    );
  }

  private async request(
    instance: InstanceEndpointInput,
    operation: (
      adapter: IdentityAuthAdapter,
      endpoint: InstanceEndpoint,
    ) => Promise<PlatformIdentityAuthResult>,
  ) {
    const endpoint = instanceEndpoint(instance);
    if (!endpoint) throw new Error("Enter a valid Sideband instance.");
    return normalizeResult(await operation(this.requireAdapter(), endpoint));
  }

  private requireAdapter() {
    if (!this.adapter)
      throw new Error(
        "Identity authentication is unavailable on this platform",
      );
    return this.adapter;
  }
}

function normalizeResult(
  result: PlatformIdentityAuthResult,
): IdentityAuthResult {
  switch (result.status) {
    case "authenticated":
      return {
        status: result.status,
        account: normalizeAccount(result.account),
      };
    case "provisioning_required":
      return { status: result.status, exchangeToken: result.exchange_token };
    case "account_selection_required":
      return {
        status: result.status,
        exchangeToken: result.exchange_token,
        accounts: result.accounts.map(({ selectionId, ...account }) => ({
          selectionId,
          ...normalizeAccount(account),
        })),
      };
    default:
      return result;
  }
}

function normalizeAccount(account: PlatformIdentityAccount): IdentityAccount {
  const instanceDomain = account.instanceDomain.trim().toLowerCase();
  const username = account.username.trim().toLowerCase();
  if (!instanceDomain || !username)
    throw new TypeError("Invalid Sideband account");
  return {
    instanceDomain,
    username,
    userId: entityId<"user">(account.userId),
  };
}
