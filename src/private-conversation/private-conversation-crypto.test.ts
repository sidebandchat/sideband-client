import { describe, expect, it, vi } from "vitest";
import {
  decryptPrivateContent,
  encryptPrivateContent,
  validDeviceId,
  validEncryptedPrivateContent,
  validPublicBundle,
  type PrivateConversationCipher,
  type PublicBundle,
} from "./private-conversation-crypto";

const validBundle: PublicBundle = {
  deviceId: 101,
  registrationId: 202,
  identityKey: btoa("identity"),
  signedPreKey: {
    keyId: 1,
    publicKey: btoa("signed-public"),
    signature: btoa("signature"),
  },
  preKey: { keyId: 2, publicKey: btoa("pre-public") },
};

describe("private conversation crypto boundaries", () => {
  it.each([1, 42, Number.MAX_SAFE_INTEGER])(
    "accepts the valid device id %s",
    (deviceId) => expect(validDeviceId(deviceId)).toBe(true),
  );

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid device id %s",
    (deviceId) => expect(validDeviceId(deviceId)).toBe(false),
  );

  it("validates every required public-bundle field", () => {
    expect(validPublicBundle(validBundle)).toBe(true);
    expect(validPublicBundle(undefined)).toBe(false);
    expect(validPublicBundle({ ...validBundle, deviceId: 0 })).toBe(false);
    expect(validPublicBundle({ ...validBundle, registrationId: 0 })).toBe(
      false,
    );
    expect(validPublicBundle({ ...validBundle, identityKey: "" })).toBe(false);
    expect(
      validPublicBundle({
        ...validBundle,
        signedPreKey: { ...validBundle.signedPreKey, signature: "" },
      }),
    ).toBe(false);
    expect(
      validPublicBundle({
        ...validBundle,
        preKey: { ...validBundle.preKey, publicKey: "" },
      }),
    ).toBe(false);
  });

  it("serializes content before passing it to the session cipher", async () => {
    const encrypt = vi.fn(async () => ({
      type: 3,
      kex: true,
      body: "encrypted-bytes",
    }));
    const cipher = { encrypt } as unknown as PrivateConversationCipher;

    await expect(
      encryptPrivateContent(cipher, { type: "message", body: "secret" }),
    ).resolves.toEqual({
      type: 3,
      kex: true,
      body: btoa("encrypted-bytes"),
    });
    expect(encrypt).toHaveBeenCalledWith(
      JSON.stringify({ type: "message", body: "secret" }),
    );
  });

  it.each([
    [true, "decryptPreKeyWhisperMessage"],
    [false, "decryptWhisperMessage"],
  ] as const)(
    "uses the correct decryption path when kex is %s",
    async (kex, method) => {
      const plaintext = new TextEncoder().encode("decrypted message").buffer;
      const decryptPreKeyWhisperMessage = vi.fn(async () => ({ plaintext }));
      const decryptWhisperMessage = vi.fn(async () => ({ plaintext }));
      const cipher = {
        decryptPreKeyWhisperMessage,
        decryptWhisperMessage,
      } as unknown as PrivateConversationCipher;

      await expect(
        decryptPrivateContent(cipher, { type: 3, kex, body: "ciphertext" }),
      ).resolves.toBe("decrypted message");
      expect(
        method === "decryptPreKeyWhisperMessage"
          ? decryptPreKeyWhisperMessage
          : decryptWhisperMessage,
      ).toHaveBeenCalledWith("ciphertext", "base64");
    },
  );

  it("rejects malformed and mismatched encrypted envelopes", () => {
    const valid = {
      type: 3,
      kex: true,
      body: btoa("ciphertext"),
      deviceId: 101,
    };
    expect(validEncryptedPrivateContent(valid, 101)).toBe(true);
    expect(validEncryptedPrivateContent({ ...valid, deviceId: 102 }, 101)).toBe(
      false,
    );
    expect(validEncryptedPrivateContent({ ...valid, body: "%%%" }, 101)).toBe(
      false,
    );
    expect(
      validEncryptedPrivateContent({ ...valid, type: Number.NaN }, 101),
    ).toBe(false);
    expect(validEncryptedPrivateContent({ ...valid, kex: "yes" }, 101)).toBe(
      false,
    );
  });
});
