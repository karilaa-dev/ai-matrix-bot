export interface MatrixEvent {
  event_id: string;
  room_id?: string;
  sender: string;
  type: string;
  origin_server_ts?: number;
  state_key?: string;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface MatrixRelation {
  rel_type?: string;
  event_id?: string;
  "m.in_reply_to"?: { event_id?: string };
}

export interface MatrixFileInfo {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
}

export interface MatrixEncryptedFile {
  url: string;
  key: Record<string, unknown>;
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

export interface NormalizedMessage {
  eventId: string;
  roomId: string;
  sender: string;
  timestamp: number;
  threadRoot: string;
  replyToEventId?: string;
  editTargetEventId?: string;
  msgtype: string;
  body: string;
  formattedBody?: string;
  media?: {
    name: string;
    mxcUrl?: string;
    encryptedFile?: MatrixEncryptedFile;
    info?: MatrixFileInfo;
  };
  rawContent: Record<string, unknown>;
}
