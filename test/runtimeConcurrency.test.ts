import { describe, expect, it, vi } from "vitest";
import { ActiveTurnRegistry } from "../src/runtime/activeTurns.js";
import { KeyedSerialQueue } from "../src/runtime/keyedQueue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("per-conversation scheduling", () => {
  it("serializes the same conversation while allowing another conversation to proceed", async () => {
    const queue = new KeyedSerialQueue();
    const firstGate = deferred();
    const order: string[] = [];

    const first = queue.run("!room\0main", async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
    });
    const second = queue.run("!room\0main", async () => { order.push("second"); });
    const other = queue.run("!other\0main", async () => { order.push("other"); });

    await other;
    expect(order).toEqual(["first:start", "other"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
    expect(queue.size).toBe(0);
  });

  it("lets !stop abort an active turn without waiting for its conversation queue", () => {
    const active = new ActiveTurnRegistry();
    const abort = vi.fn();
    active.set("!room", "main", { abort });

    expect(active.stop("!room", "main")).toBe(true);
    expect(abort).toHaveBeenCalledWith("stopped by user");
    expect(active.stop("!other", "main")).toBe(false);
  });

  it("cancels all turns and drains queued work during shutdown", async () => {
    const active = new ActiveTurnRegistry();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    active.set("!one", "main", { abort: firstAbort });
    active.set("!two", "$thread", { abort: secondAbort });
    expect(active.cancelAll()).toBe(2);
    expect(firstAbort).toHaveBeenCalledWith("runtime is shutting down");
    expect(secondAbort).toHaveBeenCalledWith("runtime is shutting down");

    const queue = new KeyedSerialQueue();
    const gate = deferred();
    const work = queue.run("!room\0main", async () => gate.promise);
    let drained = false;
    const drain = queue.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([work, drain]);
    expect(drained).toBe(true);
  });
});
