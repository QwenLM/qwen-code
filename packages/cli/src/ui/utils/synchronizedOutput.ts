/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const BEGIN_SYNCHRONIZED_UPDATE = '\u001B[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001B[?2026l';

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

  if (env['TMUX'] || env['SSH_TTY'] || env['SSH_CLIENT']) {
    return false;
  }

  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'WezTerm' || termProgram === 'iTerm.app') {
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
