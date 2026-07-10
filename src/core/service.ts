import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import {
  createCodexCore,
  type Actor,
  type BlobStore,
  type CodexCore,
  type Conversation,
  type StoredAttachment,
  type TurnExecution,
} from "@karilaa-dev/codex-core";
import { createSQLitePersistence } from "@karilaa-dev/codex-core/storage/sqlite";
import { createPostgresPersistence } from "@karilaa-dev/codex-core/storage/postgres";
import { CodexAppServerClient } from "@karilaa-dev/codex-core/app-server";
import {
  createCodexHelperProviders,
  createDoclingAttachmentExtractor,
  createOpenRouterEmbeddingProvider,
  createPersistentShellProvider,
  createTavilyProvider,
  type CoreProviders,
} from "@karilaa-dev/codex-core/providers";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";

class LocalBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    const target = resolve(this.#root, key);
    if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`)) throw new Error("Blob key escapes FILE_ROOT");
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.#path(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.#path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  localPath(key: string): string {
    return this.#path(key);
  }
}

function persistenceFor(databaseUrl: string) {
  if (databaseUrl.startsWith("postgres:") || databaseUrl.startsWith("postgresql:")) {
    return createPostgresPersistence({ url: databaseUrl });
  }
  if (databaseUrl === ":memory:") return createSQLitePersistence({ path: databaseUrl });
  const path = databaseUrl.startsWith("file:") ? resolve(databaseUrl.slice("file:".length)) : resolve(databaseUrl);
  return createSQLitePersistence({ path });
}

export class CoreService {
  readonly #core: CodexCore;
  readonly #blobStore: LocalBlobStore;

  constructor(config: AppConfig["core"], logger: Logger) {
    const persistence = persistenceFor(config.databaseUrl);
    this.#blobStore = new LocalBlobStore(config.fileRoot);
    const environment = config.codexHome ? { ...process.env, CODEX_HOME: config.codexHome } : undefined;
    const appServer = new CodexAppServerClient({
      binary: config.codexPath,
      ...(environment ? { environment } : {}),
      clientName: "ai-matrix-bot",
      clientTitle: "AI Matrix Bot",
      logger,
    });
    const helperProviders = createCodexHelperProviders({
      inference: appServer,
      chatModel: config.codexModel,
      compactionModel: config.codexCompactionModel,
      imageModel: config.codexImageModel,
      cwd: config.codexWorkingDirectory,
      serviceTier: config.codexSpeedMode === "fast" ? "priority" : null,
      verbosity: config.codexVerbosity,
      imageTimeoutMs: config.imageTimeoutMs,
      logger,
    });
    const providers: CoreProviders = {
      ...helperProviders,
      shell: createPersistentShellProvider({
        root: config.bashRoot,
        timeoutMs: config.bashTimeoutMs,
        maxOutputChars: config.bashMaxOutputCharacters,
        logger,
      }),
      ...(config.doclingUrl ? {
        attachments: createDoclingAttachmentExtractor({
          baseUrl: config.doclingUrl,
          timeoutMs: config.doclingTimeoutMs,
          logger,
        }),
      } : {}),
      ...(config.tavilyApiKey ? { web: createTavilyProvider({ apiKey: config.tavilyApiKey, logger }) } : {}),
      ...(config.openRouterApiKey ? {
        embeddings: createOpenRouterEmbeddingProvider({
          apiKey: config.openRouterApiKey,
          model: config.openRouterEmbeddingModel,
          logger,
        }),
      } : {}),
    };
    this.#core = createCodexCore({
      persistence,
      appServer,
      model: config.codexModel,
      serviceTier: config.codexSpeedMode === "fast" ? "priority" : null,
      reasoningEffort: config.reasoningEffort,
      reasoningSummary: config.reasoningSummary,
      verbosity: config.codexVerbosity,
      providers,
      blobStore: this.#blobStore,
      logger,
      fileRoot: config.fileRoot,
      bashRoot: config.bashRoot,
      codexWorkingDirectory: config.codexWorkingDirectory,
      contextWarningRatio: config.contextWarningRatio,
      turnTimeoutMs: config.turnTimeoutMs,
    });
  }

  createConversation(actorKey: string, title?: string): Promise<Conversation> {
    return this.#core.createConversation({ actorKey, ...(title ? { title } : {}) });
  }

  forkConversation(
    conversationId: string,
    actorKey: string,
    options: { forkPointMessageId?: string; title?: string } = {},
  ): Promise<Conversation> {
    return this.#core.forkConversation({ conversationId, actorKey, ...options });
  }

  compactConversation(conversationId: string): ReturnType<CodexCore["compactConversation"]> {
    return this.#core.compactConversation({ conversationId });
  }

  ingestAttachment(input: {
    actorKey: string;
    conversationId: string;
    name: string;
    bytes: Uint8Array;
    mimeType?: string;
    source: { adapter: string; id: string; uniqueId?: string; metadata?: Record<string, unknown> };
  }): Promise<StoredAttachment> {
    return this.#core.ingestAttachment(input);
  }

  startTurn(input: {
    actor: Actor;
    conversationId: string;
    sourceKey: string;
    text: string;
    content?: unknown;
    attachmentIds?: string[];
    transportInstructions?: string;
    signal?: AbortSignal;
  }): TurnExecution {
    return this.#core.startTurn({
      actor: input.actor,
      conversationId: input.conversationId,
      message: {
        kind: "new",
        sourceKey: input.sourceKey,
        text: input.text,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
      },
      ...(input.transportInstructions ? { transportInstructions: input.transportInstructions } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  resumeTurn(input: {
    actor: Actor;
    conversationId: string;
    messageId: string;
    transportInstructions?: string;
    signal?: AbortSignal;
  }): TurnExecution {
    return this.#core.startTurn({
      actor: input.actor,
      conversationId: input.conversationId,
      message: { kind: "existing", messageId: input.messageId },
      ...(input.transportInstructions ? { transportInstructions: input.transportInstructions } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async attachmentBytes(attachment: StoredAttachment): Promise<Buffer> {
    return Buffer.from(await this.#blobStore.get(attachment.blobKey));
  }

  close(): Promise<void> {
    return this.#core.close();
  }
}
