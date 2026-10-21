// Keeps the fork's branch up to date with upstream: on a timer, and on demand
// right before a bug report is processed.
import { syncFork } from "./github.js";

let inFlight = null;
let lastResult = null;

/**
 * Syncs the fork now. Concurrent callers share a single request.
 * @returns {Promise<{ok: boolean, mergeType?: string, status?: number, message: string}>}
 */
export function syncNow(fork, branch) {
  inFlight ??= syncFork(fork, branch)
    .catch((err) => ({ ok: false, message: err.message }))
    .then((result) => {
      lastResult = result;
      if (result.ok && result.mergeType !== "none") {
        console.log(`[sync] ${fork}:${branch} updated from upstream (${result.mergeType}).`);
      } else if (!result.ok) {
        console.error(`[sync] ${fork}:${branch} sync failed: ${result.message}`);
      }
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Runs syncNow immediately and then every `intervalMs`. `onStatusChange` is
 * called when sync starts failing or recovers, so the maintainer gets one alert
 * per outage instead of one per interval.
 */
export function startForkSync(fork, branch, intervalMs, onStatusChange) {
  let wasFailing = false;
  const tick = async () => {
    const result = await syncNow(fork, branch);
    const failing = !result.ok;
    if (failing !== wasFailing) {
      wasFailing = failing;
      await onStatusChange(result).catch((err) =>
        console.error("[sync] Failed to send status alert:", err),
      );
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

export function lastSyncResult() {
  return lastResult;
}
