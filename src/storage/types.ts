export type InboxState = "queued" | "processing" | "done" | "failed" | "ignored";
export type OutboxState = "pending" | "sending" | "sent" | "failed";

export interface UserPreferences {
  mxid: string;
  locale: "en" | "ru";
  timezoneOffsetMinutes: number;
  streamEnabled: boolean;
}

export interface RoomRecord {
  roomId: string;
  peerMxid: string;
  encrypted: boolean;
  direct: boolean;
  status: "invited" | "active" | "rejected" | "left";
}

export interface ConversationLink {
  roomId: string;
  threadRoot: string;
  conversationId: string;
  rootEventId?: string;
}

export interface InboundEvent {
  eventId: string;
  roomId: string;
  sender: string;
  type: string;
  content: Record<string, unknown>;
  originServerTs: number;
  threadRoot: string;
  batchKey: string;
  sourceKey: string;
  state: InboxState;
  receivedAt: number;
  updatedAt: number;
  error?: string;
}

export interface OutboundJob {
  jobId: string;
  transactionId: string;
  roomId: string;
  eventType: string;
  content: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  eventId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryRecord {
  matrixEventId: string;
  roomId: string;
  conversationId: string;
  coreMessageId?: string;
  sourceEventId?: string;
  kind: "placeholder" | "answer" | "attachment" | "thread-root";
  createdAt: number;
}

export interface EventMapping {
  eventId: string;
  roomId: string;
  threadRoot: string;
  conversationId: string;
  coreMessageId: string;
  direction: "inbound" | "outbound";
  originServerTs: number;
}
