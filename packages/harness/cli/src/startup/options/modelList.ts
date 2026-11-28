/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logRouteEntered } from '../route/routeLogging.js';
import type { ConfiguredStartupContext } from '../startupContext.js';

export async function runModelListOption(
  context: ConfiguredStartupContext,
): Promise<never> {
  logRouteEntered(context, 'listModels');
  const { runModelListCommand } = await import('../../utils/modelList.js');
  await runModelListCommand({ config: context.config });
  return undefined as never;
}
