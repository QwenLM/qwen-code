/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runExitCleanup } from './cleanup.js';
import fs from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core';

/**
 * Exit code used to signal that the CLI should be relaunched.
 */
export const RELAUNCH_EXIT_CODE = 42;

export const UPDATE_RELAUNCH_EXIT_CODE = 43;

export const UPDATE_COMPLETE_EXIT_CODE = 44;

export const SKIP_UPDATE_CHECK_ENV_VAR = 'QWEN_CODE_SKIP_UPDATE_CHECK_ONCE';

export const SKIP_INITIAL_PROMPT_ENV_VAR = 'QWEN_CODE_SKIP_INITIAL_PROMPT_ONCE';

export const CUSTOM_SANDBOX_IMAGE_ENV_VAR = 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE';

export const HOST_UPDATE_RELAUNCH_ENV_VAR = 'QWEN_CODE_HOST_UPDATE_RELAUNCH';

export const UPDATE_RELAUNCH_SUPPORTED_ENV_VAR =
  'QWEN_CODE_UPDATE_RELAUNCH_SUPPORTED';

export const UPDATE_RELAUNCH_STATE_PATH_ENV_VAR =
  'QWEN_CODE_UPDATE_RELAUNCH_STATE_PATH';

/**
 * Exits the process with a special code to signal that the parent process should relaunch it.
 */
export async function relaunchApp(): Promise<void> {
  await runExitCleanup();
  process.exit(RELAUNCH_EXIT_CODE);
}

export async function relaunchForUpdate(
  sessionId?: string,
  skipInitialPrompt = Boolean(sessionId),
): Promise<void> {
  const statePath = process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR];
  if (statePath && (sessionId || skipInitialPrompt)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ sessionId, skipInitialPrompt }),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
  }
  await runExitCleanup();
  process.exit(UPDATE_RELAUNCH_EXIT_CODE);
}

export function canRelaunchForUpdate(): boolean {
  return (
    process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR] === 'true' &&
    Boolean(process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR])
  );
}

export async function prepareUpdateRelaunch(
  config: Config,
  hasUserMessages: boolean,
  initialPromptConsumed = false,
): Promise<{ sessionId?: string; skipInitialPrompt: boolean } | null> {
  try {
    await config.getChatRecordingService()?.flush();
    const sessionId = config.getSessionId();
    if (await config.getSessionService().getSessionLocation(sessionId)) {
      return { sessionId, skipInitialPrompt: true };
    }
  } catch {
    if (hasUserMessages) return null;
  }
  return hasUserMessages ? null : { skipInitialPrompt: initialPromptConsumed };
}
