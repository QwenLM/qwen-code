/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolConfig } from '../runtime/agent-types.js';
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

export function buildMeshToolConfig(
  definitionTools?: readonly string[],
): ToolConfig {
  const allowAll =
    definitionTools === undefined || definitionTools.includes('*');
  const allowed = allowAll
    ? Object.entries(MESH_TOOL_CLASSIFICATION)
        .filter(([, classification]) => classification === 'allow')
        .map(([name]) => name)
    : definitionTools.filter((name) => classifyMeshTool(name) === 'allow');
  const tools = Array.from(new Set([...allowed, ...MESH_THREAD_TOOL_NAMES]));

  return {
    tools,
    executionAllowedTools: [...tools],
    disallowedTools: Object.entries(MESH_TOOL_CLASSIFICATION)
      .filter(([, classification]) => classification === 'deny')
      .map(([name]) => name),
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
        reason: `Mesh agents may only run read-only shell commands; classified as ${safety}.`,
      };
}
