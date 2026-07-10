import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import MatrixBotSdk from "@vector-im/matrix-bot-sdk";
import type {
  MatrixClient as MatrixClientType,
  RustSdkCryptoStoreType as RustSdkCryptoStoreTypeValue,
} from "@vector-im/matrix-bot-sdk";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { decryptMedia, encryptMedia } from "./mediaCrypto.js";
import type { MatrixEncryptedFile, MatrixEvent } from "./types.js";

const {
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} = MatrixBotSdk;
const SQLITE_CRYPTO_STORE = 0 as RustSdkCryptoStoreTypeValue;

export interface MatrixClientHandlers {
  beforeSync?(): Promise<void> | void;
  onSync?(): Promise<void> | void;
  onAccountData?(event: MatrixEvent): Promise<void> | void;
  onEvent(roomId: string, event: MatrixEvent): Promise<void> | void;
  onInvite(roomId: string, event?: MatrixEvent): Promise<void> | void;
}

export interface UploadedMedia {
  url: string;
  encryptedFile?: MatrixEncryptedFile;
}

type SdkClient = MatrixClientType & {
  doRequest<T>(method: string, endpoint: string, query?: Record<string, string> | null, body?: unknown): Promise<T>;
};

type DurableSyncEventHandler = (eventType: string, ...payload: unknown[]) => Promise<void> | void;

export function createDurableSyncEmitter(
  handler: DurableSyncEventHandler,
  emit?: (eventType: string, ...payload: unknown[]) => void,
): (eventType: string, ...payload: unknown[]) => Promise<void> {
  return async (eventType, ...payload) => {
    await handler(eventType, ...payload);
    emit?.(eventType, ...payload);
  };
}

export async function processDurableSyncCycle<T extends { next_batch: string }>(options: {
  token: string | null;
  doSync(token: string | null): Promise<T>;
  processSync(response: T): Promise<void>;
  persistToken(token: string): Promise<void> | void;
}): Promise<string> {
  const response = await options.doSync(options.token);
  await options.processSync(response);
  await options.persistToken(response.next_batch);
  return response.next_batch;
}

class DurableSyncMatrixClient extends MatrixClient {
  #durableHandler?: DurableSyncEventHandler;
  #syncSuccessHandler?: () => Promise<void> | void;
  #syncLoop?: Promise<void>;
  #stopRequested = false;
  #resolveFirstSync: (() => void) | undefined;
  readonly #firstSync = new Promise<void>((resolve) => { this.#resolveFirstSync = resolve; });

  enableDurableSyncTokenPersistence(): void {
    this.persistTokenAfterSync = true;
  }

  setDurableHandler(handler: DurableSyncEventHandler): void {
    this.#durableHandler = handler;
  }

  setSyncSuccessHandler(handler: () => Promise<void> | void): void {
    this.#syncSuccessHandler = handler;
  }

  protected override startSyncInternal(): Promise<unknown> {
    const handler = this.#durableHandler ?? (() => undefined);
    const emit = createDurableSyncEmitter(handler, (eventType, ...payload) => {
      this.emit(eventType, ...payload);
    });
    this.#stopRequested = false;
    this.#syncLoop = this.#runDurableSyncLoop(emit);
    return Promise.resolve();
  }

  override stop(): void {
    this.#stopRequested = true;
    super.stop();
  }

  waitForSyncStop(): Promise<void> {
    return this.#syncLoop ?? Promise.resolve();
  }

  waitForFirstSync(): Promise<void> {
    return this.#firstSync;
  }

