/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { READ_FILE_TOOL_NAME } from './tool-names.js';
import type { PermissionContext } from '../permissions/manager/types.js';

/** Probe Read using the active agent's restrictions, without prompting. */
export async function canReadFileWithoutPrompt(
  config: Config,
  filePath: string,
  context?: ToolUseContext,
): Promise<boolean> {
  const agent = context?.agentLoopContext;
  const permission = agent ? agent.permission : config.permission;
  if (!permission) return false;
  try {
    if (agent && !agent.toolRegistry.getTool(READ_FILE_TOOL_NAME)) return false;
    const agentContext = agent?.permissionContext?.();
    const grants = context?.skillPermissionOverlay?.allowedToolPatterns;
    const permissionContext: PermissionContext = {
      ...agentContext,
      scene: 'probe',
      canPrompt: false,
      ...(grants?.length
        ? {
            skillRules: {
              ...agentContext?.skillRules,
              grants,
            },
          }
        : undefined),
    };
    const result = await permission.check(
      {
        toolName: READ_FILE_TOOL_NAME,
        input: { file_path: filePath },
        toolUseId: 'file-read-state-probe',
        signal: context?.signal,
      },
      permissionContext,
    );
    return result.kind === 'allow';
  } catch {
    return false;
  }
}
