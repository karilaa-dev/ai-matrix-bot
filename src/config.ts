import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  matrix: {
    homeserverUrl: string;
    botUserId?: string;
    ownerId: string;
    accessToken: string;
    recoveryKey?: string;
    deviceId: string;
    storagePath: string;
    cryptoPath: string;
    databasePath: string;
    globalConcurrency: number;
    batchWindowMs: number;
    maxEventBytes: number;
  };
  core: {
    databaseUrl: string;
    fileRoot: string;
    bashRoot: string;
    codexPath: string;
    codexHome?: string;
    codexWorkingDirectory: string;
    codexModel: string;
    codexCompactionModel: string;
    codexImageModel: string;
    codexImageQuality: "low" | "medium" | "high" | "auto";
    codexSpeedMode: "standard" | "fast";
    codexVerbosity: "low" | "medium" | "high";
    reasoningEffort: string;
    reasoningSummary: string;
    turnTimeoutMs: number;
    imageTimeoutMs: number;
    doclingUrl?: string;
    doclingTimeoutMs: number;
    tavilyApiKey?: string;
    openRouterApiKey?: string;
    openRouterEmbeddingModel: string;
    contextWarningRatio: number;
    bashTimeoutMs: number;
    bashMaxOutputCharacters: number;
    recentWindowMessages: number;
    systemPromptPath: string;
  };
  logLevel: LogLevelName;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function secret(valueName: string, fileName: string, allowMissingFile = false): string | undefined {
  const direct = optional(valueName);
  if (direct) return direct;
  const path = optional(fileName);
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if (allowMissingFile && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function logLevel(): LogLevelName {
  const value = optional("LOG_LEVEL") ?? "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("LOG_LEVEL must be debug, info, warn, or error");
}

function choice<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const value = optional(name) ?? fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function ratio(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be greater than 0 and at most 1`);
  return value;
}

export function loadConfig(options: { allowMissingAccessToken?: boolean; allowMissingSecretFiles?: boolean } = {}): AppConfig {
  const accessToken = secret("MATRIX_ACCESS_TOKEN", "MATRIX_ACCESS_TOKEN_FILE", options.allowMissingSecretFiles);
  if (!accessToken && !options.allowMissingAccessToken) {
    throw new Error("Set MATRIX_ACCESS_TOKEN or MATRIX_ACCESS_TOKEN_FILE");
  }

  const recoveryKey = secret("MATRIX_RECOVERY_KEY", "MATRIX_RECOVERY_KEY_FILE", options.allowMissingSecretFiles);
  const appDatabaseUrl = optional("APP_DATABASE_URL");
  const appDatabasePath = appDatabaseUrl?.startsWith("file:") ? appDatabaseUrl.slice("file:".length) : appDatabaseUrl;
  const config: AppConfig = {
    matrix: {
      homeserverUrl: required("MATRIX_HOMESERVER_URL").replace(/\/+$/, ""),
      ...(optional("MATRIX_BOT_USER_ID") ? { botUserId: required("MATRIX_BOT_USER_ID") } : {}),
      ownerId: required("MATRIX_OWNER_ID"),
      accessToken: accessToken ?? "",
      deviceId: optional("MATRIX_DEVICE_ID") ?? "AI_MATRIX_BOT",
      storagePath: resolve(optional("MATRIX_STORAGE_PATH") ?? "data/matrix/sync.json"),
      cryptoPath: resolve(optional("MATRIX_CRYPTO_PATH") ?? "data/matrix/crypto"),
      databasePath: resolve(optional("MATRIX_DATABASE_PATH") ?? appDatabasePath ?? "data/matrix-bot.sqlite"),
      globalConcurrency: integer("MATRIX_GLOBAL_CONCURRENCY", 4, 1, 32),
      batchWindowMs: integer("MATRIX_BATCH_WINDOW_MS", 750, 0, 30_000),
      maxEventBytes: integer("MATRIX_MAX_EVENT_BYTES", 60_000, 4_096, 1_000_000),
      ...(recoveryKey ? { recoveryKey } : {}),
    },
    core: {
      databaseUrl: optional("CORE_DATABASE_URL") ?? "file:data/codex-core.sqlite",
      fileRoot: resolve(optional("FILE_ROOT") ?? "data/files"),
      bashRoot: resolve(optional("BASH_ROOT") ?? "data/bash"),
      codexPath: optional("CODEX_PATH") ?? "codex",
      codexWorkingDirectory: resolve(optional("CODEX_WORKING_DIRECTORY") ?? "."),
      codexModel: optional("CODEX_MODEL") ?? "gpt-5.6-sol",
      codexCompactionModel: optional("CODEX_COMPACTION_MODEL") ?? "gpt-5.6-luna",
      codexImageModel: optional("CODEX_IMAGE_MODEL") ?? "gpt-image-2",
      codexImageQuality: choice("CODEX_IMAGE_QUALITY", "low", ["low", "medium", "high", "auto"] as const),
      codexSpeedMode: choice("CODEX_SPEED_MODE", "fast", ["standard", "fast"] as const),
      codexVerbosity: choice("CODEX_VERBOSITY", "high", ["low", "medium", "high"] as const),
      reasoningEffort: optional("REASONING_EFFORT") ?? "medium",
      reasoningSummary: optional("REASONING_SUMMARY") ?? "detailed",
      turnTimeoutMs: integer("CODEX_TURN_TIMEOUT_MS", 900_000, 0, 3_600_000),
      imageTimeoutMs: integer("CODEX_IMAGE_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
      doclingTimeoutMs: integer("DOCLING_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
      openRouterEmbeddingModel: optional("OPENROUTER_EMBEDDING_MODEL") ?? "perplexity/pplx-embed-v1-0.6b",
      contextWarningRatio: ratio("CONTEXT_WARN_RATIO", 0.85),
      bashTimeoutMs: integer("BASH_TIMEOUT_MS", 30_000, 1_000, 300_000),
      bashMaxOutputCharacters: integer("BASH_MAX_OUTPUT_CHARS", 12_000, 1_000, 1_000_000),
      recentWindowMessages: integer("RECENT_WINDOW_MESSAGES", 20, 1, 1_000),
      systemPromptPath: resolve(optional("SYSTEM_PROMPT_PATH") ?? "system_prompt.md"),
      ...(optional("CODEX_HOME") ? { codexHome: resolve(required("CODEX_HOME")) } : {}),
      ...(optional("DOCLING_URL") ? { doclingUrl: required("DOCLING_URL") } : {}),
      ...(optional("TAVILY_API_KEY") ? { tavilyApiKey: required("TAVILY_API_KEY") } : {}),
      ...(optional("OPENROUTER_API_KEY") ? { openRouterApiKey: required("OPENROUTER_API_KEY") } : {}),
    },
    logLevel: logLevel(),
  };

  if (!/^@[^:]+:.+$/.test(config.matrix.ownerId)) {
    throw new Error("MATRIX_OWNER_ID must be a full Matrix user ID");
  }
  if (config.matrix.botUserId && !/^@[^:]+:.+$/.test(config.matrix.botUserId)) {
    throw new Error("MATRIX_BOT_USER_ID must be a full Matrix user ID");
  }
  return config;
}

export function readSystemPrompt(config: AppConfig): string {
  return readFileSync(config.core.systemPromptPath, "utf8").trim();
}
