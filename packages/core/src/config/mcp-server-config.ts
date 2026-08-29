/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPOAuthConfig } from '../mcp/oauth-provider.js';

/**
 * Provenance of an MCP server config. Two purposes (see issue #4615):
 *
 * - **Approval gating**: `'project'` (a workspace `.mcp.json`) and `'workspace'`
 *   (a workspace `.qwen/settings.json`) are checked-in / shareable and therefore
 *   untrusted — both are held behind the pending-approval gate. See
 *   {@link isGatedMcpScope}.
 * - **Precedence**: `'workspace'` and `'system'` rank ABOVE a `.mcp.json`
 *   server, while user/default-scoped servers (left `scope` unset) rank below it
 *   — so `.mcp.json` overrides user settings but never enterprise-enforced
 *   `'system'` settings.
 *
 * Configs from user/default settings, extensions, and `--mcp-config` leave
 * `scope` unset.
 */
export type McpServerScope = 'project' | 'workspace' | 'system';

/**
 * Why an MCP server's tools are currently unavailable, used to give the model a
 * precise tool-not-found recovery action. See
 * `Config.getMcpServerUnavailableReason` in `./config.ts`.
 * - `removed`: deleted from config this session.
 * - `not_allowed`: filtered out by the `mcp.allowed` allow-list.
 * - `excluded`: present in the `mcp.excluded` list.
 * - `pending_approval`: a gated server awaiting approval (#4615).
 */
export type McpServerUnavailableReason =
  | 'removed'
  | 'not_allowed'
  | 'excluded'
  | 'pending_approval';

/**
 * Scopes whose servers are checked-in / shareable and therefore untrusted: they
 * must be approved before the discovery layer connects them. `'system'`
 * (enterprise-enforced) and unset (user/default/CLI/extension) scopes are
 * trusted and never gated. See issue #4615.
 */
export function isGatedMcpScope(scope: McpServerScope | undefined): boolean {
  return scope === 'project' || scope === 'workspace';
}

/**
 * Test whether a server name matches a single pattern. Patterns use simple
 * glob semantics: `*` matches any sequence of characters (including empty),
 * `?` matches exactly one character. A pattern without glob characters is
 * compared as an exact string (no behavior change for existing configs).
 * Uses an iterative two-pointer algorithm — O(n×m) worst case, no regex,
 * no backtracking vulnerability.
 */
export function matchesServerPattern(name: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return name === pattern;
  }
  let ni = 0;
  let pi = 0;
  let starNi = -1;
  let starPi = -1;
  while (ni < name.length) {
    if (
      pi < pattern.length &&
      (pattern[pi] === '?' || pattern[pi] === name[ni])
    ) {
      ni++;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starPi = pi++;
      starNi = ni;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

/**
 * Test whether a server name matches any pattern in the given list.
 * Returns false for an empty or undefined list.
 */
export function matchesAnyServerPattern(
  name: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => matchesServerPattern(name, p));
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}

export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extensionName?: string,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Service Account Configuration
    /* targetAudience format: CLIENT_ID.apps.googleusercontent.com */
    readonly targetAudience?: string,
    /* targetServiceAccount format: <service-account-name>@<project-num>.iam.gserviceaccount.com */
    readonly targetServiceAccount?: string,
    // SDK MCP server type - 'sdk' indicates server runs in SDK process
    readonly type?: 'sdk',
    /**
     * Per-server cap on the discovery handshake (`connect` + `tools/list` +
     * `prompts/list` + `resources/list`). Defaults: 30s for stdio servers,
     * 5s for remote HTTP/SSE. Tool-call timeout (`timeout` above) is
     * unaffected — a long-running tool invocation is not a startup
     * pathology. Appended at the end of the parameter list to avoid
     * shifting positional arguments at the many `new MCPServerConfig(...)`
     * call sites.
     */
    readonly discoveryTimeoutMs?: number,
    /**
     * Provenance of this server config (see {@link McpServerScope}). Gated
     * scopes (`'project'`, `'workspace'`) are held behind the pending-approval
     * gate; `'system'` and unset scopes connect as before. Also drives
     * precedence in `assembleMcpServers`. Appended at the end of the parameter
     * list to avoid shifting positional arguments at the many
     * `new MCPServerConfig(...)` call sites. See issue #4615.
     */
    readonly scope?: McpServerScope,
    readonly alwaysLoadTools?: boolean,
    readonly agentPluginV1?: boolean,
    readonly versionNegotiation?: 'auto' | 'legacy',
  ) {}
}

/**
 * Check if an MCP server config represents an SDK server
 */
export function isSdkMcpServerConfig(config: MCPServerConfig): boolean {
  return config.type === 'sdk';
}
