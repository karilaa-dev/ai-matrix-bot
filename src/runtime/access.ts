import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import type { DedicatedMatrixClient } from "../matrix/client.js";
import type { MatrixEvent } from "../matrix/types.js";
import type { MatrixStore } from "../storage/sqlite.js";

export class AccessController {
  readonly #ownerId: string;
  readonly #client: DedicatedMatrixClient;
  readonly #store: MatrixStore;
  readonly #logger: Logger;
  readonly #onRoomRevoked: (roomId: string) => void;

  constructor(
    config: AppConfig["matrix"],
    client: DedicatedMatrixClient,
    store: MatrixStore,
    logger: Logger,
    onRoomRevoked: (roomId: string) => void,
  ) {
    this.#ownerId = config.ownerId;
    this.#client = client;
    this.#store = store;
    this.#logger = logger;
    this.#onRoomRevoked = onRoomRevoked;
    this.#store.bootstrapOwner(config.ownerId);
  }

  isAllowed(mxid: string): boolean {
    return this.#store.isAllowed(mxid);
  }

  isOwner(mxid: string): boolean {
    return mxid === this.#ownerId;
  }

  async handleInvite(roomId: string, event?: MatrixEvent): Promise<void> {
    const inviter = event?.sender;
    if (!inviter || !this.isAllowed(inviter)) {
      this.#logger.warn("Declining Matrix invitation from unknown user", { roomId, inviter });
      await this.#client.leaveRoom(roomId, "This bot accepts invitations only from allowlisted users");
      if (inviter) this.#store.upsertRoom({ roomId, peerMxid: inviter, encrypted: false, direct: false, status: "rejected" });
      return;
    }

    this.#store.upsertRoom({ roomId, peerMxid: inviter, encrypted: false, direct: false, status: "invited" });
    await this.#client.joinRoom(roomId);
    await this.validateDirectRoom(roomId, inviter);
  }

  async validateDirectRoom(roomId: string, expectedPeer?: string): Promise<boolean> {
    const joined = await this.#client.joinedMembers(roomId);
    const invited = await this.#client.invitedMembers(roomId).catch(() => []);
    const others = [...new Set([...joined, ...invited])].filter((mxid) => mxid !== this.#client.userId);
    const peer = expectedPeer ?? this.#store.getRoom(roomId)?.peerMxid ?? others[0];
    const valid = Boolean(peer) && others.length === 1 && others[0] === peer && this.isAllowed(peer!);
    if (!valid) {
      this.#logger.warn("Leaving room that is not an allowlisted one-to-one DM", { roomId, joined, invited });
      this.#onRoomRevoked(roomId);
      await this.#client.leaveRoom(roomId, "This bot only supports allowlisted one-to-one rooms");
      this.#store.upsertRoom({
        roomId,
        peerMxid: peer ?? "unknown",
        encrypted: false,
        direct: false,
        status: "left",
      });
      return false;
    }
    const encrypted = await this.#client.isEncrypted(roomId);
    this.#store.upsertRoom({
      roomId,
      peerMxid: peer!,
      encrypted,
      direct: this.#store.getRoom(roomId)?.direct ?? false,
      status: "active",
    });
    return true;
  }

  handleAccountData(event: MatrixEvent): void {
    if (event.type !== "m.direct") return;
    const directRoomIds = new Set<string>();
    for (const value of Object.values(event.content)) {
      if (!Array.isArray(value)) continue;
      for (const roomId of value) if (typeof roomId === "string") directRoomIds.add(roomId);
    }
    for (const room of this.#store.listRooms()) {
      this.#store.upsertRoom({ ...room, direct: directRoomIds.has(room.roomId) });
    }
  }

  async revalidateActiveRooms(): Promise<void> {
    for (const room of this.#store.listActiveRooms()) {
      await this.validateDirectRoom(room.roomId, room.peerMxid);
    }
  }

  async handleMembership(roomId: string, event: MatrixEvent): Promise<void> {
    if (event.type !== "m.room.member") return;
    const membership = event.content.membership;
    if (membership !== "join" && membership !== "invite" && membership !== "leave" && membership !== "ban") return;
    const room = this.#store.getRoom(roomId);
    if (!room || room.status !== "active") return;
    if (event.state_key === room.peerMxid && (membership === "leave" || membership === "ban")) {
      this.#onRoomRevoked(roomId);
      await this.#client.leaveRoom(roomId, "The direct-message peer left").catch(() => undefined);
      this.#store.upsertRoom({ ...room, status: "left" });
      return;
    }
    if (event.state_key !== this.#client.userId && event.state_key !== room.peerMxid && (membership === "join" || membership === "invite")) {
      await this.validateDirectRoom(roomId, room.peerMxid);
    }
  }

  allow(actor: string, mxid: string): boolean {
    if (!this.isOwner(actor) || !/^@[^:]+:.+$/.test(mxid)) return false;
    this.#store.allowUser(mxid, actor);
    return true;
  }

  async deny(actor: string, mxid: string): Promise<boolean> {
    if (!this.isOwner(actor) || !this.#store.denyUser(mxid, this.#ownerId)) return false;
    for (const roomId of this.#store.listActiveRoomsForPeer(mxid)) {
      this.#onRoomRevoked(roomId);
      await this.#client.leaveRoom(roomId, "Access was revoked by the bot owner").catch(() => undefined);
      const room = this.#store.getRoom(roomId);
      if (room) this.#store.upsertRoom({ ...room, status: "left" });
    }
    return true;
  }

  list(actor: string): string[] | undefined {
    return this.isOwner(actor) ? this.#store.listAllowedUsers() : undefined;
  }
}
