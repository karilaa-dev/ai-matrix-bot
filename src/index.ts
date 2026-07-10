import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { resolveMatrixSession } from "./matrix/auth.js";
import { MatrixBotRuntime } from "./runtime/bot.js";

async function main(): Promise<void> {
  const loadedConfig = loadConfig();
  const logger = createLogger(loadedConfig.logLevel);
  const config = await resolveMatrixSession(loadedConfig, logger);
  const runtime = new MatrixBotRuntime(config, logger);
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down", { signal });
    await runtime.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error });
    void shutdown("uncaughtException").finally(() => { process.exitCode = 1; });
  });
  process.once("unhandledRejection", (error) => {
    logger.error("Unhandled rejection", { error });
    void shutdown("unhandledRejection").finally(() => { process.exitCode = 1; });
  });
  await runtime.start();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
