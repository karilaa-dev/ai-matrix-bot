export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.#tails.size;
  }

  async drain(): Promise<void> {
    while (this.#tails.size) await Promise.all([...this.#tails.values()]);
  }
}
