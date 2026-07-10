import { loadConfig } from "./config.js";
import { checkRuntimeHealth } from "./health-state.js";
import { MatrixStore } from "./storage/sqlite.js";

function main(): void {
  const config = loadConfig();
  const store = new MatrixStore(config.matrix.databasePath);
  try {
    process.stdout.write(JSON.stringify(checkRuntimeHealth((key) => store.getValue(key))) + "\n");
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
