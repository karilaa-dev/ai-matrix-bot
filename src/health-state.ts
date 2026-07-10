export interface RuntimeHealth {
  ok: true;
  heartbeat: number;
}

export function checkRuntimeHealth(
  readValue: (key: string) => string | undefined,
  now = Date.now(),
): RuntimeHealth {
  const ready = readValue("runtime.ready") === "1";
  const heartbeat = Number(readValue("runtime.heartbeat_at") ?? 0);
  const fresh = Number.isFinite(heartbeat) && now - heartbeat < 120_000;
  if (!ready || !fresh) throw new Error("Matrix sync runtime is not ready");
  return { ok: true, heartbeat };
}
