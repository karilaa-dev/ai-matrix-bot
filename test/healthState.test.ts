import { describe, expect, it } from "vitest";
import { checkRuntimeHealth } from "../src/health-state.js";

function values(input: Record<string, string | undefined>) {
  return (key: string) => input[key];
}

describe("runtime health state", () => {
  it("accepts a ready runtime with a fresh sync heartbeat", () => {
    expect(checkRuntimeHealth(values({
      "runtime.ready": "1",
      "runtime.heartbeat_at": "990000",
    }), 1_000_000)).toEqual({ ok: true, heartbeat: 990_000 });
  });

  it.each([
    [{ "runtime.ready": "0", "runtime.heartbeat_at": "990000" }, "not ready"],
    [{ "runtime.ready": "1" }, "missing heartbeat"],
    [{ "runtime.ready": "1", "runtime.heartbeat_at": "800000" }, "stale heartbeat"],
    [{ "runtime.ready": "1", "runtime.heartbeat_at": "invalid" }, "malformed heartbeat"],
  ])("rejects %s (%s)", (state) => {
    expect(() => checkRuntimeHealth(values(state), 1_000_000)).toThrow(
      "Matrix sync runtime is not ready",
    );
  });
});
