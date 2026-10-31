/**
 * Per-scope serial queue.
 *
 * One topic's inbound messages are processed in order (the agent inbox is the
 * real ordering authority, but the surface must not race two resolutions for
 * the same scope); different topics run in parallel so a slow agent creation in
 * one group never blocks another group.
 *
 * @module @artomyuan/dsh-caduceus/bridge/scope-queue
 */
export class ScopeQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` after every earlier task for the same key; keys are independent. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True while at least one task is queued/running for the key. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys with queued/running work. */
  get size(): number {
    return this.tails.size;
  }
}
