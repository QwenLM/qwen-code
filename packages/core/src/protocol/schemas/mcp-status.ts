/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zod schema for `McpServerStatus` (carried by the `mcp_status` control
 * response). Aligned to `../wire/mcp.ts` via
 * `satisfies z.ZodType<...>`.
 *
 * The MCP server-config sub-types are kept loose for now — the CLI is the
 * authoritative source of these values, so over-strict validation here
 * would just reject legitimate future fields.
 */

import { z } from 'zod';
import type { McpServerStatus as ProtoMcpServerStatus } from '../wire/index.js';
import { lazySchema } from '../utils/lazySchema.js';

const mcpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const mcpSseServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpHttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpSdkServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string(),
});

const mcpClaudeAIProxyServerConfigSchema = z.object({
  type: z.literal('claudeai-proxy'),
  url: z.string(),
  id: z.string(),
});

const mcpServerStatusConfigSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpSseServerConfigSchema,
  mcpHttpServerConfigSchema,
  mcpSdkServerConfigSchema,
  mcpClaudeAIProxyServerConfigSchema,
]);

export const mcpServerStatusSchema = lazySchema(
  () =>
    z.object({
      name: z.string(),
      status: z.enum([
        'connected',
        'failed',
        'needs-auth',
        'pending',
        'disabled',
      ]),
      serverInfo: z
        .object({ name: z.string(), version: z.string() })
        .optional(),
      error: z.string().optional(),
      config: mcpServerStatusConfigSchema.optional(),
      scope: z.string().optional(),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            annotations: z
              .object({
                readOnly: z.boolean().optional(),
                destructive: z.boolean().optional(),
                openWorld: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    }) satisfies z.ZodType<ProtoMcpServerStatus>,
);
