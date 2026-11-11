/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Module-level OAuth session store for the MCP browser dialog.
 *
 * Why this lives outside the React tree:
 *
 * MCP OAuth needs an in-flow consent prompt (`getConsentForOauth`), which
 * fires `CoreEvent.ConsentRequest`. The DialogManager listens to that and
 * mounts `<ConsentPrompt>` in place of the MCP browser, which means the
 * `<McpBrowser>` component **unmounts** while the user clicks "yes".
 * After consent the dialog re-mounts with fresh local state.
 *
 * Storing the auth promise + progress messages in a module-level singleton
 * lets the dialog reattach and resume showing progress, instead of losing
 * the in-flight session.
 */

import {
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  McpAuthorizationPreparationError,
  mcpServerRequiresOAuth,
  openBrowserSecurely,
  requestMcpAuthorizationConsent,
  type Config,
  type MCPServerConfig,
  type SessionMcpManager,
} from '@qwen-code/core';

type PresentationManager = Pick<
  SessionMcpManager,
  'getMcpServerPresentation'
>;

/** A server the host integration describes owns its authorization flow. */
function isHostIntegrated(
  manager: PresentationManager | undefined,
  serverConfig: MCPServerConfig | undefined,
): boolean {
  return (
    serverConfig !== undefined &&
    manager?.getMcpServerPresentation?.(serverConfig) !== undefined
  );
}

// ─── Session state ──────────────────────────────────────────────────────────

export type McpAuthSessionState =
  | { state: 'idle' }
  | { state: 'running'; messages: string[]; startedAt: number }
  | { state: 'success'; finishedAt: number }
  | { state: 'error'; error: string; finishedAt: number };

const sessions = new Map<string, McpAuthSessionState>();
// Kept beyond task completion so a later reload/remove also retires terminal UI
// state. The store owns the subscription, not the dialog (which can unmount).
const lifecycles = new Map<string, { unsubscribe: () => void }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getMcpAuthSession(serverName: string): McpAuthSessionState {
  return sessions.get(serverName) ?? { state: 'idle' };
}

export function subscribeMcpAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearMcpAuthSession(serverName: string): void {
  const lifecycle = lifecycles.get(serverName);
  lifecycles.delete(serverName);
  lifecycle?.unsubscribe();
  if (sessions.delete(serverName)) {
    notify();
  }
}

// ─── OAuth capability + credential check ────────────────────────────────────

/**
 * Whether a server should expose an "Authenticate" affordance — either it
 * declares OAuth in its config, or the runtime detected a 401 and recorded
 * it in `mcpServerRequiresOAuth`.
 */
export function isOAuthCapable(
  serverName: string,
  serverConfig: MCPServerConfig | undefined,
  manager?: PresentationManager,
): boolean {
  if (!serverConfig) return false;
  if (isHostIntegrated(manager, serverConfig)) return true;
  if (serverConfig.oauth?.enabled) return true;
  if (mcpServerRequiresOAuth.has(serverName)) return true;
  return false;
}

export type CredentialState =
  | 'authenticated'
  | 'expired'
  | 'unauthenticated'
  | 'not-configured';

/**
 * Check the on-disk OAuth credential state for a server. Async because it
 * touches the token storage backend (file or keychain).
 */
export async function getMcpCredentialState(
  serverName: string,
  serverConfig: MCPServerConfig | undefined,
  manager?: PresentationManager,
): Promise<CredentialState> {
  if (!isOAuthCapable(serverName, serverConfig, manager)) {
    return 'not-configured';
  }

  if (isHostIntegrated(manager, serverConfig)) {
    return mcpServerRequiresOAuth.has(serverName)
      ? 'unauthenticated'
      : 'authenticated';
  }

  // If runtime detected a 401, the stored token is stale — report unauthenticated
  // regardless of what's on disk, so the UI enables re-auth.
  if (mcpServerRequiresOAuth.has(serverName)) return 'unauthenticated';

  const creds = await MCPOAuthTokenStorage.forServer(
    serverName,
    serverConfig,
  ).getCredentials(serverName);
  if (!creds) return 'unauthenticated';
  if (creds.token.expiresAt && creds.token.expiresAt < Date.now()) {
    return 'expired';
  }
  return 'authenticated';
}

// ─── Auth runner ────────────────────────────────────────────────────────────

// UI invalidation does not mean the underlying provider has stopped. Keep this
// independent of lifecycles so cleanup cannot allow overlapping OAuth flows.
const inFlight = new Set<string>();

/**
 * Kick off an OAuth flow for a server. Idempotent — if a session is already
 * running for the server, returns immediately. The promise resolves once
 * the auth flow finishes (success or failure); both outcomes write to
 * `getMcpAuthSession()`.
 */
