/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';

export const BEGIN_SYNCHRONIZED_UPDATE = '\u001B[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001B[?2026l';

/**
 * DECSET 2026 shipped in Windows Terminal 1.23, and Windows Terminal publishes
 * no variable carrying its version. The Windows OS build is not a substitute:
 * the terminal installs from the Store and updates on its own, so a 1.12 host
 * and a 1.24 host run on the same build (the reporter on #11929 upgraded
 * 1.12.10983 to 1.24.11911 on Windows 11 build 22631).
 *
 * WSL is the same story from the other side: a session inside it carries
 * `WSL_DISTRO_NAME` but no `WT_SESSION` on a stock setup, and the kernel is a
 * real Linux one whose release carries no Windows build at all. There is
 * therefore no signal on that path to gate on, so WSL2 keeps the legacy path
 * and reaches the wrappers through QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT.
 *
 * What is left is native Windows: `os.release()` there does track the OS, and
 * Windows Terminal has shipped inbox with Windows since 11 22H2, so a host at
 * or above build 26100 always has a Windows Terminal that implements the mode.
 * Older hosts are not excluded — the terminal may have been upgraded past 1.23
 * independently — they just are not detected without the override.
 */
const WINDOWS_BUILD_WITH_INBOX_TERMINAL_1_23 = 26100;

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

/**
 * Reads the Windows build from an `os.release()` string. Only the native
 * release carries it: a WSL kernel reports a real Linux version, so there is
 * nothing to read there and the caller stays undetected.
 */
export function windowsBuildNumber(
  osRelease: string,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (platform !== 'win32') {
    return undefined;
  }
  const raw = /^\d+\.\d+\.(\d+)(?:\.|$)/.exec(osRelease.trim())?.[1];
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

  const termProgram = env['TERM_PROGRAM'];

  // Windows Terminal is identified by `WT_SESSION`, the variable it sets on
  // every session it launches; it does not set `TERM_PROGRAM` at all. The
  // build is a lower bound on the inbox terminal, never a statement about the
  // terminal's own version — see the constant's comment.
  if (isWindowsTerminal(env)) {
    const build = osRelease
      ? windowsBuildNumber(osRelease, platform)
      : undefined;
    return (
      build !== undefined && build >= WINDOWS_BUILD_WITH_INBOX_TERMINAL_1_23
    );
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
  // The OS build is only consulted for Windows Terminal; other terminals skip
  // the syscall.
  const osRelease = isWindowsTerminal(env) ? os.release() : undefined;
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
