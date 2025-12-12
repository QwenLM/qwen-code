import type {
  PermissionMode,
  PermissionSuggestion,
  SubagentConfig,
  SDKMcpServerConfig,
} from './protocol.js';

export type { PermissionMode };

export type TransportOptions = {
  pathToQwenExecutable: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  env?: Record<string, string>;
  abortController?: AbortController;
  debug?: boolean;
  stderr?: (message: string) => void;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  maxSessionTurns?: number;
  coreTools?: string[];
  excludeTools?: string[];
  allowedTools?: string[];
  authType?: string;
  includePartialMessages?: boolean;
};

type ToolInput = Record<string, unknown>;

export type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionSuggestion[] | null;
  },
) => Promise<PermissionResult>;

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput: ToolInput;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    };

/**
 * OAuth configuration for MCP servers
 */
export interface McpOAuthConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  audiences?: string[];
  tokenParamName?: string;
  registrationUrl?: string;
}

/**
 * Auth provider type for MCP servers
 */
export type McpAuthProviderType =
  | 'dynamic_discovery'
  | 'google_credentials'
  | 'service_account_impersonation';

/**
 * CLI MCP Server configuration
 *
 * Supports multiple transport types:
 * - stdio: command, args, env, cwd
 * - SSE: url
 * - Streamable HTTP: httpUrl, headers
 * - WebSocket: tcp
 *
 * This interface aligns with MCPServerConfig in @qwen-code/qwen-code-core.
 */
export interface CLIMcpServerConfig {
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // For SSE transport
  url?: string;
  // For streamable HTTP transport
  httpUrl?: string;
  headers?: Record<string, string>;
  // For WebSocket transport
  tcp?: string;
  // Common
  timeout?: number;
  trust?: boolean;
  // Metadata
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  extensionName?: string;
  // OAuth configuration
  oauth?: McpOAuthConfig;
  authProviderType?: McpAuthProviderType;
  // Service Account Configuration
  /** targetAudience format: CLIENT_ID.apps.googleusercontent.com */
  targetAudience?: string;
  /** targetServiceAccount format: <service-account-name>@<project-num>.iam.gserviceaccount.com */
  targetServiceAccount?: string;
}

/**
 * Unified MCP Server configuration
 *
 * Supports both external MCP servers (stdio/SSE/HTTP/WebSocket) and SDK-embedded MCP servers.
 *
 * @example External MCP server (stdio)
 * ```typescript
 * mcpServers: {
 *   'my-server': { command: 'node', args: ['server.js'] }
 * }
 * ```
 *
 * @example External MCP server (SSE)
 * ```typescript
 * mcpServers: {
 *   'remote-server': { url: 'http://localhost:3000/sse' }
 * }
 * ```
 *
 * @example External MCP server (Streamable HTTP)
 * ```typescript
 * mcpServers: {
 *   'http-server': { httpUrl: 'http://localhost:3000/mcp', headers: { 'Authorization': 'Bearer token' } }
 * }
 * ```
 *
 * @example SDK MCP server
 * ```typescript
 * const server = createSdkMcpServer('weather', '1.0.0', [weatherTool]);
 * mcpServers: {
 *   'weather': { type: 'sdk', name: 'weather', instance: server }
 * }
 * ```
 */
export type McpServerConfig = CLIMcpServerConfig | SDKMcpServerConfig;

/**
 * Type guard to check if a config is an SDK MCP server
 */
export function isSdkMcpServerConfig(
  config: McpServerConfig,
): config is SDKMcpServerConfig {
  return 'type' in config && config.type === 'sdk';
}

/**
 * Configuration options for creating a query session with the Qwen CLI.
 */
export interface QueryOptions {
  /**
   * The working directory for the query session.
   * This determines the context in which file operations and commands are executed.
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * The AI model to use for the query session.
   * This takes precedence over the environment variables `OPENAI_MODEL` and `QWEN_MODEL`
   * @example 'qwen-max', 'qwen-plus', 'qwen-turbo'
   */
  model?: string;

  /**
   * Path to the Qwen CLI executable or runtime specification.
   *
   * Supports multiple formats:
   * - 'qwen' -> native binary (auto-detected from PATH)
   * - '/path/to/qwen' -> native binary (explicit path)
   * - '/path/to/cli.js' -> Node.js bundle (default for .js files)
   * - '/path/to/index.ts' -> TypeScript source (requires tsx)
   * - 'bun:/path/to/cli.js' -> Force Bun runtime
   * - 'node:/path/to/cli.js' -> Force Node.js runtime
   * - 'tsx:/path/to/index.ts' -> Force tsx runtime
   * - 'deno:/path/to/cli.ts' -> Force Deno runtime
   *
   * If not provided, the SDK will auto-detect the native binary in this order:
   * 1. QWEN_CODE_CLI_PATH environment variable
   * 2. ~/.volta/bin/qwen
   * 3. ~/.npm-global/bin/qwen
   * 4. /usr/local/bin/qwen
   * 5. ~/.local/bin/qwen
   * 6. ~/node_modules/.bin/qwen
   * 7. ~/.yarn/bin/qwen
   *
   * The .ts files are only supported for debugging purposes.
   *
   * @example 'qwen'
   * @example '/usr/local/bin/qwen'
   * @example 'tsx:/path/to/packages/cli/src/index.ts'
   */
  pathToQwenExecutable?: string;

