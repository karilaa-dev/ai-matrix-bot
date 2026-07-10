import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export class RuntimeLock {
  readonly #path: string;
  #held = false;

  constructor(path: string) {
    this.#path = path;
  }

  acquire(): void {
    try {
      const fd = openSync(this.#path, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      closeSync(fd);
      this.#held = true;
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }

    const raw = readFileSync(this.#path, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    if (alive) throw new Error(`Another ai-matrix-bot process is using this data directory (PID ${pid})`);
    rmSync(this.#path, { force: true });
    const fd = openSync(this.#path, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`, "utf8");
    closeSync(fd);
    this.#held = true;
  }

  release(): void {
    if (!this.#held) return;
    rmSync(this.#path, { force: true });
    this.#held = false;
  }
}
