/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Auth pseudo-tool.
 *
 * When an MCP server responds with 401 during connection, this tool is
 * injected into the tool registry so the model can guide the user through
 * OAuth authentication within the conversation flow.
 *
 * After successful authentication the server is restarted, real tools are
 * discovered, and this pseudo-tool is automatically removed.
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type PayloadResult,
  type ToolLiveOutput,
  type ToolResult,
} from './tools.js';
import {
  buildMcpToolName,
  isMcpToolName,
  MCP_QUALIFIED_NAME_SEPARATOR,
} from '../mcp/tools/mcp-tool.js';
import type { MCPServerConfig } from '../config/config.js';
import { MCPOAuthProvider } from '../mcp/connector/oauth/provider.js';
import { MCPOAuthTokenStorage } from '../mcp/oauth-token-storage.js';
import { runLogger } from '../utils/runLogger.js';
import { getErrorMessage } from '../utils/errors.js';

const AUTH_TOOL_SUFFIX = 'authenticate';

/**
 * Build the registry name for an MCP auth pseudo-tool.
 * Follows the standard MCP naming: `mcp__{serverName}__authenticate`
 */
export function buildMcpAuthToolName(serverName: string): string {
  return buildMcpToolName(serverName, AUTH_TOOL_SUFFIX);
}

/**
 * Check whether a tool name is an MCP auth pseudo-tool.
 */
export function isMcpAuthToolName(name: string): boolean {
  return (
    isMcpToolName(name) &&
    name.endsWith(`${MCP_QUALIFIED_NAME_SEPARATOR}${AUTH_TOOL_SUFFIX}`)
  );
}

// ─── Invocation ─────────────────────────────────────────────────────────────

type AuthParams = Record<string, never>;

interface McpAuthToolContext {
  serverName: string;
  serverConfig: MCPServerConfig;
  /** Returns the number of tools discovered after reconnecting. */
  onAuthComplete: () => Promise<number>;
  /**
   * Whether the host CLI is running in interactive (TUI) mode. Determines
   * whether the tool awaits the full OAuth flow (TUI: better UX, same-turn
   * tool use after auth completes) or returns the URL immediately and lets
   * the flow complete in the background (non-interactive: avoids hanging
   * the event loop on the callback server when no browser is available).
   */
  interactive: boolean;
}

class McpAuthToolInvocation extends BaseToolInvocation<AuthParams, ToolResult> {
  private completedDescription: string | null = null;

  constructor(
    params: AuthParams,
    toolName: string,
    displayName: string,
    private readonly ctx: McpAuthToolContext,
  ) {
    super(params, toolName, displayName);
  }

  getDescription(): string {
    return (
      this.completedDescription ??
      `Authenticate MCP server "${this.ctx.serverName}"`
    );
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const { serverName, serverConfig, onAuthComplete, interactive } = this.ctx;
    const oauthConfig = serverConfig.oauth ?? { enabled: true };
    const serverUrl = serverConfig.httpUrl || serverConfig.url;
    const provider = new MCPOAuthProvider(
      MCPOAuthTokenStorage.forServer(serverName, serverConfig),
    );

    if (interactive) {
      return this.executeInteractive(
        provider,
        serverName,
        oauthConfig,
        serverUrl,
        onAuthComplete,
        updateOutput,
      );
    }
    return this.executeNonInteractive(
      provider,
      serverName,
      oauthConfig,
      serverUrl,
      onAuthComplete,
    );
  }

  /**
   * Interactive (TUI) path: synchronously drive the full OAuth flow so that
   * when this tool returns, real MCP tools are already registered and the
   * model can call them in the same turn. Preserves the pre-existing TUI UX
   * end-to-end — including the consent dialog and browser-open banner that
   * the provider emits by default.
   */
  private async executeInteractive(
    provider: MCPOAuthProvider,
    serverName: string,
    oauthConfig: NonNullable<MCPServerConfig['oauth']>,
    serverUrl: string | undefined,
    onAuthComplete: () => Promise<number>,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    try {
      await provider.authenticate(serverName, oauthConfig, serverUrl, {
        onMessage: updateOutput ? (msg) => updateOutput(msg) : undefined,
      });

      runLogger.log(
        `MCP auth tool: authentication succeeded for "${serverName}", restarting server...`,
      );

      const toolCount = await onAuthComplete();

      if (toolCount > 0) {
        this.completedDescription = `Authenticated — ${toolCount} tool(s) now available`;
        const toolUseResult: PayloadResult = {
          summary: `Authenticated with **${serverName}** — ${toolCount} tool(s) discovered`,
          payload: serverName,
        };
        return {
          llmContent:
            `Successfully authenticated with MCP server "${serverName}". ` +
            `The server has been reconnected and ${toolCount} tool(s) are now available. ` +
            `Use the server's tools in your next response.`,
          returnDisplay: `Authenticated with **${serverName}** — ${toolCount} tool(s) discovered`,
          toolUseResult,
        };
      }

      this.completedDescription = `Authenticated but no tools discovered`;
      const toolUseResult: PayloadResult = {
        summary: `Authenticated with **${serverName}** but reconnection failed — no tools discovered`,
        payload: serverName,
      };
      return {
        llmContent:
          `Authenticated with MCP server "${serverName}" but no tools were discovered after reconnecting. ` +
          `The server may have failed to reconnect.`,
        returnDisplay: `Authenticated with **${serverName}** but reconnection failed — no tools discovered`,
        toolUseResult,
        error: {
          message: 'Authentication succeeded but tool discovery failed',
        },
      };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      runLogger.warn(
        `MCP auth tool: authentication failed for "${serverName}": ${errMsg}`,
      );
      this.completedDescription = `Authentication failed`;
      return {
        llmContent: `Authentication failed for MCP server "${serverName}": ${errMsg}.`,
        returnDisplay: `Authentication failed: ${errMsg}`,
        error: {
          message: errMsg,
        },
      };
    }
  }

