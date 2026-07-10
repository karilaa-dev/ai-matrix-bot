import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig, LoadedAppConfig, MatrixPasswordAuth } from "../config.js";
import type { Logger } from "../logging.js";
import { RuntimeLock } from "../runtime/lock.js";

interface MatrixSession {
  version: 1;
  homeserverUrl: string;
  login: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}

interface LoginResponse {
  access_token: string;
  device_id: string;
  user_id: string;
}

interface WhoAmIResponse {
  user_id: string;
  device_id?: string;
}

class InvalidMatrixSessionError extends Error {}

class MatrixAuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSession(value: unknown): MatrixSession {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.homeserverUrl !== "string"
    || typeof value.login !== "string"
    || typeof value.userId !== "string"
    || typeof value.deviceId !== "string"
    || typeof value.accessToken !== "string"
    || !value.homeserverUrl
    || !value.login
    || !value.userId
    || !value.deviceId
    || !value.accessToken) {
    throw new InvalidMatrixSessionError("The cached Matrix session is invalid");
  }
  return value as unknown as MatrixSession;
}

async function readSession(path: string): Promise<MatrixSession | undefined> {
  let data: string;
  try {
    const details = await stat(path);
    if ((details.mode & 0o077) !== 0) {
      throw new InvalidMatrixSessionError(`Matrix session must have owner-only permissions (chmod 600 ${path})`);
    }
    data = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parseSession(JSON.parse(data) as unknown);
  } catch (error) {
    if (error instanceof InvalidMatrixSessionError) throw error;
    throw new InvalidMatrixSessionError("The cached Matrix session is not valid JSON");
  }
}

async function writeSession(path: string, session: MatrixSession): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(session)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function whoAmI(
  homeserverUrl: string,
  accessToken: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<Required<WhoAmIResponse>> {
  const response = await fetchImpl(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const errcode = typeof body.errcode === "string" ? body.errcode : undefined;
    const detail = typeof body.error === "string" ? body.error : response.statusText;
    throw new MatrixAuthHttpError(response.status, errcode, `Matrix /whoami failed: ${detail}`);
  }
  if (typeof body.user_id !== "string" || typeof body.device_id !== "string") {
    throw new Error("Matrix /whoami did not return a user ID and device ID");
  }
  return { user_id: body.user_id, device_id: body.device_id };
}

async function passwordLogin(
  homeserverUrl: string,
  credentials: MatrixPasswordAuth,
  fetchImpl: typeof globalThis.fetch,
): Promise<MatrixSession> {
  const response = await fetchImpl(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: credentials.login },
      password: credentials.password,
      initial_device_display_name: "AI Matrix Bot",
    }),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const errcode = typeof body.errcode === "string" ? body.errcode : undefined;
    const detail = typeof body.error === "string" ? body.error : response.statusText;
    throw new MatrixAuthHttpError(response.status, errcode, `Matrix password login failed: ${detail}`);
  }
  const login = body as unknown as Partial<LoginResponse>;
  if (typeof login.access_token !== "string" || typeof login.user_id !== "string" || typeof login.device_id !== "string") {
    throw new Error("Matrix password login returned an incomplete session");
  }
  return {
    version: 1,
    homeserverUrl,
    login: credentials.login,
    userId: login.user_id,
    deviceId: login.device_id,
    accessToken: login.access_token,
  };
}

function isRevokedSession(error: unknown): boolean {
  return error instanceof MatrixAuthHttpError
    && (error.status === 401
      || error.status === 403
      || error.errcode === "M_UNKNOWN_TOKEN"
      || error.errcode === "M_MISSING_TOKEN");
}

function validateExpectedUser(config: LoadedAppConfig, session: MatrixSession): void {
  if (session.userId === config.matrix.ownerId) {
    throw new Error("The Matrix bot account must be different from MATRIX_OWNER_ID");
  }
  if (config.matrix.botUserId && config.matrix.botUserId !== session.userId) {
    throw new Error(`Matrix authentication belongs to ${session.userId}; expected ${config.matrix.botUserId}`);
  }
}

