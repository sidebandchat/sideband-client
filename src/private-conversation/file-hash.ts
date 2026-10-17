import { sha256 } from "@noble/hashes/sha2";

const HASH_CHUNK_BYTES = 1024 * 1024;

export async function sha256Blob(blob: Blob) {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    const bytes = new Uint8Array(
      await blob
        .slice(offset, Math.min(blob.size, offset + HASH_CHUNK_BYTES))
        .arrayBuffer(),
    );
    hash.update(bytes);
  }
  return Array.from(hash.digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
