/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolConfig } from '../runtime/agent-types.js';
import {
  evaluateToolInvocationGuard,
  type ToolInvocationGuard,
} from '../../core/tool-invocation-guard.js';
import { ToolNames } from '../../tools/tool-names.js';

export type AgentToolClassification = 'allow' | 'deny' | 'thread';

export const THREAD_TOOL_NAMES = [
  ToolNames.THREAD_POST,
  ToolNames.THREAD_WAIT,
  ToolNames.THREAD_BLOCK,
  ToolNames.THREAD_REVIEW,
  ToolNames.THREAD_CREATE,
  ToolNames.THREAD_READ,
] as const;

type CoreToolName = (typeof ToolNames)[keyof typeof ToolNames];
type AgentThreadToolName = (typeof THREAD_TOOL_NAMES)[number];

export const AGENT_TOOL_CLASSIFICATION = {
  [ToolNames.EDIT]: 'deny',
  [ToolNames.WRITE_FILE]: 'deny',
  [ToolNames.READ_FILE]: 'allow',
  [ToolNames.ZOOM_IMAGE]: 'allow',
  [ToolNames.GREP]: 'allow',
  [ToolNames.GLOB]: 'allow',
  [ToolNames.SHELL]: 'deny',
  [ToolNames.TODO_WRITE]: 'deny',
  [ToolNames.MEMORY]: 'deny',
  [ToolNames.AGENT]: 'deny',
  [ToolNames.SKILL]: 'allow',
  [ToolNames.EXIT_PLAN_MODE]: 'deny',
  [ToolNames.ENTER_PLAN_MODE]: 'deny',
  [ToolNames.WEB_FETCH]: 'deny',
  [ToolNames.WEB_SEARCH]: 'deny',
  [ToolNames.IMAGE_GEN]: 'deny',
  [ToolNames.LS]: 'allow',
  [ToolNames.LSP]: 'deny',
  [ToolNames.ASK_USER_QUESTION]: 'deny',
  [ToolNames.CRON_CREATE]: 'deny',
  [ToolNames.CRON_LIST]: 'deny',
  [ToolNames.CRON_DELETE]: 'deny',
  [ToolNames.LOOP_WAKEUP]: 'deny',
  [ToolNames.CREATE_SUB_SESSION]: 'deny',
  [ToolNames.LIST_AGENTS]: 'deny',
  [ToolNames.TASK_STOP]: 'deny',
  [ToolNames.TASK_CREATE]: 'deny',
  [ToolNames.TASK_UPDATE]: 'deny',
  [ToolNames.TASK_LIST]: 'deny',
  [ToolNames.TEAM_CREATE]: 'deny',
  [ToolNames.TEAM_DELETE]: 'deny',
  [ToolNames.TEAM_PLAN_APPROVAL]: 'deny',
  [ToolNames.REQUEST_SHUTDOWN]: 'deny',
  [ToolNames.SEND_MESSAGE]: 'deny',
  [ToolNames.STRUCTURED_OUTPUT]: 'allow',
  [ToolNames.MONITOR]: 'deny',
  [ToolNames.NOTEBOOK_EDIT]: 'deny',
  [ToolNames.TOOL_SEARCH]: 'allow',
  [ToolNames.READ_MCP_RESOURCE]: 'deny',
  [ToolNames.ENTER_WORKTREE]: 'deny',
  [ToolNames.EXIT_WORKTREE]: 'deny',
  [ToolNames.WORKFLOW]: 'deny',
  [ToolNames.ARTIFACT]: 'deny',
  [ToolNames.RECORD_ARTIFACT]: 'deny',
  [ToolNames.REPORT_FINDINGS]: 'deny',
  [ToolNames.GET_GOAL]: 'allow',
  [ToolNames.UPDATE_GOAL]: 'deny',
  [ToolNames.PROPOSE_GOAL]: 'deny',
  [ToolNames.DISPLAY_IMAGE]: 'allow',
  [ToolNames.THREAD_POST]: 'thread',
  [ToolNames.THREAD_WAIT]: 'thread',
  [ToolNames.THREAD_BLOCK]: 'thread',
  [ToolNames.THREAD_REVIEW]: 'thread',
  [ToolNames.THREAD_CREATE]: 'thread',
  [ToolNames.THREAD_READ]: 'thread',
} as const satisfies Record<
  CoreToolName | AgentThreadToolName,
  AgentToolClassification
>;

export function classifyAgentTool(name: string): AgentToolClassification {
  if (!Object.hasOwn(AGENT_TOOL_CLASSIFICATION, name)) return 'deny';
  return AGENT_TOOL_CLASSIFICATION[
    name as keyof typeof AGENT_TOOL_CLASSIFICATION
  ];
}

export function buildAgentToolConfig(definition?: ToolConfig): ToolConfig {
  const allowAll = definition === undefined || definition.tools.includes('*');
  let allowed = allowAll
    ? Object.entries(AGENT_TOOL_CLASSIFICATION)
        .filter(([, classification]) => classification === 'allow')
        .map(([name]) => name)
    : definition.tools
        .map((tool) => (typeof tool === 'string' ? tool : tool.name))
        .filter(
          (name): name is string =>
            typeof name === 'string' && classifyAgentTool(name) === 'allow',
        );
  if (definition?.executionAllowedTools !== undefined) {
    const executable = new Set(definition.executionAllowedTools);
    allowed = allowed.filter((name) => executable.has(name));
  }
  if (definition?.disallowedTools?.length) {
    const disallowed = new Set(definition.disallowedTools);
    allowed = allowed.filter((name) => !disallowed.has(name));
  }
  const tools = Array.from(new Set([...allowed, ...THREAD_TOOL_NAMES]));
  const threadTools = new Set<string>(THREAD_TOOL_NAMES);

  return {
    tools,
    executionAllowedTools: [...tools],
    disallowedTools: Array.from(
      new Set([
        ...Object.entries(AGENT_TOOL_CLASSIFICATION)
          .filter(([, classification]) => classification === 'deny')
          .map(([name]) => name),
        ...(definition?.disallowedTools ?? []).filter(
          (name) => !threadTools.has(name),
        ),
      ]),
    ),
  };
}

export function createAgentToolInvocationGuard(
  upstream?: ToolInvocationGuard,
  executionAllowedTools?: ReadonlySet<string>,
): ToolInvocationGuard {
  return async (context) => {
    if (upstream) {
      const upstreamDecision = await evaluateToolInvocationGuard(
        upstream,
        context,
      );
      if (!upstreamDecision.allowed) return upstreamDecision;
    }

    const classification = classifyAgentTool(context.toolName);
    if (
      classification === 'deny' ||
      (executionAllowedTools !== undefined &&
        !executionAllowedTools.has(context.toolName))
    ) {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is outside this subsystem read-only capability boundary.`,
      };
    }
    return { allowed: true };
  };
}
