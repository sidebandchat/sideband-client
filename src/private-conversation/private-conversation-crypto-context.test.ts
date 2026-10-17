import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitiatorCipher,
  createPrivateConversationCryptoContext,
  createResponderCipher,
  type PrivateConversationCryptoStorage,
  type PublicBundle,
} from "./private-conversation-crypto";

const mocks = vi.hoisted(() => ({
  builders: [] as Array<{ store: unknown; address: unknown; version: string }>,
  ciphers: [] as Array<{ store: unknown; address: unknown; version: string }>,
  processPreKey: vi.fn().mockResolvedValue(undefined),
  generateIdentityKeyPair: vi.fn(),
  generateRegistrationId: vi.fn(),
  generateSignedPreKey: vi.fn(),
  generatePreKey: vi.fn(),
}));

vi.mock("libomemo.js", () => {
  class InMemoryStore {
    values = new Map<string, unknown>();
    signedPreKeys = new Map<number, unknown>();
    preKeys = new Map<number, unknown>();
    put(key: string, value: unknown) {
      this.values.set(key, value);
    }
    storeSignedPreKey(id: number, value: unknown) {
      this.signedPreKeys.set(id, value);
    }
    storePreKey(id: number, value: unknown) {
      this.preKeys.set(id, value);
    }
  }
  class OMEMOAddress {
    constructor(
      public peer: string,
      public deviceId: number,
    ) {}
  }
  class SessionBuilder {
    processPreKey = mocks.processPreKey;
    constructor(store: unknown, address: unknown, version: string) {
      mocks.builders.push({ store, address, version });
    }
  }
  class SessionCipher {
    constructor(store: unknown, address: unknown, version: string) {
      mocks.ciphers.push({ store, address, version });
    }
  }
  return {
    InMemoryStore,
    OMEMOAddress,
    SessionBuilder,
    SessionCipher,
    KeyHelper: {
      generateIdentityKeyPair: mocks.generateIdentityKeyPair,
      generateRegistrationId: mocks.generateRegistrationId,
      generateSignedPreKey: mocks.generateSignedPreKey,
      generatePreKey: mocks.generatePreKey,
    },
    curvePubKeyToEd25519PubKey: vi.fn(async (key: ArrayBuffer) => key),
  };
});

function bytes(...values: number[]) {
  return new Uint8Array(values).buffer;
}

const bundle: PublicBundle = {
  deviceId: 77,
  registrationId: 88,
  identityKey: btoa("identity"),
  signedPreKey: {
    keyId: 2,
    publicKey: btoa("signed-public"),
    signature: btoa("signature"),
  },
  preKey: { keyId: 3, publicKey: btoa("pre-key") },
};

let identities: Map<
  string,
  Awaited<ReturnType<PrivateConversationCryptoStorage["loadIdentity"]>>
>;
let trust: Map<string, string>;
let storage: PrivateConversationCryptoStorage;

beforeEach(() => {
  vi.clearAllMocks();
  identities = new Map();
  trust = new Map();
  storage = {
    loadIdentity: vi.fn(async (accountId) => identities.get(accountId)),
    saveIdentity: vi.fn(async (accountId, identity) => {
      identities.set(accountId, identity);
    }),
    loadTrustedIdentity: vi.fn((accountId, address) =>
      trust.get(`${accountId}:${address}`),
    ),
    saveTrustedIdentity: vi.fn((accountId, address, identity) => {
      trust.set(`${accountId}:${address}`, identity);
    }),
  };
  mocks.builders.length = 0;
  mocks.ciphers.length = 0;
  mocks.generateIdentityKeyPair.mockResolvedValue({
    pubKey: bytes(1, 2, 3),
    privKey: bytes(4, 5, 6),
  });
  mocks.generateRegistrationId.mockReturnValue(42);
  mocks.generateSignedPreKey.mockResolvedValue({
    keyId: 1,
    keyPair: { pubKey: bytes(7, 8), privKey: bytes(9, 10) },
    signature: bytes(11, 12),
  });
  mocks.generatePreKey.mockResolvedValue({
    keyId: 2,
    keyPair: { pubKey: bytes(13, 14), privKey: bytes(15, 16) },
  });
});

