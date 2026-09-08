/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CONPTY_HOST');

/**
 * The `WindowsPtyAgent` internals `releaseConPtyHost` needs, at
 * `@lydell/node-pty` 1.2.0-beta.10 (the exact pin in `packages/core/package.json`).
 *
 * The JS field names below were re-checked on 1.2.0-beta.15 and are unchanged.
 * The NATIVE teardown semantics were **not** verified there and do differ:
 * from 1.2.0-beta.14 upstream erases the pty baton with an unconditional
 * `std::erase_if` rather than under `assert`. A bump therefore has to be
 * re-checked against `src/win/conpty.cc`, not only against the JS shape.
 *
 * Every field is optional and the release degrades to a no-op if the shape ever
 * changes, so a bump can only bring the leak back — never a kill we did not
 * intend.
 */
interface WindowsPtyAgentInternals {
  _pty?: number;
  _useConptyDll?: boolean;
  _ptyNative?: { kill?: (pty: number, useConptyDll: boolean) => void };
  _conoutSocketWorker?: { dispose?: () => void };
}

/**
 * PTYs whose pseudo-console has already been closed by a `ptyProcess.kill()`
 * reported through `noteConPtyHostReleased`.
 *
 * This guards the **cancel path only**, and only the window in which the shell
 * is still alive. There, `PtyKill` finds the baton, calls `ClosePseudoConsole`,
 * and does not erase the entry from its handle list, so a second close for the
 * same pty would be a double-free on an already-closed HPCON — undefined
 * behavior in-process, not a caught exception. `performCancelKill` runs
 * `kill()` and the finalizer then runs the release, which is exactly that
 * second close.
 *
 * It does nothing for the natural-exit path: there the native exit watcher has
 * already erased the baton (see `releaseConPtyHost`), so `PtyKill` no-ops and
 * there is no close to double.
 *
 * A WeakSet so a finished PTY is still collectable.
 */
const releasedHosts = new WeakSet<object>();

const asPtyObject = (ptyProcess: unknown): object | undefined =>
  typeof ptyProcess === 'object' && ptyProcess !== null
    ? ptyProcess
    : undefined;

/**
 * Record that a `ptyProcess.kill()` on the cancel or process-exit path has
 * already closed this PTY's pseudo-console, so a later `releaseConPtyHost`
 * does not close it a second time. Only meaningful when that `kill()` ran
 * while the shell was still alive — see `releasedHosts`.
 */
export const noteConPtyHostReleased = (ptyProcess: unknown): void => {
  const key = asPtyObject(ptyProcess);
  if (key) {
    releasedHosts.add(key);
  }
};

/**
 * Releases what node-pty leaves behind when a Windows PTY finishes.
 *
 * **What this actually frees today: the conout worker thread, and not the
 * ConPTY host.** Read that before trusting the name.
 *
 * A finished PTY strands two resources for the lifetime of the CLI process:
 * the ConPTY host process (`conhost.exe --headless`, ~8 MB) and the
 * `worker_threads` Worker node-pty runs to read the conout pipe. #11303
 * measured both — 347 orphaned conhosts against 353 threads in the parent, one
 * leaked worker each. node-pty releases neither on a natural shell exit:
 * `_$onProcessExit` only flushes buffered data and destroys its sockets, while
 * `ClosePseudoConsole` and `ConoutConnection.dispose()` are reachable only from
 * `WindowsPtyAgent.kill()`.
 *
 * - `_conoutSocketWorker.dispose()` is pure JS — a 1 s drain, then
 *   `worker.terminate()` — and genuinely frees the worker here.
 * - `_ptyNative.kill()` is a **silent no-op on every call site below**, at the
 *   pinned version. In `src/win/conpty.cc` the native exit-watcher thread
 *   erases the pty baton *before* it delivers the JS `onExit`, and `PtyKill`
 *   skips `ClosePseudoConsole` when `get_pty_baton` returns null — with no
 *   throw, so not even the warn below fires. `struct pty_baton` has no
 *   destructor, so the erase leaks the HPCON rather than closing it. Every
 *   caller here runs strictly after `onExit`, so none of them can reach a live
 *   baton. The conhost half of #11303 is therefore NOT fixed by this function.
 *
 * The call is kept because the call *site* is right: the moment upstream closes
 * the HPCON when the baton is erased (a `ClosePseudoConsole` in
 * `remove_pty_baton`, or a `~pty_baton`), this starts working with no change
 * here. Until then the only mitigation for the host half is
 * `tools.shell.enableInteractiveShell: false`, which skips the PTY path
 * entirely. Do not add a test that asserts the host is released — stubbing
 * `_ptyNative.kill` makes such a test pass on a call that does nothing.
 *
 * **Why not just call `ptyProcess.kill()`.** Beyond those two teardowns,
 * `kill()` forks a helper to run `GetConsoleProcessList` on the shell pid and
 * then `process.kill()`s every pid it returns. That is correct while the shell
 * is alive, but after a natural exit `AttachConsole` fails, the helper dies
 * with an uncaught error, node-pty's 5 s timeout falls back to
 * `resolve([shellPid])` — and we `TerminateProcess` a pid that has already been
 * freed for reuse. That is the #6067 collateral-kill mode, and it would fire on
 * every tool call. So the teardowns are invoked directly and the process-list
 * kill is skipped; taskkill (`windowsKillPid`) covers the cases that need it.
 *
 * win32-only: there is no ConPTY host or conout worker elsewhere, and node-pty's
 * `UnixTerminal.kill()` would signal an already-exited, possibly recycled pid.
 */
export const releaseConPtyHost = (ptyProcess: unknown): void => {
  if (os.platform() !== 'win32') {
    return;
  }
  const key = asPtyObject(ptyProcess);
  if (!key || releasedHosts.has(key)) {
    return;
  }
  releasedHosts.add(key);
  const agent = (ptyProcess as { _agent?: WindowsPtyAgentInternals } | null)
    ?._agent;
  const ptyId = agent?._pty;
  const nativeKill = agent?._ptyNative?.kill;
  if (!agent || typeof nativeKill !== 'function' || typeof ptyId !== 'number') {
    // Degrade to the pre-#11303 behavior rather than to `kill()`: leaking is
    // recoverable by restarting the CLI, killing a recycled pid is not.
    debugLogger.warn(
      'releaseConPtyHost: node-pty internals not in the expected shape; the conout worker was not released (see #11303)',
    );
    return;
  }
  try {
    nativeKill.call(agent._ptyNative, ptyId, agent._useConptyDll ?? false);
  } catch (e) {
    debugLogger.warn(
      `releaseConPtyHost: the native pty kill threw: ${e instanceof Error ? e.message : String(e)}`,
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
