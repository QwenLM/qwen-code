#!/usr/bin/env node
/**
 * Session MCP Server
 *
 * This MCP server provides session-scoped tools to backend runtimes via stdio transport.
 * It uses the shared handlers from @craft-agent/session-tools-core to ensure
 * consistent behavior across transport modes.
 *
 * Callback Communication:
 * Tools that need to communicate with the main Electron process (e.g., SubmitPlan
 * triggering a plan display, OAuth triggers pausing execution) send structured
 * JSON messages to stderr with a "__CALLBACK__" prefix. The main process monitors
 * stderr and handles these callbacks.
 *
 * Usage:
 *   node session-mcp-server.js --session-id <id> --workspace-root <path> --plans-folder <path>
 *
 * Arguments:
 *   --session-id: Unique session identifier
 *   --workspace-root: Path to workspace folder (~/.craft-agent/workspaces/{id})
 *   --plans-folder: Path to session's plans folder
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeveloperFeedbackEnabled } from '@craft-agent/shared/feature-flags';
// Import from session-tools-core
import {
  type SessionToolContext,
  type CallbackMessage,
  type AuthRequest,
  type SourceConfig,
  type LoadedSource,
  type CredentialManagerInterface,
  // Registry
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  // Helpers
  loadSourceConfig as loadSourceConfigFromHelpers,
  errorResponse,
} from '@craft-agent/session-tools-core';

// ============================================================
// Types
// ============================================================

interface SessionConfig {
  sessionId: string;
  workspaceRootPath: string;
  plansFolderPath: string;
  callbackPort?: string;
}

const CALLBACK_TOOL_TIMEOUT_MS = 120000;

// ============================================================
// Callback Communication
// ============================================================

/**
 * Send a callback message to the main process via stderr.
 * These messages are parsed by the main process to trigger UI actions.
 */
function sendCallback(callback: CallbackMessage): void {
  // Write to stderr as a single line JSON (main process parses this)
  console.error(`__CALLBACK__${JSON.stringify(callback)}`);
}

// ============================================================
// Credential Cache Access
// ============================================================

/**
 * Credential cache entry format (matches main process format).
 * Written by Electron main process, read by this server.
 */
interface CredentialCacheEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Get the path to a source's credential cache file.
 * The main process writes decrypted credentials to these files.
 */
function getCredentialCachePath(workspaceRootPath: string, sourceSlug: string): string {
  return join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
}

/**
 * Read credentials from the cache file for a source.
 * Returns null if the cache doesn't exist or is expired.
 */
function readCredentialCache(workspaceRootPath: string, sourceSlug: string): string | null {
  const cachePath = getCredentialCachePath(workspaceRootPath, sourceSlug);

  try {
    if (!existsSync(cachePath)) {
      return null;
    }

    const content = readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(content) as CredentialCacheEntry;

    // Check expiry if set
    if (cache.expiresAt && Date.now() > cache.expiresAt) {
      return null;
    }

    return cache.value || null;
  } catch {
    return null;
  }
}

/**
 * Create a credential manager that reads from credential cache files.
 * This allows the session-mcp-server to access credentials without keychain access.
 */
function createCredentialManager(workspaceRootPath: string): CredentialManagerInterface {
  return {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const token = readCredentialCache(workspaceRootPath, source.config.slug);
      return token !== null;
    },

    getToken: async (source: LoadedSource): Promise<string | null> => {
      return readCredentialCache(workspaceRootPath, source.config.slug);
    },

    refresh: async (_source: LoadedSource): Promise<string | null> => {
      // Cannot refresh from subprocess - would need main process
      return null;
    },
  };
}

// ============================================================
// Session Tool Context Factory
// ============================================================

/**
 * Create a SessionToolContext for the session MCP server.
 * This provides the context needed by all handlers.
 */
