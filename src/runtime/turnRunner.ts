import type { Actor, StoredAttachment, TurnResult } from "@karilaa-dev/codex-core";
import type { AppConfig } from "../config.js";
import type { CoreService } from "../core/service.js";
import type { Logger } from "../logging.js";
import type { DedicatedMatrixClient } from "../matrix/client.js";
import { deterministicTransactionId, threadRelation } from "../matrix/relations.js";
import { renderMessage, splitMarkdown } from "../matrix/render.js";
import type { NormalizedMessage } from "../matrix/types.js";
import type { MatrixStore } from "../storage/sqlite.js";
import type { ConversationLink, InboundEvent } from "../storage/types.js";
import type { AccessController } from "./access.js";
import type { CommandAction } from "./commands.js";
import { CommandHandler } from "./commands.js";
import { t } from "./i18n.js";
import { MAX_OUTPUT_ATTACHMENTS, MediaService } from "./media.js";
import type { DurableOutbox } from "./outbox.js";
import { formatCompletedTurn } from "./finalFormat.js";
import { ActiveTurnRegistry, type AbortableTurn } from "./activeTurns.js";

function normalized(event: InboundEvent): NormalizedMessage {
  const value = event.content.normalized;
  if (!value || typeof value !== "object") throw new Error(`Inbox event ${event.eventId} has no normalized content`);
  return value as NormalizedMessage;
}

function errorMessage(result: TurnResult, locale: "en" | "ru"): string {
  if (result.status === "context-limit") {
    return locale === "ru"
      ? "Контекст переполнен. Используйте `!compact` и повторите запрос."
      : "The context is full. Use `!compact`, then retry the request.";
  }
  if (result.status === "busy") return locale === "ru" ? "Диалог уже обрабатывает запрос." : "The conversation is already processing a request.";
  if (result.status === "cancelled") return locale === "ru" ? "Остановлено." : "Stopped.";
  if (result.status === "failed") return locale === "ru" ? `Ошибка: ${result.error.message}` : `Failed: ${result.error.message}`;
  return locale === "ru" ? "Запрос не завершён." : "The request did not complete.";
}

function progressMarkdown(answer: string, reasoning: string): string {
  if (!reasoning.trim()) return answer || "Working…";
  const details = `<details><summary>Thinking</summary>\n\n${reasoning}\n\n</details>`;
  return answer.trim() ? `${details}\n\n${answer}` : details;
}

export class TurnRunner {
  readonly #config: AppConfig;
  readonly #systemPrompt: string;
  readonly #store: MatrixStore;
  readonly #core: CoreService;
  readonly #client: DedicatedMatrixClient;
  readonly #outbox: DurableOutbox;
  readonly #media: MediaService;
  readonly #access: AccessController;
  readonly #commands: CommandHandler;
  readonly #logger: Logger;
  readonly #active = new ActiveTurnRegistry();

  constructor(options: {
    config: AppConfig;
    systemPrompt: string;
    store: MatrixStore;
    core: CoreService;
    client: DedicatedMatrixClient;
    outbox: DurableOutbox;
    media: MediaService;
    access: AccessController;
    logger: Logger;
  }) {
    this.#config = options.config;
    this.#systemPrompt = options.systemPrompt;
    this.#store = options.store;
    this.#core = options.core;
    this.#client = options.client;
    this.#outbox = options.outbox;
    this.#media = options.media;
    this.#access = options.access;
    this.#commands = new CommandHandler(options.store, options.access);
    this.#logger = options.logger;
  }

  cancelRoom(roomId: string): void {
    this.#active.cancelRoom(roomId);
  }

  cancelAll(): void {
    this.#active.cancelAll();
  }

  requestStop(roomId: string, threadRoot: string): boolean {
    return this.#active.stop(roomId, threadRoot);
  }