export async function startMcpAuth(
  serverName: string,
  serverConfig: MCPServerConfig,
  config: Config,
): Promise<void> {

  if (inFlight.has(serverName)) return;
  inFlight.add(serverName);
  clearMcpAuthSession(serverName);
  const manager = config.getMcpClientManager();
  const lifecycle = { unsubscribe: () => {} };
  lifecycles.set(serverName, lifecycle);
  const isCurrent = () => lifecycles.get(serverName) === lifecycle;
  lifecycle.unsubscribe =
    manager?.onServerAuthorizationInvalidated((name) => {
      if (name === serverName && isCurrent()) clearMcpAuthSession(serverName);
    }) ?? (() => {});
  const setSession = (state: McpAuthSessionState) => {
    if (!isCurrent()) return;
    sessions.set(serverName, state);
    notify();
  };

  const startedAt = Date.now();
  const messages: string[] = [];
  setSession({ state: 'running', messages, startedAt });

  // Capture the provider's progress messages via the `onMessage` hook rather
  // than the shared feedback bus. The bus is read by AppContainer and would
  // otherwise add a permanent "Opening your browser…" block to the chat
  // transcript — the dialog renders these inline and hides them when the
  // session transitions to success/error/idle.
  const handleMessage = (message: string) => {
    if (!isCurrent()) return;
    messages.push(message);
    setSession({
      state: 'running',
      messages: [...messages],
      startedAt,
    });
  };

  try {
    if (manager) {
      let preparation:
        | Awaited<ReturnType<typeof manager.prepareMcpAuthorization>>
        | undefined;
      try {
        preparation = await manager.prepareMcpAuthorization(serverName);
      } catch (error) {
        if (
          !(error instanceof McpAuthorizationPreparationError) ||
          error.kind !== 'unsupported'
        ) {
          throw error;
        }
      }
      if (preparation) {
        if (!isCurrent()) return;
        if (preparation.kind === 'action') {
          const outcome = await manager.authorizeMcpServer(serverName, {
            confirmOpenUrl: requestMcpAuthorizationConsent,
            openUrl: async (url, signal) => {
              signal.throwIfAborted();
              await openBrowserSecurely(url.href, signal);
            },
            onStateChanged: (event) => {
              handleMessage(`MCP authorization: ${event.state}`);
            },
          });
          if (!isCurrent()) return;
          if (outcome.state !== 'completed') {
            throw new Error(
              outcome.state === 'failed'
                ? outcome.failure.userMessage
                : `MCP authorization ${outcome.state}`,
            );
          }
        }
        try {
          await config.refreshMcpContext();
        } catch {
          // The manager already refreshed registries; this UI refresh is best-effort.
        }
        setSession({ state: 'success', finishedAt: Date.now() });
        return;
      }
    }

    const provider = new MCPOAuthProvider(
      MCPOAuthTokenStorage.forServer(serverName, serverConfig),
    );
    const oauthConfig = serverConfig.oauth ?? { enabled: false };
    const url = serverConfig.httpUrl || serverConfig.url;
    await provider.authenticate(serverName, oauthConfig, url, {
      onMessage: handleMessage,
    });
    if (!isCurrent()) return;

    // Restart only this server so the new bearer token takes effect, then
    // refresh the client tools so the model picks up its tools.
    try {
      await manager?.restartServer(serverName, false, {
        preserveAuthorization: true,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setSession({
        state: 'error',
        error: `Authenticated but failed to restart server: ${errMsg}`,
        finishedAt: Date.now(),
      });
      return;
    }

    if (!isCurrent()) return;
    try {
      await config.refreshMcpContext();
    } catch {
      // non-fatal — tool refresh failures shouldn't fail the auth flow
    }

    setSession({ state: 'success', finishedAt: Date.now() });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    setSession({
      state: 'error',
      error: errMsg,
      finishedAt: Date.now(),
    });
  } finally {
    // Only actual task settlement releases the lock; UI cleanup never does.
    inFlight.delete(serverName);
  }
}

// ─── UI state preservation across consent-prompt remounts ───────────────────

/**
 * Which server's detail view was active when the dialog last unmounted.
 * Used by `McpBrowser` to restore the detail view after the consent prompt
 * (which replaces the dialog while the user confirms) goes away.
 *
 * Cleared by the dialog when the user explicitly closes the detail view
 * (Esc) or the whole dialog.
 */
let preservedDetailServer: string | null = null;

export function getPreservedDetailServer(): string | null {
  return preservedDetailServer;
}

export function setPreservedDetailServer(name: string | null): void {
  preservedDetailServer = name;
}
