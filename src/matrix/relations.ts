import { createHash } from "node:crypto";
import type { MatrixEncryptedFile, MatrixEvent, MatrixFileInfo, MatrixRelation, NormalizedMessage } from "./types.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function relation(content: Record<string, unknown>): MatrixRelation {
  return (object(content["m.relates_to"]) ?? {}) as MatrixRelation;
}

export function stripReplyFallback(body: string): string {
  if (!body.startsWith("> ")) return body;
  const separator = body.indexOf("\n\n");
  if (separator === -1) return body;
  const quoted = body.slice(0, separator).split("\n");
  return quoted.every((line) => line.startsWith(">")) ? body.slice(separator + 2) : body;
}

export function normalizeMessage(roomId: string, event: MatrixEvent): NormalizedMessage | undefined {
  if (event.type !== "m.room.message") return undefined;
  const originalContent = event.content;
  const rel = relation(originalContent);
  const newContent = object(originalContent["m.new_content"]);
  const content = rel.rel_type === "m.replace" && newContent ? newContent : originalContent;
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
  if (!["m.text", "m.image", "m.file"].includes(msgtype)) return undefined;
  const body = typeof content.body === "string" ? stripReplyFallback(content.body) : "";
  const formattedBody = typeof content.formatted_body === "string" ? content.formatted_body : undefined;
  const contentRelation = relation(content);
  const threadRoot = contentRelation.rel_type === "m.thread" && contentRelation.event_id
    ? contentRelation.event_id
    : rel.rel_type === "m.thread" && rel.event_id
      ? rel.event_id
      : "main";
  const replyToEventId = contentRelation["m.in_reply_to"]?.event_id ?? rel["m.in_reply_to"]?.event_id;
  const editTargetEventId = rel.rel_type === "m.replace" ? rel.event_id : undefined;
  const url = typeof content.url === "string" ? content.url : undefined;
  const encryptedFile = object(content.file) as MatrixEncryptedFile | undefined;
  const info = object(content.info) as MatrixFileInfo | undefined;
  const media = msgtype === "m.image" || msgtype === "m.file" ? {
    name: body || (msgtype === "m.image" ? "image" : "file"),
    ...(url ? { mxcUrl: url } : {}),
    ...(encryptedFile ? { encryptedFile } : {}),
    ...(info ? { info } : {}),
  } : undefined;

  return {
    eventId: event.event_id,
    roomId,
    sender: event.sender,
    timestamp: event.origin_server_ts ?? Date.now(),
    threadRoot,
    msgtype,
    body,
    rawContent: originalContent,
    ...(formattedBody ? { formattedBody } : {}),
    ...(replyToEventId ? { replyToEventId } : {}),
    ...(editTargetEventId ? { editTargetEventId } : {}),
    ...(media ? { media } : {}),
  };
}

export function threadRelation(threadRoot: string, replyToEventId?: string): Record<string, unknown> | undefined {
  if (threadRoot === "main") {
    return replyToEventId ? { "m.in_reply_to": { event_id: replyToEventId } } : undefined;
  }
  return {
    rel_type: "m.thread",
    event_id: threadRoot,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToEventId ?? threadRoot },
  };
}

export function replacementRelation(eventId: string): Record<string, unknown> {
  return { rel_type: "m.replace", event_id: eventId };
}

export function deterministicTransactionId(...parts: string[]): string {
  return `codex_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
}
