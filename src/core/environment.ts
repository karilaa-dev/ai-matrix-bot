const APP_ONLY_ENVIRONMENT_KEYS = new Set([
  "APP_DATABASE_URL",
  "CORE_DATABASE_URL",
  "DB_URL",
  "DOCLING_URL",
  "OPENROUTER_API_KEY",
  "POSTGRES_PASSWORD",
  "TAVILY_API_KEY",
]);

/**
 * Build the environment inherited by `codex app-server`.
 *
 * Matrix and provider credentials belong to the adapter process. Passing an
 * explicit, sanitized environment keeps them out of the direct environment of
 * the Codex subprocess while retaining normal process, proxy, CA, and Codex
 * authentication variables.
 */
export function createCodexChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  codexHome?: string,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("MATRIX_") || APP_ONLY_ENVIRONMENT_KEYS.has(name)) {
      delete environment[name];
    }
  }
  if (codexHome) environment.CODEX_HOME = codexHome;
  return environment;
}