function createSessionMcpContext(config: SessionConfig): SessionToolContext {
  const { sessionId, workspaceRootPath, plansFolderPath } = config;

  // File system implementation
  const fs = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callback implementation using stderr
  const callbacks = {
    onPlanSubmitted: (planPath: string) => {
      sendCallback({
        __callback__: 'plan_submitted',
        sessionId,
        planPath,
      });
    },
    onAuthRequest: (request: AuthRequest) => {
      sendCallback({
        __callback__: 'auth_request',
        ...request,
      });
    },
  };

  // Create credential manager that reads from cache files
  const credentialManager = createCredentialManager(workspaceRootPath);

  // Session paths for transform_data / render_template
  const sessionsDir = join(workspaceRootPath, 'sessions', sessionId);
  const sessionDataDir = join(sessionsDir, 'data');

  // Build context
  return {
    sessionId,
    workspacePath: workspaceRootPath,
    get sourcesPath() { return join(workspaceRootPath, 'sources'); },
    get skillsPath() { return join(workspaceRootPath, 'skills'); },
    plansFolderPath,
    sessionPath: sessionsDir,
    dataPath: sessionDataDir,
    callbacks,
    fs,
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      return loadSourceConfigFromHelpers(workspaceRootPath, sourceSlug);
    },

    // Credential manager reads from cache files written by main process
    credentialManager,

    // Preferences: write directly to preferences.json
    updatePreferences: (updates: Record<string, unknown>) => {
      // Resolve preferences path from config dir (parent of workspaces dir)
      // workspaceRootPath = ~/.craft-agent/workspaces/{id}
      // preferencesPath = ~/.craft-agent/preferences.json
      const configDir = join(workspaceRootPath, '..', '..');
      const prefsPath = join(configDir, 'preferences.json');
      try {
        let current: Record<string, unknown> = {};
        if (existsSync(prefsPath)) {
          current = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        }
        const merged = {
          ...current,
          ...updates,
          location: updates.location
            ? { ...(current.location as Record<string, unknown> || {}), ...(updates.location as Record<string, unknown>) }
            : current.location,
          updatedAt: Date.now(),
        };
        writeFileSync(prefsPath, JSON.stringify(merged, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to update preferences:', err);
      }
    },

    // Developer feedback: write one JSON file per entry to {configDir}/feedback/
    submitFeedback: (feedback) => {
      const configDir = process.env.CRAFT_CONFIG_DIR || join(workspaceRootPath, '..', '..');
      const feedbackDir = join(configDir, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
    },

    // Note: saveSourceConfig, validators, renderMermaid
    // are not available in subprocess context (require main-process internals)
  };
}

// ============================================================
// Tool Definitions (from canonical registry)
// ============================================================

function createSessionTools(includeDeveloperFeedback: boolean): Tool[] {
  return getToolDefsAsJsonSchema({
    includeDeveloperFeedback,
  }).map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema as Tool['inputSchema'],
  }));
}

// ============================================================
// Qwen Code Docs Upstream Proxy
// ============================================================

const DOCS_MCP_URL = 'https://agents.craft.do/docs/mcp';

/** Cached upstream client + tool list */
let docsClient: Client | null = null;
let docsTools: Tool[] = [];

/**
 * Connect to the craft-agents-docs MCP server and fetch its tool definitions.
 * Falls back gracefully if the server is unreachable (tools will just be empty).
 */
