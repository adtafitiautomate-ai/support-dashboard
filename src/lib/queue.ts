// Serializes work per key (e.g. per customer) within this server instance so
// bursts of messages from one customer are handled in order, while different
// customers run fully in parallel.
const tails = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  tails.set(key, next);
  void next.finally(() => {
    if (tails.get(key) === next) tails.delete(key);
  });
  return next;
}
