/**
 * Zod schemas for QueryOptions validation
 */

import { z } from 'zod';
import type { CanUseTool } from './config.js';

/**
 * Schema for external MCP server configuration
 */
export const ExternalMcpServerConfigSchema = z.object({
  command: z.string().min(1, 'Command must be a non-empty string'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * Schema for SDK-embedded MCP server configuration
 */
export const SdkMcpServerConfigSchema = z.object({
  connect: z.custom<(transport: unknown) => Promise<void>>(
    (val) => typeof val === 'function',
    { message: 'connect must be a function' },
  ),
});

/**
 * Schema for QueryOptions
 */
export const QueryOptionsSchema = z
  .object({
    cwd: z.string().optional(),
    model: z.string().optional(),
    pathToQwenExecutable: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    permissionMode: z.enum(['default', 'plan', 'auto-edit', 'yolo']).optional(),
    canUseTool: z
      .custom<CanUseTool>((val) => typeof val === 'function', {
        message: 'canUseTool must be a function',
      })
      .optional(),
    mcpServers: z.record(z.string(), ExternalMcpServerConfigSchema).optional(),
    sdkMcpServers: z.record(z.string(), SdkMcpServerConfigSchema).optional(),
    abortController: z.instanceof(AbortController).optional(),
    debug: z.boolean().optional(),
    stderr: z
      .custom<
        (message: string) => void
      >((val) => typeof val === 'function', { message: 'stderr must be a function' })
      .optional(),
    maxSessionTurns: z.number().optional(),
    coreTools: z.array(z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
    authType: z.enum(['openai', 'qwen-oauth']).optional(),
  })
  .strict();

/**
 * Inferred TypeScript types from schemas
 */
export type ExternalMcpServerConfig = z.infer<
  typeof ExternalMcpServerConfigSchema
>;
export type QueryOptions = z.infer<typeof QueryOptionsSchema>;
