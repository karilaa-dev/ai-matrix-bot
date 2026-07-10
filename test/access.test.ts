import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import type { DedicatedMatrixClient } from "../src/matrix/client.js";
import { AccessController } from "../src/runtime/access.js";
import { MatrixStore } from "../src/storage/sqlite.js";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let directories: string[] = [];

function matrixConfig(): AppConfig["matrix"] {
  return {
    homeserverUrl: "https://matrix.example.org",
    ownerId: "@owner:example.org",
    accessToken: "test-token",
    deviceId: "AI_MATRIX_BOT",
    storagePath: "/tmp/sync.json",
    cryptoPath: "/tmp/crypto",
    databasePath: "/tmp/matrix.sqlite",
    globalConcurrency: 4,
    batchWindowMs: 750,
    maxEventBytes: 60_000,
  };
}

function setup(options: { joined?: string[]; invited?: string[]; encrypted?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "matrix-access-"));
  directories.push(directory);
  const store = new MatrixStore(join(directory, "adapter.sqlite"));
  const client = {
    userId: "@bot:example.org",
    joinRoom: vi.fn(async (roomId: string) => roomId),
    leaveRoom: vi.fn(async () => undefined),
    joinedMembers: vi.fn(async () => options.joined ?? ["@bot:example.org", "@alice:example.org"]),
    invitedMembers: vi.fn(async () => options.invited ?? []),
    isEncrypted: vi.fn(async () => options.encrypted ?? true),
  };
  const revoked = vi.fn();
  const access = new AccessController(
    matrixConfig(),
    client as unknown as DedicatedMatrixClient,
    store,
    logger,
    revoked,
  );
  return { access, client, revoked, store };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("AccessController", () => {
  it("durably bootstraps the configured owner", () => {
    const { access, store } = setup();
    try {
      expect(access.isOwner("@owner:example.org")).toBe(true);
      expect(access.isAllowed("@owner:example.org")).toBe(true);
      expect(access.list("@owner:example.org")).toEqual(["@owner:example.org"]);
      expect(access.list("@alice:example.org")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("declines an unknown invitation without joining it", async () => {
    const { access, client, store } = setup();
    try {
      await access.handleInvite("!unknown:example.org", {
        event_id: "$invite",
        sender: "@mallory:example.org",
        type: "m.room.member",
        content: { membership: "invite" },
      });

      expect(client.joinRoom).not.toHaveBeenCalled();
      expect(client.leaveRoom).toHaveBeenCalledWith(
        "!unknown:example.org",
        "This bot accepts invitations only from allowlisted users",
      );
      expect(store.getRoom("!unknown:example.org")).toMatchObject({
        peerMxid: "@mallory:example.org",
        status: "rejected",
      });
    } finally {
      store.close();
    }
  });

  it("joins an allowlisted encrypted one-to-one invitation", async () => {
    const { access, client, store } = setup({ encrypted: true });
    try {
      expect(access.allow("@owner:example.org", "@alice:example.org")).toBe(true);
      await access.handleInvite("!dm:example.org", {
        event_id: "$invite",
        sender: "@alice:example.org",
        type: "m.room.member",
        content: { membership: "invite" },
      });

      expect(client.joinRoom).toHaveBeenCalledWith("!dm:example.org");
      expect(client.leaveRoom).not.toHaveBeenCalled();
      expect(store.getRoom("!dm:example.org")).toEqual({
        roomId: "!dm:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: false,
        status: "active",
      });
    } finally {
      store.close();
    }
  });

  it("records m.direct metadata without using it as authorization", () => {
    const { access, store } = setup();
    try {
      store.upsertRoom({
        roomId: "!dm:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: false,
        status: "active",
      });
      access.handleAccountData({
        event_id: "$account-data",
        sender: "@bot:example.org",
        type: "m.direct",
        content: { "@alice:example.org": ["!dm:example.org"] },
      });
      expect(store.getRoom("!dm:example.org")?.direct).toBe(true);
      expect(access.isAllowed("@alice:example.org")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("leaves and cancels work when the room has a third participant", async () => {
    const { access, client, revoked, store } = setup({
      joined: ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
    });
    try {
      access.allow("@owner:example.org", "@alice:example.org");
      await access.handleInvite("!group:example.org", {
        event_id: "$invite",
        sender: "@alice:example.org",
        type: "m.room.member",
        content: { membership: "invite" },
      });

      expect(revoked).toHaveBeenCalledWith("!group:example.org");
      expect(client.leaveRoom).toHaveBeenCalledWith(
        "!group:example.org",
        "This bot only supports allowlisted one-to-one rooms",
      );
      expect(store.getRoom("!group:example.org")?.status).toBe("left");
    } finally {
      store.close();
    }
  });

  it("revokes existing rooms when the owner denies a user", async () => {
    const { access, client, revoked, store } = setup();
    try {
      access.allow("@owner:example.org", "@alice:example.org");
      store.upsertRoom({
        roomId: "!dm:example.org",
        peerMxid: "@alice:example.org",
        encrypted: false,
        direct: true,
        status: "active",
      });

      expect(await access.deny("@alice:example.org", "@owner:example.org")).toBe(false);
      expect(await access.deny("@owner:example.org", "@owner:example.org")).toBe(false);
      expect(await access.deny("@owner:example.org", "@alice:example.org")).toBe(true);
      expect(revoked).toHaveBeenCalledWith("!dm:example.org");
      expect(client.leaveRoom).toHaveBeenCalledWith("!dm:example.org", "Access was revoked by the bot owner");
      expect(store.getRoom("!dm:example.org")?.status).toBe("left");
    } finally {
      store.close();
    }
  });

  it("revalidates persisted active rooms before the sync loop starts", async () => {
    const { access, client, revoked, store } = setup({
      joined: ["@bot:example.org", "@alice:example.org", "@mallory:example.org"],
    });
    try {
      access.allow("@owner:example.org", "@alice:example.org");
      store.upsertRoom({
        roomId: "!restored:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: true,
        status: "active",
      });

      await access.revalidateActiveRooms();

      expect(revoked).toHaveBeenCalledWith("!restored:example.org");
      expect(client.leaveRoom).toHaveBeenCalledWith(
        "!restored:example.org",
        "This bot only supports allowlisted one-to-one rooms",
      );
      expect(store.getRoom("!restored:example.org")?.status).toBe("left");
    } finally {
      store.close();
    }
  });
});
