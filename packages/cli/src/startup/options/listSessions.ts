/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { exitSuccessfully } from './exitLifecycle.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

export async function runListSessionsOption(
  context: ConfiguredStartupContext,
  _startupCoordinator: StartupCoordinator,
): Promise<never> {
  logRouteEntered(context, 'listSessions');
  const { config } = context;

  const { listSessions } = await import('../../utils/sessions.js');
  await listSessions(config);
  return exitSuccessfully(
    'Listed sessions successfully',
    'gemini.listSessions',
  );
}
