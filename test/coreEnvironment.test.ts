import { describe, expect, it } from "vitest";
import { createCodexChildEnvironment } from "../src/core/environment.js";

describe("Codex child environment", () => {
  it("keeps runtime and Codex auth settings while removing adapter secrets", () => {
    const environment = createCodexChildEnvironment({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/node",
      HTTPS_PROXY: "http://proxy.example.org:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/private-ca.pem",
      OPENAI_API_KEY: "codex-api-key",
      MATRIX_HOMESERVER_URL: "https://matrix.example.org",
      MATRIX_ACCESS_TOKEN: "matrix-token",
      MATRIX_LOGIN: "@bot:example.org",
      MATRIX_PASSWORD: "matrix-password",
      MATRIX_SESSION_PATH: "/app/data/matrix/session.json",
      MATRIX_ENCRYPTION_SECRET: "portable-matrix-encryption-secret-32",
      MATRIX_RECOVERY_KEY: "matrix-recovery-key",
      MATRIX_ACCESS_TOKEN_FILE: "/run/secrets/matrix-token",
      OPENROUTER_API_KEY: "embedding-key",
      TAVILY_API_KEY: "search-key",
      CORE_DATABASE_URL: "postgres://user:password@database/core",
      POSTGRES_PASSWORD: "database-password",
      DOCLING_URL: "https://user:password@docling.example.org",
    }, "/app/data/codex");

    expect(environment).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/node",
      HTTPS_PROXY: "http://proxy.example.org:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/private-ca.pem",
      OPENAI_API_KEY: "codex-api-key",
      CODEX_HOME: "/app/data/codex",
    });
    expect(environment).not.toHaveProperty("MATRIX_HOMESERVER_URL");
    expect(environment).not.toHaveProperty("MATRIX_ACCESS_TOKEN");
    expect(environment).not.toHaveProperty("MATRIX_LOGIN");
    expect(environment).not.toHaveProperty("MATRIX_PASSWORD");
    expect(environment).not.toHaveProperty("MATRIX_SESSION_PATH");
    expect(environment).not.toHaveProperty("MATRIX_ENCRYPTION_SECRET");
    expect(environment).not.toHaveProperty("MATRIX_RECOVERY_KEY");
    expect(environment).not.toHaveProperty("MATRIX_ACCESS_TOKEN_FILE");
    expect(environment).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(environment).not.toHaveProperty("TAVILY_API_KEY");
    expect(environment).not.toHaveProperty("CORE_DATABASE_URL");
    expect(environment).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(environment).not.toHaveProperty("DOCLING_URL");
  });

  it("sanitizes secrets even when no explicit Codex home is configured", () => {
    expect(createCodexChildEnvironment({
      PATH: "/usr/bin",
      MATRIX_ACCESS_TOKEN: "matrix-token",
    })).toEqual({ PATH: "/usr/bin" });
  });
});
