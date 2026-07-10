import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeLock } from "../src/runtime/lock.js";

let directories: string[] = [];

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "matrix-lock-"));
  directories.push(directory);
  return join(directory, "bot.lock");
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("RuntimeLock", () => {
  it("prevents a second process owner from taking a live lock", () => {
    const path = lockPath();
    const first = new RuntimeLock(path);
    const second = new RuntimeLock(path);
    first.acquire();
    try {
      expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
      expect(() => second.acquire()).toThrow("Another ai-matrix-bot process");
    } finally {
      first.release();
    }
  });

  it("reclaims a stale PID lock and releases only after acquisition", () => {
    const path = lockPath();
    writeFileSync(path, "2147483647\n", { mode: 0o600 });
    const lock = new RuntimeLock(path);

    lock.acquire();
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
    lock.release();
  });
});
