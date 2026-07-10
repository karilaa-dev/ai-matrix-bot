import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("filters messages below the configured level", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger("warn");

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      message: "warn",
    });
  });

  it("recursively redacts credentials by field name", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("debug");

    logger.info("configured", {
      accessToken: "matrix-secret",
      nested: {
        Authorization: "Bearer provider-secret",
        password: "database-secret",
        safe: "room-id",
      },
      values: [{ recovery_key: "recovery-secret" }],
    });

    const line = String(stdout.mock.calls[0]?.[0]);
    expect(line).not.toContain("matrix-secret");
    expect(line).not.toContain("provider-secret");
    expect(line).not.toContain("database-secret");
    expect(line).not.toContain("recovery-secret");
    expect(JSON.parse(line).fields).toEqual({
      accessToken: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        password: "[REDACTED]",
        safe: "room-id",
      },
      values: [{ recovery_key: "[REDACTED]" }],
    });
  });

  it("routes warnings and errors to stderr and informational logs to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger("debug");

    logger.info("ready");
    logger.error("failed");

    expect(stdout).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stdout.mock.calls[0]?.[0])).toContain('"message":"ready"');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('"message":"failed"');
  });
});
