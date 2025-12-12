import { z } from 'zod';
import type { CanUseTool } from './types.js';
import type { SubagentConfig } from './protocol.js';

/**
 * OAuth configuration for MCP servers
 */
export const McpOAuthConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    clientId: z
      .string()
      .min(1, 'clientId must be a non-empty string')
      .optional(),
    clientSecret: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    redirectUri: z.string().optional(),
    authorizationUrl: z.string().optional(),
    tokenUrl: z.string().optional(),
    audiences: z.array(z.string()).optional(),
    tokenParamName: z.string().optional(),
    registrationUrl: z.string().optional(),
  })
  .strict();

/**
 * CLI MCP Server configuration schema
 *
 * Supports multiple transport types:
 * - stdio: command, args, env, cwd
 * - SSE: url
 * - Streamable HTTP: httpUrl, headers
 * - WebSocket: tcp
 */
export const CLIMcpServerConfigSchema = z.object({
  // For stdio transport
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  // For SSE transport
  url: z.string().optional(),
  // For streamable HTTP transport
  httpUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // For WebSocket transport
  tcp: z.string().optional(),
  // Common
  timeout: z.number().optional(),
  trust: z.boolean().optional(),
  // Metadata
  description: z.string().optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
  extensionName: z.string().optional(),
  // OAuth configuration
  oauth: McpOAuthConfigSchema.optional(),
  authProviderType: z
    .enum([
      'dynamic_discovery',
      'google_credentials',
      'service_account_impersonation',
    ])
    .optional(),
  // Service Account Configuration
  targetAudience: z.string().optional(),
  targetServiceAccount: z.string().optional(),
});

/**
 * SDK MCP Server configuration schema
 */
export const SdkMcpServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string().min(1, 'name must be a non-empty string'),
  instance: z.custom<{
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  }>(
    (val) =>
      val &&
      typeof val === 'object' &&
      'connect' in val &&
      typeof val.connect === 'function',
    { message: 'instance must be an MCP Server with connect method' },
  ),
});

/**
 * Unified MCP Server configuration schema
 */
export const McpServerConfigSchema = z.union([
  CLIMcpServerConfigSchema,
  SdkMcpServerConfigSchema,
]);

export const ModelConfigSchema = z.object({
  model: z.string().optional(),
  temp: z.number().optional(),
  top_p: z.number().optional(),
});

export const RunConfigSchema = z.object({
  max_time_minutes: z.number().optional(),
  max_turns: z.number().optional(),
});

export const SubagentConfigSchema = z.object({
  name: z.string().min(1, 'Name must be a non-empty string'),
  description: z.string().min(1, 'Description must be a non-empty string'),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().min(1, 'System prompt must be a non-empty string'),
  modelConfig: ModelConfigSchema.partial().optional(),
  runConfig: RunConfigSchema.partial().optional(),
  color: z.string().optional(),
  isBuiltin: z.boolean().optional(),
});

export const TimeoutConfigSchema = z.object({
  canUseTool: z.number().positive().optional(),
  mcpRequest: z.number().positive().optional(),
  controlRequest: z.number().positive().optional(),
  streamClose: z.number().positive().optional(),
});

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
    mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
    abortController: z.instanceof(AbortController).optional(),
    debug: z.boolean().optional(),
    stderr: z
      .custom<
        (message: string) => void
      >((val) => typeof val === 'function', { message: 'stderr must be a function' })
      .optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    maxSessionTurns: z.number().optional(),
    coreTools: z.array(z.string()).optional(),
    excludeTools: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    authType: z.enum(['openai', 'qwen-oauth']).optional(),
    agents: z
      .array(
        z.custom<SubagentConfig>(
          (val) =>
            val &&
            typeof val === 'object' &&
            'name' in val &&
            'description' in val &&
            'systemPrompt' in val && {
              message: 'agents must be an array of SubagentConfig objects',
            },
        ),
      )
      .optional(),
    includePartialMessages: z.boolean().optional(),
    timeout: TimeoutConfigSchema.optional(),
  })
  .strict();
