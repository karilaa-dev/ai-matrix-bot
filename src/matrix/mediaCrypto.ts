import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { MatrixEncryptedFile } from "./types.js";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function encryptMedia(plain: Buffer): { ciphertext: Buffer; file: Omit<MatrixEncryptedFile, "url"> } {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    ciphertext,
    file: {
      key: { alg: "A256CTR", ext: true, k: base64Url(key), key_ops: ["encrypt", "decrypt"], kty: "oct" },
      iv: iv.toString("base64"),
      hashes: { sha256: createHash("sha256").update(ciphertext).digest("base64") },
      v: "v2",
    },
  };
}

export function decryptMedia(ciphertext: Buffer, file: MatrixEncryptedFile): Buffer {
  const expected = file.hashes.sha256;
  if (!expected) throw new Error("Encrypted Matrix attachment has no sha256 hash");
  const actual = createHash("sha256").update(ciphertext).digest();
  const expectedBuffer = fromBase64(expected);
  if (actual.length !== expectedBuffer.length || !actual.equals(expectedBuffer)) {
    throw new Error("Encrypted Matrix attachment hash mismatch");
  }
  const encodedKey = typeof file.key.k === "string" ? file.key.k : "";
  if (!encodedKey) throw new Error("Encrypted Matrix attachment has no key");
  const decipher = createDecipheriv("aes-256-ctr", fromBase64(encodedKey), fromBase64(file.iv));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
