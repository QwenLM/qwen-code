/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeToStderr } from '@qwen-code/core';
import { exitSuccessfully, exitWithInputError } from './exitLifecycle.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

export async function runDeleteSessionOption(
  context: ConfiguredStartupContext,
  _startupCoordinator: StartupCoordinator,
  sessionToDelete: string | undefined,
): Promise<never> {
  logRouteEntered(context, 'deleteSession');
  const { config } = context;
  if (!sessionToDelete) {
    writeToStderr('Error: --delete-session requires a session identifier.\n');
    return exitWithInputError(
      '--delete-session requires a session identifier',
      'gemini.deleteSession',
    );
  }

  const { deleteSession } = await import('../../utils/sessions.js');
  await deleteSession(config, sessionToDelete);
  return exitSuccessfully(
    'Deleted session successfully',
    'gemini.deleteSession',
  );
}
