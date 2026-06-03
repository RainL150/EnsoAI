// Simple promise-chained queue to serialize all write ops on the skill lock.
// Node's main process is single-threaded but async operations interleave;
// without this queue concurrent install/uninstall/sync would race on the lock.

export class WriteQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Run regardless of previous failure (both arms of .then)
    const next = this.chain.then(fn, fn);
    // Don't poison the chain on failure
    this.chain = next.catch(() => {});
    return next;
  }
}
