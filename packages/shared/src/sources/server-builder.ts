/**
 * SourceServerBuilder
 *
 * Builds MCP and API server configurations from LoadedSource objects.
 * This module handles URL normalization and server config creation,
 * but does NOT fetch credentials - credentials are passed in.
 *
 * This replaces SourceService's server building logic with a cleaner
 * separation of concerns:
 * - SourceCredentialManager: handles credentials
 * - SourceServerBuilder: handles server configuration
 */

import type { LoadedSource, ApiConfig } from './types.ts';
import { isMultiHeaderCredential, type ApiCredential } from './credential-manager.ts';
import { isSourceUsable } from './storage.ts';
import { createApiServer, type SummarizeCallback } from './api-tools.ts';
import { createLocalMcpServer } from '../mcp/local-tools.ts';
import { debug } from '../utils/debug.ts';

/**
 * Standard error messages for server build failures.
 * Use these constants instead of string literals to ensure consistent matching.
 */
export const SERVER_BUILD_ERRORS = {
  AUTH_REQUIRED: 'Authentication required',
  CREDENTIALS_NEEDED: 'Credentials needed',
} as const;

/**
 * MCP server configuration used by Qwen and the source pool.
 * Supports HTTP/SSE (remote) and stdio (local subprocess) transports.
 */
export type McpServerConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/**
 * Source with its credential pre-loaded
 */
export interface SourceWithCredential {
  source: LoadedSource;
  /** Token for MCP sources, or ApiCredential for API sources */
  token?: string | null;
  credential?: ApiCredential | null;
}

/**
 * Result of building servers from sources
 */
export interface BuiltServers {
  /** MCP server configs keyed by source slug */
  mcpServers: Record<string, McpServerConfig>;
  /** In-process API servers keyed by source slug */
  apiServers: Record<string, ReturnType<typeof createLocalMcpServer>>;
  /** Sources that failed to build (missing auth, etc.) */
  errors: Array<{ sourceSlug: string; error: string }>;
}

/**
 * SourceServerBuilder - builds server configs from sources
 *
 * Usage:
 * ```typescript
 * const builder = new SourceServerBuilder();
 *
 * // Build MCP server config
 * const mcpConfig = builder.buildMcpServer(source, token);
 *
 * // Build all servers from sources with credentials
 * const { mcpServers, apiServers, errors } = await builder.buildAll([
 *   { source, token: 'abc123' },
 *   { source: apiSource, credential: 'api-key' },
 * ]);
 * ```
 */
