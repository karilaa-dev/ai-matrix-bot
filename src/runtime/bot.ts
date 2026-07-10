import type { AppConfig } from "../config.js";
import { readSystemPrompt } from "../config.js";
import { CoreService } from "../core/service.js";
import type { Logger } from "../logging.js";
import { DedicatedMatrixClient } from "../matrix/client.js";
import { deterministicTransactionId, normalizeMessage } from "../matrix/relations.js";
import { renderMessage } from "../matrix/render.js";
import type { MatrixEvent } from "../matrix/types.js";
import { MatrixStore } from "../storage/sqlite.js";
import { AccessController } from "./access.js";
import { t } from "./i18n.js";
import { RuntimeLock } from "./lock.js";
import { MediaService } from "./media.js";
import { DurableOutbox } from "./outbox.js";
import { Semaphore } from "./semaphore.js";
import { TurnRunner } from "./turnRunner.js";
import { KeyedSerialQueue } from "./keyedQueue.js";

function relationTarget(content: Record<string, unknown>): string | undefined {
  const relation = content["m.relates_to"];
  if (!relation || typeof relation !== "object" || Array.isArray(relation)) return undefined;
  const value = (relation as Record<string, unknown>).event_id;
  return typeof value === "string" ? value : undefined;
}

export class MatrixBotRuntime {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #store: MatrixStore;
  readonly #lock: RuntimeLock;
  readonly #core: CoreService;
  readonly #client: DedicatedMatrixClient;
  readonly #outbox: DurableOutbox;
  readonly #access: AccessController;
  readonly #runner: TurnRunner;
  readonly #semaphore: Semaphore;
  readonly #conversationQueue = new KeyedSerialQueue();
  readonly #runningBatchKeys = new Set<string>();
  #scanTimer?: NodeJS.Timeout;
  #stopping = false;

