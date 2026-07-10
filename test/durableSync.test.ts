import { describe, expect, it, vi } from "vitest";
import { createDurableSyncEmitter, processDurableSyncCycle } from "../src/matrix/client.js";

describe("durable Matrix sync dispatch", () => {
  it.each(["room.invite", "room.event"])("awaits %s authorization work before emitting", async (eventType) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const durableHandler = vi.fn(async () => gate);
    const emitted = vi.fn();
    const emit = createDurableSyncEmitter(durableHandler, emitted);

    const pending = emit(eventType, "!room", { type: "m.room.member" });
    await Promise.resolve();
    expect(durableHandler).toHaveBeenCalledWith(eventType, "!room", { type: "m.room.member" });
    expect(emitted).not.toHaveBeenCalled();

    release();
    await pending;
    expect(emitted).toHaveBeenCalledWith(eventType, "!room", { type: "m.room.member" });
  });
});

describe("durable sync token advancement", () => {
  it("persists next_batch only after durable event processing completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persistToken = vi.fn();
    const cycle = processDurableSyncCycle({
      token: "old-token",
      doSync: vi.fn(async () => ({ next_batch: "new-token" })),
      processSync: vi.fn(async () => gate),
      persistToken,
    });

    await Promise.resolve();
    expect(persistToken).not.toHaveBeenCalled();
    release();
    await expect(cycle).resolves.toBe("new-token");
    expect(persistToken).toHaveBeenCalledWith("new-token");
  });

  it("does not advance the token when membership processing fails", async () => {
    const persistToken = vi.fn();
    await expect(processDurableSyncCycle({
      token: "old-token",
      doSync: async () => ({ next_batch: "new-token" }),
      processSync: async () => { throw new Error("membership rejected"); },
      persistToken,
    })).rejects.toThrow("membership rejected");
    expect(persistToken).not.toHaveBeenCalled();
  });
});
