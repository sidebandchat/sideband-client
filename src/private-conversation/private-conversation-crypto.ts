import {
  InMemoryStore,
  KeyHelper,
  OMEMOAddress,
  SessionBuilder,
  SessionCipher,
  curvePubKeyToEd25519PubKey,
  type Direction,
  type KeyPair,
  type PreKeyBundle,
} from "libomemo.js";
import { base64 } from "@scure/base";
const OMEMO_VERSION = "urn:xmpp:omemo:2" as const;

export type PublicBundle = {
  deviceId: number;
  registrationId: number;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  preKey: { keyId: number; publicKey: string };
};

export type PrivateConversationCryptoContext = {
  store: InMemoryStore;
  deviceId: number;
  bundle: PublicBundle;
};

export type PrivateConversationCipher = SessionCipher;

export type EncryptedPrivateContent = {
  type: number;
  kex?: boolean;
  body: string;
};

export type StoredPrivateConversationIdentity = {
  registrationId: number;
  publicKey: string;
  privateKey: string;
};

export type PrivateConversationCryptoStorage = {
  loadIdentity: (
    accountId: string,
  ) => Promise<StoredPrivateConversationIdentity | undefined>;
  saveIdentity: (
    accountId: string,
    identity: StoredPrivateConversationIdentity,
  ) => Promise<void>;
  loadTrustedIdentity: (
    accountId: string,
    address: string,
  ) => string | undefined;
  saveTrustedIdentity: (
    accountId: string,
    address: string,
    identityKey: string,
  ) => void;
};

export async function createPrivateConversationCryptoContext(
  accountId: string,
  storage: PrivateConversationCryptoStorage,
): Promise<PrivateConversationCryptoContext> {
  const store = new PrivateConversationStore(accountId, storage);
  const persisted = await loadOrCreateIdentity(accountId, storage);
  const identity = persisted.identity;
  const registrationId = persisted.registrationId;
  const signedPreKey = await KeyHelper.generateSignedPreKey(
    identity,
    1,
    OMEMO_VERSION,
  );
  const preKey = await KeyHelper.generatePreKey(1);
  store.put("identityKey", identity);
  store.put("registrationId", registrationId);
  store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  store.storePreKey(preKey.keyId, preKey.keyPair);
  const publishedIdentity = await curvePubKeyToEd25519PubKey(identity.pubKey);
  return {
    store,
    deviceId: registrationId,
    bundle: {
      deviceId: registrationId,
      registrationId,
      identityKey: encode(publishedIdentity),
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: encode(signedPreKey.keyPair.pubKey),
        signature: encode(signedPreKey.signature),
      },
      preKey: {
        keyId: Number(preKey.keyId),
        publicKey: encode(preKey.keyPair.pubKey),
      },
    },
  };
}

export async function createInitiatorCipher(
  context: PrivateConversationCryptoContext,
  peer: string,
  bundle: PublicBundle,
) {
  const address = new OMEMOAddress(peer, bundle.deviceId);
  await new SessionBuilder(context.store, address, OMEMO_VERSION).processPreKey(
    decodeBundle(bundle),
  );
  return new SessionCipher(context.store, address, OMEMO_VERSION);
}

export function createResponderCipher(
  context: PrivateConversationCryptoContext,
  peer: string,
  remoteDeviceId: number,
) {
  return new SessionCipher(
    context.store,
    new OMEMOAddress(peer, remoteDeviceId),
    OMEMO_VERSION,
  );
}

export async function encryptPrivateContent(
  cipher: PrivateConversationCipher,
  content: Record<string, unknown>,
): Promise<EncryptedPrivateContent> {
  const encrypted = await cipher.encrypt(JSON.stringify(content));
  return {
    type: encrypted.type,
    kex: encrypted.kex,
    body: btoa(encrypted.body),
  };
}

export async function decryptPrivateContent(
  cipher: PrivateConversationCipher,
  encrypted: EncryptedPrivateContent,
) {
  const decrypted = encrypted.kex
    ? await cipher.decryptPreKeyWhisperMessage(encrypted.body, "base64")
    : await cipher.decryptWhisperMessage(encrypted.body, "base64");
  return new TextDecoder().decode(decrypted.plaintext);
}

