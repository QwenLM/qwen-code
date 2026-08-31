/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// `open` / `explorer.exe` / `xdg-open` hand off to the GUI and return
// immediately; the timeout only guards against a hung launcher.
const OPEN_TIMEOUT_MS = 10_000;

// Linux terminal emulators tried in order; the first executable on PATH wins.
const LINUX_TERMINAL_NAMES = ['gnome-terminal', 'konsole', 'xterm'] as const;

export class LocalPathOpenUnavailableError extends Error {}

interface MacOsSessionUids {
  readonly processUid?: number;
  readonly consoleUid?: number;
}

function defaultMacOsSessionUids(): MacOsSessionUids | undefined {
  return process.platform === 'darwin' ? readMacOsSessionUids() : undefined;
}

// Shared darwin/win32 graphical-session evidence. Returns undefined on other
// platforms so the caller falls through to its own platform probe.
function hasGuiSession(
  env: Readonly<Record<string, string | undefined>>,
  macOsSessionUids: MacOsSessionUids | undefined,
): boolean | undefined {
  if (process.platform === 'darwin') {
    return (
      macOsSessionUids?.processUid !== undefined &&
      macOsSessionUids.processUid > 0 &&
      macOsSessionUids.consoleUid === macOsSessionUids.processUid &&
      !env['SSH_CONNECTION'] &&
      !env['SSH_TTY']
    );
  }
  if (process.platform === 'win32') {
    const sessionName = env['SESSIONNAME']?.trim();
    return Boolean(sessionName && sessionName.toLowerCase() !== 'services');
  }
  return undefined;
}

function findExecutableOnPath(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  // Names outer: the caller's preference order wins over PATH order.
  for (const name of names) {
    for (const dir of (env['PATH'] ?? '').split(delimiter)) {
      if (dir === '') continue;
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// Startup probe so `/capabilities` can omit the local-open feature on headless
// hosts and clients hide the Open-locally affordance instead of surfacing a
// guaranteed `cannot open display` failure. Same session evidence as the
// native directory picker probe; only the Linux launcher differs (xdg-open
// instead of zenity).
export function isLocalPathOpenAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  macOsSessionUids = defaultMacOsSessionUids(),
): boolean {
  const guiSession = hasGuiSession(env, macOsSessionUids);
  if (guiSession !== undefined) return guiSession;
  if (process.platform !== 'linux') return false;
  if (!env['DISPLAY'] && !env['WAYLAND_DISPLAY']) return false;
  return findExecutableOnPath(env, ['xdg-open']) !== undefined;
}

// Same session evidence as isLocalPathOpenAvailable; on Linux any one common
// terminal emulator on PATH is enough.
export function isLocalTerminalAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  macOsSessionUids = defaultMacOsSessionUids(),
): boolean {
  const guiSession = hasGuiSession(env, macOsSessionUids);
  if (guiSession !== undefined) return guiSession;
  if (process.platform !== 'linux') return false;
  if (!env['DISPLAY'] && !env['WAYLAND_DISPLAY']) return false;
  return findExecutableOnPath(env, LINUX_TERMINAL_NAMES) !== undefined;
}

function readMacOsSessionUids(): MacOsSessionUids {
  try {
    return {
      processUid: process.getuid?.(),
      consoleUid: statSync('/dev/console').uid,
    };
  } catch {
    return {};
  }
}

function isExecutableFile(file: string): boolean {
  try {
    // A directory passes an X_OK probe (search permission) but cannot be
    // exec'd, so it must not count as an installed xdg-open.
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function openPathLocally(path: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', [path], { timeout: OPEN_TIMEOUT_MS });
      return;
    }

    if (process.platform === 'win32') {
      // explorer.exe opens Quick Access for a deleted directory and still
      // exits 0, which would report a successful open for a workspace that
      // no longer exists — darwin/linux fail that case in the launcher, so
      // probe first here.
      assertPathExists(path);
      await spawnAndIgnoreExitCode('explorer.exe', [path]);
      return;
    }

    if (process.platform === 'linux') {
      await execFileAsync('xdg-open', [path], { timeout: OPEN_TIMEOUT_MS });
      return;
    }
  } catch (error) {
    throw new LocalPathOpenUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  throw new LocalPathOpenUnavailableError(
    `Local path open is not supported on ${process.platform}`,
  );
}

function assertPathExists(path: string): void {
  try {
    statSync(path);
  } catch {
    throw new LocalPathOpenUnavailableError(`Path does not exist: ${path}`);
  }
}

export async function openTerminalLocally(path: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-a', 'Terminal', path], {
        timeout: OPEN_TIMEOUT_MS,
      });
      return;
    }

    if (process.platform === 'win32') {
      // Same deleted-directory honesty as the folder open: wt.exe ignores a
      // missing -d target and opens its default profile directory.
      assertPathExists(path);
      await spawnWindowsTerminal(path);
      return;
    }

    if (process.platform === 'linux') {
      await spawnLinuxTerminal(path);
      return;
    }
  } catch (error) {
    if (error instanceof LocalPathOpenUnavailableError) throw error;
    throw new LocalPathOpenUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  throw new LocalPathOpenUnavailableError(
    `Local terminal open is not supported on ${process.platform}`,
  );
}

// wt.exe (Windows Terminal) is absent on older installs; fall back to a
// PowerShell-launched cmd window.
async function spawnWindowsTerminal(path: string): Promise<void> {
  try {
    await spawnAndIgnoreExitCode('wt.exe', ['-d', path]);
  } catch {
    // cmd.exe `start` re-parses its command line and disagrees with Node's
    // CreateProcess quoting — even space-containing paths mis-parse there.
    // PowerShell expands the directory from the environment instead, so the
    // path never travels through a re-parsed command line.
    await spawnAndIgnoreExitCode(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-Command',
        'Start-Process cmd.exe -ArgumentList "/k cd /d `"$env:QWEN_LOCAL_OPEN_DIR`""',
      ],
      { QWEN_LOCAL_OPEN_DIR: path },
    );
  }
}

async function spawnLinuxTerminal(path: string): Promise<void> {
  const terminal = findExecutableOnPath(process.env, LINUX_TERMINAL_NAMES);
  if (terminal === undefined) {
    throw new LocalPathOpenUnavailableError(
      'No terminal emulator found on PATH',
    );
  }
  const name = terminal.split(/[\\/]/).pop();
  if (name === 'gnome-terminal') {
    await spawnLongLived(terminal, [`--working-directory=${path}`]);
    return;
  }
  if (name === 'konsole') {
    await spawnLongLived(terminal, ['--workdir', path]);
    return;
  }
  await spawnLongLived(terminal, [
    '-e',
    'sh',
    '-c',
    'cd "$1" && exec "${SHELL:-/bin/sh}"',
    'sh',
    path,
  ]);
}

// explorer.exe / wt.exe commonly exit 1 even when they did open the folder,
// so their exit code is meaningless; only a spawn-level failure (ENOENT,
// EACCES, ...) or a hang is a real error.
function spawnAndIgnoreExitCode(
  command: string,
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: 'ignore',
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not exit within 10s`));
    }, OPEN_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Terminal windows are long-lived child processes: resolve as soon as the OS
// accepts the spawn and detach so the daemon's lifetime stays independent of
// the window. Only a spawn-level failure is an error.
function spawnLongLived(
  command: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: 'ignore',
      detached: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not spawn within 10s`));
    }, OPEN_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('spawn', () => {
      clearTimeout(timer);
      child.unref();
      resolve();
    });
  });
}