describe("private conversation crypto contexts", () => {
  it("creates, persists, and publishes a fresh identity", async () => {
    const context = await createPrivateConversationCryptoContext(
      "alice",
      storage,
    );

    expect(context.deviceId).toBe(42);
    expect(context.bundle).toEqual({
      deviceId: 42,
      registrationId: 42,
      identityKey: btoa(String.fromCharCode(1, 2, 3)),
      signedPreKey: {
        keyId: 1,
        publicKey: btoa(String.fromCharCode(7, 8)),
        signature: btoa(String.fromCharCode(11, 12)),
      },
      preKey: {
        keyId: 2,
        publicKey: btoa(String.fromCharCode(13, 14)),
      },
    });
    expect(storage.saveIdentity).toHaveBeenCalledWith("alice", {
      registrationId: 42,
      publicKey: btoa(String.fromCharCode(1, 2, 3)),
      privateKey: btoa(String.fromCharCode(4, 5, 6)),
    });
  });

  it("reuses a persisted identity without generating another", async () => {
    identities.set("alice", {
      registrationId: 91,
      publicKey: btoa("persisted-public"),
      privateKey: btoa("persisted-private"),
    });

    const context = await createPrivateConversationCryptoContext(
      "alice",
      storage,
    );

    expect(context.deviceId).toBe(91);
    expect(mocks.generateIdentityKeyPair).not.toHaveBeenCalled();
    expect(storage.saveIdentity).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted identity", async () => {
    identities.set("alice", {
      registrationId: 91,
      publicKey: "%%%",
      privateKey: "%%%",
    });

    await expect(
      createPrivateConversationCryptoContext("alice", storage),
    ).rejects.toThrow("The saved private conversation identity is invalid");
  });

  it("pins peer identity keys independently for each local account", async () => {
    const alice = await createPrivateConversationCryptoContext(
      "alice",
      storage,
    );
    const peerIdentity = bytes(20, 21);
    const changedIdentity = bytes(22, 23);
    const store = alice.store;

    expect(store.isTrustedIdentity("bob@example.test", peerIdentity, 1)).toBe(
      true,
    );
    expect(store.saveIdentity("bob@example.test", peerIdentity)).toBe(false);
    expect(store.loadIdentityKey("bob@example.test")).toEqual(peerIdentity);
    expect(
      store.isTrustedIdentity("bob@example.test", changedIdentity, 1),
    ).toBe(false);
    expect(store.saveIdentity("bob@example.test", changedIdentity)).toBe(true);

    const bob = await createPrivateConversationCryptoContext("bob", storage);
    expect(bob.store.loadIdentityKey("bob@example.test")).toBeUndefined();
  });

  it("builds initiator and responder ciphers for the peer device", async () => {
    const context = await createPrivateConversationCryptoContext(
      "alice",
      storage,
    );

    const initiator = await createInitiatorCipher(
      context,
      "bob@example.test",
      bundle,
    );
    const responder = createResponderCipher(
      context,
      "bob@example.test",
      bundle.deviceId,
    );

    expect(initiator).toBeTruthy();
    expect(responder).toBeTruthy();
    expect(mocks.builders[0].address).toMatchObject({
      peer: "bob@example.test",
      deviceId: 77,
    });
    expect(mocks.processPreKey).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: 88,
        identityKey: expect.any(ArrayBuffer),
      }),
    );
    expect(mocks.ciphers).toHaveLength(2);
    expect(mocks.ciphers[1].address).toMatchObject({
      peer: "bob@example.test",
      deviceId: 77,
    });
  });
});