  constructor(config: AppConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#store = new MatrixStore(config.matrix.databasePath);
    this.#lock = new RuntimeLock(`${config.matrix.databasePath}.lock`);
    this.#core = new CoreService(config.core, logger);
    this.#client = new DedicatedMatrixClient(config.matrix, logger);
    this.#outbox = new DurableOutbox(this.#store, this.#client, logger);
    this.#access = new AccessController(
      config.matrix,
      this.#client,
      this.#store,
      logger,
      (roomId) => this.#runner?.cancelRoom(roomId),
    );
    const media = new MediaService(this.#client, this.#core);
    this.#runner = new TurnRunner({
      config,
      systemPrompt: readSystemPrompt(config),
      store: this.#store,
      core: this.#core,
      client: this.#client,
      outbox: this.#outbox,
      media,
      access: this.#access,
      logger,
    });
    this.#semaphore = new Semaphore(config.matrix.globalConcurrency);
  }

  async start(): Promise<void> {
    this.#lock.acquire();
    this.#store.recoverProcessing();
    this.#store.recoverOutbox();
    this.#store.setValue("runtime.ready", "0");
    try {
      const versions = await this.#client.versions();
      this.#validateVersions(versions);
      await this.#client.start({
        beforeSync: () => this.#access.revalidateActiveRooms(),
        onSync: () => this.#heartbeat(),
        onAccountData: (event) => this.#access.handleAccountData(event),
        onEvent: (roomId, event) => this.#onEvent(roomId, event),
        onInvite: async (roomId, event) => {
          await this.#access.handleInvite(roomId, event);
        },
      });
      await this.#outbox.drain().catch((error) => this.#logger.warn("Outbox recovery paused", { error }));
      this.#scanTimer = setInterval(() => this.#scan(), 100);
      this.#store.setValue("runtime.ready", "1");
      this.#logger.info("AI Matrix bot is ready", {
        userId: this.#client.userId,
        globalConcurrency: this.#config.matrix.globalConcurrency,
      });
    } catch (error) {
      this.#stopping = true;
      await this.#client.stop().catch(() => undefined);
      await this.#core.close().catch(() => undefined);
      this.#store.close();
      this.#lock.release();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#store.setValue("runtime.ready", "0");
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    this.#runner.cancelAll();
    await this.#client.stop().catch((error) => this.#logger.warn("Matrix client stop failed", { error }));
    try {
      await this.#conversationQueue.drain();
      await this.#core.close().catch((error) => this.#logger.warn("Codex core close failed", { error }));
    } finally {
      this.#store.close();
      this.#lock.release();
    }
  }

  #heartbeat(): void {
    this.#store.setValue("runtime.heartbeat_at", String(Date.now()));
  }

  #validateVersions(response: Record<string, unknown>): void {
    const versions = Array.isArray(response.versions) ? response.versions.filter((item): item is string => typeof item === "string") : [];
    const supportsThreads = versions.some((version) => {
      const match = /^v(\d+)\.(\d+)$/.exec(version);
      return match ? Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 4) : false;
    });
    if (!supportsThreads) throw new Error("The Matrix homeserver must support Matrix client-server API v1.4 or newer for threads");
  }

  async #onEvent(roomId: string, event: MatrixEvent): Promise<void> {
    if (this.#stopping) return;
    this.#heartbeat();
    if (event.sender === this.#client.userId) return;
    if (event.type === "m.room.member") {
      await this.#access.handleMembership(roomId, event);
      return;
    }
    if (event.type === "m.reaction") return;
    const message = normalizeMessage(roomId, event);
    if (!message) return;
    if (message.msgtype === "m.notice" || !this.#access.isAllowed(message.sender)) return;
    const room = this.#store.getRoom(roomId);
    if (!room || room.status !== "active" || room.peerMxid !== message.sender) return;

    if (message.editTargetEventId) {
      const original = this.#store.getInbound(message.editTargetEventId);
      const replacement = { ...message, eventId: message.editTargetEventId, editTargetEventId: undefined };
      if (original && this.#store.replaceQueuedContent(message.editTargetEventId, { normalized: replacement })) return;
      const preferences = this.#store.getPreferences(message.sender);
      void this.#outbox.send(
        roomId,
        "m.room.message",
        renderMessage(t(preferences, "correctionLate"), {
          notice: true,
          threadRoot: message.threadRoot,
          replyToEventId: message.eventId,
        }),
        deterministicTransactionId(`matrix:${message.eventId}`, "late-edit"),
      ).catch((error) => this.#logger.warn("Failed to report late edit", { roomId, error }));
      return;
    }

    const immediateStop = message.body.trim().toLowerCase() === "!stop"
      ? this.#runner.requestStop(roomId, message.threadRoot)
      : undefined;
    const command = message.body.startsWith("!");
    const batchKey = JSON.stringify(command
      ? [roomId, message.threadRoot, message.sender, `command:${message.eventId}`]
      : [roomId, message.threadRoot, message.sender]);
    const inserted = this.#store.enqueueInbound({
      eventId: message.eventId,
      roomId,
      sender: message.sender,
      type: event.type,
      content: { normalized: message, ...(immediateStop !== undefined ? { immediateStop } : {}) },
      originServerTs: message.timestamp,
      threadRoot: message.threadRoot,
      batchKey,
      sourceKey: `matrix:${message.eventId}`,
    });
    if (inserted) this.#logger.debug("Queued inbound Matrix event", { roomId, eventId: message.eventId, threadRoot: message.threadRoot });
  }

  #scan(): void {
    if (this.#stopping) return;
    const cutoff = Date.now() - this.#config.matrix.batchWindowMs;
    for (const batchKey of this.#store.listReadyBatchKeys(cutoff)) {
      if (this.#runningBatchKeys.has(batchKey)) continue;
      this.#runningBatchKeys.add(batchKey);
      void (async () => {
        const events = this.#store.claimBatch(batchKey);
        if (!events.length) return;
        const conversationKey = JSON.stringify([events[0]!.roomId, events[0]!.threadRoot]);
        try {
          await this.#conversationQueue.run(
            conversationKey,
            () => this.#semaphore.run(() => this.#runner.run(events)),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#store.failClaimedInbound(events.map((event) => event.eventId), message);
          throw error;
        }
      })().catch((error) => {
        this.#logger.error("Inbound Matrix batch failed", { batchKey, error });
      }).finally(() => {
        this.#runningBatchKeys.delete(batchKey);
      });
    }
  }
}
