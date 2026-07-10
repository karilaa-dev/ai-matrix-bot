import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { StoredAttachment } from "@karilaa-dev/codex-core";
import type { CoreService } from "../core/service.js";
import type { DedicatedMatrixClient } from "../matrix/client.js";
import type { NormalizedMessage } from "../matrix/types.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_ATTACHMENTS = 10;

function cleanName(value: string): string {
  const name = basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return (name || "attachment").slice(0, 240);
}

export class MediaService {
  readonly #client: DedicatedMatrixClient;
  readonly #core: CoreService;

  constructor(client: DedicatedMatrixClient, core: CoreService) {
    this.#client = client;
    this.#core = core;
  }

  async ingest(actorKey: string, conversationId: string, message: NormalizedMessage): Promise<StoredAttachment> {
    const media = message.media;
    if (!media) throw new Error("Matrix message does not contain media");
    if (media.info?.size !== undefined && media.info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment exceeds the 20 MiB limit");
    }
    const url = media.encryptedFile?.url ?? media.mxcUrl;
    if (!url) throw new Error("Matrix attachment has no downloadable URL");
    const bytes = await this.#client.download(url, media.encryptedFile);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds the 20 MiB limit");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return this.#core.ingestAttachment({
      actorKey,
      conversationId,
      name: cleanName(media.name),
      bytes,
      ...(media.info?.mimetype ? { mimeType: media.info.mimetype } : {}),
      source: {
        adapter: "matrix",
        id: message.eventId,
        uniqueId: url,
        metadata: { roomId: message.roomId, sha256, encrypted: Boolean(media.encryptedFile) },
      },
    });
  }

  async upload(attachment: StoredAttachment, roomId: string): Promise<Record<string, unknown>> {
    const bytes = await this.#core.attachmentBytes(attachment);
    const mimeType = attachment.mimeType ?? "application/octet-stream";
    const encrypted = await this.#client.isEncrypted(roomId);
    const upload = await this.#client.upload(bytes, mimeType, cleanName(attachment.name), encrypted);
    const msgtype = attachment.type === "image" || mimeType.startsWith("image/") ? "m.image" : "m.file";
    const base = {
      msgtype,
      body: cleanName(attachment.name),
      info: { mimetype: mimeType, size: bytes.byteLength },
    };
    return upload.encryptedFile
      ? { ...base, file: upload.encryptedFile }
      : { ...base, url: upload.url };
  }
}
