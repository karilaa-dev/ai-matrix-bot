import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessController } from "../src/runtime/access.js";
import { CommandHandler } from "../src/runtime/commands.js";
import { MatrixStore } from "../src/storage/sqlite.js";

let directories: string[] = [];

function setup(owner = false) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-commands-"));
  directories.push(directory);
  const store = new MatrixStore(join(directory, "adapter.sqlite"));
  const access = {
    isOwner: vi.fn(() => owner),
    allow: vi.fn(() => owner),
    deny: vi.fn(async () => owner),
    list: vi.fn(() => owner ? ["@owner:example.org", "@alice:example.org"] : undefined),
  } as unknown as AccessController;
  return { access, handler: new CommandHandler(store, access), store };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("CommandHandler", () => {
  it("ignores non-command messages and exposes conversation actions", async () => {
    const { handler, store } = setup();
    try {
      await expect(handler.handle("@alice:example.org", "hello")).resolves.toBeUndefined();
      await expect(handler.handle("@alice:example.org", "!stop")).resolves.toEqual({ kind: "stop" });
      await expect(handler.handle("@alice:example.org", "!compact")).resolves.toEqual({ kind: "compact" });
      await expect(handler.handle("@alice:example.org", "!retry")).resolves.toEqual({ kind: "retry" });
      await expect(handler.handle("@alice:example.org", "!fork Research topic")).resolves.toEqual({
        kind: "fork",
        title: "Research topic",
      });
    } finally {
      store.close();
    }
  });

  it("persists locale, timezone, and stream preferences", async () => {
    const { handler, store } = setup();
    try {
      await handler.handle("@alice:example.org", "!lang ru");
      await handler.handle("@alice:example.org", "!timezone -07:30");
      await handler.handle("@alice:example.org", "!stream off");

      expect(store.getPreferences("@alice:example.org")).toEqual({
        mxid: "@alice:example.org",
        locale: "ru",
        timezoneOffsetMinutes: -450,
        streamEnabled: false,
      });
      await expect(handler.handle("@alice:example.org", "!help")).resolves.toMatchObject({
        kind: "reply",
        markdown: expect.stringContaining("**Команды**"),
      });
    } finally {
      store.close();
    }
  });

  it.each(["+14:01", "-15:00", "+10:99", "PST", "+"]) ("rejects invalid timezone %s", async (value) => {
    const { handler, store } = setup();
    try {
      await expect(handler.handle("@alice:example.org", `!timezone ${value}`)).resolves.toEqual({
        kind: "reply",
        markdown: "Usage: `!timezone ±HH:MM`",
      });
    } finally {
      store.close();
    }
  });

  it("keeps allowlist commands owner-only", async () => {
    const nonOwner = setup(false);
    const owner = setup(true);
    try {
      await expect(nonOwner.handler.handle("@alice:example.org", "!allow @bob:example.org")).resolves.toMatchObject({
        markdown: expect.stringContaining("owner only"),
      });
      await expect(nonOwner.handler.handle("@alice:example.org", "!users")).resolves.toMatchObject({
        markdown: "You are not authorized to use this bot.",
      });
      await expect(owner.handler.handle("@owner:example.org", "!users")).resolves.toMatchObject({
        markdown: "- @owner:example.org\n- @alice:example.org",
      });
    } finally {
      nonOwner.store.close();
      owner.store.close();
    }
  });
});
