/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the main Electron process.
 * Backends receive proxy tool definitions
 * and route tool calls through this pool instead of managing MCP connections
 * themselves.
 *
 * Benefits:
 * - One MCP code path for all backends
 * - Shared clients across sessions (e.g., same Linear connection)
 * - No credential cache files — main process has direct access
 * - Runtime source switching without session restart
 */

import { CraftMcpClient, type McpClientConfig, type PoolClient } from './client.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

/**
 * Configuration for an in-process API source server.
 * Used by sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
  type: 'sdk';
  instance: McpServer;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string;
}

/**
 * Convert SdkMcpServerConfig (used by backend types) to CraftMcpClient config.
 */
function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
  if (config.type === 'http' || config.type === 'sse') {
    return {
      transport: 'http',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }
  return null;
}

/**
 * Check if an MCP source's config has changed in a way that requires reconnection.
 * Compares auth headers (token refresh) and URL changes.
 * Ignores stdio sources since they don't use OAuth tokens.
 */
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    if (oldConfig.url !== newConfig.url) return true;
    const oldAuth = oldConfig.headers?.['Authorization'];
    const newAuth = newConfig.headers?.['Authorization'];
    if (oldAuth !== newAuth) return true;
  }

  return false;
}

export class McpClientPool {
  /** Active MCP clients keyed by source slug */
  private clients = new Map<string, PoolClient>();

  /** Configs used for active MCP connections (for change detection during sync) */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /** Cached tool lists keyed by source slug */
  private toolCache = new Map<string, Tool[]>();

  /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
  private proxyTools = new Map<string, { slug: string; originalName: string }>();

  /** Optional debug logger */
  private debugFn: ((msg: string) => void) | undefined;

  /** Workspace root path for local MCP filtering */
  private workspaceRootPath?: string;

  /** Session storage path for saving large responses */
  private sessionPath?: string;

  /** Summarize callback for large response handling */
  private summarizeCallback?: (prompt: string) => Promise<string | null>;

  /** Called after sync() connects/disconnects sources, so clients can be notified */
  onToolsChanged?: () => void;

  constructor(options?: { debug?: (msg: string) => void; workspaceRootPath?: string; sessionPath?: string }) {
    this.debugFn = options?.debug;
    this.workspaceRootPath = options?.workspaceRootPath;
    this.sessionPath = options?.sessionPath;
  }

