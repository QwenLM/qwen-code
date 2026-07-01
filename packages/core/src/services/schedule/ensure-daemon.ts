/**
 * Auto-start for the `/schedule` daemon. Creating a task is pointless if
 * nothing fires it, so schedule_create ensures a daemon is running by spawning
 * a detached `qwen schedule daemon` when one isn't already up. The spawn reuses
 * the same node flags + entry as this process (see resolveQwenChildCommand),
 * so it works both from a packaged install and from `npm run dev`.
 */

import { spawn } from 'node:child_process';

import { createDebugLogger } from '../../utils/debugLogger.js';
import { isDaemonRunning } from './daemon-lock.js';
import { resolveQwenChildCommand } from './run-scheduled-task.js';

const debugLogger = createDebugLogger('SCHEDULE_ENSURE_DAEMON');

export type EnsureDaemonResult =
  | 'already-running'
  | 'started'
  | 'disabled'
  | 'dev-manual'
  | 'failed';

/**
 * Ensures a schedule daemon is running, starting one detached if not.
 * Idempotent: the daemon's single-owner lock means a redundant spawn just
 * exits. Set `QWEN_SCHEDULE_NO_AUTOSTART` to opt out.
 */
export async function ensureScheduleDaemonRunning(): Promise<EnsureDaemonResult> {
  if (process.env['QWEN_SCHEDULE_NO_AUTOSTART']) return 'disabled';

  try {
    if (await isDaemonRunning()) return 'already-running';
  } catch (err) {
    // A lock-read failure shouldn't block the attempt; the daemon's own lock
    // acquisition is the real guard against duplicates.
    debugLogger.warn(`isDaemonRunning check failed: ${err}`);
  }

  // `npm run dev` runs the CLI through a temp tsx loader whose registration
  // file (NODE_OPTIONS → a mkdtemp register.mjs) is deleted when the dev
  // session exits. A DETACHED daemon spawned here would inherit that path and
  // break the moment the session closes — a broken "runs without a session"
  // promise. So in dev we don't auto-spawn; the user runs it in its own
  // terminal (which keeps its loader alive). Packaged installs have no such
  // loader and auto-start normally.
  if (process.env['DEV'] === 'true') return 'dev-manual';

  try {
    const { command, prefixArgs } = resolveQwenChildCommand();
    const child = spawn(command, [...prefixArgs, 'schedule', 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    debugLogger.debug(`Auto-started schedule daemon (pid ${child.pid})`);
    return 'started';
  } catch (err) {
    debugLogger.warn(`Auto-start of schedule daemon failed: ${err}`);
    return 'failed';
  }
}
