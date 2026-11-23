/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide OSC 7501 reporter.
 *
 * `useProgramStatus` decides what the record should be; this module owns
 * what has actually been written, so code that hands the terminal to a
 * child process (external editors) can take the record down and put it
 * back without knowing the current state.
 */

import {
  oscProgramStatus,
  oscProgramStatusClear,
  type ProgramStatus,
} from './osc.js';

type Write = (sequence: string) => void;

const defaultWrite: Write = (sequence) => {
  process.stdout.write(sequence);
};

let desired: ProgramStatus | undefined;
/** The sequence currently on the terminal, if any. */
let written: string | undefined;
let released = false;

function isEnabled(): boolean {
  // Never write escape sequences into piped or redirected output.
  return !!process.stdout?.isTTY;
}

function send(sequence: string, write: Write): void {
  if (sequence === written) return;
  try {
    write(sequence);
    written = sequence;
  } catch {
    // Leave `written` unchanged so the next report retries.
  }
}

/** Set the record. Writes only when it differs from what is on screen. */
export function reportProgramStatus(
  status: ProgramStatus,
  write: Write = defaultWrite,
): void {
  desired = status;
  if (!isEnabled() || released) return;
  send(oscProgramStatus(status), write);
}

/**
 * Remove the record while another program owns the terminal. Reports made
 * meanwhile are remembered and written by `restoreProgramStatus`.
 */
export function releaseProgramStatus(write: Write = defaultWrite): void {
  released = true;
  if (!isEnabled() || written === undefined) return;
  try {
    write(oscProgramStatusClear());
    written = undefined;
  } catch {
    // Nothing else to do; the terminal drops working/blocked on its own
    // once the child exits or a shell prompt appears.
  }
}

/** Take the terminal back and rewrite the latest record. */
export function restoreProgramStatus(write: Write = defaultWrite): void {
  released = false;
  if (!isEnabled() || !desired) return;
  send(oscProgramStatus(desired), write);
}

/** Rewrite the record even if it looks unchanged (e.g. after SIGCONT). */
export function resendProgramStatus(write: Write = defaultWrite): void {
  written = undefined;
  restoreProgramStatus(write);
}

/**
 * Called on exit. `done` and `error` stay so the user can still see how
 * the last turn ended after the CLI is gone; anything else is cleared so a
 * tab does not keep showing a stale idle record.
 */
export function finalizeProgramStatus(write: Write = defaultWrite): void {
  const keep = desired?.state === 'done' || desired?.state === 'error';
  if (!isEnabled() || keep || written === undefined) return;
  try {
    write(oscProgramStatusClear());
    written = undefined;
  } catch {
    // stdout may already be closed during shutdown.
  }
}

/** Test-only: forget all reporter state. */
export function resetProgramStatusForTest(): void {
  desired = undefined;
  written = undefined;
  released = false;
}
