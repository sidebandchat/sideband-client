import { Tag } from "cbor-x";
import type {
  AttachmentGrant,
  AttachmentMetadata,
  AttachmentUploadTarget,
} from "../domain.js";
import type { AttachmentId, ConversationId } from "../entity-id.js";
import { decodeEntityRef, entityRef, wireMap } from "../sbp/codec.js";
import type { SbpCommandTransport } from "../sbp/command-transport.js";
import { decodeAttachment } from "../sbp/records.js";
import {
  mapValue,
  optional,
  required,
  textValue,
  timestampValue,
  unsignedValue,
} from "../sbp/value.js";

export type BeginAttachmentInput = {
  conversationId: ConversationId;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: Uint8Array;
  imageDimensions?: { width: number; height: number };
};

export type BeginAvatarInput = Omit<BeginAttachmentInput, "conversationId">;

export type AttachmentByteUpload = (
  target: AttachmentUploadTarget,
  options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
) => Promise<void>;

export class SbpAttachmentsClient {
  constructor(private readonly transport: SbpCommandTransport) {}

  async begin(input: BeginAttachmentInput): Promise<AttachmentUploadTarget> {
    if (input.sha256.byteLength !== 32)
      throw new TypeError("Attachment SHA-256 must contain 32 bytes");
    const response = mapValue(
      await this.transport.command(
        300,
        wireMap([
          [0, entityRef("conversation", input.conversationId)],
          [1, input.filename],
          [2, input.mediaType],
          [3, input.byteSize],
          [4, input.sha256],
          ...optionalEntry(
            5,
            input.imageDimensions &&
              wireMap([
                [0, input.imageDimensions.width],
                [1, input.imageDimensions.height],
              ]),
          ),
        ]),
      ),
    );
    return decodeUploadTarget(response);
  }

  async beginAvatar(input: BeginAvatarInput): Promise<AttachmentUploadTarget> {
    if (input.sha256.byteLength !== 32)
      throw new TypeError("Attachment SHA-256 must contain 32 bytes");
    if (!input.mediaType.startsWith("image/"))
      throw new TypeError("Avatar must be an image");

    return decodeUploadTarget(
      mapValue(
        await this.transport.command(
          303,
          wireMap([
            [0, input.filename],
            [1, input.mediaType],
            [2, input.byteSize],
            [3, input.sha256],
            ...optionalEntry(
              4,
              input.imageDimensions &&
                wireMap([
                  [0, input.imageDimensions.width],
                  [1, input.imageDimensions.height],
                ]),
            ),
          ]),
        ),
      ),
    );
  }

  async complete(attachmentId: AttachmentId): Promise<AttachmentMetadata> {
    return decodeAttachment(
      await this.transport.command(
        301,
        wireMap([[0, entityRef("attachment", attachmentId)]]),
      ),
    );
  }

  async grant(
    attachmentId: AttachmentId,
    disposition: "inline" | "download",
  ): Promise<AttachmentGrant> {
    const response = mapValue(
      await this.transport.command(
        302,
        wireMap([
          [0, entityRef("attachment", attachmentId)],
          [1, disposition === "download"],
        ]),
      ),
    );
    return {
      url: uriValue(required(response, 0)),
      expiresAt: timestampValue(required(response, 1)),
    };
  }

  async upload(
    input: BeginAttachmentInput,
    uploadBytes: AttachmentByteUpload,
    options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
  ) {
    const target = await this.begin(input);
    await uploadBytes(target, options);
    return this.complete(target.attachmentId);
  }

  async uploadAvatar(
    input: BeginAvatarInput,
    uploadBytes: AttachmentByteUpload,
    options?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
  ) {
    const target = await this.beginAvatar(input);
    await uploadBytes(target, options);
    return this.complete(target.attachmentId);
  }
}

function decodeUploadTarget(
  response: Map<number, unknown>,
): AttachmentUploadTarget {
  return {
    attachmentId: decodeEntityRef(required(response, 0), "attachment"),
    url: uriValue(required(response, 1)),
    expiresAt: timestampValue(required(response, 2)),
    method: decodeUploadMethod(required(response, 3)),
    headers: optional(response, 4, stringMap) ?? {},
  };
}

function decodeUploadMethod(value: unknown): "PUT" | "POST" {
  const method = unsignedValue(value);
  if (method === 0) return "PUT";
  if (method === 1) return "POST";
  throw new TypeError("Invalid attachment upload method");
}

function uriValue(value: unknown) {
  if (!(value instanceof Tag) || value.tag !== 32)
    throw new TypeError("Expected an SBP URI");
  return textValue(value.value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!(value instanceof Map)) throw new TypeError("Expected upload headers");
  return Object.fromEntries(
    [...value].map(([key, entry]) => [textValue(key), textValue(entry)]),
  );
}

function optionalEntry(key: number, value: unknown): [number, unknown][] {
  return value === undefined ? [] : [[key, value]];
}
