/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-level MCP OAuth: authorize a user-level or plugin server without a
 * session, the way the settings page of a host app does.
 *
 * The host receives the browser redirect itself (`redirectUri` points at a
 * listener the host owns), so a flow is:
 *
 *   authenticate(serverId, redirectUri) → authorization URL for the host
 *   host opens the browser, receives the redirect
 *   submitCallback(serverId, callbackUrl) → this process exchanges the code,
 *     saves the token, and reconnects the pooled server
 *
 * PKCE and the token exchange stay in this process; the host only ever sees
 * the authorization code. The flow logic itself is core's
 * `MCPOAuthProvider.authenticate`, driven through the process-wide opener
 * registry the session-level `mcp_authenticate` also uses.
 *
 * A flow ends when the callback completes, when it is cancelled, or after
 * {@link MCP_AUTHORIZATION_TTL_MS}. Ending one early hands core a callback URL
 * that carries an OAuth error, so the provider stops without falling back to
 * opening a system browser.
 *
 * Brokered (gateway) servers are not handled here; their authorization lives
 * with the session's authorization coordinator.
 */

import { randomUUID } from 'node:crypto';
import {
  getErrorMessage,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  mcpServerKeyId,
  runLogger,
  type MCPOAuthConfig,
  type McpOAuthBrowserOpenMeta,
  type McpOAuthBrowserOpenResult,
  type MCPServerConfig,
  type McpServerKey,
  type OAuthToken,
} from '@qwen-code/core';
import {
  registerMcpOAuthOpener,
  unregisterMcpOAuthOpener,
} from '@qwen-code/core';
import { userMcpServerKey } from '../../../mcp/framework.js';
import { defaultMcpAuthMethod, type DaemonMcpContext } from './context.js';
import { DaemonMcpError } from './errors.js';
import {
  resolveServer,
  type McpServerSummary,
  type ResolvedMcpServer,
} from './queries.js';
import { rawUserMcpServers } from './userSettings.js';
import { waitAtMost } from './waitAtMost.js';

/** Same budget the host app gives a browser authorization. */
export const MCP_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * How long a delete or clear waits for a flow that is already exchanging the
 * code for a token. Past it they go ahead; the flow's own check after the
 * exchange still removes a token saved for a deleted server.
 */
export const MCP_AUTHORIZATION_SETTLE_WAIT_MS = 10_000;

/** Makes core's provider end a flow with an error instead of a browser. */
const ABORT_CALLBACK_URL =
  'http://127.0.0.1/?error=access_denied&error_description=';

export interface McpAuthorizationStart {
  /** False when stored credentials were enough and no browser step is needed. */
  readonly requiresUserAction: boolean;
  readonly authUrl?: string;
  /** Epoch ms after which an unfinished flow is dropped. */
  readonly expiresAt?: number;
}

export interface McpCancelAuthorizationResult {
  /** A flow existed and was waiting for the user. */
  readonly cancelled: boolean;
  /** Why nothing was cancelled. */
  readonly reason?: 'not_in_progress' | 'completing';
}

export interface McpClearAuthResult {
  readonly credentialsDeleted: boolean;
  readonly server: McpServerSummary;
}

/** One OAuth flow this process runs for a server, from start to token. */
class AuthorizationFlow {
  readonly flowId = randomUUID();
  /** Core reached the browser step and is waiting on {@link openerResult}. */
  claimed = false;
  /**
   * Ended by a clear or a delete. The flow stays in `flows` until it settles,
   * so core's browser step, if still ahead, reaches it and gets the abort.
   */
  revoked = false;
  /** Set right after the provider starts; settles when the flow ends. */
  completion!: Promise<OAuthToken>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles once core has built the authorization URL. */
  readonly authUrl: Promise<string>;
  /** What core gets back from the browser step. */
  readonly openerResult: Promise<McpOAuthBrowserOpenResult>;
  private resolveAuthUrl!: (url: string) => void;
  private resolveOpener!: (result: McpOAuthBrowserOpenResult) => void;
  private finished = false;

