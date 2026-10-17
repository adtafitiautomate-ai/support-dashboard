import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Contacts created from the simulator carry this tag; nothing is ever sent to them over WhatsApp. */
export const SIMULATOR_TAG = "simulator";

const store = new AsyncLocalStorage<true>();

/** Runs work (e.g. the bot handling a simulated message) in "never send for real" mode. */
export function runSimulated<T>(fn: () => Promise<T>) {
  return store.run(true, fn);
}

export function isSimulatedRun() {
  return store.getStore() === true;
}
