import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedAppConfig, MatrixPasswordAuth } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { resolveMatrixSession } from "../src/matrix/auth.js";

const roots: string[] = [];
const PASSWORD = "correct horse battery staple matrix password";

interface ConfigOptions {
  accessToken?: string;
  botUserId?: string;
  homeserverUrl?: string;
  passwordAuth?: MatrixPasswordAuth;
}

function config(root: string, options: ConfigOptions = {}): LoadedAppConfig {
  return {
    matrix: {
      homeserverUrl: options.homeserverUrl ?? "https://matrix.example.org",
      ownerId: "@owner:example.org",
      accessToken: options.accessToken ?? "",
      encryptionSecret: "portable-matrix-encryption-secret-32",
      deviceId: "AI_MATRIX_BOT",
      sessionPath: join(root, "matrix", "session.json"),
      storagePath: join(root, "matrix", "sync.json"),
      cryptoPath: join(root, "matrix", "crypto"),
      databasePath: join(root, "matrix-bot.sqlite"),
      globalConcurrency: 4,
      batchWindowMs: 750,
      maxEventBytes: 60_000,
      ...(options.botUserId ? { botUserId: options.botUserId } : {}),
      ...(options.passwordAuth ? { passwordAuth: options.passwordAuth } : {}),
    },
    core: {} as LoadedAppConfig["core"],
    logLevel: "info",
  };
}

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "matrix-auth-"));
  roots.push(directory);
  return directory;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cachedSession(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    homeserverUrl: "https://matrix.example.org",
    login: "@bot:example.org",
    userId: "@bot:example.org",
    deviceId: "BOT_DEVICE",
    accessToken: "cached-access-token",
    ...overrides,
  };
}

