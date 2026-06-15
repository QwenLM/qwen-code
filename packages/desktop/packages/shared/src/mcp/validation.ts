/**
 * MCP Connection Validation
 *
 * Connects directly to the target MCP server, lists tools, and validates
 * schemas before a source is enabled for sessions.
 */

import { spawn, type ChildProcess } from 'child_process';
import { CraftMcpClient } from './client.js';
import { debug } from '../utils/debug.ts';
import { parseError, type AgentError } from '../agent/errors.ts';
import { normalizeMcpUrl } from '../sources/server-builder.ts';
import type { McpTransport } from '../sources/types.ts';

export interface InvalidProperty {
  toolName: string;
  propertyPath: string;
  propertyKey: string;
}

export interface McpValidationResult {
  success: boolean;
  error?: string;
  errorType?: 'failed' | 'needs-auth' | 'pending' | 'invalid-schema' | 'disabled' | 'unknown';
  /** Typed error for API/billing failures - display as ErrorBanner */
  typedError?: AgentError;
  serverInfo?: {
    name: string;
    version: string;
  };
  invalidProperties?: InvalidProperty[];
  /** Tool names available on this server (populated on successful connection) */
  tools?: string[];
}

/**
 * Pattern for valid property names in tool input schemas.
 * Must match: letters, numbers, underscores, dots, hyphens (1-64 chars)
 *
 * Keep schemas conservative so they work across MCP clients and model runtimes.
 */
export const TOOL_PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Recursively finds invalid property names in a JSON schema.
 * Returns an array of invalid properties with their paths.
 */
function findInvalidProperties(
  schema: Record<string, unknown>,
  path = ''
): { path: string; key: string }[] {
  const invalid: { path: string; key: string }[] = [];

  if (!schema || typeof schema !== 'object') {
    return invalid;
  }

  // Check properties object
  if (schema.properties && typeof schema.properties === 'object') {
    const properties = schema.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (!TOOL_PROPERTY_NAME_PATTERN.test(key)) {
        invalid.push({
          path: path ? `${path}.${key}` : key,
          key,
        });
      }
      // Recurse into nested schemas
      const nestedSchema = properties[key];
      if (nestedSchema && typeof nestedSchema === 'object') {
        invalid.push(
          ...findInvalidProperties(
            nestedSchema as Record<string, unknown>,
            path ? `${path}.${key}` : key
          )
        );
      }
    }
  }

  // Check items for arrays
  if (schema.items && typeof schema.items === 'object') {
    invalid.push(
      ...findInvalidProperties(
        schema.items as Record<string, unknown>,
        path ? `${path}[]` : '[]'
      )
    );
  }

  // Check additionalProperties if it's a schema object
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    invalid.push(
      ...findInvalidProperties(
        schema.additionalProperties as Record<string, unknown>,
        path ? `${path}.<additionalProperties>` : '<additionalProperties>'
      )
    );
  }

  return invalid;
}

export interface McpValidationConfig {
  /** MCP server URL */
  mcpUrl: string;
  /** Transport type ('http' or 'sse'). Defaults to 'http'. */
  mcpTransport?: McpTransport;
  /** Custom headers for MCP requests (merged before auth headers) */
  mcpHeaders?: Record<string, string>;
  /** Access token for MCP server (OAuth or bearer) */
  mcpAccessToken?: string;
}

/**
 * Validates an MCP connection by opening a direct MCP client and listing tools.
 */
