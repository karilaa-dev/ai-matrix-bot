import type { LogLevelName } from "./config.js";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ranks: Record<LogLevelName, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretPattern = /(access.?token|password|recovery.?key|authorization|cookie|secret)/i;

function redact(value: unknown, key = ""): unknown {
  if (secretPattern.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function createLogger(level: LogLevelName): Logger {
  const threshold = ranks[level];
  const write = (entryLevel: LogLevelName, message: string, fields?: Record<string, unknown>) => {
    if (ranks[entryLevel] < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(fields ? { fields: redact(fields) } : {}),
    };
    const line = JSON.stringify(entry);
    if (entryLevel === "error" || entryLevel === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
