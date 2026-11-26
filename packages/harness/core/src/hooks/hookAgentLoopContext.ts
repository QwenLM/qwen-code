/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for creating an AgentLoopContext from Config for hook agent execution.
 *
 * Hook agents need a full AgentLoopContext to create a Scheduler, but they
 * don't run in a main agent loop — they're spawned per-hook-execution.
 * This factory assembles the context from Config's existing getter methods.
 */

import {
  createConversationMessageAccessors,
  type AgentLoopContext,
} from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { PermissionModes } from '../permissions/manager/decision/index.js';

/**
 * Create an AgentLoopContext for hook agent execution.
 *
 * @param config   The global Config instance
 * @param promptId Unique prompt ID for this hook execution
 * @param toolRegistry Optional scoped ToolRegistry (e.g. with filtered tools).
 *                     If not provided, uses Config's default registry.
 */
export function createHookAgentLoopContext(
  config: Config,
  promptId: string,
  toolRegistry?: ToolRegistry,
): AgentLoopContext {
  return {
    config,
    promptId,
    toolRegistry: toolRegistry ?? config.getToolRegistry(),
    toolCallSnapshots: config.toolCallSnapshots,
    permission: config.permission,
    // A hook agent runs with no user attached, so it declares DontAsk and
    // cannot prompt. DontAsk denies anything that would have asked.
    permissionContext: () => ({
      mode: PermissionModes.DontAsk,
      canPrompt: false,
    }),
    ...createConversationMessageAccessors(config),
  };
}

