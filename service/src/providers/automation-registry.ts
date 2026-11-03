import type { Browser, BrowserContext } from "playwright";

interface RunHandle {
  context?: BrowserContext;
  browser?: Browser;
}

/**
 * Tracks the live browser/context for each in-flight automation run, keyed
 * by requestId, so a caller elsewhere in the same process (the batch
 * runner) can forcibly stop one that's taking too long.
 *
 * Why this exists: the automation provider drives a single shared
 * persistent Chrome profile (confirmed live earlier — two runs against it
 * at once fight over it and corrupt each other's state). So "give up
 * waiting on a stuck record and move on to the next one" is only safe if
 * the stuck run's browser is actually closed first, not just ignored —
 * otherwise the next record's run launches a second browser against the
 * same profile while the first is still alive. cancelRun() closing the
 * context/browser makes whatever Playwright call is in-flight throw, which
 * unwinds runWorker() through its own existing try/finally cleanup.
 */
const active = new Map<string, RunHandle>();

export function registerRun(requestId: string, handle: RunHandle): void {
  active.set(requestId, handle);
}

export function unregisterRun(requestId: string): void {
  active.delete(requestId);
}

/** Returns true if a run was found and closed, false if it had already finished/unregistered. */
export async function cancelRun(requestId: string): Promise<boolean> {
  const handle = active.get(requestId);
  if (!handle) return false;
  await handle.context?.close().catch(() => {});
  await handle.browser?.close().catch(() => {});
  return true;
}
