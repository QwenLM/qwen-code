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

/**
 * Exits the process with a special code to signal that the parent process should relaunch it.
 */
export async function relaunchApp(): Promise<void> {
  await runExitCleanup();
  process.exit(RELAUNCH_EXIT_CODE);
}

export async function relaunchForUpdate(): Promise<void> {
  await runExitCleanup();
  process.exit(UPDATE_RELAUNCH_EXIT_CODE);
}

export function requestUpdateOnExit(): boolean {
  if (!process.send) return false;
  try {
    process.send({ type: UPDATE_ON_EXIT_MESSAGE });
    return true;
  } catch {
    return false;
  }
}
