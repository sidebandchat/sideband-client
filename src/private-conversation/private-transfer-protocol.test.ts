import { describe, expect, it } from "vitest";
import {
  createPrivateTransferKey,
  decryptPrivateTransferFrame,
  encryptPrivateTransferChunk,
  encryptPrivateTransferControl,
  exportPrivateTransferKey,
  importPrivateTransferKey,
  PRIVATE_TRANSFER_LIMITS,
  validPrivateTransferControl,
} from "./private-transfer-protocol";

const fileId = "ccf7717f-9562-4ff3-a8b2-b68a61aa14d1";
const messageId = "437c1414-8f11-43f6-b582-a9a3fc351468";

describe("private transfer protocol", () => {
  it("round trips an exported room key", async () => {
    const key = await createPrivateTransferKey();
    const imported = await importPrivateTransferKey(
      await exportPrivateTransferKey(key),
    );
    const frame = await encryptPrivateTransferControl(imported, {
      kind: "accept",
      fileIds: [fileId],
    });
    await expect(decryptPrivateTransferFrame(key, frame)).resolves.toEqual({
      kind: "control",
      control: { kind: "accept", fileIds: [fileId] },
    });
  });

  it("encrypts metadata so it is absent from the relayed frame", async () => {
    const key = await createPrivateTransferKey();
    const frame = await encryptPrivateTransferControl(key, {
      kind: "offer",
      messageId,
      body: "secret caption",
      files: [
        {
          id: fileId,
          filename: "private-photo.png",
          mediaType: "image/png",
          byteSize: 123,
          sha256: "a".repeat(64),
        },
      ],
    });
    const wire = new TextDecoder().decode(frame);
    expect(wire).not.toContain("private-photo");
    expect(wire).not.toContain("secret caption");
    expect((await decryptPrivateTransferFrame(key, frame)).kind).toBe(
      "control",
    );
  });

  it("round trips bounded binary chunks", async () => {
    const key = await createPrivateTransferKey();
    const bytes = crypto.getRandomValues(new Uint8Array(1024));
    const frame = await encryptPrivateTransferChunk(key, fileId, 42, bytes);
    const decoded = await decryptPrivateTransferFrame(key, frame);
    expect(decoded).toEqual({ kind: "chunk", fileId, chunk: 42, bytes });
  });

  it("rejects tampering and the wrong room key", async () => {
    const key = await createPrivateTransferKey();
    const frame = await encryptPrivateTransferChunk(
      key,
      fileId,
      0,
      new Uint8Array([1, 2, 3]),
    );
    frame[frame.length - 1] ^= 1;
    await expect(decryptPrivateTransferFrame(key, frame)).rejects.toThrow();

    const otherKey = await createPrivateTransferKey();
    const validFrame = await encryptPrivateTransferControl(key, {
      kind: "cancel",
      fileId,
    });
    await expect(
      decryptPrivateTransferFrame(otherKey, validFrame),
    ).rejects.toThrow();
  });

  it("enforces file, filename, aggregate, and chunk limits", async () => {
    expect(
      validPrivateTransferControl({
        kind: "offer",
        messageId,
        files: [
          {
            id: fileId,
            filename: "../escape.exe",
            mediaType: "application/octet-stream",
            byteSize: 1,
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).toBe(false);

    const key = await createPrivateTransferKey();
    await expect(
      encryptPrivateTransferChunk(
        key,
        fileId,
        0,
        new Uint8Array(PRIVATE_TRANSFER_LIMITS.chunkBytes + 1),
      ),
    ).rejects.toThrow("Invalid private transfer chunk");
  });
});
