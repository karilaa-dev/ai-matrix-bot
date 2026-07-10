import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationLink,
  DeliveryRecord,
  EventMapping,
  InboundEvent,
  OutboundJob,
  RoomRecord,
  UserPreferences,
} from "./types.js";

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export class MatrixStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS matrix_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matrix_allowed_users (
        mxid TEXT PRIMARY KEY,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matrix_user_preferences (
        mxid TEXT PRIMARY KEY,
        locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ru')),
        timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
        stream_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matrix_rooms (
        room_id TEXT PRIMARY KEY,
        peer_mxid TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        direct INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'rejected', 'left')),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matrix_conversations (
        room_id TEXT NOT NULL,
        thread_root TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        root_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, thread_root),
        UNIQUE (conversation_id)
      );
      CREATE TABLE IF NOT EXISTS matrix_inbox (
        event_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        origin_server_ts INTEGER NOT NULL,
        thread_root TEXT NOT NULL,
        batch_key TEXT NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'done', 'failed', 'ignored')),
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS matrix_inbox_pending_idx
        ON matrix_inbox (state, batch_key, received_at);
      CREATE TABLE IF NOT EXISTS matrix_outbox (
        job_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        event_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matrix_outbox_pending_idx
        ON matrix_outbox (state, created_at);
      CREATE TABLE IF NOT EXISTS matrix_deliveries (
        matrix_event_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        core_message_id TEXT,
        source_event_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('placeholder', 'answer', 'attachment', 'thread-root')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matrix_deliveries_core_idx
        ON matrix_deliveries (core_message_id);
      CREATE INDEX IF NOT EXISTS matrix_deliveries_source_idx
        ON matrix_deliveries (room_id, source_event_id, created_at);
      CREATE TABLE IF NOT EXISTS matrix_event_mappings (
        event_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        thread_root TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        core_message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        origin_server_ts INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matrix_event_mappings_scope_idx
        ON matrix_event_mappings (room_id, thread_root, origin_server_ts);
    `);
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getValue(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM matrix_kv WHERE key = ?").get(key) as Row | undefined;
    return row ? text(row.value) : undefined;
  }

  setValue(key: string, value: string): void {
    this.#db.prepare(`
      INSERT INTO matrix_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  bootstrapOwner(mxid: string): void {
    this.allowUser(mxid, mxid);
  }

  allowUser(mxid: string, createdBy: string): void {
    this.#db.prepare(`
      INSERT INTO matrix_allowed_users (mxid, created_by, created_at) VALUES (?, ?, ?)
      ON CONFLICT(mxid) DO NOTHING
    `).run(mxid, createdBy, Date.now());
  }

  denyUser(mxid: string, ownerId: string): boolean {
    if (mxid === ownerId) return false;
    return number(this.#db.prepare("DELETE FROM matrix_allowed_users WHERE mxid = ?").run(mxid).changes) > 0;
  }

  isAllowed(mxid: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM matrix_allowed_users WHERE mxid = ?").get(mxid));
  }

  listAllowedUsers(): string[] {
    return (this.#db.prepare("SELECT mxid FROM matrix_allowed_users ORDER BY created_at, mxid").all() as Row[])
      .map((row) => text(row.mxid));
  }

  getPreferences(mxid: string): UserPreferences {
    const row = this.#db.prepare("SELECT * FROM matrix_user_preferences WHERE mxid = ?").get(mxid) as Row | undefined;
    return row ? this.#preferences(row) : { mxid, locale: "en", timezoneOffsetMinutes: 0, streamEnabled: true };
  }

  savePreferences(preferences: UserPreferences): void {
    this.#db.prepare(`
      INSERT INTO matrix_user_preferences
        (mxid, locale, timezone_offset_minutes, stream_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mxid) DO UPDATE SET
        locale = excluded.locale,
        timezone_offset_minutes = excluded.timezone_offset_minutes,
        stream_enabled = excluded.stream_enabled,
        updated_at = excluded.updated_at
    `).run(
      preferences.mxid,
      preferences.locale,
      preferences.timezoneOffsetMinutes,
      preferences.streamEnabled ? 1 : 0,
      Date.now(),
    );
  }

  #preferences(row: Row): UserPreferences {
    return {
      mxid: text(row.mxid),
      locale: text(row.locale) === "ru" ? "ru" : "en",
      timezoneOffsetMinutes: number(row.timezone_offset_minutes),
      streamEnabled: number(row.stream_enabled) === 1,
    };
  }

  upsertRoom(room: RoomRecord): void {
    this.#db.prepare(`
      INSERT INTO matrix_rooms (room_id, peer_mxid, encrypted, direct, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        peer_mxid = excluded.peer_mxid,
        encrypted = excluded.encrypted,
        direct = excluded.direct,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(room.roomId, room.peerMxid, room.encrypted ? 1 : 0, room.direct ? 1 : 0, room.status, Date.now());
  }

  getRoom(roomId: string): RoomRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM matrix_rooms WHERE room_id = ?").get(roomId) as Row | undefined;
    if (!row) return undefined;
    return {
      roomId: text(row.room_id),
      peerMxid: text(row.peer_mxid),
      encrypted: number(row.encrypted) === 1,
      direct: number(row.direct) === 1,
      status: text(row.status) as RoomRecord["status"],
    };
  }

  listActiveRooms(): RoomRecord[] {
    return (this.#db.prepare("SELECT * FROM matrix_rooms WHERE status = 'active' ORDER BY room_id").all() as Row[])
      .map((row) => ({
        roomId: text(row.room_id),
        peerMxid: text(row.peer_mxid),
        encrypted: number(row.encrypted) === 1,
        direct: number(row.direct) === 1,
        status: text(row.status) as RoomRecord["status"],
      }));
  }

  listRooms(): RoomRecord[] {
    return (this.#db.prepare("SELECT * FROM matrix_rooms ORDER BY room_id").all() as Row[])
      .map((row) => ({
        roomId: text(row.room_id),
        peerMxid: text(row.peer_mxid),
        encrypted: number(row.encrypted) === 1,
        direct: number(row.direct) === 1,
        status: text(row.status) as RoomRecord["status"],
      }));
  }

  listActiveRoomsForPeer(peerMxid: string): string[] {
    return (this.#db.prepare("SELECT room_id FROM matrix_rooms WHERE peer_mxid = ? AND status = 'active'").all(peerMxid) as Row[])
      .map((row) => text(row.room_id));
  }

  getConversation(roomId: string, threadRoot: string): ConversationLink | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_conversations WHERE room_id = ? AND thread_root = ?
    `).get(roomId, threadRoot) as Row | undefined;
    return row ? this.#conversation(row) : undefined;
  }

  findConversationById(conversationId: string): ConversationLink | undefined {
    const row = this.#db.prepare("SELECT * FROM matrix_conversations WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return row ? this.#conversation(row) : undefined;
  }

  saveConversation(link: ConversationLink): void {
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO matrix_conversations
        (room_id, thread_root, conversation_id, root_event_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, thread_root) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        root_event_id = COALESCE(excluded.root_event_id, matrix_conversations.root_event_id),
        updated_at = excluded.updated_at
    `).run(link.roomId, link.threadRoot, link.conversationId, link.rootEventId ?? null, now, now);
  }

  #conversation(row: Row): ConversationLink {
    const rootEventId = row.root_event_id ? text(row.root_event_id) : undefined;
    return {
      roomId: text(row.room_id),
      threadRoot: text(row.thread_root),
      conversationId: text(row.conversation_id),
      ...(rootEventId ? { rootEventId } : {}),
    };
  }

  enqueueInbound(input: Omit<InboundEvent, "state" | "receivedAt" | "updatedAt">): boolean {
    const now = Date.now();
    const result = this.#db.prepare(`
      INSERT INTO matrix_inbox
        (event_id, room_id, sender, event_type, content_json, origin_server_ts, thread_root,
         batch_key, source_key, state, received_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      input.eventId,
      input.roomId,
      input.sender,
      input.type,
      JSON.stringify(input.content),
      input.originServerTs,
      input.threadRoot,
      input.batchKey,
      input.sourceKey,
      now,
      now,
    );
    return number(result.changes) > 0;
  }

  getInbound(eventId: string): InboundEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM matrix_inbox WHERE event_id = ?").get(eventId) as Row | undefined;
    return row ? this.#inbound(row) : undefined;
  }

  getLatestFailed(roomId: string, threadRoot: string, sender: string): InboundEvent | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_inbox
      WHERE room_id = ? AND thread_root = ? AND sender = ? AND state = 'failed'
      ORDER BY origin_server_ts DESC LIMIT 1
    `).get(roomId, threadRoot, sender) as Row | undefined;
    return row ? this.#inbound(row) : undefined;
  }

  retryInbound(eventId: string): boolean {
    return number(this.#db.prepare(`
      UPDATE matrix_inbox SET state = 'queued', error = NULL, received_at = ?, updated_at = ?
      WHERE event_id = ? AND state = 'failed'
    `).run(Date.now(), Date.now(), eventId).changes) > 0;
  }

  replaceQueuedContent(eventId: string, content: Record<string, unknown>): boolean {
    const result = this.#db.prepare(`
      UPDATE matrix_inbox SET content_json = ?, updated_at = ? WHERE event_id = ? AND state = 'queued'
    `).run(JSON.stringify(content), Date.now(), eventId);
    return number(result.changes) > 0;
  }

  listReadyBatchKeys(cutoff: number): string[] {
    return (this.#db.prepare(`
      SELECT batch_key, MAX(received_at) AS newest
      FROM matrix_inbox
      WHERE state = 'queued'
      GROUP BY batch_key
      HAVING newest <= ?
      ORDER BY newest
    `).all(cutoff) as Row[]).map((row) => text(row.batch_key));
  }

  claimBatch(batchKey: string): InboundEvent[] {
    return this.transaction(() => {
      const rows = this.#db.prepare(`
        SELECT * FROM matrix_inbox WHERE state = 'queued' AND batch_key = ? ORDER BY origin_server_ts, event_id
      `).all(batchKey) as Row[];
      if (rows.length === 0) return [];
      const now = Date.now();
      const statement = this.#db.prepare(`
        UPDATE matrix_inbox SET state = 'processing', updated_at = ? WHERE event_id = ? AND state = 'queued'
      `);
      for (const row of rows) statement.run(now, text(row.event_id));
      return rows.map((row) => this.#inbound({ ...row, state: "processing", updated_at: now }));
    });
  }

  recoverProcessing(): number {
    return number(this.#db.prepare(`
      UPDATE matrix_inbox SET state = 'queued', updated_at = ?, error = NULL WHERE state = 'processing'
    `).run(Date.now()).changes);
  }

  finishInbound(eventIds: string[], state: "done" | "failed" | "ignored", error?: string): void {
    const statement = this.#db.prepare(`
      UPDATE matrix_inbox SET state = ?, error = ?, updated_at = ? WHERE event_id = ?
    `);
    const now = Date.now();
    this.transaction(() => {
      for (const eventId of eventIds) statement.run(state, error ?? null, now, eventId);
    });
  }

  failClaimedInbound(eventIds: string[], error: string): number {
    const statement = this.#db.prepare(`
      UPDATE matrix_inbox SET state = 'failed', error = ?, updated_at = ?
      WHERE event_id = ? AND state = 'processing'
    `);
    const now = Date.now();
    return this.transaction(() => {
      let changed = 0;
      for (const eventId of eventIds) changed += number(statement.run(error.slice(0, 2000), now, eventId).changes);
      return changed;
    });
  }

  #inbound(row: Row): InboundEvent {
    const error = row.error ? text(row.error) : undefined;
    return {
      eventId: text(row.event_id),
      roomId: text(row.room_id),
      sender: text(row.sender),
      type: text(row.event_type),
      content: parseObject(row.content_json),
      originServerTs: number(row.origin_server_ts),
      threadRoot: text(row.thread_root),
      batchKey: text(row.batch_key),
      sourceKey: text(row.source_key),
      state: text(row.state) as InboundEvent["state"],
      receivedAt: number(row.received_at),
      updatedAt: number(row.updated_at),
      ...(error ? { error } : {}),
    };
  }

  enqueueOutbound(job: Omit<OutboundJob, "state" | "attempts" | "createdAt" | "updatedAt">): OutboundJob {
    const now = Date.now();
    this.#db.prepare(`
      INSERT INTO matrix_outbox
        (job_id, transaction_id, room_id, event_type, content_json, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(transaction_id) DO NOTHING
    `).run(job.jobId, job.transactionId, job.roomId, job.eventType, JSON.stringify(job.content), now, now);
    const row = this.#db.prepare("SELECT * FROM matrix_outbox WHERE transaction_id = ?").get(job.transactionId) as Row;
    return this.#outbound(row);
  }

  getOutboundByTransaction(transactionId: string): OutboundJob | undefined {
    const row = this.#db.prepare("SELECT * FROM matrix_outbox WHERE transaction_id = ?").get(transactionId) as Row | undefined;
    return row ? this.#outbound(row) : undefined;
  }

  nextOutbound(): OutboundJob | undefined {
    return this.transaction(() => {
      const row = this.#db.prepare(`
        SELECT * FROM matrix_outbox WHERE state IN ('pending', 'failed') AND attempts < 8 ORDER BY created_at LIMIT 1
      `).get() as Row | undefined;
      if (!row) return undefined;
      const now = Date.now();
      this.#db.prepare(`
        UPDATE matrix_outbox SET state = 'sending', attempts = attempts + 1, updated_at = ? WHERE job_id = ?
      `).run(now, text(row.job_id));
      return this.#outbound({ ...row, state: "sending", attempts: number(row.attempts) + 1, updated_at: now });
    });
  }

  finishOutbound(jobId: string, eventId: string): void {
    this.#db.prepare(`
      UPDATE matrix_outbox SET state = 'sent', event_id = ?, error = NULL, updated_at = ? WHERE job_id = ?
    `).run(eventId, Date.now(), jobId);
  }

  failOutbound(jobId: string, error: string): void {
    this.#db.prepare(`
      UPDATE matrix_outbox SET state = 'failed', error = ?, updated_at = ? WHERE job_id = ?
    `).run(error.slice(0, 2000), Date.now(), jobId);
  }

  recoverOutbox(): number {
    return number(this.#db.prepare(`
      UPDATE matrix_outbox SET state = 'pending', updated_at = ? WHERE state = 'sending'
    `).run(Date.now()).changes);
  }

  #outbound(row: Row): OutboundJob {
    const eventId = row.event_id ? text(row.event_id) : undefined;
    const error = row.error ? text(row.error) : undefined;
    return {
      jobId: text(row.job_id),
      transactionId: text(row.transaction_id),
      roomId: text(row.room_id),
      eventType: text(row.event_type),
      content: parseObject(row.content_json),
      state: text(row.state) as OutboundJob["state"],
      attempts: number(row.attempts),
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at),
      ...(eventId ? { eventId } : {}),
      ...(error ? { error } : {}),
    };
  }

  saveDelivery(delivery: DeliveryRecord): void {
    this.#db.prepare(`
      INSERT INTO matrix_deliveries
        (matrix_event_id, room_id, conversation_id, core_message_id, source_event_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(matrix_event_id) DO UPDATE SET
        core_message_id = COALESCE(excluded.core_message_id, matrix_deliveries.core_message_id),
        source_event_id = COALESCE(excluded.source_event_id, matrix_deliveries.source_event_id)
    `).run(
      delivery.matrixEventId,
      delivery.roomId,
      delivery.conversationId,
      delivery.coreMessageId ?? null,
      delivery.sourceEventId ?? null,
      delivery.kind,
      delivery.createdAt,
    );
  }

  findDeliveryBySource(roomId: string, sourceEventId: string): DeliveryRecord | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_deliveries WHERE room_id = ? AND source_event_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(roomId, sourceEventId) as Row | undefined;
    return row ? this.#delivery(row) : undefined;
  }

  findLatestDelivery(roomId: string, before: number): DeliveryRecord | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_deliveries WHERE room_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1
    `).get(roomId, before) as Row | undefined;
    return row ? this.#delivery(row) : undefined;
  }

  #delivery(row: Row): DeliveryRecord {
    const coreMessageId = row.core_message_id ? text(row.core_message_id) : undefined;
    const sourceEventId = row.source_event_id ? text(row.source_event_id) : undefined;
    return {
      matrixEventId: text(row.matrix_event_id),
      roomId: text(row.room_id),
      conversationId: text(row.conversation_id),
      kind: text(row.kind) as DeliveryRecord["kind"],
      createdAt: number(row.created_at),
      ...(coreMessageId ? { coreMessageId } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
    };
  }

  saveEventMapping(mapping: EventMapping): void {
    this.#db.prepare(`
      INSERT INTO matrix_event_mappings
        (event_id, room_id, thread_root, conversation_id, core_message_id, direction, origin_server_ts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        core_message_id = excluded.core_message_id,
        thread_root = excluded.thread_root,
        direction = excluded.direction,
        origin_server_ts = excluded.origin_server_ts
    `).run(
      mapping.eventId,
      mapping.roomId,
      mapping.threadRoot,
      mapping.conversationId,
      mapping.coreMessageId,
      mapping.direction,
      mapping.originServerTs,
      Date.now(),
    );
  }

  findEventMapping(roomId: string, eventId: string): EventMapping | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_event_mappings WHERE room_id = ? AND event_id = ?
    `).get(roomId, eventId) as Row | undefined;
    return row ? this.#eventMapping(row) : undefined;
  }

  findLatestEventMapping(roomId: string, threadRoot: string, beforeOriginServerTs: number): EventMapping | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM matrix_event_mappings
      WHERE room_id = ? AND thread_root = ? AND origin_server_ts <= ?
      ORDER BY origin_server_ts DESC, created_at DESC LIMIT 1
    `).get(roomId, threadRoot, beforeOriginServerTs) as Row | undefined;
    return row ? this.#eventMapping(row) : undefined;
  }

  #eventMapping(row: Row): EventMapping {
    return {
      eventId: text(row.event_id),
      roomId: text(row.room_id),
      threadRoot: text(row.thread_root),
      conversationId: text(row.conversation_id),
      coreMessageId: text(row.core_message_id),
      direction: text(row.direction) === "outbound" ? "outbound" : "inbound",
      originServerTs: number(row.origin_server_ts),
    };
  }
}
