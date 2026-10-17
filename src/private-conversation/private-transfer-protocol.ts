import { base64 } from "@scure/base";
import { PRIVATE_TRANSFER_LIMITS } from "./private-transfer-limits.js";

export { PRIVATE_TRANSFER_LIMITS } from "./private-transfer-limits.js";

const VERSION = 1;
const NONCE_BYTES = 12;
const UUID_BYTES = 16;
const CHUNK_HEADER_BYTES = 1 + UUID_BYTES + 4;
const CONTROL_KIND = 1;
const CHUNK_KIND = 2;
const MAX_CONTROL_BYTES = 16 * 1024;

export type PrivateTransferFile = {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
};

export type PrivateTransferControl =
  | {
      kind: "offer";
      messageId: string;
      body?: string;
      files: PrivateTransferFile[];
    }
  | { kind: "accept"; fileIds: string[] }
  | { kind: "decline"; fileIds: string[] }
  | { kind: "ack"; fileId: string; chunk: number }
  | { kind: "complete"; fileId: string }
  | { kind: "cancel"; fileId: string }
  | { kind: "failed"; fileId: string; reason: string };

export type PrivateTransferFrame =
  | { kind: "control"; control: PrivateTransferControl }
  | { kind: "chunk"; fileId: string; chunk: number; bytes: Uint8Array };

export async function createPrivateTransferKey(
  runtime: Crypto = globalThis.crypto,
) {
  return runtime.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportPrivateTransferKey(
  key: CryptoKey,
  runtime: Crypto = globalThis.crypto,
) {
  return base64.encode(
    new Uint8Array(await runtime.subtle.exportKey("raw", key)),
  );
}

export async function importPrivateTransferKey(
  encoded: string,
  runtime: Crypto = globalThis.crypto,
) {
  const raw = Uint8Array.from(base64.decode(encoded));
  if (raw.byteLength !== 32) throw new Error("Invalid private transfer key");
  return runtime.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptPrivateTransferControl(
  key: CryptoKey,
  control: PrivateTransferControl,
  runtime: Crypto = globalThis.crypto,
) {
  if (!validPrivateTransferControl(control))
    throw new Error("Invalid private transfer control message");
  const encoded = new TextEncoder().encode(JSON.stringify(control));
  if (encoded.byteLength > MAX_CONTROL_BYTES)
    throw new Error("Private transfer control message is too large");
  return encryptFrame(
    key,
    join(new Uint8Array([CONTROL_KIND]), encoded),
    runtime,
  );
}

export async function encryptPrivateTransferChunk(
  key: CryptoKey,
  fileId: string,
  chunk: number,
  bytes: Uint8Array,
  runtime: Crypto = globalThis.crypto,
) {
  if (
    !validUuid(fileId) ||
    !Number.isSafeInteger(chunk) ||
    chunk < 0 ||
    chunk > 0xffffffff ||
    bytes.byteLength === 0 ||
    bytes.byteLength > PRIVATE_TRANSFER_LIMITS.chunkBytes
  ) {
    throw new Error("Invalid private transfer chunk");
  }
  const header = new Uint8Array(CHUNK_HEADER_BYTES);
  header[0] = CHUNK_KIND;
  header.set(uuidBytes(fileId), 1);
  new DataView(header.buffer).setUint32(1 + UUID_BYTES, chunk);
  return encryptFrame(key, join(header, bytes), runtime);
}

export async function decryptPrivateTransferFrame(
  key: CryptoKey,
  frame: ArrayBuffer | Uint8Array,
  runtime: Crypto = globalThis.crypto,
): Promise<PrivateTransferFrame> {
  const bytes = asBytes(frame);
  if (bytes.byteLength <= 1 + NONCE_BYTES + 16)
    throw new Error("Invalid private transfer frame");
  if (bytes[0] !== VERSION)
    throw new Error("Unsupported private transfer frame");
  const nonce = bytes.slice(1, 1 + NONCE_BYTES);
  const ciphertext = bytes.slice(1 + NONCE_BYTES);
  const plaintext = new Uint8Array(
    await runtime.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );

  if (plaintext[0] === CONTROL_KIND) {
    const control = parseControl(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext.slice(1)),
    );
    return { kind: "control", control };
  }
  if (
    plaintext[0] === CHUNK_KIND &&
    plaintext.byteLength > CHUNK_HEADER_BYTES
  ) {
    const fileId = bytesUuid(plaintext.slice(1, 1 + UUID_BYTES));
    const chunk = new DataView(
      plaintext.buffer,
      plaintext.byteOffset + 1 + UUID_BYTES,
      4,
    ).getUint32(0);
    const chunkBytes = plaintext.slice(CHUNK_HEADER_BYTES);
    if (chunkBytes.byteLength > PRIVATE_TRANSFER_LIMITS.chunkBytes)
      throw new Error("Private transfer chunk is too large");
    return { kind: "chunk", fileId, chunk, bytes: chunkBytes };
  }
  throw new Error("Invalid private transfer frame");
}

export function validPrivateTransferControl(
  value: unknown,
): value is PrivateTransferControl {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "offer") {
    return (
      validUuid(value.messageId) &&
      (value.body === undefined ||
        (typeof value.body === "string" && value.body.length <= 8_000)) &&
      Array.isArray(value.files) &&
      value.files.length > 0 &&
      value.files.length <= PRIVATE_TRANSFER_LIMITS.maximumFilesPerMessage &&
      value.files.every(validFile) &&
      value.files.reduce((sum, file) => sum + file.byteSize, 0) <=
        PRIVATE_TRANSFER_LIMITS.maximumMessageBytes
    );
  }
  if (value.kind === "accept" || value.kind === "decline")
    return validIds(value.fileIds);
  if (value.kind === "ack")
    return (
      validUuid(value.fileId) &&
      Number.isSafeInteger(value.chunk) &&
      Number(value.chunk) >= 0
    );
  if (
    value.kind === "complete" ||
    value.kind === "cancel" ||
    value.kind === "failed"
  ) {
    return (
      validUuid(value.fileId) &&
      (value.kind !== "failed" ||
        (typeof value.reason === "string" && value.reason.length <= 256))
    );
  }
  return false;
}

