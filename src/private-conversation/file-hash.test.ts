import { describe, expect, it } from "vitest";
import { sha256Blob } from "./file-hash.js";

describe("sha256Blob", () => {
  it("hashes an empty blob", async () => {
    await expect(sha256Blob(new Blob())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes data incrementally across internal chunk boundaries", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 17);
    bytes.fill(97);

    await expect(sha256Blob(new Blob([bytes]))).resolves.toBe(
      "c26032d5154f96bd29c799447d715ab681d8d0aa308ecc6f321a35d98f0672da",
    );
  });
});
