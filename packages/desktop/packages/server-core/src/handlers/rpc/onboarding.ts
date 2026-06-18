/**
 * Onboarding IPC handlers for Electron main process
 *
 * Handles workspace setup and configuration persistence.
 */
import { getAuthState, getSetupNeeds } from '@craft-agent/shared/auth';
import { isSetupDeferred, setSetupDeferred } from '@craft-agent/shared/config';
import { prepareMcpOAuth } from '@craft-agent/shared/auth';
import { validateMcpConnection } from '@craft-agent/shared/mcp';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import {
  getQwenWorkspacePreflightViaAcp,
  listQwenProvidersViaAcp,
} from '@craft-agent/shared/agent';
import { buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

// ============================================
// IPC Handlers
// ============================================

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.onboarding.VALIDATE_MCP,
  RPC_CHANNELS.onboarding.START_MCP_OAUTH,
  RPC_CHANNELS.onboarding.DEFER_SETUP,
] as const;

function completeSetupNeeds() {
  return {
    needsBillingConfig: false,
    needsCredentials: false,
    isFullyConfigured: true,
  };
}

function requiredSetupNeeds() {
  return {
    needsBillingConfig: true,
    needsCredentials: true,
    isFullyConfigured: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function findPreflightCell(
  preflight: Record<string, unknown>,
  kind: string,
): Record<string, unknown> | undefined {
  const cells = Array.isArray(preflight.cells) ? preflight.cells : [];
  return cells.filter(isRecord).find((cell) => cell.kind === kind);
}

type SetupSignal = 'complete' | 'maybe-required' | 'required';

function preflightSetupSignal(
  preflight: Record<string, unknown>,
): SetupSignal {
  const auth = findPreflightCell(preflight, 'auth');
  const authDetail = isRecord(auth?.detail) ? auth.detail : {};
  const authStatus = auth?.status;

  if (authDetail.source === 'none') return 'required';
  if (authStatus === 'warning' && authDetail.hasToken === false) {
    return 'maybe-required';
  }

  const providers = findPreflightCell(preflight, 'providers');
  const providersDetail = isRecord(providers?.detail) ? providers.detail : {};
  return providers?.status === 'error' && providersDetail.count === 0
    ? 'required'
    : 'complete';
}

function hasExistingProviderConfig(catalog: {
  providers: Array<{
    existingConfig?: { apiKey?: string; modelIds?: string[] };
  }>;
}): boolean {
  return catalog.providers.some((provider) => {
    const config = provider.existingConfig;
    return !!config?.apiKey || !!config?.modelIds?.length;
  });
}

async function getQwenSetupNeeds(deps: HandlerDeps) {
  if (isSetupDeferred()) {
    return completeSetupNeeds();
  }

  try {
    const preflight = await getQwenWorkspacePreflightViaAcp({
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    });
    const signal = preflightSetupSignal(preflight);
    if (signal === 'complete') return completeSetupNeeds();
    if (signal === 'required') return requiredSetupNeeds();

    const catalog = await listQwenProvidersViaAcp({
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    });
    return hasExistingProviderConfig(catalog)
      ? completeSetupNeeds()
      : requiredSetupNeeds();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.platform.logger?.warn(
      `Qwen setup preflight failed; continuing to main UI: ${message}`,
    );
    return completeSetupNeeds();
  }
}

export function registerOnboardingHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  const log = deps.platform.logger;

  // Get current auth state
  server.handle(RPC_CHANNELS.onboarding.GET_AUTH_STATE, async () => {
    const authState = await getAuthState();
    const setupNeeds = getSetupNeeds(authState).isFullyConfigured
      ? await getQwenSetupNeeds(deps)
      : getSetupNeeds(authState);
    // Redact raw credentials — renderer only needs boolean flags (hasCredentials, setupNeeds)
    return {
      authState: {
        ...authState,
        billing: {
          ...authState.billing,
          apiKey: authState.billing.apiKey ? '••••' : null,
        },
      },
      setupNeeds,
    };
  });

  // Validate MCP connection
  server.handle(
    RPC_CHANNELS.onboarding.VALIDATE_MCP,
    async (_ctx, mcpUrl: string, accessToken?: string) => {
      try {
        const result = await validateMcpConnection({
          mcpUrl,
          mcpAccessToken: accessToken,
        });
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: message };
      }
    },
  );

  // Prepare MCP server OAuth (server-side only — no browser open).
  // Returns authUrl for the client to open locally.
  // NOTE: Currently unused in renderer. If re-enabled, needs client-side
  // orchestration (callback server + browser open) like performOAuth().
  server.handle(
    RPC_CHANNELS.onboarding.START_MCP_OAUTH,
    async (_ctx, mcpUrl: string, callbackPort?: number) => {
      log.info('[Onboarding:Main] ONBOARDING_START_MCP_OAUTH received');
      try {
        if (!callbackPort) {
          throw new Error(
            'callbackPort is required — client must run a local callback server',
          );
        }
        const prepared = await prepareMcpOAuth(mcpUrl, { callbackPort });
        log.info(
          '[Onboarding:Main] MCP OAuth prepared, returning authUrl to client',
        );

        return {
          success: true,
          authUrl: prepared.authUrl,
          state: prepared.state,
          codeVerifier: prepared.codeVerifier,
          tokenEndpoint: prepared.tokenEndpoint,
          clientId: prepared.clientId,
          redirectUri: prepared.redirectUri,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        log.error('[Onboarding:Main] MCP OAuth prepare failed:', message);
        return { success: false, error: message };
      }
    },
  );

  // User chose "Setup later" — persist so onboarding doesn't re-show on next launch
  server.handle(RPC_CHANNELS.onboarding.DEFER_SETUP, async () => {
    setSetupDeferred(true);
    log?.info('[Onboarding] User deferred setup');
    return { success: true };
  });
}