  async run(events: InboundEvent[]): Promise<void> {
    if (events.length === 0) return;
    const first = normalized(events[0]!);
    const preferences = this.#store.getPreferences(first.sender);
    const command = events.length === 1 ? await this.#commands.handle(first.sender, first.body) : undefined;
    if (command) {
      await this.#runCommand(first, command, events[0]?.content.immediateStop === true);
      this.#store.finishInbound(events.map((event) => event.eventId), "done");
      return;
    }

    const link = await this.#ensureConversation(first);
    const actor = this.#actor(first.sender);
    const attachments: StoredAttachment[] = [];
    const texts: string[] = [];
    for (const event of events) {
      const message = normalized(event);
      if (message.body && (message.msgtype === "m.text" || !message.media)) texts.push(message.body);
      if (message.media) attachments.push(await this.#media.ingest(actor.key, link.conversationId, message));
    }
    const text = texts.join("\n\n") || (attachments.length ? "Please analyze the attached files." : "");
    const sourceKey = `matrix:${events[0]!.eventId}`;
    const placeholder = await this.#outbox.send(
      first.roomId,
      "m.room.message",
      renderMessage(t(preferences, "working"), {
        notice: true,
        threadRoot: first.threadRoot,
        replyToEventId: events.at(-1)!.eventId,
      }),
      deterministicTransactionId(sourceKey, "placeholder"),
    );
    this.#store.saveDelivery({
      matrixEventId: placeholder,
      roomId: first.roomId,
      conversationId: link.conversationId,
      sourceEventId: first.eventId,
      kind: "placeholder",
      createdAt: Date.now(),
    });

    const abortController = new AbortController();
    const execution = this.#core.startTurn({
      actor,
      conversationId: link.conversationId,
      sourceKey,
      text,
      content: { matrix: { roomId: first.roomId, threadRoot: first.threadRoot, eventIds: events.map((event) => event.eventId) } },
      attachmentIds: attachments.map((attachment) => attachment.id),
      transportInstructions: this.#systemPrompt,
      signal: abortController.signal,
    });
    const activeTurn: AbortableTurn = { abort: (reason) => { abortController.abort(reason); execution.abort(reason); } };
    this.#active.set(first.roomId, first.threadRoot, activeTurn);

    let progressSequence = 0;
    let lastEditAt = 0;
    let latestProgress = "";
    const typingTimer = setInterval(() => {
      void this.#client.sendTyping(first.roomId, true).catch((error) => this.#logger.debug("Typing refresh failed", { error }));
    }, 25_000);
    await this.#client.sendTyping(first.roomId, true).catch(() => undefined);

    try {
      for await (const event of execution.events) {
        if (event.type !== "progress") continue;
        latestProgress = progressMarkdown(event.snapshot.answerMarkdown, event.snapshot.reasoningMarkdown);
        if (!preferences.streamEnabled || Date.now() - lastEditAt < 1_000) continue;
        lastEditAt = Date.now();
        progressSequence += 1;
        await this.#outbox.send(
          first.roomId,
          "m.room.message",
          renderMessage(latestProgress, { notice: true, replaceEventId: placeholder }),
          deterministicTransactionId(sourceKey, "progress", String(progressSequence)),
        );
      }
      const result = await execution.result;
      if (result.status === "completed") {
        for (const event of events) {
          this.#store.saveEventMapping({
            eventId: event.eventId,
            roomId: event.roomId,
            threadRoot: event.threadRoot,
            conversationId: link.conversationId,
            coreMessageId: result.userMessageId,
            direction: "inbound",
            originServerTs: event.originServerTs,
          });
        }
      }
      await this.#deliverResult(first, link, placeholder, sourceKey, result);
      this.#store.finishInbound(
        events.map((event) => event.eventId),
        result.status === "completed" || result.status === "cancelled" ? "done" : "failed",
        result.status === "failed" ? result.error.message : undefined,
      );
    } catch (error) {
      this.#store.finishInbound(events.map((event) => event.eventId), "failed", error instanceof Error ? error.message : String(error));
      await this.#outbox.send(
        first.roomId,
        "m.room.message",
        renderMessage(t(preferences, "failed"), { notice: true, replaceEventId: placeholder }),
        deterministicTransactionId(sourceKey, "failed"),
      ).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(typingTimer);
      await this.#client.sendTyping(first.roomId, false).catch(() => undefined);
      this.#active.clear(first.roomId, first.threadRoot, activeTurn);
    }
  }

  async #deliverResult(
    message: NormalizedMessage,
    link: ConversationLink,
    placeholder: string,
    sourceKey: string,
    result: TurnResult,
  ): Promise<void> {
    const preferences = this.#store.getPreferences(message.sender);
    const markdown = result.status === "completed" ? formatCompletedTurn(result) : errorMessage(result, preferences.locale);
    const chunks = splitMarkdown(markdown || "Done.", this.#config.matrix.maxEventBytes);
    let finalEventId = "";
    for (const [index, chunk] of chunks.entries()) {
      const content = index === 0
        ? renderMessage(chunk, { replaceEventId: placeholder })
        : renderMessage(chunk, { threadRoot: message.threadRoot, replyToEventId: placeholder });
      finalEventId = await this.#outbox.send(
        message.roomId,
        "m.room.message",
        content,
        deterministicTransactionId(sourceKey, "final", String(index)),
      );
    }
    this.#store.saveDelivery({
      matrixEventId: finalEventId,
      roomId: message.roomId,
      conversationId: link.conversationId,
      ...(result.status === "completed" ? { coreMessageId: result.assistantMessageId } : {}),
      sourceEventId: message.eventId,
      kind: "answer",
      createdAt: Date.now(),
    });
    if (result.status !== "completed") return;
    this.#store.saveEventMapping({
      eventId: finalEventId,
      roomId: message.roomId,
      threadRoot: message.threadRoot,
      conversationId: link.conversationId,
      coreMessageId: result.assistantMessageId,
      direction: "outbound",
      originServerTs: Date.now(),
    });
    for (const attachment of result.attachments.slice(0, MAX_OUTPUT_ATTACHMENTS)) {
      const content = await this.#media.upload(attachment, message.roomId);
      const relation = threadRelation(message.threadRoot, finalEventId);
      const eventId = await this.#outbox.send(
        message.roomId,
        "m.room.message",
        { ...content, ...(relation ? { "m.relates_to": relation } : {}) },
        deterministicTransactionId(sourceKey, "attachment", attachment.id),
      );
      this.#store.saveDelivery({
        matrixEventId: eventId,
        roomId: message.roomId,
        conversationId: link.conversationId,
        coreMessageId: result.assistantMessageId,
        sourceEventId: message.eventId,
        kind: "attachment",
        createdAt: Date.now(),
      });
    }
  }

  async #ensureConversation(message: NormalizedMessage): Promise<ConversationLink> {
    const existing = this.#store.getConversation(message.roomId, message.threadRoot);
    if (existing) return existing;
    const actorKey = `matrix:${message.sender}`;
    if (message.threadRoot === "main") {
      const conversation = await this.#core.createConversation(actorKey, "Matrix DM");
      const link = { roomId: message.roomId, threadRoot: "main", conversationId: conversation.id };
      this.#store.saveConversation(link);
      return link;
    }
    const main = await this.#ensureConversation({ ...message, threadRoot: "main" });
    const rootMapping = this.#store.findEventMapping(message.roomId, message.threadRoot)
      ?? this.#store.findLatestEventMapping(message.roomId, "main", message.timestamp);
    const conversation = await this.#core.forkConversation(main.conversationId, actorKey, {
      ...(rootMapping?.coreMessageId ? { forkPointMessageId: rootMapping.coreMessageId } : {}),
      title: "Matrix thread",
    });
    const link = {
      roomId: message.roomId,
      threadRoot: message.threadRoot,
      conversationId: conversation.id,
      rootEventId: message.threadRoot,
    };
    this.#store.saveConversation(link);
    return link;
  }

  #actor(mxid: string): Actor {
    const preferences = this.#store.getPreferences(mxid);
    return {
      key: `matrix:${mxid}`,
      displayName: mxid,
      locale: preferences.locale,
      timezoneOffsetMinutes: preferences.timezoneOffsetMinutes,
    };
  }

  async #runCommand(message: NormalizedMessage, command: CommandAction, immediateStop = false): Promise<void> {
    const preferences = this.#store.getPreferences(message.sender);
    const sourceKey = `matrix:${message.eventId}`;
    if (command.kind === "reply") {
      await this.#reply(message, command.markdown, sourceKey);
      return;
    }
    if (command.kind === "stop") {
      const stopped = immediateStop || this.requestStop(message.roomId, message.threadRoot);
      await this.#reply(message, t(preferences, stopped ? "stopped" : "noActiveTurn"), sourceKey);
      return;
    }
    const link = await this.#ensureConversation(message);
    if (command.kind === "compact") {
      await this.#core.compactConversation(link.conversationId);
      await this.#reply(message, t(preferences, "compacted"), sourceKey);
      return;
    }
    if (command.kind === "retry") {
      const failed = this.#store.getLatestFailed(message.roomId, message.threadRoot, message.sender);
      if (failed) this.#store.retryInbound(failed.eventId);
      await this.#reply(message, failed ? "Retry queued." : t(preferences, "retryMissing"), sourceKey);
      return;
    }
    const delivery = this.#store.findLatestEventMapping(message.roomId, message.threadRoot, message.timestamp);
    const fork = await this.#core.forkConversation(link.conversationId, `matrix:${message.sender}`, {
      ...(delivery?.coreMessageId ? { forkPointMessageId: delivery.coreMessageId } : {}),
      ...(command.title ? { title: command.title } : {}),
    });
    const rootContent = renderMessage(command.title ? `**${command.title}**` : "**New conversation**");
    const rootEventId = await this.#outbox.send(
      message.roomId,
      "m.room.message",
      rootContent,
      deterministicTransactionId(sourceKey, "fork-root"),
    );
    this.#store.saveConversation({ roomId: message.roomId, threadRoot: rootEventId, conversationId: fork.id, rootEventId });
    this.#store.saveDelivery({
      matrixEventId: rootEventId,
      roomId: message.roomId,
      conversationId: fork.id,
      sourceEventId: message.eventId,
      kind: "thread-root",
      createdAt: Date.now(),
    });
    await this.#outbox.send(
      message.roomId,
      "m.room.message",
      renderMessage(t(preferences, "forked"), { threadRoot: rootEventId, replyToEventId: rootEventId }),
      deterministicTransactionId(sourceKey, "fork-child"),
    );
  }

  async #reply(message: NormalizedMessage, markdown: string, sourceKey: string): Promise<void> {
    await this.#outbox.send(
      message.roomId,
      "m.room.message",
      renderMessage(markdown, { threadRoot: message.threadRoot, replyToEventId: message.eventId }),
      deterministicTransactionId(sourceKey, "command"),
    );
  }
}
