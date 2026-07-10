import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireWritableSecretOutput } from "../src/bootstrap-files.js";

const paths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bootstrap secret outputs", () => {
  it("creates a private parent directory for a new output", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-bootstrap-"));
    paths.push(root);
    const output = join(root, "private", "recovery-key");

    requireWritableSecretOutput(output, "Matrix recovery key", "--recovery-key-out");

    expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
  });

  it("rejects a read-only secret before creating remote credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-bootstrap-"));
    paths.push(root);
    const output = join(root, "recovery-key");
    writeFileSync(output, "", { mode: 0o400 });

    try {
      expect(() => requireWritableSecretOutput(
        output,
        "Matrix recovery key",
        "--recovery-key-out",
      )).toThrow(/Docker secrets are read-only/);
    } finally {
      chmodSync(output, 0o600);
    }

    expect(readFileSync(output, "utf8")).toBe("");
  });
});