async function connectDocsUpstream(): Promise<void> {
  try {
    const client = new Client(
      { name: 'craft-agent-session-proxy', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(DOCS_MCP_URL));
    await client.connect(transport);

    const result = await client.listTools();
    docsTools = (result.tools || []) as Tool[];
    docsClient = client;

    console.error(`Qwen Code Docs proxy connected: ${docsTools.length} tools`);
  } catch (err) {
    console.error(`Qwen Code Docs proxy connection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    docsClient = null;
    docsTools = [];
  }
}

/**
 * Route a tool call to the upstream docs client.
 */
async function callDocsUpstream(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!docsClient) {
    return errorResponse(`Qwen Code Docs server is not connected. Tool '${name}' unavailable.`);
  }

  try {
    const result = await docsClient.callTool({ name, arguments: args });
    // Convert MCP result to our format
    const textContent = (result.content as Array<{ type: string; text?: string }> || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => ({ type: 'text' as const, text: c.text! }));

    return {
      content: textContent.length > 0 ? textContent : [{ type: 'text', text: '(No response from docs server)' }],
      isError: result.isError as boolean | undefined,
    };
  } catch (err) {
    return errorResponse(`Docs tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check if a tool name belongs to the docs upstream */
function isDocsUpstreamTool(name: string): boolean {
  return docsTools.some(t => t.name === name);
}

// ============================================================
// call_llm Handler (backend-specific)
// ============================================================

async function handleCallLlm(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse injects _precomputedResult when available.
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`call_llm failed: ${parsed.error}`);
      }
      if (parsed.text !== undefined) {
        return {
          content: [{ type: 'text' as const, text: parsed.text || '(Model returned empty response)' }],
        };
      }
      return errorResponse('call_llm: _precomputedResult has unexpected format (missing text field).');
    } catch {
      return errorResponse(`call_llm: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // Fallback path: HTTP callback to agent.
  // Uses callbackPort from CLI arg (--callback-port) or env var (CRAFT_LLM_CALLBACK_PORT).
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/call-llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as { text?: string; model?: string; error?: string };
      if (result.error) {
        return errorResponse(`call_llm failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: result.text || '(Model returned empty response)' }],
      };
    } catch (err) {
      return errorResponse(`call_llm callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'call_llm requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// spawn_session Handler (backend-specific)
// ============================================================

async function handleSpawnSession(
  args: Record<string, unknown>,
  config: SessionConfig,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Primary path: PreToolUse injects _precomputedResult when available.
  const precomputed = args?._precomputedResult as string | undefined;

  if (precomputed) {
    try {
      const parsed = JSON.parse(precomputed);
      if (parsed.error) {
        return errorResponse(`spawn_session failed: ${parsed.error}`);
      }
      // Return the full result (could be help info or spawn result)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch {
      return errorResponse(`spawn_session: Failed to parse _precomputedResult: ${precomputed.slice(0, 200)}`);
    }
  }

  // Fallback path: HTTP callback to agent.
  if (config.callbackPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${config.callbackPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALLBACK_TOOL_TIMEOUT_MS),
      });
      const result = await resp.json() as Record<string, unknown>;
      if (result.error) {
        return errorResponse(`spawn_session failed: ${result.error}`);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResponse(`spawn_session callback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return errorResponse(
    'spawn_session requires either PreToolUse intercept (_precomputedResult) or ' +
    'HTTP callback (CRAFT_LLM_CALLBACK_PORT). Neither is available.'
  );
}

// ============================================================
// MCP Server Setup
// ============================================================

function setupSignalHandlers(): void {
  const shutdown = (signal: string) => {
    console.error(`Session MCP Server received ${signal}, shutting down gracefully`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in session MCP server:', reason);
  });
}

async function main() {
  setupSignalHandlers();

  // Parse command line arguments
  const args = process.argv.slice(2);
  let sessionId: string | undefined;
  let workspaceRootPath: string | undefined;
  let plansFolderPath: string | undefined;
  let callbackPort: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    } else if (args[i] === '--workspace-root' && args[i + 1]) {
      workspaceRootPath = args[i + 1];
      i++;
    } else if (args[i] === '--plans-folder' && args[i + 1]) {
      plansFolderPath = args[i + 1];
      i++;
    } else if (args[i] === '--callback-port' && args[i + 1]) {
      callbackPort = args[i + 1];
      i++;
    }
  }

  if (!sessionId || !workspaceRootPath || !plansFolderPath) {
    console.error('Usage: session-mcp-server --session-id <id> --workspace-root <path> --plans-folder <path>');
    process.exit(1);
  }

  const config: SessionConfig = {
    sessionId,
    workspaceRootPath,
    plansFolderPath,
    // CLI arg takes priority, env var as fallback.
    callbackPort: callbackPort || process.env.CRAFT_LLM_CALLBACK_PORT,
  };

  // Create the session tool context
  const ctx = createSessionMcpContext(config);

  const includeDeveloperFeedback = isDeveloperFeedbackEnabled();
  const sessionToolRegistry = getSessionToolRegistry({ includeDeveloperFeedback });

  // Create MCP server
  const server = new Server(
    {
      name: 'craft-agent-session',
      version: '0.3.1',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Connect to upstream docs server (non-blocking, best-effort)
  await connectDocsUpstream();

  // Handle tool listing — session tools + docs upstream tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...createSessionTools(includeDeveloperFeedback), ...docsTools],
  }));

  // Handle tool calls — route via canonical registry, call_llm, or docs upstream
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;

    try {
      // call_llm has backend-specific execution (precomputed result / HTTP callback)
      if (name === 'call_llm') {
        return await handleCallLlm(toolArgs as Record<string, unknown>, config);
      }

      // spawn_session has backend-specific execution (precomputed result / HTTP callback)
      if (name === 'spawn_session') {
        return await handleSpawnSession(toolArgs as Record<string, unknown>, config);
      }

      // Check canonical session tool registry first (feature-filtered)
      const def = sessionToolRegistry.get(name);
      if (def?.handler) {
        return await def.handler(ctx, toolArgs);
      }

      // Route to docs upstream if it's a docs tool
      if (isDocsUpstreamTool(name)) {
        return await callDocsUpstream(name, toolArgs as Record<string, unknown>);
      }

      return errorResponse(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResponse(
        `Tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Session MCP Server started for session ${sessionId} (developerFeedback=${includeDeveloperFeedback})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
