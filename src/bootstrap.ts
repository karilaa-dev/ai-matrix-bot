import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { requireWritableSecretOutput } from "./bootstrap-files.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { DedicatedMatrixClient } from "./matrix/client.js";
import { MatrixStore } from "./storage/sqlite.js";

interface LoginResponse {
  access_token: string;
  device_id: string;
  user_id: string;
}

interface WhoAmIResponse {
  user_id: string;
  device_id?: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string; errcode?: string };
  if (!response.ok) throw new Error(`${body.errcode ?? response.status}: ${body.error ?? response.statusText}`);
  return body;
}

function requireOwnerOnlyFile(path: string | undefined, label: string): void {
  if (!path || !existsSync(path)) return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${label} must have owner-only permissions (chmod 600 ${path})`);
}

async function main(): Promise<void> {
  const config = loadConfig({ allowMissingAccessToken: true, allowMissingSecretFiles: true });
  const logger = createLogger(config.logLevel);
  let token = config.matrix.accessToken;
  let login: LoginResponse | undefined;
  requireOwnerOnlyFile(process.env.MATRIX_ACCESS_TOKEN_FILE, "Matrix access-token file");
  requireOwnerOnlyFile(process.env.MATRIX_RECOVERY_KEY_FILE, "Matrix recovery-key file");

  const tokenPath = argument("--token-out") ?? process.env.MATRIX_ACCESS_TOKEN_FILE;

  if (!token) {
    const user = argument("--user");
    if (!user || !process.argv.includes("--password-stdin")) {
      throw new Error("Without an access token, use --user @bot:server --password-stdin");
    }
    const password = await readStdin();
    if (!password) throw new Error("No password was received on stdin");
    if (!tokenPath) throw new Error("Set MATRIX_ACCESS_TOKEN_FILE or pass --token-out to save the new access token");
    requireWritableSecretOutput(tokenPath, "Matrix access token", "--token-out");
    login = await request<LoginResponse>(`${config.matrix.homeserverUrl}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password,
        device_id: config.matrix.deviceId,
        initial_device_display_name: "AI Matrix Bot",
      }),
    });
    token = login.access_token;
  }

  const whoami = await request<WhoAmIResponse>(`${config.matrix.homeserverUrl}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (whoami.user_id === config.matrix.ownerId) {
    logger.warn("The bot account is the owner account; a separate non-admin Matrix account is recommended", { userId: whoami.user_id });
  }
  if (config.matrix.botUserId && whoami.user_id !== config.matrix.botUserId) {
    throw new Error(`Access token belongs to ${whoami.user_id}; expected MATRIX_BOT_USER_ID=${config.matrix.botUserId}`);
  }
  if (whoami.device_id && whoami.device_id !== config.matrix.deviceId) {
    throw new Error(`Access token belongs to device ${whoami.device_id}; set MATRIX_DEVICE_ID to that stable device ID`);
  }

  if (login && tokenPath) {
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }
  mkdirSync(config.matrix.cryptoPath, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.matrix.storagePath), { recursive: true, mode: 0o700 });
  chmodSync(config.matrix.cryptoPath, 0o700);
  chmodSync(dirname(config.matrix.storagePath), 0o700);

  const recoveryPath = argument("--recovery-key-out") ?? process.env.MATRIX_RECOVERY_KEY_FILE;
  if (!config.matrix.recoveryKey && !recoveryPath) {
    throw new Error(
      "Set MATRIX_RECOVERY_KEY, MATRIX_RECOVERY_KEY_FILE, or pass --recovery-key-out before initializing Matrix recovery",
    );
  }
  if (!config.matrix.recoveryKey && recoveryPath) {
    requireWritableSecretOutput(recoveryPath, "Matrix recovery key", "--recovery-key-out");
  }
  const bootstrapClient = new DedicatedMatrixClient({ ...config.matrix, accessToken: token }, logger);
  const identity = await bootstrapClient.initializeCryptoIdentity(config.matrix.recoveryKey);
  if (identity.created && identity.recoveryKey && !config.matrix.recoveryKey) {
    if (!recoveryPath) throw new Error("Recovery output path unexpectedly missing");
    mkdirSync(dirname(recoveryPath), { recursive: true, mode: 0o700 });
    writeFileSync(recoveryPath, `${identity.recoveryKey}\n`, { mode: 0o600 });
    chmodSync(recoveryPath, 0o600);
  }
  const store = new MatrixStore(config.matrix.databasePath);
  try {
    store.bootstrapOwner(config.matrix.ownerId);
  } finally {
    store.close();
  }

  stdout.write(JSON.stringify({
    ok: true,
    userId: whoami.user_id,
    deviceId: whoami.device_id ?? login?.device_id ?? config.matrix.deviceId,
    tokenWritten: Boolean(login && tokenPath),
    recoveryCreated: identity.created,
    cryptoPath: config.matrix.cryptoPath,
  }, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
