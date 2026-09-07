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
import { classifyShellCommandSafetyInDirectory } from '../../utils/shellAstParser.js';

export type MeshToolClassification = 'allow' | 'deny' | 'thread';

export const MESH_THREAD_TOOL_NAMES = [
  'thread_post',
  'thread_wait',
  'thread_block',
  'thread_review',
  'thread_create',
  'thread_read',
] as const;

type CoreToolName = (typeof ToolNames)[keyof typeof ToolNames];
type MeshThreadToolName = (typeof MESH_THREAD_TOOL_NAMES)[number];

export const MESH_TOOL_CLASSIFICATION = {
  [ToolNames.EDIT]: 'deny',
  [ToolNames.WRITE_FILE]: 'deny',
  [ToolNames.READ_FILE]: 'allow',
  [ToolNames.ZOOM_IMAGE]: 'allow',
  [ToolNames.GREP]: 'allow',
  [ToolNames.GLOB]: 'allow',
  [ToolNames.SHELL]: 'allow',
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
  thread_post: 'thread',
  thread_wait: 'thread',
  thread_block: 'thread',
  thread_review: 'thread',
  thread_create: 'thread',
  thread_read: 'thread',
} as const satisfies Record<
  CoreToolName | MeshThreadToolName,
  MeshToolClassification
>;

export function classifyMeshTool(name: string): MeshToolClassification {
  if (!Object.hasOwn(MESH_TOOL_CLASSIFICATION, name)) return 'deny';
  return MESH_TOOL_CLASSIFICATION[
    name as keyof typeof MESH_TOOL_CLASSIFICATION
  ];
}

export function buildMeshToolConfig(definition?: ToolConfig): ToolConfig {
  const allowAll = definition === undefined || definition.tools.includes('*');
  let allowed = allowAll
    ? Object.entries(MESH_TOOL_CLASSIFICATION)
        .filter(([, classification]) => classification === 'allow')
        .map(([name]) => name)
    : definition.tools
        .map((tool) => (typeof tool === 'string' ? tool : tool.name))
        .filter(
          (name): name is string =>
            typeof name === 'string' && classifyMeshTool(name) === 'allow',
        );
  if (definition?.executionAllowedTools !== undefined) {
    const executable = new Set(definition.executionAllowedTools);
    allowed = allowed.filter((name) => executable.has(name));
  }
  if (definition?.disallowedTools?.length) {
    const disallowed = new Set(definition.disallowedTools);
    allowed = allowed.filter((name) => !disallowed.has(name));
  }
  const tools = Array.from(new Set([...allowed, ...MESH_THREAD_TOOL_NAMES]));
  const threadTools = new Set<string>(MESH_THREAD_TOOL_NAMES);

  return {
    tools,
    executionAllowedTools: [...tools],
    disallowedTools: Array.from(
      new Set([
        ...Object.entries(MESH_TOOL_CLASSIFICATION)
          .filter(([, classification]) => classification === 'deny')
          .map(([name]) => name),
        ...(definition?.disallowedTools ?? []).filter(
          (name) => !threadTools.has(name),
        ),
      ]),
    ),
  };
}

export async function checkMeshShellCommand(
  command: string,
  cwd: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const safety = await classifyShellCommandSafetyInDirectory(command, cwd);
  return safety === 'read-only'
    ? { allowed: true }
    : {
        allowed: false,
        reason: `You may only run read-only shell commands; this one is classified as ${safety}.`,
      };
}

export function createMeshToolInvocationGuard(
  upstream?: ToolInvocationGuard,
): ToolInvocationGuard {
  return async (context) => {
    if (upstream) {
      const upstreamDecision = await evaluateToolInvocationGuard(
        upstream,
        context,
      );
      if (!upstreamDecision.allowed) return upstreamDecision;
    }

    const classification = classifyMeshTool(context.toolName);
    if (classification === 'deny') {
      return {
        allowed: false,
        reason: `Tool "${context.toolName}" is outside the mesh read-only capability boundary.`,
      };
    }
    if (context.toolName !== ToolNames.SHELL) return { allowed: true };
    if (context.args['is_background'] === true) {
      return {
        allowed: false,
        reason: 'You may not start background shell processes.',
      };
    }
    const command = context.args['command'];
    if (typeof command !== 'string') {
      return { allowed: false, reason: 'Mesh shell command is missing.' };
    }
    const directory = context.args['directory'];
    return checkMeshShellCommand(
      command,
      typeof directory === 'string'
        ? directory
        : (context.cwd ?? process.cwd()),
    );
  };
}