  constructor(
    readonly key: McpServerKey,
    readonly name: string,
    readonly expiresAt: number,
    readonly enterprise = false,
  ) {
    this.authUrl = new Promise((resolve) => {
      this.resolveAuthUrl = resolve;
    });
    this.openerResult = new Promise((resolve) => {
      this.resolveOpener = resolve;
    });
  }

  /** Core's browser step for this flow: publish the URL, wait for a result. */
  claim(authUrl: string): Promise<McpOAuthBrowserOpenResult> {
    this.claimed = true;
    // An ended flow gets its abort back; its URL is never offered to the host.
    if (!this.finished) this.resolveAuthUrl(authUrl);
    return this.openerResult;
  }

  /** Hands core the browser result; false when one was already given. */
  finish(result: McpOAuthBrowserOpenResult): boolean {
    if (this.finished) return false;
    this.finished = true;
    this.resolveOpener(result);
    return true;
  }
}

export interface DaemonMcpAuthorizationOptions {
  readonly createProvider?: (
    serverName: string,
    config: MCPServerConfig,
  ) => Pick<MCPOAuthProvider, 'authenticate'>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly settleWaitMs?: number;
}

export class DaemonMcpAuthorization {
  private readonly flows = new Map<string, AuthorizationFlow>();
  private openerKey: symbol | undefined;
  private readonly createProvider: (
    serverName: string,
    config: MCPServerConfig,
  ) => Pick<MCPOAuthProvider, 'authenticate'>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly settleWaitMs: number;

  constructor(
    private readonly context: DaemonMcpContext,
    options: DaemonMcpAuthorizationOptions = {},
  ) {
    this.createProvider =
      options.createProvider ??
      ((serverName, config) =>
        new MCPOAuthProvider(
          MCPOAuthTokenStorage.forServer(serverName, config),
        ));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? MCP_AUTHORIZATION_TTL_MS;
    this.settleWaitMs =
      options.settleWaitMs ?? MCP_AUTHORIZATION_SETTLE_WAIT_MS;
  }

  /**
   * Starts (or rejoins) the OAuth flow for a server. A flow still waiting for
   * the user returns the same URL, so a host that lost its window can reopen
   * it instead of being stuck until the flow expires.
   */
  async authenticate(
    serverId: string,
    request: { readonly redirectUri: string },
  ): Promise<McpAuthorizationStart> {
    const target = this.resolveOAuthServer(serverId);
    const id = mcpServerKeyId(target.key);
    const existing = this.flows.get(id);
    if (existing && !existing.revoked) return this.awaitStart(existing, target);
    // An ended flow may still be exchanging its code (bounded by the token
    // request timeout); a new one starts after its cleanup, never alongside.
    if (existing) await existing.completion.catch(() => {});

    const serverUrl = target.config.httpUrl ?? target.config.url;
    const flow = this.startFlow(
      target,
      {
        ...target.config.oauth,
        enabled: true,
        redirectUri: request.redirectUri,
      },
      serverUrl,
    );
    return this.awaitStart(flow, target);
  }

  /** Completes a flow with the redirect URL the host received. */
  async submitCallback(
    serverId: string,
    callbackUrl: string,
  ): Promise<McpServerSummary> {
    const target = resolveServer(this.context, serverId);
    const flow = this.flows.get(mcpServerKeyId(target.key));
    if (!flow || !flow.claimed) {
      throw new DaemonMcpError(
        'NOT_IN_PROGRESS',
        `No authorization is waiting for a callback for "${target.name}".`,
      );
    }
    if (!flow.finish({ callbackUrl })) {
      throw new DaemonMcpError(
        'NOT_IN_PROGRESS',
        `The authorization for "${target.name}" is already completing.`,
      );
    }
    try {
      await flow.completion;
    } catch (error) {
      throw new DaemonMcpError(
        'AUTH_FAILED',
        `Authorization for "${target.name}" failed: ${getErrorMessage(error)}`,
      );
    }
    await this.reconnectPooled(target);
    return target.describe();
  }

