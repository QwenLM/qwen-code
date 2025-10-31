/**
 * Configuration types for SDK
 */

import type { ToolDefinition as ToolDef } from './mcp.js';
import type { PermissionMode } from './protocol.js';

export type { ToolDef as ToolDefinition };
export type { PermissionMode };

/**
 * Permission callback function
 * Called before each tool execution to determine if it should be allowed
 *
 * @param toolName - Name of the tool being executed
 * @param input - Input parameters for the tool
 * @param options - Additional options (signal for cancellation, suggestions)
 * @returns Promise<boolean|unknown> or boolean|unknown - true to allow, false to deny, or custom response
 */
export type PermissionCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options?: {
    signal?: AbortSignal;
    suggestions?: unknown;
  },
) => Promise<boolean | unknown> | boolean | unknown;

/**
 * Hook callback function
 * Called at specific points in tool execution lifecycle
 *
 * @param input - Hook input data
 * @param toolUseId - Tool execution ID (null if not associated with a tool)
 * @param options - Options including abort signal
 * @returns Promise with hook result
 */
export type HookCallback = (
  input: unknown,
  toolUseId: string | null,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/**
 * Hook matcher configuration
 */
export interface HookMatcher {
  matcher: Record<string, unknown>;
  hooks: HookCallback[];
}

/**
 * Hook configuration by event type
 */
export type HookConfig = {
  [event: string]: HookMatcher[];
};

/**
 * External MCP server configuration (spawned by CLI)
 */
export type ExternalMcpServerConfig = {
  /** Command to execute (e.g., 'mcp-server-filesystem') */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
};

/**
 * Options for creating a Query instance
 */
export type CreateQueryOptions = {
  // Basic configuration
  /** Working directory for CLI execution */
  cwd?: string;
  /** Model name (e.g., 'qwen-2.5-coder-32b-instruct') */
  model?: string;

  // Transport configuration
  /** Path to qwen executable (auto-detected if omitted) */
  pathToQwenExecutable?: string;
  /** Environment variables for CLI process */
  env?: Record<string, string>;

  // Permission control
  /** Permission mode ('default' | 'plan' | 'auto-edit' | 'yolo') */
  permissionMode?: PermissionMode;
  /** Callback invoked before each tool execution */
  canUseTool?: PermissionCallback;

  // Hook system
  /** Hook configuration for tool execution lifecycle */
  hooks?: HookConfig;

  // MCP server configuration
  /** External MCP servers (spawned by CLI) */
  mcpServers?: Record<string, ExternalMcpServerConfig>;
  /** SDK-embedded MCP servers (run in Node.js process) */
  sdkMcpServers?: Record<
    string,
    { connect: (transport: unknown) => Promise<void> }
  >; // Server from @modelcontextprotocol/sdk

  // Conversation mode
  /**
   * Single-turn mode: automatically close input after receiving result
   * Multi-turn mode: keep input open for follow-up messages
   * @default false (multi-turn)
   */
  singleTurn?: boolean;

  // Advanced options
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
  /** Enable debug output (inherits stderr) */
  debug?: boolean;
  /** Callback for stderr output */
  stderr?: (message: string) => void;
};

/**
 * Transport options for ProcessTransport
 */
export type TransportOptions = {
  /** Path to qwen executable */
  pathToQwenExecutable: string;
  /** Working directory for CLI execution */
  cwd?: string;
  /** Model name */
  model?: string;
  /** Permission mode */
  permissionMode?: PermissionMode;
  /** External MCP servers */
  mcpServers?: Record<string, ExternalMcpServerConfig>;
  /** Environment variables */
  env?: Record<string, string>;
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
  /** Enable debug output */
  debug?: boolean;
  /** Callback for stderr output */
  stderr?: (message: string) => void;
};
