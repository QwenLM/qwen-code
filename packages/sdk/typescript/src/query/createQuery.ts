/**
 * Factory function for creating Query instances.
 */

import type { CLIUserMessage } from '../types/protocol.js';
import { serializeJsonLine } from '../utils/jsonLines.js';
import type {
  CreateQueryOptions,
  PermissionMode,
  PermissionCallback,
  ExternalMcpServerConfig,
} from '../types/config.js';
import { ProcessTransport } from '../transport/ProcessTransport.js';
import { resolveCliPath, parseExecutableSpec } from '../utils/cliPath.js';
import { Query } from './Query.js';

/**
 * Configuration options for creating a Query.
 */
export type QueryOptions = {
  cwd?: string;
  model?: string;
  pathToQwenExecutable?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
  canUseTool?: PermissionCallback;
  mcpServers?: Record<string, ExternalMcpServerConfig>;
  sdkMcpServers?: Record<
    string,
    { connect: (transport: unknown) => Promise<void> }
  >;
  signal?: AbortSignal;
  debug?: boolean;
  stderr?: (message: string) => void;
};

/**
 * Create a Query instance for interacting with the Qwen CLI.
 *
 * Supports both single-turn (string) and multi-turn (AsyncIterable) prompts.
 *
 * @example
 * ```typescript
 * const q = query({
 *   prompt: 'What files are in this directory?',
 *   options: { cwd: process.cwd() },
 * });
 *
 * for await (const msg of q) {
 *   if (msg.type === 'assistant') {
 *     console.log(msg.message.content);
 *   }
 * }
 * ```
 */
export function query({
  prompt,
  options = {},
}: {
  prompt: string | AsyncIterable<CLIUserMessage>;
  options?: QueryOptions;
}): Query {
  // Validate options
  validateOptions(options);

  // Determine if this is a single-turn or multi-turn query
  // Single-turn: string prompt (simple Q&A)
  // Multi-turn: AsyncIterable prompt (streaming conversation)
  const isSingleTurn = typeof prompt === 'string';

  // Build CreateQueryOptions
  const queryOptions: CreateQueryOptions = {
    ...options,
    singleTurn: isSingleTurn,
  };

  // Resolve CLI path (auto-detect if not provided)
  const pathToQwenExecutable = resolveCliPath(options.pathToQwenExecutable);

  // Pass signal to transport (it will handle AbortController internally)
  const signal = options.signal;

  // Create transport
  const transport = new ProcessTransport({
    pathToQwenExecutable,
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    mcpServers: options.mcpServers,
    env: options.env,
    signal,
    debug: options.debug,
    stderr: options.stderr,
  });

  // Create Query
  const queryInstance = new Query(transport, queryOptions);

  // Handle prompt based on type
  if (isSingleTurn) {
    // For single-turn queries, send the prompt directly via transport
    const stringPrompt = prompt as string;
    const message: CLIUserMessage = {
      type: 'user',
      session_id: queryInstance.getSessionId(),
      message: {
        role: 'user',
        content: stringPrompt,
      },
      parent_tool_use_id: null,
    };

    // Send message after query is initialized
    (async () => {
      try {
        // Wait a bit for initialization to complete
        await new Promise((resolve) => setTimeout(resolve, 0));
        transport.write(serializeJsonLine(message));
      } catch (err) {
        console.error('[query] Error sending single-turn prompt:', err);
      }
    })();
  } else {
    // For multi-turn queries, stream the input
    queryInstance
      .streamInput(prompt as AsyncIterable<CLIUserMessage>)
      .catch((err) => {
        console.error('[query] Error streaming input:', err);
      });
  }

  return queryInstance;
}

/**
 * Backward compatibility alias
 * @deprecated Use query() instead
 */
export const createQuery = query;

/**
 * Validates query configuration options.
 */
function validateOptions(options: QueryOptions): void {
  // Validate permission mode if provided
  if (options.permissionMode) {
    const validModes = ['default', 'plan', 'auto-edit', 'yolo'];
    if (!validModes.includes(options.permissionMode)) {
      throw new Error(
        `Invalid permissionMode: ${options.permissionMode}. Valid values are: ${validModes.join(', ')}`,
      );
    }
  }

  // Validate canUseTool is a function if provided
  if (options.canUseTool && typeof options.canUseTool !== 'function') {
    throw new Error('canUseTool must be a function');
  }

  // Validate signal is AbortSignal if provided
  if (options.signal && !(options.signal instanceof AbortSignal)) {
    throw new Error('signal must be an AbortSignal instance');
  }

  // Validate executable path early to provide clear error messages
  try {
    parseExecutableSpec(options.pathToQwenExecutable);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pathToQwenExecutable: ${errorMessage}`);
  }

  // Validate no MCP server name conflicts
  if (options.mcpServers && options.sdkMcpServers) {
    const externalNames = Object.keys(options.mcpServers);
    const sdkNames = Object.keys(options.sdkMcpServers);

    const conflicts = externalNames.filter((name) => sdkNames.includes(name));
    if (conflicts.length > 0) {
      throw new Error(
        `MCP server name conflicts between mcpServers and sdkMcpServers: ${conflicts.join(', ')}`,
      );
    }
  }
}
