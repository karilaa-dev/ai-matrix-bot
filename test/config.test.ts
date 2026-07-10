import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const originalEnv = { ...process.env };
let temporaryDirectories: string[] = [];
const ENCRYPTION_SECRET = "portable-matrix-encryption-secret-32";
const SECOND_ENCRYPTION_SECRET = "different-portable-encryption-secret-32";
const LEGACY_RECOVERY_SECRET = "EsT7 nCLK jKNT 7mWo yjmu LS8z zS7x TFo5";

function requiredEnvironment(): void {
  process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org///";
  process.env.MATRIX_OWNER_ID = "@owner:example.org";
  process.env.MATRIX_ACCESS_TOKEN = "test-access-token";
  process.env.MATRIX_ENCRYPTION_SECRET = ENCRYPTION_SECRET;
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
      encryptionSecret: ENCRYPTION_SECRET,
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

  it("loads a minimal deployment from four portable Matrix values", () => {
    requiredEnvironment();

    const config = loadConfig();

    expect(config.matrix).toMatchObject({
      homeserverUrl: "https://matrix.example.org",
      ownerId: "@owner:example.org",
      accessToken: "test-access-token",
      encryptionSecret: ENCRYPTION_SECRET,
      deviceId: "AI_MATRIX_BOT",
    });
    expect(config.matrix.botUserId).toBeUndefined();
    expect(config.matrix.passwordAuth).toBeUndefined();
    expect(config.matrix.sessionPath).toBe(resolve("data/matrix/session.json"));
    expect(config.core.doclingUrl).toBeUndefined();
    expect(config.core.openRouterApiKey).toBeUndefined();
    expect(config.core.tavilyApiKey).toBeUndefined();
  });

  it("accepts Matrix login and password instead of an access token", () => {
    requiredEnvironment();
    delete process.env.MATRIX_ACCESS_TOKEN;
    process.env.MATRIX_LOGIN = "@bot:example.org";
    process.env.MATRIX_PASSWORD = "  password whitespace is preserved  ";

    const config = loadConfig();

    expect(config.matrix.accessToken).toBe("");
    expect(config.matrix.passwordAuth).toEqual({
      login: "@bot:example.org",
      password: "  password whitespace is preserved  ",
    });
  });

  it.each([
    ["login without password", "@bot:example.org", undefined],
    ["password without login", undefined, "matrix-password"],
  ])("rejects partial password authentication: %s", (_label, login, password) => {
    requiredEnvironment();
    delete process.env.MATRIX_ACCESS_TOKEN;
    if (login) process.env.MATRIX_LOGIN = login;
    if (password) process.env.MATRIX_PASSWORD = password;

    expect(() => loadConfig()).toThrow("Set both MATRIX_LOGIN and MATRIX_PASSWORD, or neither");
  });

  it("rejects ambiguous token and password authentication", () => {
    requiredEnvironment();
    process.env.MATRIX_LOGIN = "@bot:example.org";
    process.env.MATRIX_PASSWORD = "matrix-password";

    expect(() => loadConfig()).toThrow(
      "Configure either MATRIX_ACCESS_TOKEN or MATRIX_LOGIN with MATRIX_PASSWORD, not both",
    );
  });

  it("allows auth values to be omitted when a cached session will be resolved at startup", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    requiredEnvironment();
    delete process.env.MATRIX_ACCESS_TOKEN;
    process.env.MATRIX_SESSION_PATH = join(directory, "session.json");

    const config = loadConfig();

    expect(config.matrix.accessToken).toBe("");
    expect(config.matrix.passwordAuth).toBeUndefined();
    expect(config.matrix.sessionPath).toBe(join(directory, "session.json"));
  });

  it("requires the portable encryption secret for a normal startup", () => {
    requiredEnvironment();
    delete process.env.MATRIX_ENCRYPTION_SECRET;

    expect(() => loadConfig()).toThrow("MATRIX_ENCRYPTION_SECRET");
  });

  it("rejects encryption secrets shorter than 32 characters", () => {
    requiredEnvironment();
    process.env.MATRIX_ENCRYPTION_SECRET = "too-short";

    expect(() => loadConfig()).toThrow("MATRIX_ENCRYPTION_SECRET must contain at least 32 characters");
  });

  it("accepts the legacy recovery key as the portable encryption secret", () => {
    requiredEnvironment();
    delete process.env.MATRIX_ENCRYPTION_SECRET;
    process.env.MATRIX_RECOVERY_KEY = LEGACY_RECOVERY_SECRET;

    expect(loadConfig().matrix.encryptionSecret).toBe(LEGACY_RECOVERY_SECRET);
  });

  it("rejects conflicting portable and legacy encryption secrets", () => {
    requiredEnvironment();
    process.env.MATRIX_RECOVERY_KEY = SECOND_ENCRYPTION_SECRET;

    expect(() => loadConfig()).toThrow(
      "MATRIX_ENCRYPTION_SECRET conflicts with legacy MATRIX_RECOVERY_KEY(_FILE)",
    );
  });

  it("accepts matching portable and legacy encryption secrets during migration", () => {
    requiredEnvironment();
    process.env.MATRIX_RECOVERY_KEY = ENCRYPTION_SECRET;

    expect(loadConfig().matrix.encryptionSecret).toBe(ENCRYPTION_SECRET);
  });

  it("reads trimmed Matrix secrets from files without retaining the password", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "file-access-token\n");
    writeFileSync(recoveryKeyPath, `${LEGACY_RECOVERY_SECRET}\n`);
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    const config = loadConfig();

    expect(config.matrix.accessToken).toBe("file-access-token");
    expect(config.matrix.encryptionSecret).toBe(LEGACY_RECOVERY_SECRET);
    expect(JSON.stringify(config)).not.toContain("password");
  });

  it("prefers explicitly supplied Matrix secrets over secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "stale-file-token");
    writeFileSync(recoveryKeyPath, SECOND_ENCRYPTION_SECRET);
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN = "test-access-token";
    process.env.MATRIX_RECOVERY_KEY = LEGACY_RECOVERY_SECRET;
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "test-access-token",
      encryptionSecret: LEGACY_RECOVERY_SECRET,
    });
  });

  it("falls back to files when direct Matrix secret values are empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    const accessTokenPath = join(directory, "access-token");
    const recoveryKeyPath = join(directory, "recovery-key");
    writeFileSync(accessTokenPath, "file-access-token\n");
    writeFileSync(recoveryKeyPath, `${LEGACY_RECOVERY_SECRET}\n`);
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ACCESS_TOKEN = "   ";
    process.env.MATRIX_RECOVERY_KEY = "";
    process.env.MATRIX_ACCESS_TOKEN_FILE = accessTokenPath;
    process.env.MATRIX_RECOVERY_KEY_FILE = recoveryKeyPath;

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "file-access-token",
      encryptionSecret: LEGACY_RECOVERY_SECRET,
    });
  });

  it("uses direct Matrix secrets when container-default secret files are absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "matrix-config-"));
    temporaryDirectories.push(directory);
    requiredEnvironment();
    process.env.MATRIX_ACCESS_TOKEN_FILE = join(directory, "missing-access-token");
    process.env.MATRIX_RECOVERY_KEY_FILE = join(directory, "missing-recovery-key");

    expect(loadConfig().matrix).toMatchObject({
      accessToken: "test-access-token",
      encryptionSecret: ENCRYPTION_SECRET,
    });
  });

  it("accepts an external Docling endpoint for a single-container deployment", () => {
    requiredEnvironment();
    process.env.DOCLING_URL = "https://docling.example.org/api/";

    expect(loadConfig().core.doclingUrl).toBe("https://docling.example.org/api/");
  });

  it("allows configuration loading before auth is resolved from a cached session", () => {
    process.env.MATRIX_HOMESERVER_URL = "https://matrix.example.org";
    process.env.MATRIX_OWNER_ID = "@owner:example.org";
    process.env.MATRIX_ENCRYPTION_SECRET = ENCRYPTION_SECRET;

    expect(loadConfig({ allowMissingAccessToken: true }).matrix.accessToken).toBe("");
    expect(loadConfig().matrix.accessToken).toBe("");
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
      allowMissingEncryptionSecret: true,
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