  /**
   * Environment variables to pass to the Qwen CLI process.
   * These variables will be merged with the current process environment.
   */
  env?: Record<string, string>;

  /**
   * Permission mode controlling how the SDK handles tool execution approval.
   *
   * - 'default': Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`.
   *   Read-only tools execute without confirmation.
   * - 'plan': Blocks all write tools, instructing AI to present a plan first.
   *   Read-only tools execute normally.
   * - 'auto-edit': Auto-approve edit tools (edit, write_file) while other tools require confirmation.
   * - 'yolo': All tools execute automatically without confirmation.
   *
   * **Priority Chain (highest to lowest):**
   * 1. `excludeTools` - Blocks tools completely (returns permission error)
   * 2. `permissionMode: 'plan'` - Blocks non-read-only tools (except exit_plan_mode)
   * 3. `permissionMode: 'yolo'` - Auto-approves all tools
   * 4. `allowedTools` - Auto-approves matching tools
   * 5. `canUseTool` callback - Custom approval logic
   * 6. Default behavior - Auto-deny in SDK mode
   *
   * @default 'default'
   * @see canUseTool For custom permission handling
   * @see allowedTools For auto-approving specific tools
   * @see excludeTools For blocking specific tools
   */
  permissionMode?: 'default' | 'plan' | 'auto-edit' | 'yolo';

  /**
   * Custom permission handler for tool execution approval.
   *
   * This callback is invoked when a tool requires confirmation and allows you to
   * programmatically approve or deny execution. It acts as a fallback after
   * `allowedTools` check but before default denial.
   *
   * **When is this called?**
   * - Only for tools requiring confirmation (write operations, shell commands, etc.)
   * - After `excludeTools` and `allowedTools` checks
   * - Not called in 'yolo' mode or 'plan' mode
   * - Not called for tools already in `allowedTools`
   *
   * **Usage with permissionMode:**
   * - 'default': Invoked for all write tools not in `allowedTools`; if not provided, auto-denied.
   * - 'auto-edit': Invoked for non-edit tools (edit/write_file auto-approved); if not provided, auto-denied.
   * - 'plan': Not invoked; write tools are blocked by plan mode.
   * - 'yolo': Not invoked; all tools auto-approved.
   *
   * @see allowedTools For auto-approving tools without callback
   */
  canUseTool?: CanUseTool;

  /**
   * MCP (Model Context Protocol) servers to connect to.
   *
   * Supports both external MCP servers and SDK-embedded MCP servers:
   *
   * **External MCP servers** - Run in separate processes, connected via stdio/SSE/HTTP:
   * ```typescript
   * mcpServers: {
   *   'stdio-server': { command: 'node', args: ['server.js'], env: { PORT: '3000' } },
   *   'sse-server': { url: 'http://localhost:3000/sse' },
   *   'http-server': { httpUrl: 'http://localhost:3000/mcp' }
   * }
   * ```
   *
   * **SDK MCP servers** - Run in the SDK process, connected via in-memory transport:
   * ```typescript
   * const myTool = tool({
   *   name: 'my_tool',
   *   description: 'My custom tool',
   *   inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
   *   handler: async (input) => ({ result: input.input.toUpperCase() }),
   * });
   *
   * const server = createSdkMcpServer('my-server', '1.0.0', [myTool]);
   *
   * mcpServers: {
   *   'my-server': { type: 'sdk', name: 'my-server', instance: server }
   * }
   * ```
   */
  mcpServers?: Record<string, McpServerConfig>;

  /**
   * AbortController to cancel the query session.
   * Call abortController.abort() to terminate the session and cleanup resources.
   * Remember to handle the AbortError when the session is aborted.
   */
  abortController?: AbortController;

  /**
   * Enable debug mode for verbose logging.
   * When true, additional diagnostic information will be output.
   * Use this with `logLevel` to control the verbosity of the logs.
   * @default false
   */
  debug?: boolean;

  /**
   * Custom handler for stderr output from the Qwen CLI process.
   * Use this to capture and process error messages or diagnostic output.
   */
  stderr?: (message: string) => void;