export async function validateMcpConnection(
  config: McpValidationConfig
): Promise<McpValidationResult> {
  debug('Validating MCP connection to', config.mcpUrl);
  const mcpUrl = normalizeMcpUrl(config.mcpUrl);
  const headers = {
    ...config.mcpHeaders,
    ...(config.mcpAccessToken ? { Authorization: `Bearer ${config.mcpAccessToken}` } : {}),
  };
  const mcpClient = new CraftMcpClient({
    transport: 'http',
    url: mcpUrl,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  try {
    const tools = await mcpClient.listTools();
    const toolNames = tools.map((t) => t.name);
    const allInvalidProperties: InvalidProperty[] = [];

    debug(`Validating schemas for ${tools.length} tools`);

    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(tool.inputSchema as Record<string, unknown>);
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      const toolsWithIssues = [...new Set(allInvalidProperties.map((p) => p.toolName))];
      return {
        success: false,
        error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
        errorType: 'invalid-schema',
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      tools: toolNames,
    };
  } catch (err) {
    const typedError = parseError(err);
    if (typedError.code !== 'unknown_error') {
      return {
        success: false,
        error: typedError.message,
        errorType: 'unknown',
        typedError,
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Validation failed',
      errorType: 'unknown',
    };
  } finally {
    await mcpClient.close().catch(() => {});
  }
}

export interface StdioValidationConfig {
  /** Command to spawn (e.g., 'npx', 'node') */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the spawned process */
  env?: Record<string, string>;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Validates a stdio MCP connection by spawning the process and listing tools.
 *
 * Unlike HTTP validation, this actually spawns the MCP server process,
 * connects via stdio transport, and validates the available tools.
 */
export async function validateStdioMcpConnection(
  config: StdioValidationConfig
): Promise<McpValidationResult> {
  const { command, args = [], env = {}, timeout = 30000 } = config;

  debug(`[stdio-validation] Spawning: ${command} ${args.join(' ')}`);

  // Dynamically import MCP SDK stdio transport
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  );

  let childProcess: ChildProcess | null = null;
  let client: InstanceType<typeof Client> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let stderrOutput = '';

  const cleanup = async () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
      client = null;
    }
    if (childProcess && !childProcess.killed) {
      // Platform-aware process termination (SIGTERM/SIGKILL don't exist on Windows)
      if (process.platform === 'win32') {
        childProcess.kill();
      } else {
        childProcess.kill('SIGTERM');
      }
      // Force kill after 1s if still alive
      setTimeout(() => {
        if (childProcess && !childProcess.killed) {
          if (process.platform === 'win32') {
            childProcess.kill();
          } else {
            childProcess.kill('SIGKILL');
          }
        }
      }, 1000);
    }
  };

  try {
    // Create promise that rejects on timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Timeout: Process did not respond within ${timeout}ms`));
      }, timeout);
    });

    // Spawn the process
    const spawnPromise = (async () => {
      childProcess = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Capture stderr for error messages
      childProcess.stderr?.on('data', (data) => {
        stderrOutput += data.toString();
        // Limit stderr capture to prevent memory issues
        if (stderrOutput.length > 10000) {
          stderrOutput = stderrOutput.slice(-10000);
        }
      });

      // Handle spawn errors
      const spawnError = await new Promise<Error | null>((resolve) => {
        childProcess!.on('error', (err) => resolve(err));
        // Give spawn a moment to fail
        setTimeout(() => resolve(null), 100);
      });

      if (spawnError) {
        throw spawnError;
      }

      // Check if process exited immediately
      if (childProcess.exitCode !== null) {
        const exitMsg = stderrOutput.trim() || `Process exited with code ${childProcess.exitCode}`;
        throw new Error(exitMsg);
      }

      // Create stdio transport
      // Filter out undefined values from process.env
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          processEnv[key] = value;
        }
      }
      const transport = new StdioClientTransport({
        command,
        args,
        env: { ...processEnv, ...env },
      });

      // Create MCP client
      client = new Client(
        { name: 'craft-agent-validator', version: '1.0.0' },
        { capabilities: {} }
      );

      // Connect to the server
      await client.connect(transport);

      // List available tools
      const toolsResult = await client.listTools();
      const tools = toolsResult.tools || [];
      const toolNames = tools.map((t: { name: string }) => t.name);

      debug(`[stdio-validation] Found ${tools.length} tools`);

      // Validate tool schemas for property naming
      const allInvalidProperties: InvalidProperty[] = [];
      for (const tool of tools) {
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
          const invalidProps = findInvalidProperties(
            tool.inputSchema as Record<string, unknown>
          );
          for (const prop of invalidProps) {
            allInvalidProperties.push({
              toolName: tool.name,
              propertyPath: prop.path,
              propertyKey: prop.key,
            });
          }
        }
      }

      if (allInvalidProperties.length > 0) {
        const toolsWithIssues = [
          ...new Set(allInvalidProperties.map((p) => p.toolName)),
        ];
        return {
          success: false,
          error: `Server has ${allInvalidProperties.length} invalid property name(s) in ${toolsWithIssues.length} tool(s): ${toolsWithIssues.join(', ')}. Property names must match ^[a-zA-Z0-9_.-]{1,64}$`,
          errorType: 'invalid-schema' as const,
          invalidProperties: allInvalidProperties,
          tools: toolNames,
        };
      }

      return {
        success: true,
        tools: toolNames,
        serverInfo: {
          name: command,
          version: args.join(' '),
        },
      };
    })();

    // Race between spawn and timeout
    const result = await Promise.race([spawnPromise, timeoutPromise]);
    return result;
  } catch (err) {
    const error = err as Error;
    debug(`[stdio-validation] Error: ${error.message}`);

    // Determine error type based on error message
    let errorType: McpValidationResult['errorType'] = 'failed';
    let errorMessage = error.message;

    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      errorMessage = `Command not found: "${command}". Install the required dependency and try again.`;
    } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
      errorMessage = `Permission denied running "${command}". Check file permissions.`;
    } else if (error.message.includes('Timeout')) {
      errorMessage = `Server startup timeout. The process may be hanging or waiting for input.`;
    } else if (stderrOutput.trim()) {
      // Include stderr output in error message
      errorMessage = `Process error: ${stderrOutput.trim().split('\n')[0]}`;
    }

    return {
      success: false,
      error: errorMessage,
      errorType,
    };
  } finally {
    await cleanup();
  }
}

/**
 * Get a user-friendly error message based on the validation result.
 * Accepts optional transport context to distinguish local (stdio) vs remote failures.
 */
export function getValidationErrorMessage(
  result: McpValidationResult,
  context?: { transport?: string }
): string {
  if (result.error) return result.error;

  switch (result.errorType) {
    case 'failed':
      // Distinguish local stdio servers (crashed/not running) from remote (unreachable)
      if (context?.transport === 'stdio') {
        return 'Server process not running or failed to start.';
      }
      return 'Server unreachable - check the URL and your network.';
    case 'needs-auth':
      return 'Authentication expired or was revoked.';
    case 'pending':
      return 'Connection is still pending - try again.';
    case 'invalid-schema':
      return 'Server has tools with invalid property names.';
    case 'unknown':
    default:
      return 'Connection failed - check source configuration.';
  }
}
