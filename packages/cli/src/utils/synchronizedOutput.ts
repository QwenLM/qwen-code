/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DEC mode 2026 (Synchronized Output): when the terminal supports it, a frame
 * bracketed by BSU/ESU is committed atomically — the terminal never renders
 * an intermediate state where some cells are cleared and others not yet
 * repainted. This removes the "black-flash" visible during Ink's log-update
 * "erase N lines → write N lines" sequence.
 *
 * Ink (open-source) writes to `process.stdout` in many small chunks per frame
 * (cursor moves, style transitions, content). We intercept `stdout.write`,
 * inject BSU on the first write of a tick, and schedule ESU via
 * `queueMicrotask` at the end of the current synchronous burst — which is
 * exactly one Ink frame's output.
 *
 * Unsupported terminals ignore unknown CSI mode sequences, so the wrapping
 * is safe in principle; the env allowlist avoids paying the ~16 bytes/frame
 * overhead on terminals we know don't benefit.
 */

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

function terminalSupportsSynchronizedOutput(): boolean {
  // tmux parses every byte but doesn't implement DEC 2026. BSU/ESU pass
  // through to the outer terminal, but tmux has already broken atomicity
  // by chunking — skip to save the overhead.
  if (process.env['TMUX']) return false;

  const termProgram = process.env['TERM_PROGRAM'];
  const term = process.env['TERM'];

  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true;
  }

  if (term?.includes('kitty') || process.env['KITTY_WINDOW_ID']) return true;
  if (term === 'xterm-ghostty') return true;
  if (term?.startsWith('foot')) return true;
  if (term?.includes('alacritty')) return true;
  if (process.env['ZED_TERM']) return true;
  if (process.env['WT_SESSION']) return true;

  const vteVersion = process.env['VTE_VERSION'];
  if (vteVersion) {
    const version = parseInt(vteVersion, 10);
    if (version >= 6800) return true;
  }

  return false;
}

let installed = false;

/**
 * Wrap `process.stdout.write` so each synchronous burst of writes is bracketed
 * by DEC 2026 BSU/ESU. Returns a restore function for tests / teardown.
 * No-op on unsupported terminals or non-TTY output.
 */
export function installSynchronizedOutput(): () => void {
  if (installed) return () => {};
  if (!process.stdout.isTTY) return () => {};
  if (!terminalSupportsSynchronizedOutput()) return () => {};

  const stream = process.stdout;
  const originalWrite = stream.write.bind(stream);

  let inBatch = false;
  const endBatch = () => {
    if (inBatch) {
      inBatch = false;
      originalWrite(ESU);
    }
  };

  // We must preserve every overload of stream.write. The runtime only cares
  // that the first arg is forwarded and the return value is boolean.
  const patchedWrite = function patchedWrite(
    this: unknown,
    chunk: unknown,
    ...args: unknown[]
  ): boolean {
    if (!inBatch) {
      inBatch = true;
      originalWrite(BSU);
      queueMicrotask(endBatch);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWrite as any)(chunk, ...args);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = patchedWrite;
  installed = true;

  // Safety net: if the process exits mid-batch (crash, SIGTERM, etc.), the
  // microtask that would have emitted ESU never runs and the terminal is
  // left in synchronized-output mode. Most implementations auto-release on
  // a timeout but not all — emit ESU synchronously on exit to be safe.
  const exitHandler = () => {
    if (inBatch) {
      try {
        originalWrite(ESU);
      } catch {
        // stdout may already be closed; nothing useful to do here.
      }
    }
  };
  process.once('exit', exitHandler);

  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).write = originalWrite;
    process.removeListener('exit', exitHandler);
    installed = false;
  };
}
