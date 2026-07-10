import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatrixStore } from "../src/storage/sqlite.js";

let directories: string[] = [];

function createStore(): { path: string; store: MatrixStore } {
  const directory = mkdtempSync(join(tmpdir(), "matrix-store-"));
  directories.push(directory);
  const path = join(directory, "adapter.sqlite");
  return { path, store: new MatrixStore(path) };
}

function inbound(eventId: string, sourceKey = `matrix:${eventId}`, timestamp = 1) {
  return {
    eventId,
    roomId: "!room:example.org",
    sender: "@alice:example.org",
    type: "m.room.message",
    content: { msgtype: "m.text", body: eventId },
    originServerTs: timestamp,
    threadRoot: "main",
    batchKey: JSON.stringify(["!room:example.org", "main", "@alice:example.org"]),
    sourceKey,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

describe("MatrixStore authorization and preferences", () => {
  it("bootstraps an owner and never permits owner revocation", () => {
    const { store } = createStore();
    try {
      store.bootstrapOwner("@owner:example.org");
      store.allowUser("@alice:example.org", "@owner:example.org");

      expect(store.listAllowedUsers()).toHaveLength(2);
      expect(store.listAllowedUsers()).toEqual(expect.arrayContaining(["@owner:example.org", "@alice:example.org"]));
      expect(store.denyUser("@owner:example.org", "@owner:example.org")).toBe(false);
      expect(store.isAllowed("@owner:example.org")).toBe(true);
      expect(store.denyUser("@alice:example.org", "@owner:example.org")).toBe(true);
      expect(store.isAllowed("@alice:example.org")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("returns safe defaults and persists user preferences across restart", () => {
    const { path, store } = createStore();
    expect(store.getPreferences("@alice:example.org")).toEqual({
      mxid: "@alice:example.org",
      locale: "en",
      timezoneOffsetMinutes: 0,
      streamEnabled: true,
    });
    store.savePreferences({
      mxid: "@alice:example.org",
      locale: "ru",
      timezoneOffsetMinutes: 180,
      streamEnabled: false,
    });
    store.close();

    const reopened = new MatrixStore(path);
    try {
      expect(reopened.getPreferences("@alice:example.org")).toEqual({
        mxid: "@alice:example.org",
        locale: "ru",
        timezoneOffsetMinutes: 180,
        streamEnabled: false,
      });
    } finally {
      reopened.close();
    }
  });
});

describe("MatrixStore room and conversation mappings", () => {
  it("upserts room security state and lists active peer rooms only", () => {
    const { store } = createStore();
    try {
      store.upsertRoom({
        roomId: "!room:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: true,
        status: "active",
      });
      store.upsertRoom({
        roomId: "!left:example.org",
        peerMxid: "@alice:example.org",
        encrypted: false,
        direct: false,
        status: "left",
      });

      expect(store.getRoom("!room:example.org")).toEqual({
        roomId: "!room:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: true,
        status: "active",
      });
      expect(store.listActiveRoomsForPeer("@alice:example.org")).toEqual(["!room:example.org"]);
      expect(store.listActiveRooms()).toEqual([{
        roomId: "!room:example.org",
        peerMxid: "@alice:example.org",
        encrypted: true,
        direct: true,
        status: "active",
      }]);
    } finally {
      store.close();
    }
  });

  it("keeps main and native-thread conversations distinct", () => {
    const { store } = createStore();
    try {
      store.saveConversation({
        roomId: "!room:example.org",
        threadRoot: "main",
        conversationId: "conversation-main",
      });
      store.saveConversation({
        roomId: "!room:example.org",
        threadRoot: "$thread-root",
        conversationId: "conversation-thread",
        rootEventId: "$thread-root",
      });

      expect(store.getConversation("!room:example.org", "main")?.conversationId).toBe("conversation-main");
      expect(store.getConversation("!room:example.org", "$thread-root")).toEqual({
        roomId: "!room:example.org",
        threadRoot: "$thread-root",
        conversationId: "conversation-thread",
        rootEventId: "$thread-root",
      });
      expect(store.findConversationById("conversation-thread")?.threadRoot).toBe("$thread-root");
    } finally {
      store.close();
    }
  });
});

describe("MatrixStore durable inbox", () => {
  it("deduplicates both Matrix event IDs and core source keys", () => {
    const { store } = createStore();
    try {
      expect(store.enqueueInbound(inbound("$event"))).toBe(true);
      expect(store.enqueueInbound(inbound("$event"))).toBe(false);
      expect(store.enqueueInbound(inbound("$replayed-alias", "matrix:$event"))).toBe(false);
      expect(store.getInbound("$event")?.sourceKey).toBe("matrix:$event");
    } finally {
      store.close();
    }
  });

  it("batches in timestamp order and permits edits only while queued", () => {
    const { store } = createStore();
    try {
      expect(store.enqueueInbound(inbound("$later", undefined, 20))).toBe(true);
      expect(store.enqueueInbound(inbound("$earlier", undefined, 10))).toBe(true);
      expect(store.replaceQueuedContent("$later", { msgtype: "m.text", body: "edited" })).toBe(true);

      const claimed = store.claimBatch(inbound("$later").batchKey);
      expect(claimed.map((event) => event.eventId)).toEqual(["$earlier", "$later"]);
      expect(claimed[1]?.content).toEqual({ msgtype: "m.text", body: "edited" });
      expect(store.replaceQueuedContent("$later", { body: "too late" })).toBe(false);
      expect(store.claimBatch(inbound("$later").batchKey)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("waits for the batching window after the newest adjacent event", () => {
    vi.useFakeTimers();
    const { store } = createStore();
    try {
      vi.setSystemTime(1_000);
      store.enqueueInbound(inbound("$first", undefined, 1));
      vi.setSystemTime(2_000);
      store.enqueueInbound(inbound("$second", undefined, 2));

      expect(store.listReadyBatchKeys(1_500)).toEqual([]);
      expect(store.listReadyBatchKeys(2_000)).toEqual([inbound("$first").batchKey]);
    } finally {
      store.close();
    }
  });

  it("recovers processing work after a crash and records terminal state", () => {
    const { store } = createStore();
    try {
      store.enqueueInbound(inbound("$event"));
      store.claimBatch(inbound("$event").batchKey);
      expect(store.recoverProcessing()).toBe(1);
      expect(store.getInbound("$event")?.state).toBe("queued");

      const retry = store.claimBatch(inbound("$event").batchKey);
      expect(retry).toHaveLength(1);
      store.finishInbound(["$event"], "done");
      expect(store.getInbound("$event")?.state).toBe("done");
    } finally {
      store.close();
    }
  });

  it("marks only still-claimed rows failed when a runner throws", () => {
    const { store } = createStore();
    try {
      store.enqueueInbound(inbound("$claimed", undefined, 1));
      store.enqueueInbound(inbound("$already-done", undefined, 2));
      store.claimBatch(inbound("$claimed").batchKey);
      store.finishInbound(["$already-done"], "done");

      expect(store.failClaimedInbound(["$claimed", "$already-done"], "runner exploded")).toBe(1);
      expect(store.getInbound("$claimed")).toMatchObject({ state: "failed", error: "runner exploded" });
      expect(store.getInbound("$already-done")?.state).toBe("done");
    } finally {
      store.close();
    }
  });
});

describe("MatrixStore durable outbox and deliveries", () => {
  it("uses a stable transaction ID to collapse ambiguous send retries", () => {
    const { store } = createStore();
    try {
      const first = store.enqueueOutbound({
        jobId: "job-1",
        transactionId: "stable-transaction",
        roomId: "!room:example.org",
        eventType: "m.room.message",
        content: { msgtype: "m.notice", body: "Working…" },
      });
      const duplicate = store.enqueueOutbound({
        jobId: "job-2",
        transactionId: "stable-transaction",
        roomId: "!room:example.org",
        eventType: "m.room.message",
        content: { msgtype: "m.notice", body: "duplicate" },
      });

      expect(first.jobId).toBe("job-1");
      expect(duplicate.jobId).toBe("job-1");
      expect(duplicate.content).toEqual({ msgtype: "m.notice", body: "Working…" });
    } finally {
      store.close();
    }
  });

  it("recovers a sending job and preserves the resulting delivery mapping", () => {
    const { store } = createStore();
    try {
      store.enqueueOutbound({
        jobId: "job-1",
        transactionId: "stable-transaction",
        roomId: "!room:example.org",
        eventType: "m.room.message",
        content: { msgtype: "m.text", body: "answer" },
      });
      expect(store.nextOutbound()).toMatchObject({ jobId: "job-1", state: "sending", attempts: 1 });
      expect(store.recoverOutbox()).toBe(1);
      expect(store.nextOutbound()).toMatchObject({ jobId: "job-1", state: "sending", attempts: 2 });
      store.finishOutbound("job-1", "$answer");
      expect(store.nextOutbound()).toBeUndefined();

      store.saveDelivery({
        matrixEventId: "$answer",
        roomId: "!room:example.org",
        conversationId: "conversation-main",
        coreMessageId: "core-answer",
        sourceEventId: "$question",
        kind: "answer",
        createdAt: 100,
      });
      expect(store.findDeliveryBySource("!room:example.org", "$question")).toMatchObject({
        matrixEventId: "$answer",
        coreMessageId: "core-answer",
      });
      expect(store.findLatestDelivery("!room:example.org", 100)?.matrixEventId).toBe("$answer");
    } finally {
      store.close();
    }
  });

  it("maps Matrix roots to exact core messages within the right timeline", () => {
    const { store } = createStore();
    try {
      store.saveEventMapping({
        eventId: "$main-user",
        roomId: "!room:example.org",
        threadRoot: "main",
        conversationId: "conversation-main",
        coreMessageId: "core-user",
        direction: "inbound",
        originServerTs: 100,
      });
      store.saveEventMapping({
        eventId: "$thread-answer",
        roomId: "!room:example.org",
        threadRoot: "$thread-root",
        conversationId: "conversation-thread",
        coreMessageId: "core-thread-answer",
        direction: "outbound",
        originServerTs: 150,
      });

      expect(store.findEventMapping("!room:example.org", "$main-user")?.coreMessageId).toBe("core-user");
      expect(store.findLatestEventMapping("!room:example.org", "main", 200)?.coreMessageId).toBe("core-user");
      expect(store.findLatestEventMapping("!room:example.org", "$thread-root", 200)?.coreMessageId).toBe("core-thread-answer");
    } finally {
      store.close();
    }
  });
});