  /**
   * Logging level for the SDK.
   * Controls the verbosity of log messages output by the SDK.
   * @default 'error'
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';

  /**
   * Maximum number of conversation turns before the session automatically terminates.
   * A turn consists of a user message and an assistant response.
   * @default -1 (unlimited)
   */
  maxSessionTurns?: number;

  /**
   * Equivalent to `tool.core` in settings.json.
   * List of core tools to enable for the session.
   * If specified, only these tools will be available to the AI.
   * @example ['read_file', 'write_file', 'run_terminal_cmd']
   */
  coreTools?: string[];

  /**
   * Equivalent to `tool.exclude` in settings.json.
   * List of tools to exclude from the session.
   *
   * **Behavior:**
   * - Excluded tools return a permission error immediately when invoked
   * - Takes highest priority - overrides all other permission settings
   * - Tools will not be available to the AI, even if in `coreTools` or `allowedTools`
   *
   * **Pattern matching:**
   * - Tool name: `'write_file'`, `'run_shell_command'`
   * - Tool class: `'WriteTool'`, `'ShellTool'`
   * - Shell command prefix: `'ShellTool(git commit)'` (matches commands starting with "git commit")
   *
   * @example ['run_terminal_cmd', 'delete_file', 'ShellTool(rm )']
   * @see allowedTools For allowing specific tools
   */
  excludeTools?: string[];

  /**
   * Equivalent to `tool.allowed` in settings.json.
   * List of tools that are allowed to run without confirmation.
   *
   * **Behavior:**
   * - Matching tools bypass `canUseTool` callback and execute automatically
   * - Only applies when tool requires confirmation (write operations, shell commands)
   * - Checked after `excludeTools` but before `canUseTool` callback
   * - Does not override `permissionMode: 'plan'` (plan mode blocks all write tools)
   * - Has no effect in `permissionMode: 'yolo'` (already auto-approved)
   *
   * **Pattern matching:**
   * - Tool name: `'write_file'`, `'run_shell_command'`
   * - Tool class: `'WriteTool'`, `'ShellTool'`
   * - Shell command prefix: `'ShellTool(git status)'` (matches commands starting with "git status")
   *
   * **Use cases:**
   * - Auto-approve safe shell commands: `['ShellTool(git status)', 'ShellTool(ls)']`
   * - Auto-approve specific tools: `['write_file', 'edit']`
   * - Combine with `permissionMode: 'default'` to selectively auto-approve tools
   *
   * @example ['read_file', 'ShellTool(git status)', 'ShellTool(npm test)']
   * @see canUseTool For custom approval logic
   * @see excludeTools For blocking specific tools
   */
  allowedTools?: string[];

  /**
   * Authentication type for the AI service.
   * - 'openai': Use OpenAI-compatible authentication
   * - 'qwen-oauth': Use Qwen OAuth authentication
   *
   * Though we support 'qwen-oauth', it's not recommended to use it in the SDK.
   * Because the credentials are stored in `~/.qwen` and may need to refresh periodically.
   */
  authType?: 'openai' | 'qwen-oauth';

  /**
   * Configuration for subagents that can be invoked during the session.
   * Subagents are specialized AI agents that can handle specific tasks or domains.
   * The invocation is marked as a `task` tool use with the name of agent and a tool_use_id.
   * The tool use of these agent is marked with the parent_tool_use_id of the `task` tool use.
   */
  agents?: SubagentConfig[];

  /**
   * Include partial messages in the response stream.
   * When true, the SDK will emit incomplete messages as they are being generated,
   * allowing for real-time streaming of the AI's response.
   * @default false
   */
  includePartialMessages?: boolean;

  /**
   * Timeout configuration for various SDK operations.
   * All values are in milliseconds.
   */
  timeout?: {
    /**
     * Timeout for the `canUseTool` callback.
     * If the callback doesn't resolve within this time, the permission request
     * will be denied with a timeout error (fail-safe behavior).
     * @default 60000 (1 minute)
     */
    canUseTool?: number;

    /**
     * Timeout for SDK MCP tool calls.
     * This applies to tool calls made to SDK-embedded MCP servers.
     * @default 60000 (1 minute)
     */
    mcpRequest?: number;

    /**
     * Timeout for SDK→CLI control requests.
     * This applies to internal control operations like initialize, interrupt,
     * setPermissionMode, setModel, etc.
     * @default 60000 (1 minute)
     */
    controlRequest?: number;

    /**
     * Timeout for waiting before closing CLI's stdin after user messages are sent.
     * In multi-turn mode with SDK MCP servers, after all user messages are processed,
     * the SDK waits for the first result message to ensure all initialization
     * (control responses, MCP server setup, etc.) is complete before closing stdin.
     * This timeout is a fallback to avoid hanging indefinitely.
     * @default 60000 (1 minute)
     */
    streamClose?: number;
  };
}
