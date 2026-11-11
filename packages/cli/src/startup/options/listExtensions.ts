/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '@qwen-code/core';
import { exitSuccessfully } from './exitLifecycle.js';
import { logRouteEntered } from '../route/routeLogging.js';
import type { StartupCoordinator } from '../startupCoordinator.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

export async function runListExtensionsOption(
  context: ConfiguredStartupContext,
  _startupCoordinator: StartupCoordinator,
): Promise<never> {
  logRouteEntered(context, 'listExtensions');
  const { config } = context;
  runLogger.log('Installed plugins:');
  for (const plugin of config.getEnabledPlugins()) {
    runLogger.log(`- ${plugin.name}`);
  }
  return exitSuccessfully(
    'Listed extensions successfully',
    'gemini.listExtensions',
  );
}