export class SourceServerBuilder {
  /**
   * Build MCP server config from a source
   *
   * @param source - The source configuration
   * @param token - Authentication token (null for public/stdio sources)
   * @param credential - Multi-header credential from credential store (null if not set)
   */
  buildMcpServer(source: LoadedSource, token: string | null, credential?: ApiCredential | null): McpServerConfig | null {
    if (source.config.type !== 'mcp' || !source.config.mcp) {
      return null;
    }

    const mcp = source.config.mcp;

    // Handle stdio transport (local subprocess servers)
    if (mcp.transport === 'stdio') {
      if (!mcp.command) {
        debug(`[SourceServerBuilder] Stdio source ${source.config.slug} missing command`);
        return null;
      }
      return {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
      };
    }

    // Handle HTTP/SSE transport (remote servers)
    if (!mcp.url) {
      debug(`[SourceServerBuilder] HTTP/SSE source ${source.config.slug} missing URL`);
      return null;
    }

    const url = normalizeMcpUrl(mcp.url);

    const config: McpServerConfig = {
      type: mcp.transport === 'sse' ? 'sse' : 'http',
      url,
    };

    // Layer headers with increasing precedence:
    // 1. Static headers from config (non-secret)
    // 2. Credential-store headers (secret API keys via headerNames)
    // 3. Authorization bearer token (OAuth/bearer auth — highest priority)
    let mergedHeaders: Record<string, string> = {};

    // 1. Static headers from config (e.g., X-Custom-Header: value)
    if (mcp.headers) {
      mergedHeaders = { ...mcp.headers };
    }

    // 2. Credential-store headers (e.g., X-API-Key from credential store)
    if (credential && isMultiHeaderCredential(credential)) {
      mergedHeaders = { ...mergedHeaders, ...credential };
    }

    // 3. Auth token (highest priority — OAuth/bearer overrides everything)
    if (mcp.authType !== 'none') {
      if (token) {
        mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${token}` };
      } else if (source.config.isAuthenticated) {
        // Source claims to be authenticated but token is missing - needs re-auth
        debug(`[SourceServerBuilder] Source ${source.config.slug} needs re-authentication`);
        return null;
      }
    }

    if (Object.keys(mergedHeaders).length > 0) {
      (config as { headers?: Record<string, string> }).headers = mergedHeaders;
    }

    return config;
  }

  /**
   * Build API server from a source
   *
   * @param source - The source configuration
   * @param credential - API credential (null for public APIs)
   * @param getToken - Token getter for OAuth APIs (Google, etc.) - supports auto-refresh
   * @param sessionPath - Optional path to session folder for saving large responses
   */
  async buildApiServer(
    source: LoadedSource,
    credential: ApiCredential | null,
    getToken?: () => Promise<string>,
    sessionPath?: string,
    summarize?: SummarizeCallback
  ): Promise<ReturnType<typeof createLocalMcpServer> | null> {
    if (source.config.type !== 'api') return null;
    if (!source.config.api) {
      debug(`[SourceServerBuilder] API source ${source.config.slug} missing api config`);
      return null;
    }

    const apiConfig = source.config.api;
    const authType = apiConfig.authType;
    const provider = source.config.provider;

    // Google APIs - use token getter with auto-refresh
    // Note: Direct isAuthenticated check is safe - Google OAuth always requires auth
    if (provider === 'google') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Google API source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building Google API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      // Pass the token getter function - it will be called before each request
      // to get a fresh token (with auto-refresh if expired)
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // Slack APIs - use token getter with auto-refresh
    // Note: Direct isAuthenticated check is safe - Slack OAuth always requires auth
    if (provider === 'slack') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Slack API source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building Slack API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      // Pass the token getter function - it will be called before each request
      // to get a fresh token (with auto-refresh if expired)
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // Generic OAuth APIs — use token getter with auto-refresh
    // Order matters: provider-specific checks (google, slack) come first
    if (authType === 'oauth') {
      if (!source.config.isAuthenticated || !getToken) {
        debug(`[SourceServerBuilder] Generic OAuth source ${source.config.slug} not authenticated`);
        return null;
      }
      debug(`[SourceServerBuilder] Building generic OAuth API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // Public APIs (no auth) can be used immediately
    if (authType === 'none') {
      debug(`[SourceServerBuilder] Building public API server for ${source.config.slug}`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, '', sessionPath, summarize);
    }

    // Renew-endpoint sources use a token getter for auto-refresh instead of a static credential
    if (getToken && apiConfig.renewEndpoint) {
      debug(`[SourceServerBuilder] Building API server for ${source.config.slug} (auth: ${authType}, renew-endpoint)`);
      const config = this.buildApiConfig(source);
      return createApiServer(config, getToken, sessionPath, summarize);
    }

    // API key/bearer/header/query/basic auth - use static credential
    if (!credential) {
      debug(`[SourceServerBuilder] API source ${source.config.slug} needs credentials`);
      return null;
    }

    debug(`[SourceServerBuilder] Building API server for ${source.config.slug} (auth: ${authType})`);
    const config = this.buildApiConfig(source);
    return createApiServer(config, credential, sessionPath, summarize);
  }

  /**
   * Build ApiConfig from a LoadedSource
   */
  buildApiConfig(source: LoadedSource): ApiConfig {
    const api = source.config.api!;

    const config: ApiConfig = {
      name: source.config.slug,
      baseUrl: api.baseUrl,
      documentation: source.guide?.raw || '',
      defaultHeaders: api.defaultHeaders,
    };

    // Map auth type
    switch (api.authType) {
      case 'bearer':
        config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
        break;
      case 'header':
        config.auth = { type: 'header', headerName: api.headerName || 'x-api-key' };
        break;
      case 'query':
        config.auth = { type: 'query', queryParam: api.queryParam || 'api_key' };
        break;
      case 'basic':
        config.auth = { type: 'basic' };
        break;
      case 'oauth':
        // Generic OAuth tokens are sent as Bearer tokens
        config.auth = { type: 'bearer', authScheme: api.authScheme ?? 'Bearer' };
        break;
      case 'none':
      default:
        config.auth = { type: 'none' };
    }

    return config;
  }

  /**
   * Build all MCP and API servers for enabled sources
   *
   * @param sourcesWithCredentials - Sources with their pre-loaded credentials
   * @param getTokenForSource - Function to get token getter for OAuth sources
   * @param sessionPath - Optional path to session folder for saving large API responses
   */
  async buildAll(
    sourcesWithCredentials: SourceWithCredential[],
    getTokenForSource?: (source: LoadedSource) => (() => Promise<string>) | undefined,
    sessionPath?: string,
    summarize?: SummarizeCallback
  ): Promise<BuiltServers> {
    const mcpServers: Record<string, McpServerConfig> = {};
    const apiServers: Record<string, ReturnType<typeof createLocalMcpServer>> = {};
    const errors: BuiltServers['errors'] = [];

    for (const { source, token, credential } of sourcesWithCredentials) {
      if (!isSourceUsable(source)) continue;

      try {
        if (source.config.type === 'mcp') {
          const config = this.buildMcpServer(source, token ?? null, credential);
          if (config) {
            debug(`[SourceServerBuilder] Built MCP server for ${source.config.slug}`);
            mcpServers[source.config.slug] = config;
          } else if (source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
            // Only report auth error for HTTP/SSE sources that need auth
            // Stdio sources don't need auth
            debug(`[SourceServerBuilder] MCP server ${source.config.slug} needs auth`);
            errors.push({
              sourceSlug: source.config.slug,
              error: SERVER_BUILD_ERRORS.AUTH_REQUIRED,
            });
          }
        } else if (source.config.type === 'api') {
          const getToken = getTokenForSource?.(source);
          const server = await this.buildApiServer(source, credential ?? null, getToken, sessionPath, summarize);
          if (server) {
            apiServers[source.config.slug] = server;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug(`[SourceServerBuilder] Failed to build server for ${source.config.slug}: ${message}`);
        errors.push({ sourceSlug: source.config.slug, error: message });
      }
    }

    return { mcpServers, apiServers, errors };
  }
}

/**
 * Normalize MCP URL to standard format
 * - Removes trailing slashes
 * - Preserves the user-configured path as-is (no /mcp suffix appended)
 */
export function normalizeMcpUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// Singleton instance
let instance: SourceServerBuilder | null = null;

/**
 * Get shared SourceServerBuilder instance
 */
export function getSourceServerBuilder(): SourceServerBuilder {
  if (!instance) {
    instance = new SourceServerBuilder();
  }
  return instance;
}
