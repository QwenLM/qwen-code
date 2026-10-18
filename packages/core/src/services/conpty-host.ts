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
 * ready-case live release. There, `PtyKill` finds the baton and closes the
 * pseudo-console. `kill()` runs first and records the note; the later
 * `releaseConPtyHost` (the finalizer, or the web-terminal `releaseHost`) then
 * skips the redundant native close. Bundled ConPTY still needs the worker
 * fallback because node-pty defers its own worker dispose until more output.
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
 * does not close it a second time. The later release may still dispose the
 * bundled backend's conout worker — see `releasedHosts`.
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
 * would double-close the same HPCON (see `releaseConPtyHost`). On the inbox
 * backend the worker dispose is idempotent. On the bundled backend each call
 * resets the one-second drain timer, so a later data-driven dispose remains
 * safe. No-op off Windows.
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
 * **What this function itself reliably frees is the conout worker thread.**
 * Shell, web-terminal, and agent-view PTYs now use node-pty's bundled ConPTY
 * backend, which releases its host reference immediately after spawn so the
 * host exits with its last client. The web terminal keeps the Windows inbox
 * backend only as a spawn-failure retry (#11352); that fallback's
 * natural-exit host leak is not fixed here.
 *
 * With the inbox backend, a finished PTY strands both the ConPTY host and the
 * `worker_threads` Worker node-pty runs to read the conout pipe. With bundled
 * ConPTY, the host lifecycle is handled by `ConptyReleasePseudoConsole`, but
 * node-pty's `_$onProcessExit` deliberately skips cleanup and still strands the
 * worker. #11303 measured one leaked worker per completed PTY.
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
 *   strictly after `onExit` land in that no-op group: the shell-tool finalizer
 *   when no note was recorded (a natural exit, or a cancel that landed before
 *   the shell's first output byte), `firePostSettle`'s `'exit'` entry, and the
 *   web-terminal release of an already-exited session (`release()`'s `else`
 *   arm) — the primary web-terminal path for #11303. Bundled ConPTY has already
 *   released its host reference after spawn. The remaining sites are
 *   the ones where a `kill()` already closed the HPCON while the shell was
 *   alive and recorded the note (the cancel path and the interactive-shell kill
 *   when `_isReady !== false`, plus the web-terminal live release whose wrapper
 *   `kill()` really ran), so this function's `releasedHosts` early return skips
 *   the close. Finally, a web-terminal release whose shell has not emitted its
 *   first output byte routes to `disposeConoutWorker` instead of this function
 *   — from the live arm AND from the exited arm alike, because `releaseHost`
 *   branches only on `_isReady` and never on `session.exited` — so its queued
 *   `kill()` stays the single closer. The inbox conhost half of #11303 is
 *   therefore not fixed by this function on the natural-exit path.
 *
 * The web-terminal PTY (`web-terminal-registry.ts`) and the agent-view PTY
 * host spawn with the bundled backend too (#11352); only the web terminal's
 * inbox spawn-failure retry can still strand an inbox host per exited
 * terminal. Do not add a test that treats a stubbed `_ptyNative.kill` call as
 * evidence that the inbox host was released.
 *
 * **Why not just call `ptyProcess.kill()`.** On the inbox backend it forks a
 * helper that can fall back after a natural exit to terminating a recycled
 * shell pid (#6067). On the bundled backend it defers worker disposal until
 * more output arrives, which may never happen after exit. Direct teardown
 * avoids both failure modes; taskkill (`windowsKillPid`) covers live children.
 *
 * win32-only: there is no ConPTY host or conout worker elsewhere, and node-pty's
 * `UnixTerminal.kill()` would signal an already-exited, possibly recycled pid.
 */

export const releaseConPtyHost = (ptyProcess: unknown): void => {
  if (os.platform() !== 'win32') {
    return;
  }
  const key = asPtyObject(ptyProcess);
  if (!key) {
    return;
  }
  const agent = (ptyProcess as { _agent?: WindowsPtyAgentInternals } | null)
    ?._agent;
  if (releasedHosts.has(key)) {
    if (agent?._useConptyDll) {
      disposeConoutWorker(ptyProcess);
    }
    return;
  }
  releasedHosts.add(key);
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
