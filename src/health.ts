import { loadConfig } from "./config.js";
import { MatrixStore } from "./storage/sqlite.js";

function main(): void {
  const config = loadConfig();
  const store = new MatrixStore(config.matrix.databasePath);
  try {
    const ready = store.getValue("runtime.ready") === "1";
    const heartbeat = Number(store.getValue("runtime.heartbeat_at") ?? 0);
    const fresh = Date.now() - heartbeat < 120_000;
    if (!ready || !fresh) throw new Error("Matrix sync runtime is not ready");
    process.stdout.write(JSON.stringify({ ok: true, heartbeat }) + "\n");
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
