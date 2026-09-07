/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CONPTY_HOST');

/**
 * The `WindowsPtyAgent` internals `releaseConPtyHost` needs. Pinned to
 * `@lydell/node-pty` 1.2.0-beta.10 (checked again on 1.2.0-beta.15, unchanged);
 * every field is optional and the release degrades to a no-op if the shape ever
 * changes, so a dependency bump can only bring the leak back — never a kill we
 * did not intend.
 */
interface WindowsPtyAgentInternals {
  _pty?: number;
  _useConptyDll?: boolean;
  _ptyNative?: { kill?: (pty: number, useConptyDll: boolean) => void };
  _conoutSocketWorker?: { dispose?: () => void };
}

/**
 * Releases the two Windows resources a finished PTY leaves behind: the ConPTY
 * host process (`conhost.exe --headless`, ~8 MB) and the `worker_threads`
 * Worker that node-pty runs to read the conout pipe. Both leak once per PTY —
 * i.e. once per tool call — for the lifetime of the CLI process. See #11303,
 * where the reporter measured 347 orphaned conhosts against 353 threads in the
 * parent: one leaked worker each.
 *
 * node-pty never releases either on a *natural* shell exit. `_$onProcessExit`
 * only flushes buffered data and destroys its sockets; `ClosePseudoConsole` and
 * `ConoutConnection.dispose()` are reached exclusively from
 * `WindowsPtyAgent.kill()`.
 *
 * **Why not just call `ptyProcess.kill()`.** On top of those two teardowns,
 * `kill()` forks a helper process to run `GetConsoleProcessList` on the shell
 * pid and then `process.kill()`s every pid it returns. That is correct while
 * the shell is alive, but on the healthy path the shell has already exited, so
 * `AttachConsole` fails, the helper dies with an uncaught error, node-pty's 5 s
 * timeout falls back to `resolve([shellPid])` — and we `TerminateProcess` a pid
 * that `ClosePseudoConsole` has already freed for reuse. That is the #6067
 * collateral-kill failure mode, and calling `kill()` here would fire it on
 * every single tool call. So we invoke the two teardowns directly and skip the
 * process-list kill, which taskkill (`windowsKillPid`) already covers for the
 * cases that need it.
 *
 * win32-only: there is no ConPTY host or conout worker elsewhere, and node-pty's
 * `UnixTerminal.kill()` would signal an already-exited, possibly recycled pid.
 */
export const releaseConPtyHost = (ptyProcess: unknown): void => {
  if (os.platform() !== 'win32') {
    return;
  }
  const agent = (ptyProcess as { _agent?: WindowsPtyAgentInternals } | null)
    ?._agent;
  const ptyId = agent?._pty;
  const nativeKill = agent?._ptyNative?.kill;
  if (!agent || typeof nativeKill !== 'function' || typeof ptyId !== 'number') {
    // Degrade to the pre-#11303 behavior rather than to `kill()`: leaking is
    // recoverable by restarting the CLI, killing a recycled pid is not.
    debugLogger.warn(
      'releaseConPtyHost: node-pty internals not in the expected shape; the ConPTY host was not released (see #11303)',
    );
    return;
  }
  try {
    nativeKill.call(agent._ptyNative, ptyId, agent._useConptyDll ?? false);
  } catch (e) {
    debugLogger.warn(
      `releaseConPtyHost: ClosePseudoConsole threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    agent._conoutSocketWorker?.dispose?.();
  } catch (e) {
    debugLogger.warn(
      `releaseConPtyHost: conout worker dispose threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};
