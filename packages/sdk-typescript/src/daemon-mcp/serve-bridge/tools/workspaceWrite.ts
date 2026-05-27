/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult, formatToolError } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import { handler, resolveSessionId } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function workspaceWriteTools(state: BridgeState): any[] {
  return [
    tool(
      'file_write',
      'Create or replace a text file in the workspace. Supports hash-verified atomic writes.',
      {
        path: z.string().describe('File path (relative to workspace root).'),
        content: z.string().describe('File content to write.'),
        mode: z.enum(['create', 'replace']).describe('"create" for new files, "replace" for existing.'),
        expected_hash: z.string().optional().describe('Expected SHA-256 hash for replace mode (required for replace).'),
      },
      handler(async (args) => {
        if (args.mode === 'replace' && !args.expected_hash) {
          return formatToolError('expected_hash is required for replace mode.');
        }
        const req =
          args.mode === 'create'
            ? {
                path: args.path,
                content: args.content,
                mode: 'create' as const,
                ...(args.expected_hash
                  ? { expectedHash: args.expected_hash as `sha256:${string}` }
                  : {}),
              }
            : {
                path: args.path,
                content: args.content,
                mode: 'replace' as const,
                expectedHash: args.expected_hash as `sha256:${string}`,
              };
        return formatJsonResult(await state.client.writeWorkspaceFile(req));
      }),
    ),

    tool(
      'file_edit',
      'Make a single text replacement in a file. Requires exact-once match of old_text.',
      {
        path: z.string().describe('File path.'),
        old_text: z.string().describe('Text to find (must match exactly once).'),
        new_text: z.string().describe('Replacement text.'),
        expected_hash: z.string().describe('Expected SHA-256 hash of the current file.'),
      },
      handler(async (args) =>
        formatJsonResult(
          await state.client.editWorkspaceFile({
            path: args.path,
            oldText: args.old_text,
            newText: args.new_text,
            expectedHash: args.expected_hash as `sha256:${string}`,
          }),
        ),
      ),
    ),

    tool(
      'session_set_approval_mode',
      'Change the approval mode of a session (plan, default, auto-edit, auto, yolo).',
      {
        mode: z.enum(['plan', 'default', 'auto-edit', 'auto', 'yolo']).describe('Approval mode.'),
        persist: z.boolean().optional().describe('Also write to workspace settings file.'),
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        // Block dangerous modes and persistent changes without explicit opt-in
        if (!state.allowGlobalScope) {
          const dangerousModes = ['yolo', 'auto', 'auto-edit'];
          if (dangerousModes.includes(args.mode)) {
            return formatToolError(
              `Approval modes '${dangerousModes.join("', '")}' are restricted for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.`,
            );
          }
          if (args.persist) {
            return formatToolError(
              'Persisting approval mode changes is restricted for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.',
            );
          }
        }
        const sessionId = resolveSessionId(state, args.session_id);
        return formatJsonResult(
          await state.client.setSessionApprovalMode(sessionId, args.mode, { persist: args.persist }),
        );
      }),
    ),

    tool(
      'workspace_tool_toggle',
      'Enable or disable a tool in the workspace settings.',
      {
        tool_name: z.string().describe('Name of the tool to toggle.'),
        enabled: z.boolean().describe('Whether to enable (true) or disable (false) the tool.'),
      },
      handler(async (args) => {
        if (!state.allowGlobalScope) {
          return formatToolError(
            'Tool toggling is restricted for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.',
          );
        }
        return formatJsonResult(
          await state.client.setWorkspaceToolEnabled(args.tool_name, args.enabled),
        );
      }),
    ),

    tool(
      'workspace_init',
      'Scaffold an empty QWEN.md at the workspace root. No LLM invocation.',
      {
        force: z.boolean().optional().describe('Overwrite existing QWEN.md if present.'),
      },
      handler(async (args) =>
        formatJsonResult(
          await state.client.initWorkspace({ force: args.force }),
        ),
      ),
    ),

    tool(
      'workspace_mcp_restart',
      'Restart a configured MCP server. Pre-checks budget before restarting.',
      {
        server_name: z.string().describe('Name of the MCP server to restart.'),
      },
      handler(async (args) => {
        if (!state.allowGlobalScope) {
          return formatToolError(
            'MCP server restart is restricted for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.',
          );
        }
        return formatJsonResult(
          await state.client.restartMcpServer(args.server_name),
        );
      }),
    ),

    tool(
      'workspace_memory_read',
      'Read workspace memory (QWEN.md hierarchy).',
      {},
      handler(async () =>
        formatJsonResult(await state.client.workspaceMemory()),
      ),
    ),

    tool(
      'workspace_memory_write',
      'Write to workspace memory (QWEN.md). Supports append or replace mode.',
      {
        scope: z.enum(['workspace', 'global']).describe('Memory scope.'),
        content: z.string().describe('Content to write.'),
        mode: z.enum(['append', 'replace']).optional().describe('Write mode (default: append).'),
      },
      handler(async (args) => {
        if (args.scope === 'global' && !state.allowGlobalScope) {
          return formatToolError(
            'Global scope is disabled for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.',
          );
        }
        return formatJsonResult(
          await state.client.writeWorkspaceMemory({
            scope: args.scope,
            content: args.content,
            mode: args.mode,
          }),
        );
      }),
    ),

    tool(
      'workspace_agents_manage',
      'Manage workspace agent definitions. Use action to list, get, create, update, or delete agents.',
      {
        action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('CRUD action to perform.'),
        agent_type: z.string().optional().describe('Agent type name (required for get/update/delete).'),
        name: z.string().optional().describe('Agent name (create only, required for create).'),
        description: z.string().optional().describe('Agent description (required for create).'),
        system_prompt: z.string().optional().describe('System prompt (required for create).'),
        scope: z.enum(['workspace', 'global']).optional().describe('Agent scope (required for create).'),
        tools: z.array(z.string()).optional().describe('Allowed tool names.'),
        disallowed_tools: z.array(z.string()).optional().describe('Disallowed tool names.'),
        model: z.string().optional().describe('Model ID for the agent.'),
      },
      handler(async (args) => handleAgentsManage(state, args)),
    ),
  ];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function validateGlobalScope(state: BridgeState, scope: string | undefined): any | null {
  if (scope === 'global' && !state.allowGlobalScope) {
    return formatToolError(
      'Global scope is disabled for security. Set QWEN_BRIDGE_ALLOW_GLOBAL_SCOPE=true to enable.',
    );
  }
  return null;
}