function resolvedConfig(config: LoadedAppConfig, session: MatrixSession): AppConfig {
  validateExpectedUser(config, session);
  const { passwordAuth: _discarded, ...matrix } = config.matrix;
  return {
    ...config,
    matrix: {
      ...matrix,
      botUserId: session.userId,
      accessToken: session.accessToken,
      deviceId: session.deviceId,
    },
  };
}

async function validateSession(
  session: MatrixSession,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  const identity = await whoAmI(session.homeserverUrl, session.accessToken, fetchImpl);
  if (identity.user_id !== session.userId || identity.device_id !== session.deviceId) {
    throw new InvalidMatrixSessionError("The cached Matrix session identity does not match /whoami");
  }
}

async function loginAndPersist(
  config: LoadedAppConfig,
  credentials: MatrixPasswordAuth,
  fetchImpl: typeof globalThis.fetch,
): Promise<MatrixSession> {
  const session = await passwordLogin(config.matrix.homeserverUrl, credentials, fetchImpl);
  try {
    validateExpectedUser(config, session);
    await validateSession(session, fetchImpl);
    await writeSession(config.matrix.sessionPath, session);
    return session;
  } catch (error) {
    await fetchImpl(`${session.homeserverUrl}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }).catch(() => undefined);
    throw error;
  }
}

async function resolveMatrixSessionLocked(
  config: LoadedAppConfig,
  logger: Logger,
  fetchImpl: typeof globalThis.fetch,
): Promise<AppConfig> {
  const passwordAuth = config.matrix.passwordAuth;
  delete config.matrix.passwordAuth;

  if (config.matrix.accessToken) {
    const identity = await whoAmI(config.matrix.homeserverUrl, config.matrix.accessToken, fetchImpl);
    const session: MatrixSession = {
      version: 1,
      homeserverUrl: config.matrix.homeserverUrl,
      login: identity.user_id,
      userId: identity.user_id,
      deviceId: identity.device_id,
      accessToken: config.matrix.accessToken,
    };
    validateExpectedUser(config, session);
    await writeSession(config.matrix.sessionPath, session);
    return resolvedConfig(config, session);
  }

  let cached = await readSession(config.matrix.sessionPath);

  const cacheMatches = cached
    && cached.homeserverUrl === config.matrix.homeserverUrl
    && (!passwordAuth || cached.login === passwordAuth.login)
    && (!config.matrix.botUserId || cached.userId === config.matrix.botUserId);

  if (cached && !cacheMatches) {
    if (!passwordAuth) {
      throw new Error("The cached Matrix session does not match the configured homeserver or bot identity");
    }
    logger.info("Replacing a cached Matrix session because its configured identity changed");
    cached = undefined;
  }

  if (cached) {
    try {
      await validateSession(cached, fetchImpl);
      return resolvedConfig(config, cached);
    } catch (error) {
      if (!passwordAuth || (!isRevokedSession(error) && !(error instanceof InvalidMatrixSessionError))) throw error;
      logger.warn("Replacing a revoked or mismatched cached Matrix session using configured password authentication");
    }
  }

  if (!passwordAuth) {
    throw new Error("Set MATRIX_ACCESS_TOKEN, set MATRIX_LOGIN with MATRIX_PASSWORD, or restore MATRIX_SESSION_PATH");
  }
  const session = await loginAndPersist(config, passwordAuth, fetchImpl);
  return resolvedConfig(config, session);
}

export async function resolveMatrixSession(
  config: LoadedAppConfig,
  logger: Logger,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AppConfig> {
  await mkdir(dirname(config.matrix.sessionPath), { recursive: true, mode: 0o700 });
  const lock = new RuntimeLock(`${config.matrix.sessionPath}.auth.lock`);
  lock.acquire();
  try {
    return await resolveMatrixSessionLocked(config, logger, fetchImpl);
  } finally {
    lock.release();
  }
}
