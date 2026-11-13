/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const BEGIN_SYNCHRONIZED_UPDATE = '\u001B[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001B[?2026l';

/**
 * Windows Terminal sets `WT_SESSION` on every session it launches and,
 * unlike the allow-listed terminals below, sets no `TERM_PROGRAM` at all. A
 * process started from a Windows Terminal tab inherits that tab's
 * `WT_SESSION`, so a `TERM_PROGRAM` that names a different terminal wins —
 * that is the host painting the frames. This is the same signal the rest of
 * the tree uses (`osc8.ts`, `useTerminalProgress.ts`).
 */
function isWindowsTerminal(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WT_SESSION']) && !env['TERM_PROGRAM'];
}

export interface SynchronizedOutputStatsSnapshot {
  synchronizedOutputFrameCount: number;
  synchronizedOutputBeginCount: number;
  synchronizedOutputEndCount: number;
}

const synchronizedOutputStats: SynchronizedOutputStatsSnapshot = {
  synchronizedOutputFrameCount: 0,
  synchronizedOutputBeginCount: 0,
  synchronizedOutputEndCount: 0,
};

let installed = false;

export function getSynchronizedOutputStatsSnapshot(): SynchronizedOutputStatsSnapshot {
  return { ...synchronizedOutputStats };
}

export function resetSynchronizedOutputStats(): void {
  synchronizedOutputStats.synchronizedOutputFrameCount = 0;
  synchronizedOutputStats.synchronizedOutputBeginCount = 0;
  synchronizedOutputStats.synchronizedOutputEndCount = 0;
}

export function terminalSupportsSynchronizedOutput(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (
    env['QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT'] === '1' ||
    env['QWEN_CODE_SYNCHRONIZED_OUTPUT'] === '0'
  ) {
    return false;
  }

  if (
    env['QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT'] === '1' ||
    env['QWEN_CODE_SYNCHRONIZED_OUTPUT'] === '1'
  ) {
    return true;
  }

  // A multiplexer or SSH hop can drop DECSET 2026 even when the outer host
  // supports it, so those exclusions win over the host detection below.
  if (env['TMUX'] || env['SSH_TTY'] || env['SSH_CLIENT']) {
    return false;
  }

  const termProgram = env['TERM_PROGRAM'];

  if (isWindowsTerminal(env)) {
    return true;
  }

  // Warp's DECRQM 2026 probe answers status 2 (recognized, reset), so
  // synchronized updates are available there; without them Warp renders the
  // erase-then-rewrite pattern as flicker (issue #8557). Ghostty implements
  // synchronized output natively.
  if (
    termProgram === 'WezTerm' ||
    termProgram === 'iTerm.app' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty'
  ) {
    return true;
  }

  const term = env['TERM'];
  return Boolean(env['KITTY_WINDOW_ID'] || term?.includes('kitty'));
}

export function installSynchronizedOutput(
  stdout: NodeJS.WriteStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  if (installed || !stdout.isTTY || !terminalSupportsSynchronizedOutput(env)) {
    return () => {};
  }

  const originalWrite = stdout.write;
  let inFrame = false;

  const writeControlSequence = (sequence: string) => {
    originalWrite.call(stdout, sequence);
  };

  const endFrame = () => {
    if (!inFrame) {
      return;
    }

    inFrame = false;
    synchronizedOutputStats.synchronizedOutputEndCount += 1;
    writeControlSequence(END_SYNCHRONIZED_UPDATE);
  };

  const patchedWrite = function (
    this: NodeJS.WriteStream,
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    if (!inFrame) {
      inFrame = true;
      synchronizedOutputStats.synchronizedOutputFrameCount += 1;
      synchronizedOutputStats.synchronizedOutputBeginCount += 1;
      writeControlSequence(BEGIN_SYNCHRONIZED_UPDATE);
      queueMicrotask(endFrame);
    }

    return originalWrite.call(
      this,
      chunk as string | Uint8Array,
      encodingOrCallback as BufferEncoding,
      callback,
    );
  } as typeof stdout.write;

  const exitHandler = () => {
    try {
      endFrame();
    } catch {
      // stdout may already be closed during process shutdown.
    }
  };

  stdout.write = patchedWrite;
  installed = true;
  process.once('exit', exitHandler);

  return () => {
    if (stdout.write === patchedWrite) {
      endFrame();
      stdout.write = originalWrite;
    }
    process.removeListener('exit', exitHandler);
    installed = false;
  };
}
