import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const originalEnv = { ...process.env };
let temporaryDirectories: string[] = [];

function requiredEnvironment(): void {
  process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org///";
  process.env.MATRIX_OWNER_ID = "@owner:example.org";
  process.env.MATRIX_ACCESS_TOKEN = "test-access-token";
}

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const name of Object.keys(process.env)) {
    if (
      name.startsWith("MATRIX_") ||
      name.startsWith("CORE_") ||
      name.startsWith("CODEX_") ||
      name.startsWith("OPENROUTER_") ||
      name.startsWith("BASH_") ||
      name === "FILE_ROOT" ||
      name === "BASH_ROOT" ||
      name === "DOCLING_URL" ||
      name === "DOCLING_TIMEOUT_MS" ||
      name === "TAVILY_API_KEY" ||
      name === "REASONING_EFFORT" ||
      name === "REASONING_SUMMARY" ||
      name === "RECENT_WINDOW_MESSAGES" ||
      name === "CONTEXT_WARN_RATIO" ||
      name === "SYSTEM_PROMPT_PATH" ||
      name === "LOG_LEVEL"
    ) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories = [];
});

describe("loadConfig", () => {
  it("normalizes the homeserver and applies safe runtime defaults", () => {
    requiredEnvironment();

    const config = loadConfig();

    expect(config.matrix).toMatchObject({
      homeserverUrl: "https://matrix.example.org",
      ownerId: "@owner:example.org",
      accessToken: "test-access-token",
      deviceId: "AI_MATRIX_BOT",
      globalConcurrency: 4,
      batchWindowMs: 750,
      maxEventBytes: 60_000,
    });
    expect(config.matrix.databasePath).toBe(resolve("data/matrix-bot.sqlite"));
    expect(config.core.databaseUrl).toBe("file:data/codex-core.sqlite");
    expect(config.core.fileRoot).toBe(resolve("data/files"));
    expect(config.core.bashRoot).toBe(resolve("data/bash"));
    expect(config.core).toMatchObject({
      codexModel: "gpt-5.6-sol",
      codexCompactionModel: "gpt-5.6-luna",
      codexImageModel: "gpt-image-2",
      codexImageQuality: "low",
      codexSpeedMode: "fast",
      openRouterEmbeddingModel: "perplexity/pplx-embed-v1-0.6b",
      contextWarningRatio: 0.85,
      recentWindowMessages: 20,
    });
    expect(config.logLevel).toBe("info");
  });

  it("reads trimmed Matrix secrets from files without retaining the password", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "file-access-token\n");
    writeFileSync(recoveryKeyPath, "file-recovery-key\n");
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    const config = loadConfig();

    expect(config.matrix.accessToken).toBe("file-access-token");
    expect(config.matrix.recoveryKey).toBe("file-recovery-key");
    expect(JSON.stringify(config)).not.toContain("password");
  });

  it("prefers explicitly supplied Matrix secrets over secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "stale-file-token");
    writeFileSync(recoveryKeyPath, "stale-file-recovery-key");
    requiredEnvironment();
    process.env.MATRIX_RECOVERY_KEY = "direct-recovery-key";
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "test-access-token",
      recoveryKey: "direct-recovery-key",
    });
  });

  it("falls back to files when direct Matrix secret values are empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "file-access-token\n");
    writeFileSync(recoveryKeyPath, "file-recovery-key\n");
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN = "   ";
    process.env.MATRIX_RECOVERY_KEY = "";
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "file-access-token",
      recoveryKey: "file-recovery-key",
    });
  });

  it("uses direct Matrix secrets when container-default secret files are absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    requiredEnvironment();
    process.env.MATRIX_RECOVERY_KEY = "direct-recovery-key";
    process.env.MATRIX_ACCESS_TOKEN_FILE = join(directory, "missing-access-token");
    process.env.MATRIX_RECOVERY_KEY_FILE = join(directory, "missing-recovery-key");

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "test-access-token",
      recoveryKey: "direct-recovery-key",
    });
  });

  it("accepts an external Docling endpoint for a single-container deployment", () => {
    requiredEnvironment();
    process.env.DOCLING_URL = "https://docling.example.org/api/";

    expect(loadConfig().core.doclingUrl).toBe("https://docling.example.org/api/");
  });

  it("allows bootstrap to load configuration before it has an access token", () => {
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";

    expect(loadConfig({ allowMissingAccessToken: true }).matrix.accessToken).toBe("");
    expect(() => loadConfig()).toThrow("Set MATRIX_ACCESS_TOKEN or MATRIX_ACCESS_TOKEN_FILE");
  });

  it("allows bootstrap to create configured secret files that do not exist yet", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN_FILE = join(directory, "new", "access-token");
    process.env.MATRIX_RECOVERY_KEY_FILE = join(directory, "new", "recovery-key");

    expect(loadConfig({
      allowMissingAccessToken: true,
      allowMissingSecretFiles: true,
    }).matrix).toMatchObject({ accessToken: "" });
    expect(() => loadConfig()).toThrow(/ENOENT/);
  });

  it.each([
    ["MATRIX_GLOBAL_CONCURRENCY", "0"],
    ["MATRIX_GLOBAL_CONCURRENCY", "33"],
    ["MATRIX_BATCH_WINDOW_MS", "-1"],
    ["MATRIX_MAX_EVENT_BYTES", "4095"],
    ["MATRIX_MAX_EVENT_BYTES", "not-a-number"],
  ])("rejects invalid bounded integer %s=%s", (name, value) => {
    requiredEnvironment();
    process.env[name] = value;

    expect(() => loadConfig()).toThrow(`${name} must be an integer`);
  });

  it("validates shared image-quality and compaction settings", () => {
    requiredEnvironment();
    process.env.CODEX_IMAGE_QUALITY = "ultra";
    expect(() => loadConfig()).toThrow("CODEX_IMAGE_QUALITY must be one of");

    process.env.CODEX_IMAGE_QUALITY = "high";
    process.env.RECENT_WINDOW_MESSAGES = "0";
    expect(() => loadConfig()).toThrow("RECENT_WINDOW_MESSAGES must be an integer");
  });

  it("requires a fully-qualified Matrix owner ID", () => {
    requiredEnvironment();
    process.env.MATRIX_OWNER_ID = "owner";

    expect(() => loadConfig()).toThrow("MATRIX_OWNER_ID must be a full Matrix user ID");
  });

  it("validates an optional dedicated bot identity", () => {
    requiredEnvironment();
    process.env.MATRIX_BOT_USER_ID = "bot";
    expect(() => loadConfig()).toThrow("MATRIX_BOT_USER_ID must be a full Matrix user ID");
    process.env.MATRIX_BOT_USER_ID = "@bot:example.org";
    expect(loadConfig().matrix.botUserId).toBe("@bot:example.org");
  });

  it("rejects unknown log levels", () => {
    requiredEnvironment();
    process.env.LOG_LEVEL = "verbose";

    expect(() => loadConfig()).toThrow("LOG_LEVEL must be debug, info, warn, or error");
  });
});