  async #runDurableSyncLoop(emit: (eventType: string, ...payload: unknown[]) => Promise<void>): Promise<void> {
    let token = await Promise.resolve(this.storageProvider.getSyncToken());
    while (!this.#stopRequested) {
      try {
        token = await processDurableSyncCycle({
          token,
          doSync: (currentToken) => this.doSync(currentToken ?? ""),
          processSync: async (response) => { await this.processSync(response, emit); },
          persistToken: async (nextToken) => { await Promise.resolve(this.storageProvider.setSyncToken(nextToken)); },
        });
        this.#resolveFirstSync?.();
        this.#resolveFirstSync = undefined;
        await this.#syncSuccessHandler?.();
      } catch (error) {
        if (this.#stopRequested) return;
        this.emit("sync.error", error);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
}

function eventId(response: unknown): string {
  if (response && typeof response === "object" && "event_id" in response && typeof response.event_id === "string") {
    return response.event_id;
  }
  if (typeof response === "string") return response;
  throw new Error("Matrix send did not return an event_id");
}

export async function downloadMatrixMedia(options: {
  url: string;
  homeserverUrl: string;
  accessToken: string;
  maxBytes: number;
  fetch?: typeof globalThis.fetch;
}): Promise<Buffer> {
  if (!options.url.startsWith("mxc://")) throw new Error("Matrix media URL must use mxc://");
  const withoutScheme = options.url.slice("mxc://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0 || slash === withoutScheme.length - 1) throw new Error("Invalid Matrix media URL");
  const serverName = withoutScheme.slice(0, slash);
  const mediaId = withoutScheme.slice(slash + 1);
  const encodedPath = `${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
  const endpoints = [
    `/_matrix/client/v1/media/download/${encodedPath}`,
    `/_matrix/media/v3/download/${encodedPath}`,
  ];
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response | undefined;
  for (const endpoint of endpoints) {
    response = await fetchImpl(`${options.homeserverUrl}${endpoint}`, {
      headers: { authorization: `Bearer ${options.accessToken}` },
    });
    if (response.ok) break;
    if (response.status !== 404 && response.status !== 405 && response.status !== 501) {
      throw new Error(`Matrix media download failed with HTTP ${response.status}`);
    }
  }
  if (!response?.ok) throw new Error(`Matrix media download failed with HTTP ${response?.status ?? "unknown"}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) throw new Error("Attachment exceeds the 20 MiB limit");
  if (!response.body) throw new Error("Matrix media response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        await reader.cancel("media size limit exceeded");
        throw new Error("Attachment exceeds the 20 MiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

export class DedicatedMatrixClient {
  readonly #config: AppConfig["matrix"];
  readonly #logger: Logger;
  readonly #client: SdkClient & DurableSyncMatrixClient;
  #userId?: string;
  #syncPromise?: Promise<unknown>;

  constructor(config: AppConfig["matrix"], logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    mkdirSync(dirname(config.storagePath), { recursive: true, mode: 0o700 });
    mkdirSync(config.cryptoPath, { recursive: true, mode: 0o700 });
    const storage = new SimpleFsStorageProvider(config.storagePath);
    const crypto = new RustSdkCryptoStorageProvider(config.cryptoPath, SQLITE_CRYPTO_STORE);
    const client = new DurableSyncMatrixClient(
      config.homeserverUrl,
      config.accessToken,
      storage,
      crypto,
    );
    client.enableDurableSyncTokenPersistence();
    this.#client = client as SdkClient & DurableSyncMatrixClient;
  }

  get raw(): MatrixClientType {
    return this.#client;
  }

  get userId(): string {
    if (!this.#userId) throw new Error("Matrix client has not started");
    return this.#userId;
  }

  async start(handlers: MatrixClientHandlers): Promise<void> {
    this.#userId = await this.#client.getUserId();
    if (this.#config.botUserId && this.#userId !== this.#config.botUserId) {
      throw new Error(`Matrix token belongs to ${this.#userId}, expected ${this.#config.botUserId}`);
    }
    this.#client.setDurableHandler(async (eventType, ...payload) => {
      if (eventType === "room.event") {
        await handlers.onEvent(payload[0] as string, payload[1] as MatrixEvent);
      } else if (eventType === "room.invite") {
        await handlers.onInvite(payload[0] as string, payload[1] as MatrixEvent | undefined);
      } else if (eventType === "account_data") {
        await handlers.onAccountData?.(payload[0] as MatrixEvent);
      }
    });
    this.#client.setSyncSuccessHandler(async () => { await handlers.onSync?.(); });
    await this.#client.crypto.prepare();
    if (this.#config.recoveryKey && await this.#client.crypto.isRecoveryAvailable()) {
      await this.#client.crypto.confirmIdentityWithRecoveryKey(this.#config.recoveryKey);
    }
    await handlers.beforeSync?.();
    await this.#client.start();
    this.#syncPromise = this.#client.waitForSyncStop().catch((error) => {
      this.#logger.error("Matrix sync loop stopped", { error });
      throw error;
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#client.waitForFirstSync(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Matrix /sync did not become ready within 60 seconds")), 60_000);
        }),
      ]);
    } catch (error) {
      this.#client.stop();
      await this.#syncPromise?.catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    this.#logger.info("Matrix client started", { userId: this.#userId, homeserver: this.#config.homeserverUrl });
  }

  async stop(): Promise<void> {
    this.#client.stop();
    await this.#syncPromise?.catch(() => undefined);
  }

  async initializeCryptoIdentity(recoveryKey?: string): Promise<{ created: boolean; recoveryKey?: string }> {
    this.#userId = await this.#client.getUserId();
    await this.#client.crypto.prepare();
    if (await this.#client.crypto.isRecoveryAvailable()) {
      if (!recoveryKey) throw new Error("Matrix recovery is already configured; provide MATRIX_RECOVERY_KEY(_FILE)");
      await this.#client.crypto.confirmIdentityWithRecoveryKey(recoveryKey);
      return { created: false };
    }
    const createdKey = await this.#client.crypto.createIdentity(recoveryKey);
    return { created: true, recoveryKey: createdKey };
  }

  async whoAmI(): Promise<{ user_id: string; device_id?: string }> {
    return this.#client.doRequest("GET", "/_matrix/client/v3/account/whoami");
  }

  async versions(): Promise<Record<string, unknown>> {
    return this.#client.doRequest("GET", "/_matrix/client/versions");
  }

  async joinRoom(roomId: string): Promise<string> {
    return this.#client.joinRoom(roomId);
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.#client.leaveRoom(roomId, reason);
  }

  async joinedMembers(roomId: string): Promise<string[]> {
    return this.#client.getJoinedRoomMembers(roomId);
  }

  async invitedMembers(roomId: string): Promise<string[]> {
    const state = await this.#client.getRoomState(roomId);
    return state
      .filter((event: MatrixEvent) => event.type === "m.room.member" && event.content.membership === "invite")
      .map((event: MatrixEvent) => event.state_key)
      .filter((value: string | undefined): value is string => Boolean(value));
  }

  async isEncrypted(roomId: string): Promise<boolean> {
    try {
      await this.#client.getRoomStateEvent(roomId, "m.room.encryption", "");
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) return false;
      if (error && typeof error === "object" && "errcode" in error && error.errcode === "M_NOT_FOUND") return false;
      throw error;
    }
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>, transactionId: string): Promise<string> {
    if (await this.#client.crypto.isRoomEncrypted(roomId)) {
      content = await this.#client.crypto.encryptRoomEvent(roomId, type, content) as unknown as Record<string, unknown>;
      type = "m.room.encrypted";
    }
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(transactionId)}`;
    return eventId(await this.#client.doRequest("PUT", path, null, content));
  }

  async sendTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    await this.#client.setTyping(roomId, typing, timeoutMs);
  }

  async download(url: string, encryptedFile?: MatrixEncryptedFile): Promise<Buffer> {
    const payload = await downloadMatrixMedia({
      url,
      homeserverUrl: this.#config.homeserverUrl,
      accessToken: this.#config.accessToken,
      maxBytes: 20 * 1024 * 1024,
    });
    return encryptedFile ? decryptMedia(payload, encryptedFile) : payload;
  }

  async upload(
    bytes: Buffer,
    mimeType: string,
    filename: string,
    encrypted: boolean,
  ): Promise<UploadedMedia> {
    if (!encrypted) {
      return { url: await this.#client.uploadContent(bytes, mimeType, filename) };
    }
    const encryptedPayload = encryptMedia(bytes);
    const url = await this.#client.uploadContent(encryptedPayload.ciphertext, "application/octet-stream", filename);
    return { url, encryptedFile: { ...encryptedPayload.file, url } };
  }
}
