/**
 * Onboarding IPC handlers for Electron main process
 *
 * Handles workspace setup and configuration persistence.
 */
import { getAuthState, getSetupNeeds } from '@craft-agent/shared/auth'
import { isSetupDeferred, setSetupDeferred } from '@craft-agent/shared/config/storage'
import { prepareMcpOAuth } from '@craft-agent/shared/auth'
import { validateMcpConnection } from '@craft-agent/shared/mcp'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handlers/handler-deps'

// ============================================
// IPC Handlers
// ============================================

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.onboarding.VALIDATE_MCP,
  RPC_CHANNELS.onboarding.START_MCP_OAUTH,
  RPC_CHANNELS.onboarding.DEFER_SETUP,
] as const

export function registerOnboardingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Get current auth state
  server.handle(RPC_CHANNELS.onboarding.GET_AUTH_STATE, async () => {
    const authState = await getAuthState()
    const setupNeeds = getSetupNeeds(authState, isSetupDeferred())
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
    }
  })

  // Validate MCP connection
  server.handle(RPC_CHANNELS.onboarding.VALIDATE_MCP, async (_ctx, mcpUrl: string, accessToken?: string) => {
    try {
      const result = await validateMcpConnection({
        mcpUrl,
        mcpAccessToken: accessToken,
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  // Prepare MCP server OAuth (server-side only — no browser open).
  // Returns authUrl for the client to open locally.
  // NOTE: Currently unused in renderer. If re-enabled, needs client-side
  // orchestration (callback server + browser open) like performOAuth().
  server.handle(RPC_CHANNELS.onboarding.START_MCP_OAUTH, async (_ctx, mcpUrl: string, callbackPort?: number) => {
    log.info('[Onboarding:Main] ONBOARDING_START_MCP_OAUTH received')
    try {
      if (!callbackPort) {
        throw new Error('callbackPort is required — client must run a local callback server')
      }
      const prepared = await prepareMcpOAuth(mcpUrl, { callbackPort })
      log.info('[Onboarding:Main] MCP OAuth prepared, returning authUrl to client')

      return {
        success: true,
        authUrl: prepared.authUrl,
        state: prepared.state,
        codeVerifier: prepared.codeVerifier,
        tokenEndpoint: prepared.tokenEndpoint,
        clientId: prepared.clientId,
        redirectUri: prepared.redirectUri,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('[Onboarding:Main] MCP OAuth prepare failed:', message)
      return { success: false, error: message }
    }
  })

  // User chose "Setup later" — persist so onboarding doesn't re-show on next launch.
  // Cleared automatically when user configures a provider from Settings.
  server.handle(RPC_CHANNELS.onboarding.DEFER_SETUP, async () => {
    setSetupDeferred(true)
    log.info('[Onboarding] User deferred setup')
    return { success: true }
  })
}
