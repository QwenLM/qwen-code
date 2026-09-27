/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runExitCleanup } from './cleanup.js';

/**
 * Exit code used to signal that the CLI should be relaunched.
 */
export const RELAUNCH_EXIT_CODE = 42;

export const UPDATE_RELAUNCH_EXIT_CODE = 43;

export const UPDATE_COMPLETE_EXIT_CODE = 44;

export const SKIP_UPDATE_CHECK_ENV_VAR = 'QWEN_CODE_SKIP_UPDATE_CHECK_ONCE';

export const CUSTOM_SANDBOX_IMAGE_ENV_VAR = 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE';

export const HOST_UPDATE_RELAUNCH_ENV_VAR = 'QWEN_CODE_HOST_UPDATE_RELAUNCH';

export const UPDATE_ON_EXIT_MESSAGE = 'qwen-code:update-on-exit';

type UpdateRelaunchHandler = (
  relaunchOnFailure: boolean,
) => Promise<number> | number;

let inProcessUpdateRelaunch: UpdateRelaunchHandler | undefined;
let supervisedInProcess = false;
let updateOnExitRequested = false;
let updatingOnExit = false;

/**
 * Marks this process as running without a supervising parent: restarts
 * re-exec this process in place and updates run here instead of in a parent.
 */
export function superviseInProcess(onUpdateRelaunch: UpdateRelaunchHandler) {
  supervisedInProcess = true;
  inProcessUpdateRelaunch = onUpdateRelaunch;
}

/**
 * Node flags to relaunch this process with. On POSIX the bin launcher exposes
 * gc at runtime rather than via argv, so `process.execArgv` alone would start
 * the relaunched CLI without the gc the memory-pressure monitor calls.
 */
export function getRelaunchExecArgv(): string[] {
  const needsExposeGc =
    typeof globalThis.gc === 'function' &&
    !process.execArgv.includes('--expose-gc');
  return needsExposeGc
    ? [...process.execArgv, '--expose-gc']
    : [...process.execArgv];
}

/**
 * Exits the process with a special code to signal that the parent process should relaunch it.
 */
export async function relaunchApp(): Promise<void> {
  await runExitCleanup();
  // Read loosely: some workspaces' @types/node predate process.execve.
  const proc = process as typeof process & {
    execve?: (file: string, args: string[]) => never;
  };
  if (supervisedInProcess && proc.execve) {
    proc.execve(process.execPath, [
      process.execPath,
      ...getRelaunchExecArgv(),
      ...process.argv.slice(1),
    ]);
  }
  process.exit(RELAUNCH_EXIT_CODE);
}

/**
 * Exits a session that ended on its own, after its exit cleanup has run. A
 * process that supervises itself first installs an update requested for exit,
 * as a supervising parent does after a clean child exit.
 */
export async function exitCleanly(code: number): Promise<never> {
  // A second quit (e.g. another Ctrl+C) must not cut the install short.
  if (updatingOnExit) return new Promise<never>(() => {});
  if (code === 0 && updateOnExitRequested && inProcessUpdateRelaunch) {
    updateOnExitRequested = false;
    updatingOnExit = true;
    try {
      code = await inProcessUpdateRelaunch(false);
    } catch {
      code = 1;
    }
  }
  process.exit(code);
}

export async function relaunchForUpdate(): Promise<void> {
  await runExitCleanup();
  if (inProcessUpdateRelaunch) {
    process.exit(await inProcessUpdateRelaunch(true));
  }
  process.exit(UPDATE_RELAUNCH_EXIT_CODE);
}

export function requestUpdateOnExit(): boolean {
  if (inProcessUpdateRelaunch) {
    updateOnExitRequested = true;
    return true;
  }
  if (!process.send) return false;
  try {
    process.send({ type: UPDATE_ON_EXIT_MESSAGE });
    return true;
  } catch {
    return false;
  }
}