  /**
   * Set the summarize callback for large response handling.
   * Typically called after agent creation: pool.setSummarizeCallback(agent.getSummarizeCallback())
   */
  setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
    this.summarizeCallback = fn;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpClientPool] ${msg}`);
  }

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for both CraftMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    this.clients.set(slug, client);
    this.toolCache.set(slug, tools);

    for (const tool of tools) {
      const proxyName = `mcp__${slug}__${tool.name}`;
      this.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }

    this.debug(`Connected source ${slug}: ${tools.length} tools`);
  }

  /**
   * Connect to an MCP source server (remote HTTP/SSE/stdio).
   * If already connected, this is a no-op.
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (this.clients.has(slug)) return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    await this.registerClient(slug, new CraftMcpClient(clientConfig));
    this.activeConfigs.set(slug, config);
  }

  /**
   * Connect to an in-process MCP server (API source) via in-memory transport.
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    if (this.clients.has(slug)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer));
  }

  /**
   * Disconnect a source and remove its tools from the pool.
   */
  async disconnect(slug: string): Promise<void> {
    const client = this.clients.get(slug);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(slug);
    }

    // Remove proxy tool entries for this slug
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName);
    }
    this.toolCache.delete(slug);
    this.activeConfigs.delete(slug);
    this.debug(`Disconnected source: ${slug}`);
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map(c => c.close().catch(() => {}));
    await Promise.all(closePromises);
    this.clients.clear();
    this.toolCache.clear();
    this.proxyTools.clear();
    this.activeConfigs.clear();
    this.debug('Disconnected all MCP clients');
  }

  // ============================================================
  // Sync: Reconcile active sources
  // ============================================================

  /**
   * Sync the pool to match a desired set of MCP + API sources.
   * Connects new sources, disconnects removed ones, keeps existing ones.
   *
   * @param mcpServers - Map of slug → config for desired MCP sources
   * @param apiServers - Map of slug → config for desired API sources
   * @returns List of slugs that failed to connect
   */
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {}
  ): Promise<string[]> {
    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        continue;
      }
      filteredMcp[slug] = config;
    }

    // Extract McpServer instances from API configs
    const apiSlugs = new Map<string, McpServer>();
    for (const [slug, config] of Object.entries(apiServers)) {
      if (config?.type === 'sdk' && config.instance) {
        apiSlugs.set(slug, config.instance);
      }
    }

    const desiredSlugs = new Set([...Object.keys(filteredMcp), ...apiSlugs.keys()]);
    const currentSlugs = new Set(this.clients.keys());
    const failures: string[] = [];

    // Disconnect sources no longer desired
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
      }
    }

    // Connect new MCP sources + reconnect existing ones whose config changed (e.g. refreshed token)
    for (const [slug, config] of Object.entries(filteredMcp)) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connect(slug, config);
        } catch (err) {
          this.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      } else {
        const oldConfig = this.activeConfigs.get(slug);
        if (oldConfig && mcpConfigChanged(oldConfig, config)) {
          this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
          await this.disconnect(slug);
          try {
            await this.connect(slug, config);
          } catch (err) {
            this.debug(`Failed to reconnect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
            failures.push(slug);
          }
        }
      }
    }

    // Connect new API sources
    for (const [slug, server] of apiSlugs) {
      if (!currentSlugs.has(slug)) {
        try {
          await this.connectInProcess(slug, server);
        } catch (err) {
          this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
    }

    this.onToolsChanged?.();
    return failures;
  }

  // ============================================================
  // Tool Discovery
  // ============================================================

  /**
   * Get cached tools for a source. Returns empty array if not connected.
   */
  getTools(slug: string): Tool[] {
    return this.toolCache.get(slug) || [];
  }

  /**
   * Get all connected source slugs.
   */
  getConnectedSlugs(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a source is connected.
   */
  isConnected(slug: string): boolean {
    return this.clients.has(slug);
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys());
    const defs: ProxyToolDef[] = [];

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || [];
      for (const tool of tools) {
        // Strip $schema — AJV (Pi agent) fails on unregistered meta-schema URIs.
        // Same pattern as getToolDefsAsJsonSchema() in tool-defs.ts.
        const { $schema, ...cleanSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        defs.push({
          name: `mcp__${slug}__${tool.name}`,
          description: tool.description || `Tool from ${slug}`,
          inputSchema: Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} },
        });
      }
    }

    return defs;
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   */
  async callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { slug, originalName } = info;

    const client = this.clients.get(slug);
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    try {
      const result = await client.callTool(originalName, args) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>;
        isError?: boolean;
      };

      const contentBlocks = result.content || [];
      const parts: string[] = [];

      // 1. Process each content block — handle text, image, audio
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // Handle non-string text fields (e.g., objects from non-conforming servers)
          if (typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2));
          }
        } else if ((block.type === 'image' || block.type === 'audio') && block.data && this.sessionPath) {
          // Decode base64 binary content and save to downloads/
          try {
            const buffer = Buffer.from(block.data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(this.sessionPath, filename, buffer, block.mimeType ?? null);
            if (saved.type === 'file_download') {
              parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
            }
          } catch {
            // Base64 decode failed — skip this block
          }
        }
      }

      // 2. Combine parts (fallback to JSON.stringify if no content extracted)
      const text = parts.join('\n') || JSON.stringify(result);

      // 3. Centralized binary + large response handling
      if (!result.isError && this.sessionPath) {
        const guarded = await guardLargeResult(text, {
          sessionPath: this.sessionPath,
          toolName: proxyName,
          input: args,
          summarize: this.summarizeCallback,
        });
        if (guarded) {
          return { content: guarded, isError: false };
        }
      }

      return {
        content: text,
        isError: !!result.isError,
      };
    } catch (err) {
      return {
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug,
      };
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool.
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName);
  }
}