async function encryptFrame(
  key: CryptoKey,
  plaintext: Uint8Array,
  runtime: Crypto,
) {
  const nonce = runtime.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ownedPlaintext = new Uint8Array(plaintext.byteLength);
  ownedPlaintext.set(plaintext);
  const ciphertext = new Uint8Array(
    await runtime.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ownedPlaintext,
    ),
  );
  return join(new Uint8Array([VERSION]), nonce, ciphertext);
}

function parseControl(encoded: string) {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Invalid private transfer control message");
  }
  if (!validPrivateTransferControl(value))
    throw new Error("Invalid private transfer control message");
  return value;
}

function validFile(value: unknown): value is PrivateTransferFile {
  if (!record(value)) return false;
  return (
    validUuid(value.id) &&
    typeof value.filename === "string" &&
    value.filename.length > 0 &&
    value.filename.length <= 255 &&
    !/[\\/\0]/u.test(value.filename) &&
    typeof value.mediaType === "string" &&
    value.mediaType.length <= 255 &&
    Number.isSafeInteger(value.byteSize) &&
    Number(value.byteSize) > 0 &&
    Number(value.byteSize) <= PRIVATE_TRANSFER_LIMITS.maximumFileBytes &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    validDimension(value.width) &&
    validDimension(value.height)
  );
}

function validDimension(value: unknown) {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      Number(value) > 0 &&
      Number(value) <= 32_768)
  );
}

function validIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= PRIVATE_TRANSFER_LIMITS.maximumFilesPerMessage &&
    new Set(value).size === value.length &&
    value.every(validUuid)
  );
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function uuidBytes(value: string) {
  return Uint8Array.from(
    value
      .replaceAll("-", "")
      .match(/.{2}/gu)!
      .map((pair) => Number.parseInt(pair, 16)),
  );
}

function bytesUuid(value: Uint8Array) {
  const hex = Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function join(...values: Uint8Array[]) {
  const result = new Uint8Array(
    values.reduce((length, value) => length + value.byteLength, 0),
  );
  let offset = 0;
  values.forEach((value) => {
    result.set(value, offset);
    offset += value.byteLength;
  });
  return result;
}

function asBytes(value: ArrayBuffer | Uint8Array) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
