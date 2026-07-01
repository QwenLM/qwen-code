/**
 * Wires the core {@link ScheduleDaemon} to the production fire action
 * ({@link runScheduledTask}) and starts it. Kept separate from the yargs
 * command so it is unit-testable without the blocking foreground loop.
 */

import { ScheduleDaemon, type FireCallback } from '@qwen-code/qwen-code-core';

import { runScheduledTask } from './run-scheduled-task.js';

export interface StartDaemonDeps {
  /** Override the fire action (tests inject a no-op to avoid real spawns). */
  fire?: FireCallback;
  now?: () => number;
  tickIntervalMs?: number;
  reloadIntervalMs?: number;
}

/**
 * Creates and starts the scheduling daemon. Throws if another daemon already
 * holds the single-owner lock. The returned handle must be `stop()`-ed to
 * release the lock and clear timers.
 */
export async function startScheduleDaemon(
  deps: StartDaemonDeps = {},
): Promise<ScheduleDaemon> {
  const daemon = new ScheduleDaemon({
    // Await the run so the daemon's in-flight tracking spans the whole child
    // process, but return void to satisfy FireCallback.
    fire:
      deps.fire ??
      (async (ctx) => {
        await runScheduledTask(ctx);
      }),
    now: deps.now,
    tickIntervalMs: deps.tickIntervalMs,
    reloadIntervalMs: deps.reloadIntervalMs,
  });
  await daemon.start();
  return daemon;
}
