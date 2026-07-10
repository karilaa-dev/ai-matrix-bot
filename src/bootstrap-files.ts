import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function requireWritableSecretOutput(path: string, label: string, option: string): void {
  const parent = dirname(path);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    accessSync(existsSync(path) ? path : parent, constants.W_OK);
  } catch {
    throw new Error(
      `${label} output is not writable: ${path}. Docker secrets are read-only; `
      + `pass ${option} with a writable path, then provision that file as the runtime secret`,
    );
  }
}
