import { Tag } from "cbor-x";
import { describe, expect, it, vi } from "vitest";
import { entityId } from "../entity-id.js";
import { decodeEntityRef, entityRef } from "../sbp/codec.js";
import { SbpAttachmentsClient } from "./attachment-client.js";

const conversationId = entityId<"conversation">(
  "11111111-1111-4111-8111-111111111111",
);
const attachmentId = entityId<"attachment">(
  "22222222-2222-4222-8222-222222222222",
);
const digest = new Uint8Array(32).fill(7);

describe("SbpAttachmentsClient", () => {
  it("begins an authenticated upload with immutable file metadata", async () => {
    const command = vi.fn().mockResolvedValue(uploadTarget());
    const client = new SbpAttachmentsClient({ command });

    const target = await client.begin({
      conversationId,
      filename: "photo.png",
      mediaType: "image/png",
      byteSize: 1234,
      sha256: digest,
      imageDimensions: { width: 320, height: 200 },
    });

    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(300);
    expect(decodeEntityRef(payload.get(0), "conversation")).toBe(
      conversationId,
    );
    expect(payload.get(4)).toBe(digest);
    expect(payload.get(5).get(0)).toBe(320);
    expect(target).toMatchObject({
      attachmentId,
      method: "PUT",
      headers: { "content-type": "image/png" },
    });
  });

  it("streams bytes before asking SBP to complete the attachment", async () => {
    const command = vi
      .fn()
      .mockResolvedValueOnce(uploadTarget())
      .mockResolvedValueOnce(attachmentRecord());
    const uploadBytes = vi.fn().mockResolvedValue(undefined);
    const client = new SbpAttachmentsClient({ command });

    const attachment = await client.upload(
      {
        conversationId,
        filename: "notes.bin",
        mediaType: "application/octet-stream",
        byteSize: 1234,
        sha256: digest,
      },
      uploadBytes,
    );

    expect(uploadBytes).toHaveBeenCalledOnce();
    expect(command.mock.calls.map(([opcode]) => opcode)).toEqual([300, 301]);
    expect(attachment.id).toBe(attachmentId);
  });

  it("reserves an account avatar without manufacturing a conversation", async () => {
    const command = vi.fn().mockResolvedValue(uploadTarget());
    const client = new SbpAttachmentsClient({ command });

    await client.beginAvatar({
      filename: "avatar.png",
      mediaType: "image/png",
      byteSize: 1234,
      sha256: digest,
      imageDimensions: { width: 256, height: 256 },
    });

    const [opcode, payload] = command.mock.calls[0]!;
    expect(opcode).toBe(303);
    expect(payload.get(0)).toBe("avatar.png");
    expect(payload.get(3)).toBe(digest);
    expect(payload.get(4).get(0)).toBe(256);
  });

  it("rejects a malformed digest before sending a command", async () => {
    const command = vi.fn();
    const client = new SbpAttachmentsClient({ command });
    await expect(
      client.begin({
        conversationId,
        filename: "bad.bin",
        mediaType: "application/octet-stream",
        byteSize: 1,
        sha256: new Uint8Array(31),
      }),
    ).rejects.toThrow("32 bytes");
    expect(command).not.toHaveBeenCalled();
  });
});

function uploadTarget() {
  return new Map([
    [0, entityRef("attachment", attachmentId)],
    [1, new Tag("https://example.test/upload", 32)],
    [2, new Date("2026-01-01T00:01:00Z")],
    [3, 0],
    [4, new Map([["content-type", "image/png"]])],
  ]);
}

function attachmentRecord() {
  return new Map([
    [0, entityRef("attachment", attachmentId)],
    [1, "notes.bin"],
    [2, "application/octet-stream"],
    [3, 1234],
    [4, digest],
    [6, 1],
  ]);
}
