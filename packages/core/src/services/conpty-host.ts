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
 * This guards every path where a `kill()` runs while the shell is still
 * alive — the cancel path (`performCancelKill`) and the web-terminal
 * ready-case live release. There, `PtyKill` finds the baton, calls
 * `ClosePseudoConsole`, and does not erase the entry from its handle list, so a
 * second close for the same pty would be a double-free on an already-closed
 * HPCON — undefined behavior in-process, not a caught exception. `kill()` runs
 * first and records the note; the later `releaseConPtyHost` (the finalizer, or
 * the web-terminal `releaseHost`) then hits this early return instead of
 * closing again.
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
 * Dispose only node-pty's conout worker thread for a finished PTY, without
 * closing the pseudo-console.
 *
 * Used by the web-terminal live-release path when the shell has not yet emitted
 * its first output byte: node-pty's `WindowsTerminal.kill()` defers its whole
 * teardown (the native `ClosePseudoConsole` and this worker dispose) into
 * `_deferreds` until `_isReady` flips, so a release at that moment must dispose
 * the worker now — the one resource a never-run deferred teardown would strand
 * — while leaving the native close to the queued `kill()`. Closing it here too
 * would double-close the same HPCON (see `releaseConPtyHost`). The worker
 * dispose is idempotent (`ConoutConnection.dispose` guards on `_isDisposed` for
 * the non-`useConptyDll` path), so doing it here and again in the queued
 * teardown is safe. No-op off Windows.
 *
 * Like `releaseConPtyHost`, this never calls `ptyProcess.kill()`; see that
 * function for the #6067 recycled-pid argument and the win32-only rationale.
 */
export const disposeConoutWorker = (ptyProcess: unknown): void => {
  if (os.platform() !== 'win32') {
    return;
  }
  const agent = (ptyProcess as { _agent?: WindowsPtyAgentInternals } | null)
    ?._agent;
  if (!agent) {
    return;
  }
  try {
    agent._conoutSocketWorker?.dispose?.();
  } catch (e) {
    debugLogger.warn(
      `disposeConoutWorker: conout worker dispose threw: ${e instanceof Error ? e.message : String(e)}`,
    );
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
 * - `_ptyNative.kill()` here only reaches a live pseudo-console from ONE call
 *   site: `firePostSettle`'s `'error'` entry point, where it does close it
 *   (matching the `windowsKillPid` reap beside it). Everywhere else it is a
 *   silent no-op. In `src/win/conpty.cc` the native exit-watcher thread erases
 *   the pty baton *before* it delivers the JS `onExit`, and `PtyKill` skips
 *   `ClosePseudoConsole` when `get_pty_baton` returns null — with no throw, so
 *   not even the warn below fires; `struct pty_baton` has no destructor, so the
 *   erase leaks the HPCON rather than closing it. The call sites that run
 *   strictly after `onExit` (the shell-tool finalizer and `firePostSettle`'s
 *   `'exit'` entry) land in that no-op group. The remaining sites are the ones
 *   where a `kill()` already closed the HPCON while the shell was alive and
 *   recorded the note (the cancel path, and the web-terminal ready-case live
 *   release), so this function's `releasedHosts` early return skips the close;
 *   and the web-terminal deferred-case live release, which routes to
 *   `disposeConoutWorker` instead of this function so its queued `kill()` stays
 *   the single closer. The conhost half of #11303 is therefore NOT fixed by
 *   this function on the natural-exit path.
 *
 * The call is kept because the call *site* is right: the moment upstream closes
 * the HPCON when the baton is erased (a `ClosePseudoConsole` in
 * `remove_pty_baton`, or a `~pty_baton`), this starts working with no change
 * here. Until then the only mitigation for the host half of the shell-tool
 * path is `tools.shell.enableInteractiveShell: false`, which drops that path
 * to `child_process`. The web-terminal PTY (`web-terminal-registry.ts`) and
 * the agent-view PTY host are not gated by it, so a daemon serving web
 * terminals keeps stranding a host per exited terminal. Do not add a test that
 * asserts the host is released — stubbing
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
  if (!agent) {
    debugLogger.warn(
      'releaseConPtyHost: no node-pty agent; nothing released (see #11303)',
    );
    return;
  }
  if (typeof nativeKill === 'function' && typeof ptyId === 'number') {
    try {
      nativeKill.call(agent._ptyNative, ptyId, agent._useConptyDll ?? false);
    } catch (e) {
      debugLogger.warn(
        `releaseConPtyHost: the native pty kill threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    // Degrade to the pre-#11303 behavior rather than to `kill()`: leaking is
    // recoverable by restarting the CLI, killing a recycled pid is not.
    debugLogger.warn(
      'releaseConPtyHost: native pty shape changed; skipping the pseudo-console close (see #11303)',
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
