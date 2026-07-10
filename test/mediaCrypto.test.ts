import { describe, expect, it } from "vitest";
import { decryptMedia, encryptMedia } from "../src/matrix/mediaCrypto.js";

describe("Matrix encrypted media", () => {
  it("round-trips bytes with a Matrix v2 encrypted-file descriptor", () => {
    const plain = Buffer.from("private attachment \u0000 with binary", "utf8");
    const encrypted = encryptMedia(plain);

    expect(encrypted.ciphertext).not.toEqual(plain);
    expect(encrypted.file).toMatchObject({
      key: { alg: "A256CTR", ext: true, kty: "oct", key_ops: ["encrypt", "decrypt"] },
      hashes: { sha256: expect.any(String) },
      v: "v2",
    });
    expect(decryptMedia(encrypted.ciphertext, { ...encrypted.file, url: "mxc://example.org/media" })).toEqual(plain);
  });

  it("rejects a tampered ciphertext before attempting decryption", () => {
    const encrypted = encryptMedia(Buffer.from("original"));
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(() => decryptMedia(tampered, { ...encrypted.file, url: "mxc://example.org/media" }))
      .toThrow("Encrypted Matrix attachment hash mismatch");
  });

  it("rejects descriptors without a content hash or key", () => {
    const encrypted = encryptMedia(Buffer.from("original"));
    expect(() => decryptMedia(encrypted.ciphertext, {
      ...encrypted.file,
      url: "mxc://example.org/media",
      hashes: {},
    })).toThrow("has no sha256 hash");
    expect(() => decryptMedia(encrypted.ciphertext, {
      ...encrypted.file,
      url: "mxc://example.org/media",
      key: {},
    })).toThrow("has no key");
  });
});
