export interface AbortableTurn {
  abort(reason?: unknown): void;
}

export class ActiveTurnRegistry {
  readonly #active = new Map<string, AbortableTurn>();

  set(roomId: string, threadRoot: string, turn: AbortableTurn): void {
    this.#active.set(this.#key(roomId, threadRoot), turn);
  }

  clear(roomId: string, threadRoot: string, expected?: AbortableTurn): void {
    const key = this.#key(roomId, threadRoot);
    if (!expected || this.#active.get(key) === expected) this.#active.delete(key);
  }

  stop(roomId: string, threadRoot: string, reason: unknown = "stopped by user"): boolean {
    const turn = this.#active.get(this.#key(roomId, threadRoot));
    if (!turn) return false;
    turn.abort(reason);
    return true;
  }

  cancelRoom(roomId: string, reason: unknown = "room access revoked"): number {
    let cancelled = 0;
    for (const [key, turn] of this.#active) {
      if (!key.startsWith(`${roomId}\0`)) continue;
      turn.abort(reason);
      this.#active.delete(key);
      cancelled += 1;
    }
    return cancelled;
  }

  cancelAll(reason: unknown = "runtime is shutting down"): number {
    const turns = [...this.#active.values()];
    this.#active.clear();
    for (const turn of turns) turn.abort(reason);
    return turns.length;
  }

  #key(roomId: string, threadRoot: string): string {
    return `${roomId}\0${threadRoot}`;
  }
}
