/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SdkMcpToolDefinition } from '../../tool.js';
import type { BridgeState } from '../types.js';
import { infrastructureTools } from './infrastructure.js';
import { sessionTools } from './session.js';
import { agentTools } from './agent.js';
import { workspaceReadTools } from './workspaceRead.js';
import { workspaceWriteTools } from './workspaceWrite.js';

/**
 * Collect all MCP tool definitions for the serve-bridge.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function allTools(state: BridgeState): Array<SdkMcpToolDefinition<any>> {
  return [
    ...infrastructureTools(state),
    ...sessionTools(state),
    ...agentTools(state),
    ...workspaceReadTools(state),
    ...workspaceWriteTools(state),
  ];
}