  /** Ends a flow that is still waiting for the user. */
  cancel(serverId: string): McpCancelAuthorizationResult {
    const target = resolveServer(this.context, serverId, {
      allowDisabled: true,
    });
    const flow = this.flows.get(mcpServerKeyId(target.key));
    if (!flow) return { cancelled: false, reason: 'not_in_progress' };
    if (!this.abort(flow, 'Authorization cancelled')) {
      return { cancelled: false, reason: 'completing' };
    }
    return { cancelled: true };
  }

  /**
   * Deletes the stored credentials and reconnects, which leaves a server that
   * needs OAuth in `auth_required`. Config and third-party grants are kept.
   */
  async clear(serverId: string): Promise<McpClearAuthResult> {
    // A disabled server can still have local credentials to clear; it is
    // just not reconnected afterwards.
    const target = this.resolveOAuthServer(serverId, { allowDisabled: true });
    await this.settle(target.key, 'Authorization cleared');
    const credentialsDeleted = await this.context.deleteCredentials(
      target.name,
      target.config,
    );
    if (target.enabled) await this.reconnectPooled(target);
    return { credentialsDeleted, server: await target.describe() };
  }

  /**
   * Ends the flow of a user-level server before its entry's credentials are
   * deleted (the entry itself is already gone from settings).
   */
  settleUserServer(configKey: string): Promise<void> {
    return this.settle(userMcpServerKey(configKey), 'MCP server deleted');
  }

  /** Ends every flow; used when the daemon shuts down. */
  invalidate(key: McpServerKey): void {
    const flow = this.flows.get(mcpServerKeyId(key));
    if (!flow) return;
    flow.revoked = true;
    this.abort(flow, 'MCP server changed');
  }