export function validEncryptedPrivateContent(
  value: unknown,
  expectedDeviceId: number,
): value is EncryptedPrivateContent & { deviceId: number } {
  const encrypted = value as
    Partial<EncryptedPrivateContent & { deviceId: number }> | undefined;
  return Boolean(
    encrypted &&
    typeof encrypted.type === "number" &&
    Number.isSafeInteger(encrypted.type) &&
    encrypted.type >= 0 &&
    encrypted.type <= 255 &&
    (encrypted.kex === undefined || typeof encrypted.kex === "boolean") &&
    validDeviceId(encrypted.deviceId) &&
    encrypted.deviceId === expectedDeviceId &&
    validBase64(encrypted.body, 1_000_000),
  );
}

export function validPublicBundle(
  bundle: PublicBundle | undefined,
): bundle is PublicBundle {
  return Boolean(
    bundle &&
    validDeviceId(bundle.deviceId) &&
    validDeviceId(bundle.registrationId) &&
    validBase64(bundle.identityKey, 4096) &&
    validDeviceId(bundle.signedPreKey?.keyId) &&
    validBase64(bundle.signedPreKey.publicKey, 4096) &&
    validBase64(bundle.signedPreKey.signature, 4096) &&
    validDeviceId(bundle.preKey?.keyId) &&
    validBase64(bundle.preKey.publicKey, 4096),
  );
}

export function validDeviceId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function decodeBundle(bundle: PublicBundle): PreKeyBundle {
  return {
    registrationId: bundle.registrationId,
    identityKey: decode(bundle.identityKey),
    signedPreKey: {
      keyId: bundle.signedPreKey.keyId,
      publicKey: decode(bundle.signedPreKey.publicKey),
      signature: decode(bundle.signedPreKey.signature),
    },
    preKey: {
      keyId: bundle.preKey.keyId,
      publicKey: decode(bundle.preKey.publicKey),
    },
  };
}

class PrivateConversationStore extends InMemoryStore {
  constructor(
    private readonly accountId: string,
    private readonly storage: PrivateConversationCryptoStorage,
  ) {
    super();
  }

  override isTrustedIdentity(
    address: string,
    identityKey: ArrayBuffer,
    _direction: Direction,
  ) {
    const trusted = this.storage.loadTrustedIdentity(this.accountId, address);
    return !trusted || trusted === encode(identityKey);
  }

  override loadIdentityKey(address: string) {
    const trusted = this.storage.loadTrustedIdentity(this.accountId, address);
    return trusted ? decode(trusted) : undefined;
  }

  override saveIdentity(address: string, identityKey: ArrayBuffer) {
    const existing = this.storage.loadTrustedIdentity(this.accountId, address);
    const encoded = encode(identityKey);
    if (existing && existing !== encoded) return true;
    this.storage.saveTrustedIdentity(this.accountId, address, encoded);
    return false;
  }
}

async function loadOrCreateIdentity(
  accountId: string,
  storage: PrivateConversationCryptoStorage,
): Promise<{
  registrationId: number;
  identity: KeyPair;
}> {
  const stored = await storage.loadIdentity(accountId);
  if (stored) {
    try {
      return {
        registrationId: stored.registrationId,
        identity: {
          pubKey: decode(stored.publicKey),
          privKey: decode(stored.privateKey),
        },
      };
    } catch {
      throw new Error("The saved private conversation identity is invalid");
    }
  }

  const identity = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  await storage.saveIdentity(accountId, {
    registrationId,
    publicKey: encode(identity.pubKey),
    privateKey: encode(identity.privKey),
  });
  return { registrationId, identity };
}

function encode(value: ArrayBuffer) {
  return base64.encode(
    value instanceof Uint8Array ? value : new Uint8Array(value),
  );
}

function decode(value: string) {
  return Uint8Array.from(base64.decode(value)).buffer;
}

function validBase64(value: unknown, maximumLength: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.length % 4 === 1 ||
    !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)
  ) {
    return false;
  }
  try {
    return base64.decode(value).length > 0;
  } catch {
    return false;
  }
}
