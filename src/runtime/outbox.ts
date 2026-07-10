import { randomUUID } from "node:crypto";
import type { Logger } from "../logging.js";
import type { DedicatedMatrixClient } from "../matrix/client.js";
import type { MatrixStore } from "../storage/sqlite.js";

export class DurableOutbox {
  readonly #store: MatrixStore;
  readonly #client: DedicatedMatrixClient;
  readonly #logger: Logger;
  #draining: Promise<void> = Promise.resolve();

  constructor(store: MatrixStore, client: DedicatedMatrixClient, logger: Logger) {
    this.#store = store;
    this.#client = client;
    this.#logger = logger;
  }

  async send(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    transactionId: string,
  ): Promise<string> {
    const existing = this.#store.enqueueOutbound({
      jobId: randomUUID(),
      transactionId,
      roomId,
      eventType,
      content,
    });
    if (existing.state === "sent" && existing.eventId) return existing.eventId;
    await this.drain();
    const completed = this.#store.getOutboundByTransaction(transactionId);
    if (completed?.state === "sent" && completed.eventId) return completed.eventId;
    throw new Error(completed?.error ?? `Matrix delivery ${transactionId} did not complete`);
  }

  drain(): Promise<void> {
    const work = this.#draining.then(() => this.#drainLoop());
    this.#draining = work.catch(() => undefined);
    return work;
  }

  async #drainLoop(): Promise<void> {
    for (;;) {
      const job = this.#store.nextOutbound();
      if (!job) return;
      try {
        const eventId = await this.#client.sendEvent(job.roomId, job.eventType, job.content, job.transactionId);
        this.#store.finishOutbound(job.jobId, eventId);
        this.#logger.debug("Delivered Matrix outbox event", {
          roomId: job.roomId,
          eventType: job.eventType,
          transactionId: job.transactionId,
          eventId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.failOutbound(job.jobId, message);
        this.#logger.warn("Matrix outbox delivery failed", {
          roomId: job.roomId,
          transactionId: job.transactionId,
          attempts: job.attempts,
          error,
        });
        throw error;
      }
    }
  }
}
