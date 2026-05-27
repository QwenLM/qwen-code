/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import { handler } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function infrastructureTools(state: BridgeState): any[] {
  return [
    tool(
      'health',
      'Check if the qwen serve daemon is alive.',
      {},
      handler(async () => formatJsonResult(await state.client.health())),
    ),
    tool(
      'capabilities',
      'Get qwen serve daemon capabilities including protocol versions, mode, features, model services, and workspace CWD.',
      {},
      handler(async () => formatJsonResult(await state.client.capabilities())),
    ),
  ];
}
