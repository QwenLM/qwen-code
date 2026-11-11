/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import readline from 'node:readline';
import { CoreEvent, coreEvents } from './events.js';
import { FatalAuthenticationError } from './errors.js';
import { createWorkingStdio, writeToStdout } from './stdio.js';
import { isHeadlessMode } from './headless.js';
import { BRAND_CLI_NAME } from '../config/brand.js';
import { raceWithAbortSignal } from './abort-race.js';

/**
 * Requests consent from the user for OAuth login.
 * Handles both interactive and non-interactive (headless) modes.
 */
export async function getConsentForOauth(
  prompt: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const finalPrompt =
    (prompt ? prompt + ' ' : '') +
    'Opening authentication page in your browser. ';

  if (isHeadlessMode()) {
    return getOauthConsentNonInteractive(finalPrompt, signal);
  } else if (coreEvents.listenerCount(CoreEvent.ConsentRequest) > 0) {
    return getOauthConsentInteractive(finalPrompt, signal);
  }
  throw new FatalAuthenticationError(
    'Authentication consent could not be obtained.\n' +
      `Please run ${BRAND_CLI_NAME} in an interactive terminal to authenticate, ` +
      'or use NO_BROWSER=true for manual authentication.',
  );
}

async function getOauthConsentNonInteractive(
  prompt: string,
  signal?: AbortSignal,
) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: createWorkingStdio().stdout,
    terminal: true,
  });

  const fullPrompt = prompt + 'Do you want to continue? [Y/n]: ';
  writeToStdout(`\n${fullPrompt}`);

  try {
    const result = new Promise<boolean>((resolve) => {
      rl.on('line', (answer) => {
        resolve(['y', ''].includes(answer.trim().toLowerCase()));
      });
    });
    return await (signal ? raceWithAbortSignal(result, signal) : result);
  } finally {
    rl.close();
  }
}

async function getOauthConsentInteractive(
  prompt: string,
  signal?: AbortSignal,
) {
  const fullPrompt = prompt + '\n\nDo you want to continue?';
  const result = new Promise<boolean>((resolve) => {
    coreEvents.emitConsentRequest({
      prompt: fullPrompt,
      ...(signal ? { signal } : {}),
      onConfirm: (confirmed: boolean) => {
        resolve(confirmed);
      },
    });
  });
  return signal ? raceWithAbortSignal(result, signal) : result;
}