  /**
   * Non-interactive (-p / print mode) path: return the authorize URL to the
   * model as soon as it's built, and let the rest of the OAuth flow run in
   * the background. Rationale:
   *   - No browser or TTY is available, so blocking on `callbackServer` would
   *     just hang the session until the watchdog killed it.
   *   - The user will complete authorization out of band (possibly after this
   *     process has exited); the token gets persisted to disk on success and
   *     becomes available to the next session.
   *   - the first-party flow has no silent-completion path through `authenticate()` (token
   *     refresh goes through `getValidToken`), so we simply await the URL —
   *     no Promise.race is needed.
   */
  private async executeNonInteractive(
    provider: MCPOAuthProvider,
    serverName: string,
    oauthConfig: NonNullable<MCPServerConfig['oauth']>,
    serverUrl: string | undefined,
    onAuthComplete: () => Promise<number>,
  ): Promise<ToolResult> {
    let resolveAuthUrl!: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      resolveAuthUrl = resolve;
    });

    const oauthPromise = provider.authenticate(
      serverName,
      oauthConfig,
      serverUrl,
      {
        skipBrowserOpen: true,
        skipConsent: true,
        onAuthUrl: (url) => resolveAuthUrl(url),
      },
    );

    // Best-effort background continuation. If the user completes the flow
    // before this process exits, we'll reconnect the server and swap real
    // tools into the registry. If the process exits first (the common case
    // in -p), the token is still persisted to disk for next session.
    void oauthPromise
      .then(async () => {
        try {
          const toolCount = await onAuthComplete();
          runLogger.log(
            `MCP auth tool: background OAuth complete for "${serverName}", ${toolCount} tool(s) discovered`,
          );
        } catch (err) {
          runLogger.warn(
            `MCP auth tool: background reconnect failed for "${serverName}": ${getErrorMessage(err)}`,
          );
        }
      })
      .catch((err) => {
        runLogger.warn(
          `MCP auth tool: background OAuth flow failed for "${serverName}": ${getErrorMessage(err)}`,
        );
      });

    try {
      // Wait for the URL, with early-reject if the flow fails before we
      // ever see one (discovery 404, dynamic-registration failure, etc.).
      const authUrl = await new Promise<string>((resolve, reject) => {
        authUrlPromise.then(resolve, reject);
        oauthPromise.catch(reject);
      });

      this.completedDescription = `Awaiting browser authorization`;
      const toolUseResult: PayloadResult = {
        summary: `Authorize **${serverName}** at ${authUrl}`,
        payload: authUrl,
      };
      return {
        llmContent:
          `MCP server "${serverName}" requires OAuth authentication. ` +
          `Ask the user to open this URL in their browser to authorize:\n\n${authUrl}\n\n` +
          `Once authorization completes, the server's tools will become available automatically on the next turn. ` +
          `Do not call any other "${serverName}" tools until the user confirms they have completed the flow.`,
        returnDisplay: `Authorize **${serverName}** at ${authUrl}`,
        toolUseResult,
      };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      runLogger.warn(
        `MCP auth tool: OAuth flow failed before URL was issued for "${serverName}": ${errMsg}`,
      );
      this.completedDescription = `OAuth start failed`;
      return {
        llmContent:
          `Failed to start OAuth flow for MCP server "${serverName}": ${errMsg}. ` +
          `Ask the user to verify the server is reachable and exposes an OAuth discovery endpoint.`,
        returnDisplay: `OAuth start failed: ${errMsg}`,
        error: {
          message: errMsg,
        },
      };
    }
  }
}

// ─── Tool declaration ───────────────────────────────────────────────────────

export class McpAuthTool extends BaseDeclarativeTool<AuthParams, ToolResult> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  readonly serverName: string;

  constructor(
    serverName: string,
    private readonly serverConfig: MCPServerConfig,
    private readonly onAuthComplete: () => Promise<number>,
    private readonly interactive: boolean,
  ) {
    const toolName = buildMcpAuthToolName(serverName);
    const transport = serverConfig.httpUrl
      ? 'HTTP'
      : serverConfig.url
        ? 'SSE'
        : 'remote';
    const url = serverConfig.httpUrl || serverConfig.url || '';

    super(
      toolName,
      `${serverName} - authenticate (MCP)`,
      `The \`${serverName}\` MCP server (${transport} at ${url}) is installed but requires authentication. ` +
        `Call this tool to start the OAuth flow — you'll receive an authorization URL to complete in your browser. ` +
        `Once authentication is complete, the server's real tools will become available automatically. ` +
        `IMPORTANT: Call this tool ALONE — do not call any other \`${serverName}\` tools in the same turn. ` +
        `Its tools will only be available after this authentication completes and the next turn begins.`,
      Kind.Other,
      { type: 'object', properties: {} },
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
    this.serverName = serverName;
  }

  override toClassifierInput(_input: AuthParams): unknown {
    return {
      mcp_server: this.serverName,
      action: 'authenticate',
    };
  }

  protected override validateToolParamValues(
    _params: AuthParams,
  ): string | null {
    return null;
  }

  protected createInvocation(
    params: AuthParams,
    toolName: string,
    displayName: string,
  ): BaseToolInvocation<AuthParams, ToolResult> {
    return new McpAuthToolInvocation(params, toolName, displayName, {
      serverName: this.serverName,
      serverConfig: this.serverConfig,
      onAuthComplete: this.onAuthComplete,
      interactive: this.interactive,
    });
  }
}
