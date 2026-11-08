/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

export const BEGIN_SYNCHRONIZED_UPDATE = '\u001B[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001B[?2026l';

/**
 * DECSET 2026 shipped in Windows Terminal 1.23. Before it the host advertises
 * WT_SESSION but silently drops the mode, so emitting the wrappers there only
 * adds bytes to frames the terminal still paints non-atomically.
 */
const WINDOWS_TERMINAL_SYNCHRONIZED_OUTPUT_MIN_BUILD = 26100;

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

/**
 * Windows Terminal publishes no variable carrying its own version. Two signals
 * stand in for it:
 * - native (`win32`): the Windows build in `os.release()` (`10.0.26100`).
 * - WSL: the host build embedded in the kernel release
 *   (`4.4.0-26100-Microsoft`). WSL1 kernels (`4.19.104-microsoft-standard`)
 *   carry no build number and stay undetected.
 * Anything older than the cutoff keeps the legacy path.
 */
export function windowsBuildNumber(
  osRelease: string,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  const release = osRelease.trim();
  const raw =
    platform === 'win32'
      ? /^\d+\.\d+\.(\d+)(?:\.|$)/.exec(release)?.[1]
      : /^\d+\.\d+\.\d+-(\d+)-[a-z]/i.exec(release)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const build = Number.parseInt(raw, 10);
  return Number.isFinite(build) ? build : undefined;
}

export function terminalSupportsSynchronizedOutput(
  env: NodeJS.ProcessEnv = process.env,
  osRelease?: string,
  platform: NodeJS.Platform = process.platform,
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

  // Windows Terminal publishes no version variable; the host build comes from
  // os.release() on both the native and WSL paths.
  if (env['WT_SESSION']) {
    const build = osRelease
      ? windowsBuildNumber(osRelease, platform)
      : undefined;
    return (
      build !== undefined &&
      build >= WINDOWS_TERMINAL_SYNCHRONIZED_OUTPUT_MIN_BUILD
    );
  }

  const termProgram = env['TERM_PROGRAM'];
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
  // The Windows build (native release or WSL host kernel) is only consulted for
  // Windows Terminal; other terminals skip the syscall.
  const osRelease =
    env['WT_SESSION'] && !env['TMUX'] ? os.release() : undefined;
  if (
    installed ||
    !stdout.isTTY ||
    !terminalSupportsSynchronizedOutput(env, osRelease)
  ) {
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
