/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import { handler, daemonFetch } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function workspaceReadTools(state: BridgeState): any[] {
  return [
    tool(
      'file_read',
      'Read a text file from the workspace. Returns content and SHA-256 hash.',
      {
        path: z.string().describe('File path (relative to workspace root).'),
        max_bytes: z.number().optional().describe('Maximum bytes to read.'),
        line: z.number().optional().describe('Starting line number.'),
        limit: z.number().optional().describe('Number of lines to read.'),
      },
      handler(async (args) => {
        const result = await state.client.readWorkspaceFile(args.path, {
          maxBytes: args.max_bytes,
          line: args.line,
          limit: args.limit,
        });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'file_read_bytes',
      'Read raw bytes from a file as base64. For binary or bounded reads.',
      {
        path: z.string().describe('File path (relative to workspace root).'),
        offset: z.number().optional().describe('Byte offset to start reading.'),
        max_bytes: z.number().optional().describe('Maximum bytes to read.'),
      },
      handler(async (args) => {
        const result = await state.client.readWorkspaceFileBytes(args.path, {
          offset: args.offset,
          maxBytes: args.max_bytes,
        });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'file_stat',
      'Get file or directory metadata (size, timestamps, type).',
      {
        path: z.string().describe('File path to stat.'),
      },
      handler(async (args) => {
        const result = await daemonFetch(state, '/stat', { path: args.path });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'dir_list',
      'List files and directories in a workspace directory (max 2000 entries).',
      {
        path: z.string().describe('Directory path to list.'),
      },
      handler(async (args) => {
        const result = await daemonFetch(state, '/list', { path: args.path });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'glob',
      'Find files matching a glob pattern in the workspace (max 5000 results).',
      {
        pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js").'),
      },
      handler(async (args) => {
        const result = await daemonFetch(state, '/glob', { pattern: args.pattern });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'workspace_mcp_status',
      'Get MCP server status including discovery state, server list, budgets.',
      {},
      handler(async () => {
        return formatJsonResult(await state.client.workspaceMcp());
      }),
    ),

    tool(
      'workspace_skills',
      'List available skills in the workspace.',
      {},
      handler(async () => {
        return formatJsonResult(await state.client.workspaceSkills());
      }),
    ),

    tool(
      'workspace_providers',
      'Get model provider status including current provider and available models.',
      {},
      handler(async () => {
        return formatJsonResult(await state.client.workspaceProviders());
      }),
    ),

    tool(
      'workspace_env',
      'Get daemon runtime environment snapshot (platform, sandbox, proxy, env var presence). Never leaks secret values.',
      {},
      handler(async () => {
        return formatJsonResult(await state.client.workspaceEnv());
      }),
    ),

    tool(
      'workspace_preflight',
      'Run readiness checks. Daemon-level cells always populated; ACP-level cells show not_started when idle.',
      {},
      handler(async () => {
        return formatJsonResult(await state.client.workspacePreflight());
      }),
    ),
  ];
}