  dispose(): void {
    for (const flow of this.flows.values()) {
      flow.revoked = true;
      this.abort(flow, 'Daemon shutting down');
    }
    this.releaseOpener();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Makes sure no flow for `key` can leave a token behind: a flow waiting for
   * the user ends now; one already exchanging the code is waited for
   * (bounded), and if it finishes later it takes back the token it saved.
   */
  private async settle(key: McpServerKey, reason: string): Promise<void> {
    const flow = this.flows.get(mcpServerKeyId(key));
    if (!flow) return;
    flow.revoked = true;
    this.abort(flow, reason);
    await waitAtMost(
      flow.completion.catch(() => {}),
      this.settleWaitMs,
    );
  }

  /** Unreadable settings count as present: never drop a token on a read failure. */
  private userEntryExists(configKey: string): boolean {
    const settings = this.context.readUserSettings();
    return (
      settings.isUserSettingsLoadRejected() ||
      Object.hasOwn(rawUserMcpServers(settings), configKey)
    );
  }

  private resolveOAuthServer(
    serverId: string,
    options: { readonly allowDisabled?: boolean } = {},
  ): ResolvedMcpServer {
    const target = resolveServer(this.context, serverId, options);
    const method =
      this.context.authMethodOf?.(target.config) ??
      defaultMcpAuthMethod(target.config);
    if (method !== 'oauth') {
      throw new DaemonMcpError(
        'UNSUPPORTED',
        method === 'brokered'
          ? `MCP server "${target.name}" is authorized through its gateway, not OAuth.`
          : `MCP server "${target.name}" does not use OAuth.`,
      );
    }
    return target;
  }

  private startFlow(
    target: ResolvedMcpServer,
    oauthConfig: MCPOAuthConfig,
    serverUrl: string | undefined,
  ): AuthorizationFlow {
    const id = mcpServerKeyId(target.key);
    const flow = new AuthorizationFlow(
      target.key,
      target.name,
      this.now() + this.ttlMs,
      target.source === 'enterprise',
    );
    this.flows.set(id, flow);
    this.ensureOpener();
    flow.timer = setTimeout(() => {
      flow.revoked = true;
      this.abort(flow, 'Authorization expired');
    }, this.ttlMs);
    flow.timer.unref?.();
    runLogger.log(
      `[daemon-mcp-auth] authorization started server=${target.name}`,
    );

    flow.completion = this.createProvider(target.name, target.config)
      .authenticate(target.name, oauthConfig, serverUrl, {
        skipConsent: true,
        flowId: flow.flowId,
        beforeTokenCommit: () => {
          if (flow.revoked || this.flows.get(id) !== flow)
            throw new Error('Authorization ended');
          if (target.source === 'enterprise') target.assertCurrent?.();
        },
        // The host receives the redirect and submits it as the callback URL.
        hostDeliversCallback: true,
      })
      .then(async (token) => {
        // Cleared or deleted while the code was being exchanged: take back
        // what was just saved, unless a newer sign-in already replaced it.
        if (
          flow.revoked ||
          (target.source === 'user' && !this.userEntryExists(target.name))
        ) {
          await this.context.deleteCredentialsIfToken(
            target.name,
            token,
            target.config,
          );
          throw new Error(`Authorization for "${target.name}" was ended`);
        }
        return token;
      })
      .finally(() => {
        clearTimeout(flow.timer);
        if (this.flows.get(id) === flow) this.flows.delete(id);
        if (this.flows.size === 0) this.releaseOpener();
      });
    flow.completion.then(
      () =>
        runLogger.log(
          `[daemon-mcp-auth] authorization completed server=${target.name}`,
        ),
      (error: unknown) =>
        runLogger.warn(
          `[daemon-mcp-auth] authorization ended server=${target.name}: ${getErrorMessage(error)}`,
        ),
    );
    return flow;
  }

  /** Resolves with the URL, or with "nothing to do" when it finished silently. */
  private async awaitStart(
    flow: AuthorizationFlow,
    target: ResolvedMcpServer,
  ): Promise<McpAuthorizationStart> {
    const outcome = await Promise.race([
      flow.authUrl.then((authUrl) => ({ kind: 'url' as const, authUrl })),
      flow.completion.then(
        () => ({ kind: 'done' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
    ]);
    if (outcome.kind === 'url') {
      return {
        requiresUserAction: true,
        authUrl: outcome.authUrl,
        expiresAt: flow.expiresAt,
      };
    }
    if (outcome.kind === 'failed') {
      throw new DaemonMcpError(
        'AUTH_FAILED',
        `Authorization for "${target.name}" could not start: ${getErrorMessage(outcome.error)}`,
      );
    }
    await this.reconnectPooled(target);
    return { requiresUserAction: false };
  }

  private abort(flow: AuthorizationFlow, reason: string): boolean {
    return flow.finish({
      callbackUrl: `${ABORT_CALLBACK_URL}${encodeURIComponent(reason)}`,
    });
  }

  private ensureOpener(): void {
    if (this.openerKey !== undefined) return;
    this.openerKey = registerMcpOAuthOpener((authUrl, meta) =>
      this.openFor(authUrl, meta),
    );
  }

  private releaseOpener(): void {
    unregisterMcpOAuthOpener(this.openerKey);
    this.openerKey = undefined;
  }

  /** Claims core's open request for a flow this object started. */
  private openFor(
    authUrl: string,
    meta: McpOAuthBrowserOpenMeta,
  ): Promise<McpOAuthBrowserOpenResult> {
    const flow = [...this.flows.values()].find(
      (candidate) =>
        !candidate.claimed &&
        (meta.flowId
          ? candidate.flowId === meta.flowId
          : !candidate.enterprise && candidate.name === meta.serverName),
    );
    if (!flow) {
      throw new Error(
        `No daemon-level authorization is waiting for "${meta.serverName ?? '<unknown>'}".`,
      );
    }
    return flow.claim(authUrl);
  }

  private async reconnectPooled(target: ResolvedMcpServer): Promise<void> {
    try {
      target.assertCurrent?.();
    } catch {
      return;
    }
    const manager = this.context.getMcpManager();
    if (!manager?.getClient(target.key)) return;
    try {
      await manager.reconnect(target.key, false);
    } catch (error) {
      runLogger.warn(
        `[daemon-mcp-auth] credentials saved but reconnect failed server=${target.name}: ${getErrorMessage(error)}`,
      );
    }
  }
}