async function handleAgentsManage(state: BridgeState, args: any): Promise<any> {
  switch (args.action) {
    case 'list':
      return formatJsonResult(await state.client.listWorkspaceAgents());
    case 'get':
      return handleAgentGet(state, args);
    case 'create': {
      const scopeErr = validateGlobalScope(state, args.scope);
      if (scopeErr) return scopeErr;
      return handleAgentCreate(state, args);
    }
    case 'update': {
      const scopeErr = validateGlobalScope(state, args.scope);
      if (scopeErr) return scopeErr;
      return handleAgentUpdate(state, args);
    }
    case 'delete': {
      const scopeErr = validateGlobalScope(state, args.scope);
      if (scopeErr) return scopeErr;
      return handleAgentDelete(state, args);
    }
    default:
      return formatToolError(`Unknown action: ${args.action}`);
  }
}

async function handleAgentGet(state: BridgeState, args: any): Promise<any> {
  if (!args.agent_type) {
    return formatToolError('agent_type is required for get action.');
  }
  return formatJsonResult(await state.client.getWorkspaceAgent(args.agent_type));
}

async function handleAgentCreate(state: BridgeState, args: any): Promise<any> {
  if (!args.name || !args.description || !args.system_prompt || !args.scope) {
    return formatToolError(
      'name, description, system_prompt, and scope are required for create action.',
    );
  }
  return formatJsonResult(
    await state.client.createWorkspaceAgent({
      name: args.name,
      description: args.description,
      systemPrompt: args.system_prompt,
      scope: args.scope,
      tools: args.tools,
      disallowedTools: args.disallowed_tools,
      model: args.model,
    }),
  );
}

async function handleAgentUpdate(state: BridgeState, args: any): Promise<any> {
  if (!args.agent_type) {
    return formatToolError('agent_type is required for update action.');
  }
  const hasField =
    args.description !== undefined ||
    args.system_prompt !== undefined ||
    args.tools !== undefined ||
    args.disallowed_tools !== undefined ||
    args.model !== undefined;
  if (!hasField) {
    return formatToolError(
      'At least one field to update must be provided (description, system_prompt, tools, disallowed_tools, or model).',
    );
  }
  return formatJsonResult(
    await state.client.updateWorkspaceAgent(
      args.agent_type,
      {
        description: args.description,
        systemPrompt: args.system_prompt,
        tools: args.tools,
        disallowedTools: args.disallowed_tools,
        model: args.model,
      },
      { scope: args.scope },
    ),
  );
}

async function handleAgentDelete(state: BridgeState, args: any): Promise<any> {
  if (!args.agent_type) {
    return formatToolError('agent_type is required for delete action.');
  }
  await state.client.deleteWorkspaceAgent(args.agent_type, {
    scope: args.scope,
  });
  return formatJsonResult({ ok: true, deleted: args.agent_type });
}
