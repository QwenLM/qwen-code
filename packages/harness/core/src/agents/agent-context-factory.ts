/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermissionModes } from '../permissions/manager/decision/index.js';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import {
  createConversationMessageAccessors,
  type AgentLoopContext,
} from '../config/agent-loop-context.js';
import { InMemoryToolCallSnapshotStore } from '../tool-executor/tool-call-snapshot.js';
import type { LocalAgentDefinition } from './types.js';
import type { PermissionContext } from '../permissions/manager/types.js';

/**
 * The permission context a fork agent runs under.
 *
 * A fork has no user attached, so both shapes say `canPrompt: false`: an ask
 * that reaches the session is refused because there is no channel to present it,
 * and the declared mode is authoritative for that reason.
 *
 * @param allowedTools When given, the fork stays in Default mode and these tools
 *                     are granted by session rule; anything else asks, and so is
 *                     refused. When absent, the fork runs in Yolo.
 */
export function buildPermissionContext(
  allowedTools?: Set<string> | string[],
): PermissionContext {
  if (allowedTools) {
    return {
      mode: PermissionModes.Default,
      rules: {
        allow: { session: Array.from(allowedTools) },
        deny: {},
        ask: {},
      },
      canPrompt: false,
    };
  }

  return {
    mode: PermissionModes.Yolo,
    rules: { allow: {}, deny: {}, ask: {} },
    canPrompt: false,
  };
}

/**
 * Builds an AgentLoopContext with an auto-approve policy for background agents.
 * Shared by memory extraction, skill extraction, and other background services.
 */
export function buildAutoApproveAgentContext(
  config: Config,
  promptIdPrefix: string,
  allowedTools?: Set<string> | string[],
  parentContext?: AgentLoopContext,
): AgentLoopContext {
  return {
    config,
    promptId: `${promptIdPrefix}-${randomUUID().slice(0, 8)}`,
    toolRegistry: parentContext?.toolRegistry ?? config.getToolRegistry(),
    agentDepth: parentContext?.agentDepth,
    toolCallSnapshots: new InMemoryToolCallSnapshotStore(),
    permission: parentContext ? parentContext.permission : config.permission,
    permissionContext: () => {
      const context = buildPermissionContext(allowedTools);
      if (!parentContext?.permission) return context;
      const parentRules =
        parentContext.permissionContext?.()?.rules ??
        parentContext.permission.getRules();
      const rules = context.rules ?? { allow: {}, deny: {}, ask: {} };
      return {
        ...context,
        rules: { ...rules, deny: { ...parentRules.deny } },
      };
    },
    ...createConversationMessageAccessors(config),
  };
}

export function resolveSkillForkAgent(
  config: Config,
  agentName?: string,
): LocalAgentDefinition | undefined {
  const registry = config.getAgentRegistry();
  if (!registry) return undefined;

  if (agentName) {
    const specified = registry.getDefinition(agentName);
    if (specified) return specified;
  }

  return registry.getAllDefinitions()[0];
}