function writeCachedSession(path: string, value: unknown, mode = 0o600): void {
  const directory = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
  chmodSync(path, mode);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("resolveMatrixSession", () => {
  it("validates direct-token auth and caches a private session", async () => {
    const directory = root();
    const loaded = config(directory, {
      accessToken: "configured-access-token",
      botUserId: "@bot:example.org",
    });
    const fetch = vi.fn(async () => json({
      user_id: "@bot:example.org",
      device_id: "TOKEN_DEVICE",
    }));

    const resolved = await resolveMatrixSession(loaded, logger(), fetch);

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0]).endsWith("/_matrix/client/v3/account/whoami")).toBe(true);
    expect(resolved.matrix).toMatchObject({
      accessToken: "configured-access-token",
      botUserId: "@bot:example.org",
      deviceId: "TOKEN_DEVICE",
    });
    const session = readFileSync(loaded.matrix.sessionPath, "utf8");
    expect(statSync(loaded.matrix.sessionPath).mode & 0o777).toBe(0o600);
    expect(session).toContain("configured-access-token");
    expect(session).not.toContain("password");
  });

  it("rejects using the owner account as the bot identity", async () => {
    const directory = root();
    const loaded = config(directory, { accessToken: "owner-access-token" });
    const fetch = vi.fn(async () => json({
      user_id: "@owner:example.org",
      device_id: "OWNER_DEVICE",
    }));

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "The Matrix bot account must be different from MATRIX_OWNER_ID",
    );

    expect(() => readFileSync(loaded.matrix.sessionPath, "utf8")).toThrow();
  });

  it("revokes a newly issued password session when it belongs to the owner", async () => {
    const directory = root();
    const loaded = config(directory, {
      passwordAuth: { login: "@owner:example.org", password: PASSWORD },
    });
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/_matrix/client/v3/login")) {
        return json({
          access_token: "owner-password-token",
          user_id: "@owner:example.org",
          device_id: "OWNER_PASSWORD_DEVICE",
        });
      }
      if (url.endsWith("/_matrix/client/v3/logout")) return json({});
      throw new Error(`Unexpected Matrix request ${url}`);
    });

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "The Matrix bot account must be different from MATRIX_OWNER_ID",
    );

    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/_matrix/client/v3/logout"))).toHaveLength(1);
    expect(() => readFileSync(loaded.matrix.sessionPath, "utf8")).toThrow();
  });

  it("logs in once, writes no password, and reuses the cached token after restart", async () => {
    const directory = root();
    const firstConfig = config(directory, {
      passwordAuth: { login: "@bot:example.org", password: PASSWORD },
    });
    const log = logger();
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/_matrix/client/v3/login")) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(request).toMatchObject({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: "@bot:example.org" },
          password: PASSWORD,
        });
        return json({
          access_token: "password-login-token",
          user_id: "@bot:example.org",
          device_id: "PASSWORD_DEVICE",
        });
      }
      if (url.endsWith("/_matrix/client/v3/account/whoami")) {
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
          "Bearer password-login-token",
        );
        return json({ user_id: "@bot:example.org", device_id: "PASSWORD_DEVICE" });
      }
      throw new Error(`Unexpected Matrix request ${url}`);
    });

    const first = await resolveMatrixSession(firstConfig, log, fetch);
    expect(first.matrix.accessToken).toBe("password-login-token");
    expect(first.matrix.deviceId).toBe("PASSWORD_DEVICE");
    expect(first.matrix).not.toHaveProperty("passwordAuth");
    expect(firstConfig.matrix).not.toHaveProperty("passwordAuth");

    const sessionContents = readFileSync(first.matrix.sessionPath, "utf8");
    expect(statSync(first.matrix.sessionPath).mode & 0o777).toBe(0o600);
    expect(sessionContents).toContain("password-login-token");
    expect(sessionContents).not.toContain(PASSWORD);
    expect(JSON.stringify(first)).not.toContain(PASSWORD);
    expect(JSON.stringify(log)).not.toContain(PASSWORD);

    const restarted = await resolveMatrixSession(config(directory), logger(), fetch);
    expect(restarted.matrix.accessToken).toBe("password-login-token");
    expect(restarted.matrix.deviceId).toBe("PASSWORD_DEVICE");
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/_matrix/client/v3/login"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/_matrix/client/v3/account/whoami"))).toHaveLength(2);
  });

  it("rejects a corrupt cached session without sending any request", async () => {
    const directory = root();
    const loaded = config(directory);
    writeCachedSession(loaded.matrix.sessionPath, "{not valid json");
    const fetch = vi.fn();

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "The cached Matrix session is not valid JSON",
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a cached session for another homeserver or configured identity", async () => {
    const directory = root();
    const loaded = config(directory, { botUserId: "@bot:example.org" });
    writeCachedSession(loaded.matrix.sessionPath, cachedSession({
      homeserverUrl: "https://other.example.org",
      userId: "@other:example.org",
    }));
    const fetch = vi.fn();

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "The cached Matrix session does not match the configured homeserver or bot identity",
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cached identity metadata that disagrees with whoami", async () => {
    const directory = root();
    const loaded = config(directory);
    writeCachedSession(loaded.matrix.sessionPath, cachedSession());
    const fetch = vi.fn(async () => json({
      user_id: "@bot:example.org",
      device_id: "DIFFERENT_DEVICE",
    }));

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "The cached Matrix session identity does not match /whoami",
    );
  });

  it("rejects a cached session readable by other users", async () => {
    const directory = root();
    const loaded = config(directory);
    writeCachedSession(loaded.matrix.sessionPath, cachedSession(), 0o644);
    const fetch = vi.fn();

    await expect(resolveMatrixSession(loaded, logger(), fetch)).rejects.toThrow(
      "Matrix session must have owner-only permissions",
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("replaces one revoked cached token with exactly one password login", async () => {
    const directory = root();
    const loaded = config(directory, {
      passwordAuth: { login: "@bot:example.org", password: PASSWORD },
    });
    writeCachedSession(loaded.matrix.sessionPath, cachedSession());
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/_matrix/client/v3/account/whoami")) {
        const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
        if (authorization === "Bearer cached-access-token") {
          return json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" }, 401);
        }
        expect(authorization).toBe("Bearer replacement-access-token");
        return json({ user_id: "@bot:example.org", device_id: "REPLACEMENT_DEVICE" });
      }
      if (url.endsWith("/_matrix/client/v3/login")) {
        return json({
          access_token: "replacement-access-token",
          user_id: "@bot:example.org",
          device_id: "REPLACEMENT_DEVICE",
        });
      }
      throw new Error(`Unexpected Matrix request ${url}`);
    });

    const resolved = await resolveMatrixSession(loaded, logger(), fetch);

    expect(resolved.matrix).toMatchObject({
      accessToken: "replacement-access-token",
      deviceId: "REPLACEMENT_DEVICE",
    });
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/_matrix/client/v3/account/whoami"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/_matrix/client/v3/login"))).toHaveLength(1);
    const persisted = readFileSync(resolved.matrix.sessionPath, "utf8");
    expect(persisted).toContain("replacement-access-token");
    expect(persisted).not.toContain("cached-access-token");
    expect(persisted).not.toContain(PASSWORD);
  });
});
