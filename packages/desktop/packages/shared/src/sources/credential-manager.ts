/**
 * SourceCredentialManager
 *
 * Unified credential management for sources. Consolidates credential CRUD,
 * credential ID resolution, expiry checking, and OAuth flows.
 *
 * This replaces scattered credential logic across:
 * - SourceService.getSourceToken()
 * - SourceService.getApiCredential()
 * - SourceService.getCredentialId()
 * - session-scoped-tools OAuth triggers
 * - IPC handlers for credential storage
 */

import {
  inferGoogleServiceFromUrl,
  inferSlackServiceFromUrl,
  inferMicrosoftServiceFromUrl,
  isApiOAuthProvider,
  hasRenewEndpoint,
  type LoadedSource,
  type GoogleService,
  type SlackService,
  type MicrosoftService,
} from './types.ts';
import { buildAuthorizationHeader } from './api-tools.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { CraftOAuth, getMcpBaseUrl, prepareMcpOAuth, exchangeMcpOAuth, type OAuthCallbacks, type OAuthTokens } from '../auth/oauth.ts';
import { type OAuthSessionContext } from '../auth/types.ts';
import { OAUTH_RELAY_CALLBACK_URL, wrapPreparedOAuthFlowForRelay } from '../auth/oauth-relay.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult, OAuthProvider } from '../auth/oauth-flow-types.ts';
import {
  startGoogleOAuth,
  prepareGoogleOAuth,
  exchangeGoogleOAuth,
  refreshGoogleToken,
  type GoogleOAuthResult,
  type GoogleOAuthOptions,
} from '../auth/google-oauth.ts';
import {
  startSlackOAuth,
  prepareSlackOAuth,
  exchangeSlackOAuth,
  refreshSlackToken,
  type SlackOAuthResult,
  type SlackOAuthOptions,
} from '../auth/slack-oauth.ts';
import {
  startMicrosoftOAuth,
  prepareMicrosoftOAuth,
  exchangeMicrosoftOAuth,
  refreshMicrosoftToken,
  type MicrosoftOAuthResult,
  type MicrosoftOAuthOptions,
} from '../auth/microsoft-oauth.ts';
import {
  prepareGenericOAuth,
  exchangeGenericOAuth,
  refreshGenericOAuthToken,
} from '../auth/generic-oauth.ts';
import { debug } from '../utils/debug.ts';
import { markSourceAuthenticated, loadSourceConfig, saveSourceConfig } from './storage.ts';

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  success: boolean;
  error?: string;
  /** For Gmail OAuth, includes user's email */
  email?: string;
}

/**
 * API credential types (string for simple auth, object for basic auth or multi-header)
 */
export interface BasicAuthCredential {
  username: string;
  password: string;
}

/**
 * Multi-header credentials stored as Record<string, string>
 * Used for APIs like Datadog that require multiple auth headers (DD-API-KEY + DD-APPLICATION-KEY)
 */
export type MultiHeaderCredential = Record<string, string>;

export type ApiCredential = string | BasicAuthCredential | MultiHeaderCredential;

/**
 * Type guard to check if credential is a MultiHeaderCredential.
 * Returns true for Record<string, string> objects that are NOT BasicAuthCredential.
 */
export function isMultiHeaderCredential(cred: ApiCredential): cred is MultiHeaderCredential {
  return (
    typeof cred === 'object' &&
    cred !== null &&
    !('username' in cred && 'password' in cred)
  );
}

/**
 * SourceCredentialManager - unified credential operations for sources
 *
 * Usage:
 * ```typescript
 * const credManager = new SourceCredentialManager();
 *
 * // Save credentials
 * await credManager.save(source, { value: 'token123' });
 *
 * // Load credentials
 * const cred = await credManager.load(source);
 *
 * // Run OAuth flow
 * const result = await credManager.authenticate(source, {
 *   onStatus: (msg) => console.log(msg),
 *   onError: (err) => console.error(err),
 * });
 * ```
 */
export class SourceCredentialManager {
  // Track in-flight refresh promises to prevent concurrent refreshes for the same source
  // This prevents race conditions (especially important for Microsoft which rotates refresh tokens)
  private pendingRefreshes = new Map<string, Promise<string | null>>();

  // ============================================================
  // Core CRUD Operations
  // ============================================================

  /**
   * Save credential for a source
   */
  async save(source: LoadedSource, credential: StoredCredential): Promise<void> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    await manager.set(credentialId, credential);
    debug(`[SourceCredentialManager] Saved ${credentialId.type} for ${source.config.slug}`);
  }

  /**
   * Load credential for a source
   *
   * For MCP sources, tries both OAuth and bearer credentials as fallback
   * (credentials may have been stored via different auth modes)
   */
  async load(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();

    // For MCP sources, try both OAuth and bearer credentials
    // (stdio transport doesn't need credentials)
    if (source.config.type === 'mcp' && source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
      return this.loadMcpCredential(source);
    }

    // For other sources, use the credential ID based on authType
    const credentialId = this.getCredentialId(source);
    const cred = await manager.get(credentialId);

    if (cred) {
      debug(`[SourceCredentialManager] Found ${credentialId.type} for ${source.config.slug}`);
    }

    return cred;
  }

  /**
   * Load MCP credential with fallback (OAuth -> bearer)
   */
  private async loadMcpCredential(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();
    const baseId = {
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };

    // Try OAuth first
    const oauthCreds = await manager.get({ type: 'source_oauth', ...baseId });
    if (oauthCreds?.value) {
      debug(`[SourceCredentialManager] Found source_oauth for ${source.config.slug}`);
      return oauthCreds;
    }

    // Fall back to bearer
    const bearerCreds = await manager.get({ type: 'source_bearer', ...baseId });
    if (bearerCreds?.value) {
      debug(`[SourceCredentialManager] Found source_bearer for ${source.config.slug}`);
      return bearerCreds;
    }

    debug(`[SourceCredentialManager] No credential found for MCP source ${source.config.slug}`);
    return null;
  }

  /**
   * Delete credential for a source
   */
  async delete(source: LoadedSource): Promise<boolean> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    const deleted = await manager.delete(credentialId);
    if (deleted) {
      debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
  }

  /**
   * Get token value for a source (convenience method)
   * Returns null if no credential exists or if expired
   */
  async getToken(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred?.value) return null;

    // Check expiry
    if (this.isExpired(cred)) {
      debug(`[SourceCredentialManager] Token expired for ${source.config.slug}`);
      return null;
    }

    return cred.value;
  }

  /**
   * Get API credential for a source (handles basic auth and multi-header JSON parsing)
   */
  async getApiCredential(source: LoadedSource): Promise<ApiCredential | null> {
    const cred = await this.load(source);
    // Check both API and MCP headerNames (same credential store pattern)
    const headerNames = source.config.api?.headerNames || source.config.mcp?.headerNames;
    debug(`[SourceCredentialManager] getApiCredential for ${source.config.slug}: cred.value exists=${!!cred?.value}, headerNames=${JSON.stringify(headerNames)}`);
    if (!cred?.value) return null;

    // Check for multi-header auth (JSON with header names as keys)
    // Works for both API sources (api.headerNames) and MCP sources (mcp.headerNames)
    if (headerNames?.length) {
      debug(`[SourceCredentialManager] Attempting multi-header parse for ${source.config.slug}, raw value length=${cred.value.length}`);
      try {
        const parsed = JSON.parse(cred.value);
        debug(`[SourceCredentialManager] Parsed JSON keys: ${Object.keys(parsed).join(', ')}`);
        // Validate all required headers are present
        const hasAllHeaders = headerNames.every((h) => h in parsed);
        debug(`[SourceCredentialManager] hasAllHeaders=${hasAllHeaders}`);
        if (hasAllHeaders) {
          return parsed as MultiHeaderCredential;
        }
      } catch (e) {
        // Not JSON, fall through to other auth types
        debug(`[SourceCredentialManager] JSON parse failed: ${e}`);
      }
    }

    // Check for basic auth (JSON with username/password)
    if (source.config.api?.authType === 'basic') {
      try {
        const parsed = JSON.parse(cred.value);
        if (parsed.username && parsed.password) {
          return parsed as BasicAuthCredential;
        }
      } catch {
        // Not JSON, treat as regular credential
      }
    }

    return cred.value;
  }

  // ============================================================
  // Credential ID Resolution
  // ============================================================

  /**
   * Get the credential ID for a source
   *
   * Determines the correct credential type based on:
   * - Source type (mcp, api, local)
   * - Auth type (oauth, bearer, header, etc.)
   */
  getCredentialId(source: LoadedSource): CredentialId {
    const mcp = source.config.mcp;
    const api = source.config.api;

    let type: CredentialId['type'];

    if (source.config.type === 'mcp') {
      type = mcp?.authType === 'bearer' ? 'source_bearer' : 'source_oauth';
    } else if (source.config.type === 'api') {
      // Order matters: provider-specific checks first, then generic OAuth fallback
      if (isApiOAuthProvider(source.config.provider)) {
        type = 'source_oauth';
      } else if (api?.authType === 'oauth') {
        // Generic OAuth API sources — explicit config or auto-discovery
        type = 'source_oauth';
      } else if (api?.authType === 'bearer') {
        type = 'source_bearer';
      } else if (api?.authType === 'basic') {
        type = 'source_basic';
      } else {
        // header, query, or other → stored as apikey
        type = 'source_apikey';
      }
    } else {
      type = 'source_oauth';
    }

    return {
      type,
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };
  }

  // ============================================================
  // Expiry Checking
  // ============================================================

  /**
   * Check if a credential is expired
   */
  isExpired(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    return Date.now() > credential.expiresAt;
  }

  /**
   * Check if a credential needs refresh (within 5 min of expiry)
   */
  needsRefresh(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    const fiveMinutes = 5 * 60 * 1000;
    return Date.now() > credential.expiresAt - fiveMinutes;
  }

  /**
   * Mark a source as needing re-authentication.
   * Called when token is missing/expired or token refresh fails.
   * Updates config.json so the UI shows "needs auth" and the agent gets proper context.
   */
  markSourceNeedsReauth(source: LoadedSource, errorMessage: string): void {
    try {
      const config = loadSourceConfig(source.workspaceRootPath, source.config.slug);
      if (config) {
        config.isAuthenticated = false;
        config.connectionStatus = 'needs_auth';
        config.connectionError = errorMessage;
        saveSourceConfig(source.workspaceRootPath, config);
        debug(`[SourceCredentialManager] Marked ${source.config.slug} as needing re-auth: ${errorMessage}`);
      }
    } catch (error) {
      debug(`[SourceCredentialManager] Failed to mark ${source.config.slug} as needing re-auth:`, error);
    }
  }

  /**
   * Check if source has valid (non-expired) credentials
   */
  async hasValidCredentials(source: LoadedSource): Promise<boolean> {
    const token = await this.getToken(source);
    return token !== null;
  }

  // ============================================================
  // Server-Owned OAuth (Prepare / Exchange)
  // ============================================================

  /**
   * Detect the OAuth provider for a source.
   */
  detectProvider(source: LoadedSource): OAuthProvider {
    // Order matters: provider-specific checks first, then generic OAuth fallback
    if (source.config.provider === 'google') return 'google';
    if (source.config.provider === 'slack') return 'slack';
    if (source.config.provider === 'microsoft') return 'microsoft';
    // Generic OAuth: either explicit oauth config block or authType 'oauth' with auto-discovery
    if (source.config.api?.authType === 'oauth') return 'generic';
    return 'mcp';
  }

  /**
   * Prepare an OAuth flow for a source (server-side).
   *
   * Generates PKCE, state, and auth URL without opening a browser or starting
   * a callback server. The caller provides either callbackPort (Electron local
   * server) or callbackUrl (WebUI server endpoint) for the redirect URI.
   *
   * Returns a PreparedOAuthFlow that should be stored in the flow store
   * and partially returned to the client (authUrl, state, flowId).
   */
  async prepareOAuth(
    source: LoadedSource,
    options: { callbackPort?: number; callbackUrl?: string },
  ): Promise<PreparedOAuthFlow> {
    const { callbackPort } = options;
    const relayReturnTo = options.callbackUrl;
    // When callbackUrl is provided (WebUI), keep the provider-facing redirect_uri
    // stable so providers like Google only need a single registered callback.
    // The relay unwraps the real server callback target from the outer state.
    const providerCallbackUrl = relayReturnTo
      ? OAUTH_RELAY_CALLBACK_URL
      : undefined;
    const provider = this.detectProvider(source);

    let prepared: PreparedOAuthFlow;

    switch (provider) {
      case 'google': {
        const api = source.config.api;
        let service: GoogleService | undefined;
        let scopes: string[] | undefined;

        if (api?.googleScopes && api.googleScopes.length > 0) {
          scopes = api.googleScopes;
        } else if (api?.googleService) {
          service = api.googleService;
        } else {
          service = inferGoogleServiceFromUrl(api?.baseUrl);
          if (!service) {
            throw new Error(
              `Cannot determine Google service for source '${source.config.slug}'. ` +
              `Set googleService in api config.`
            );
          }
        }

        prepared = prepareGoogleOAuth({
          service,
          scopes,
          callbackPort,
          callbackUrl: providerCallbackUrl,
          clientId: api?.googleOAuthClientId,
          clientSecret: api?.googleOAuthClientSecret,
        });
        break;
      }

      case 'slack': {
        const api = source.config.api;
        let service: import('./types.ts').SlackService | undefined;
        let userScopes: string[] | undefined;

        if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
          userScopes = api.slackUserScopes;
        } else if (api?.slackService) {
          service = api.slackService;
        } else {
          service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
        }

        prepared = prepareSlackOAuth({ service, userScopes, callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }

      case 'microsoft': {
        const api = source.config.api;
        let service: MicrosoftService | undefined;
        let scopes: string[] | undefined;

        if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
          scopes = api.microsoftScopes;
        } else if (api?.microsoftService) {
          service = api.microsoftService;
        } else {
          service = inferMicrosoftServiceFromUrl(api?.baseUrl);
          if (!service) {
            throw new Error(
              `Cannot determine Microsoft service for source '${source.config.slug}'. ` +
              `Set microsoftService in api config.`
            );
          }
        }

        prepared = prepareMicrosoftOAuth({ service, scopes, callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }

      case 'generic': {
        const oauthConfig = source.config.api?.oauth;
        if (oauthConfig) {
          // Static config: endpoints provided in config.json
          prepared = prepareGenericOAuth({ oauthConfig, callbackPort, callbackUrl: providerCallbackUrl });
        } else {
          // Auto-discovery: hit baseUrl, discover OAuth metadata via RFC 9728/8414,
          // dynamically register a client — same flow as MCP OAuth.
          const baseUrl = source.config.api?.baseUrl;
          if (!baseUrl) {
            throw new Error(`Source '${source.config.slug}' missing api.baseUrl for OAuth discovery`);
          }
          prepared = await prepareMcpOAuth(baseUrl, { callbackPort, callbackUrl: providerCallbackUrl });
          // Relabel as generic (discovery used MCP internals but this is an API source)
          prepared = { ...prepared, provider: 'generic' };
        }
        break;
      }

      case 'mcp': {
        if (!source.config.mcp?.url) {
          throw new Error('MCP URL not configured');
        }
        prepared = await prepareMcpOAuth(source.config.mcp.url, { callbackPort, callbackUrl: providerCallbackUrl });
        break;
      }
    }

    return relayReturnTo
      ? wrapPreparedOAuthFlowForRelay(prepared, relayReturnTo)
      : prepared;
  }

  /**
   * Exchange an authorization code for tokens and store them (server-side).
   *
   * Called after the client forwards the code from the OAuth callback.
   * Routes to the correct provider exchange, saves credentials, and marks
   * the source as authenticated.
   */
  async exchangeAndStore(
    source: LoadedSource,
    provider: OAuthProvider,
    params: OAuthExchangeParams
  ): Promise<AuthResult> {
    let result: OAuthExchangeResult;

    switch (provider) {
      case 'google':
        result = await exchangeGoogleOAuth(params);
        break;
      case 'slack':
        result = await exchangeSlackOAuth(params);
        break;
      case 'microsoft':
        result = await exchangeMicrosoftOAuth(params);
        break;
      case 'generic':
        result = await exchangeGenericOAuth(params);
        break;
      case 'mcp':
        result = await exchangeMcpOAuth(params);
        break;
    }

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Save credentials
    await this.save(source, {
      value: result.accessToken!,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      clientId: result.oauthClientId,
      clientSecret: result.oauthClientSecret,
    });

    // Mark source as authenticated in config.json
    markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

    debug(`[SourceCredentialManager] OAuth exchange+store complete for ${source.config.slug}`);
    return { success: true, email: result.email };
  }

  // ============================================================
  // OAuth Authentication (Monolithic — convenience wrapper for CLI/test)
  // ============================================================

  /**
   * Authenticate source via OAuth
   *
   * Handles both MCP OAuth and Gmail OAuth flows.
   * On success, credentials are automatically saved.
   */
  async authenticate(
    source: LoadedSource,
    callbacks?: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    const defaultCallbacks: OAuthCallbacks = {
      onStatus: (msg) => debug(`[SourceCredentialManager] ${msg}`),
      onError: (err) => debug(`[SourceCredentialManager] Error: ${err}`),
    };
    const cb = callbacks || defaultCallbacks;

    // Google APIs use Google OAuth
    if (source.config.provider === 'google') {
      return this.authenticateGoogle(source, cb, sessionContext);
    }

    // Slack APIs use Slack OAuth
    if (source.config.provider === 'slack') {
      return this.authenticateSlack(source, cb, sessionContext);
    }

    // Microsoft APIs use Microsoft OAuth
    if (source.config.provider === 'microsoft') {
      return this.authenticateMicrosoft(source, cb, sessionContext);
    }

    // Generic OAuth (explicit config or auto-discovery from baseUrl)
    if (source.config.api?.authType === 'oauth') {
      return this.authenticateGeneric(source, cb, sessionContext);
    }

    // MCP OAuth flow
    if (source.config.type === 'mcp' && source.config.mcp?.authType === 'oauth') {
      return this.authenticateMcp(source, cb, sessionContext);
    }

    return {
      success: false,
      error: `Source ${source.config.slug} does not use OAuth authentication`,
    };
  }

  /**
   * Authenticate MCP source via OAuth
   */
  private async authenticateMcp(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    if (!source.config.mcp?.url) {
      return { success: false, error: 'MCP URL not configured' };
    }

    try {
      const oauth = new CraftOAuth(
        { mcpUrl: source.config.mcp.url },
        callbacks,
        sessionContext
      );

      const { tokens, clientId } = await oauth.authenticate();

      // Save the credentials
      await this.save(source, {
        value: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId,
        tokenType: tokens.tokenType,
      });

      // Mark source as authenticated in config.json
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * Authenticate Google API source via Google OAuth
   *
   * Supports multiple Google services (Gmail, Calendar, Drive) via:
   * - provider: "google" with googleService field
   * - provider: "google" with custom googleScopes
   * - Inferred from baseUrl (e.g., gmail.googleapis.com → gmail)
   */
  private async authenticateGoogle(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // Determine service/scopes from config
      const api = source.config.api;
      let service: GoogleService | undefined;
      let scopes: string[] | undefined;

      if (api?.googleScopes && api.googleScopes.length > 0) {
        // Custom scopes take precedence
        scopes = api.googleScopes;
      } else if (api?.googleService) {
        // Use predefined service scopes
        service = api.googleService;
      } else {
        // Infer from baseUrl
        service = inferGoogleServiceFromUrl(api?.baseUrl);
        if (!service) {
          return {
            success: false,
            error: `Cannot determine Google service for source '${source.config.slug}'. Set googleService ('gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', or 'searchconsole') in api config.`,
          };
        }
      }

      const serviceName = service || 'Google API';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: GoogleOAuthOptions = {
        service,
        scopes,
        appType: 'electron',
        // Pass user-provided OAuth credentials from source config (if available)
        clientId: api?.googleOAuthClientId,
        clientSecret: api?.googleOAuthClientSecret,
        sessionContext,
      };

      const result: GoogleOAuthResult = await startGoogleOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Google OAuth failed' };
      }

      // Save the credentials (including clientId/clientSecret for token refresh)
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        clientId: result.clientId,
        clientSecret: result.clientSecret,
      });

      // Mark source as authenticated in config.json
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      return { success: true, email: result.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * Authenticate Slack API source via Slack OAuth
   *
   * Supports multiple Slack services via:
   * - provider: "slack" with slackService field
   * - provider: "slack" with custom slackBotScopes/slackUserScopes
   * - Inferred from baseUrl (slack.com → full)
   */
  private async authenticateSlack(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // Determine service/scopes from config
      const api = source.config.api;
      let service: SlackService | undefined;
      let userScopes: string[] | undefined;

      if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
        // Custom scopes take precedence
        userScopes = api.slackUserScopes;
      } else if (api?.slackService) {
        // Use predefined service scopes
        service = api.slackService;
      } else {
        // Infer from baseUrl (defaults to 'full')
        service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
      }

      const serviceName = service ? `Slack ${service}` : 'Slack';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: SlackOAuthOptions = {
        service,
        userScopes,
        appType: 'electron',
        sessionContext,
      };

      const result: SlackOAuthResult = await startSlackOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Slack OAuth failed' };
      }

      // Save the credentials
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });

      // Mark source as authenticated in config.json
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      // Use teamName as the identifier (similar to email for Google)
      return { success: true, email: result.teamName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * Authenticate Microsoft API source via Microsoft OAuth
   *
   * Supports multiple Microsoft services (Outlook, OneDrive, Calendar, Teams) via:
   * - provider: "microsoft" with microsoftService field
   * - provider: "microsoft" with custom microsoftScopes
   * - Inferred from baseUrl (e.g., graph.microsoft.com → outlook)
   */
  private async authenticateMicrosoft(
    source: LoadedSource,
    callbacks: OAuthCallbacks,
    sessionContext?: OAuthSessionContext
  ): Promise<AuthResult> {
    try {
      // Determine service/scopes from config
      const api = source.config.api;
      let service: MicrosoftService | undefined;
      let scopes: string[] | undefined;

      if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
        // Custom scopes take precedence
        scopes = api.microsoftScopes;
      } else if (api?.microsoftService) {
        // Use predefined service scopes
        service = api.microsoftService;
      } else {
        // Infer from baseUrl
        service = inferMicrosoftServiceFromUrl(api?.baseUrl);
        if (!service) {
          return {
            success: false,
            error: `Cannot determine Microsoft service for source '${source.config.slug}'. Set microsoftService ('outlook', 'calendar', 'onedrive', 'teams', or 'sharepoint') in api config.`,
          };
        }
      }

      const serviceName = service || 'Microsoft API';
      callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);

      const options: MicrosoftOAuthOptions = {
        service,
        scopes,
        appType: 'electron',
        sessionContext,
      };

      const result: MicrosoftOAuthResult = await startMicrosoftOAuth(options);

      if (!result.success) {
        return { success: false, error: result.error || 'Microsoft OAuth failed' };
      }

      // Save the credentials
      await this.save(source, {
        value: result.accessToken!,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      });

      // Mark source as authenticated in config.json
      markSourceAuthenticated(source.workspaceRootPath, source.config.slug);

      callbacks.onStatus(`${serviceName} authentication successful`);
      return { success: true, email: result.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.onError(message);
      return { success: false, error: message };
    }
  }

  /**
   * Refresh token for a source
   *
   * Returns the new access token, or null if refresh fails.
   * On success, credentials are automatically updated.
   *
   * Uses promise deduplication to prevent concurrent refresh requests for the same source.
   * This is important because:
   * - Multiple API calls may hit refresh simultaneously when token is expiring
   * - Microsoft rotates refresh tokens, so concurrent refreshes could cause token invalidation
   */
  async refresh(source: LoadedSource): Promise<string | null> {
    const key = source.config.slug;

    // Return existing refresh promise if one is in progress
    const pending = this.pendingRefreshes.get(key);
    if (pending) {
      debug(`[SourceCredentialManager] Reusing pending refresh for ${key}`);
      return pending;
    }

    // Create and track new refresh promise
    const refreshPromise = this.doRefresh(source).finally(() => {
      this.pendingRefreshes.delete(key);
    });

    this.pendingRefreshes.set(key, refreshPromise);
    return refreshPromise;
  }

  /**
   * Internal refresh implementation
   */
  private async doRefresh(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred) {
      debug(`[SourceCredentialManager] No credential for ${source.config.slug}`);
      return null;
    }

    // API renew endpoint (non-OAuth token refresh) — check before provider routing.
    // These sources may not have a separate refreshToken; they use the current
    // access token for renewal.
    if (hasRenewEndpoint(source)) {
      return this.refreshApiRenew(source, cred);
    }

    // For all other refresh strategies, a refreshToken is required.
    if (!cred.refreshToken) {
      debug(`[SourceCredentialManager] No refresh token for ${source.config.slug}`);
      return null;
    }

    // Google API refresh
    if (source.config.provider === 'google') {
      return this.refreshGoogle(source, cred);
    }

    // Slack API refresh
    if (source.config.provider === 'slack') {
      return this.refreshSlack(source, cred);
    }

    // Microsoft API refresh
    if (source.config.provider === 'microsoft') {
      return this.refreshMicrosoft(source, cred);
    }

    // Generic OAuth refresh
    if (source.config.api?.authType === 'oauth') {
      if (source.config.api?.oauth?.tokenUrl) {
        // Static config: tokenUrl from config.json
        return this.refreshGeneric(source, cred);
      }
      // Auto-discovered: re-discover token endpoint from baseUrl via MCP OAuth refresh
      if (source.config.api?.baseUrl && cred.clientId) {
        return this.refreshMcp(
          { ...source, config: { ...source.config, type: 'mcp', mcp: { url: source.config.api.baseUrl, authType: 'oauth' } } },
          cred,
        );
      }
      return null;
    }

    // MCP refresh
    if (source.config.type === 'mcp' && source.config.mcp?.url) {
      return this.refreshMcp(source, cred);
    }

    return null;
  }

  /**
   * Refresh token via a custom API renew endpoint (non-OAuth).
   * Uses the current access token for renewal — no separate refresh token needed.
   */
  private async refreshApiRenew(
    source: LoadedSource,
    cred: StoredCredential,
  ): Promise<string | null> {
    const renewConfig = source.config.api?.renewEndpoint;
    if (!renewConfig?.path) return null;

    const baseUrl = source.config.api!.baseUrl;
    const authScheme = source.config.api!.authScheme;
    const currentToken = cred.value;

    try {
      // 1. Resolve URL
      const url = renewConfig.path.startsWith('http')
        ? renewConfig.path
        : new URL(renewConfig.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();

      // 2. Build headers: defaultHeaders < renewEndpoint.headers < Authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...source.config.api!.defaultHeaders,
        ...substituteTokenInHeaders(renewConfig.headers, currentToken),
      };
      // Add Authorization unless explicitly overridden in renewEndpoint.headers
      if (!renewConfig.headers?.['Authorization'] && !renewConfig.headers?.['authorization']) {
        headers['Authorization'] = buildAuthorizationHeader(authScheme, currentToken);
      }

      // 3. Build body with {{token}} substitution
      const method = renewConfig.method ?? 'POST';
      const fetchOptions: RequestInit = { method, headers };
      if (renewConfig.body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(substituteTokenInBody(renewConfig.body, currentToken));
      }

      // 4. Execute
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Renew endpoint returned ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // 5. Extract new token
      const tokenField = renewConfig.tokenField ?? 'access_token';
      const newToken = json[tokenField];
      if (typeof newToken !== 'string' || !newToken) {
        throw new Error(`Renew response missing "${tokenField}" field`);
      }

      // 6. Extract expiry
      const expiresInField = renewConfig.expiresInField ?? 'expires_in';
      const expiresInRaw = json[expiresInField];
      let expiresAt: number | undefined;
      if (typeof expiresInRaw === 'number' && expiresInRaw > 0) {
        expiresAt = Date.now() + expiresInRaw * 1000;
      } else if (renewConfig.fallbackTtlSecs) {
        expiresAt = Date.now() + renewConfig.fallbackTtlSecs * 1000;
      }
      // If neither is available, expiresAt stays undefined — needsRefresh() will
      // trigger refresh on next session start (safe but noisy).

      // 7. Save updated credential
      await this.save(source, {
        ...cred,
        value: newToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });

      debug(`[SourceCredentialManager] Refreshed token via renew endpoint for ${source.config.slug}`);
      return newToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Renew endpoint refresh failed for ${source.config.slug}:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Refresh Google OAuth token
   */
  private async refreshGoogle(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      // Pass stored credentials (or fall back to env vars via undefined)
      const result = await refreshGoogleToken(
        cred.refreshToken!,
        cred.clientId,
        cred.clientSecret
      );

      // Update stored credentials
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Google token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Google token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Refresh Slack OAuth token
   */
  private async refreshSlack(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      const result = await refreshSlackToken(cred.refreshToken!, cred.clientId);

      // Update stored credentials
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Slack token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Slack token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Refresh Microsoft OAuth token
   */
  private async refreshMicrosoft(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    try {
      const result = await refreshMicrosoftToken(cred.refreshToken!);

      // Update stored credentials (Microsoft may rotate refresh tokens)
      await this.save(source, {
        ...cred,
        value: result.accessToken,
        refreshToken: result.refreshToken || cred.refreshToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed Microsoft token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Microsoft token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Authenticate source via generic OAuth flow (CLI/test convenience wrapper).
   * Note: The session-based UI flow goes through prepareOAuth() + exchangeAndStore() instead.
   */
  private async authenticateGeneric(
    source: LoadedSource,
    _cb: OAuthCallbacks,
    _sessionContext?: OAuthSessionContext,
  ): Promise<AuthResult> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig) {
      return { success: false, error: 'Source missing api.oauth config block' };
    }

    // CLI generic OAuth is not yet implemented — the desktop app handles this
    // through the source_oauth_trigger → prepareOAuth → exchangeAndStore pipeline.
    return { success: false, error: 'Generic OAuth CLI flow not supported — use the desktop app or source_oauth_trigger tool' };
  }

  /**
   * Refresh generic OAuth token.
   * tokenUrl from source config, clientId/clientSecret from stored credential falling back to config.
   */
  private async refreshGeneric(
    source: LoadedSource,
    cred: StoredCredential,
  ): Promise<string | null> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig?.tokenUrl) {
      debug(`[SourceCredentialManager] No tokenUrl in config for generic OAuth refresh`);
      this.markSourceNeedsReauth(source, 'Missing tokenUrl in api.oauth config');
      return null;
    }

    try {
      const result = await refreshGenericOAuthToken(
        cred.refreshToken!,
        oauthConfig.tokenUrl,
        cred.clientId || oauthConfig.clientId,
        cred.clientSecret || oauthConfig.clientSecret,
      );

      await this.save(source, {
        ...cred,
        value: result.accessToken,
        refreshToken: result.refreshToken || cred.refreshToken,
        expiresAt: result.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed generic OAuth token for ${source.config.slug}`);
      return result.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Generic OAuth token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Refresh MCP OAuth token
   */
  private async refreshMcp(
    source: LoadedSource,
    cred: StoredCredential
  ): Promise<string | null> {
    if (!cred.clientId) {
      debug(`[SourceCredentialManager] No clientId for MCP token refresh`);
      this.markSourceNeedsReauth(source, 'Missing clientId for token refresh');
      return null;
    }

    try {
      // Only HTTP/SSE transport can refresh tokens - stdio doesn't use OAuth
      if (!source.config.mcp?.url) {
        // This is expected for stdio transport - not an error
        debug(`[SourceCredentialManager] No URL for MCP token refresh (stdio transport)`);
        return null;
      }

      const oauth = new CraftOAuth(
        { mcpUrl: source.config.mcp.url },
        {
          onStatus: () => {},
          onError: () => {},
        }
      );

      const tokens = await oauth.refreshAccessToken(cred.refreshToken!, cred.clientId);

      // Update stored credentials
      await this.save(source, {
        ...cred,
        value: tokens.accessToken,
        refreshToken: tokens.refreshToken || cred.refreshToken,
        expiresAt: tokens.expiresAt,
      });

      debug(`[SourceCredentialManager] Refreshed MCP token for ${source.config.slug}`);
      return tokens.accessToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] MCP token refresh failed:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }
}

// ============================================================
// Token substitution helpers for renew endpoint
// ============================================================

/**
 * Recursively substitute {{token}} in string leaves of an object.
 * Supports nested objects and arrays.
 */
function substituteTokenInBody(obj: Record<string, unknown>, token: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\{\{token\}\}/g, token);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? item.replace(/\{\{token\}\}/g, token) :
          (item && typeof item === 'object' ? substituteTokenInBody(item as Record<string, unknown>, token) : item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = substituteTokenInBody(value as Record<string, unknown>, token);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Substitute {{token}} in header values.
 */
function substituteTokenInHeaders(
  headers: Record<string, string> | undefined,
  token: string,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\{\{token\}\}/g, token);
  }
  return result;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Check if a single source needs authentication.
 * Returns true if the source requires auth but isn't yet authenticated.
 *
 * This is the **inverse** of the auth portion of isSourceUsable().
 * - isSourceUsable() → Is the source ready to use? (enabled AND auth OK)
 * - sourceNeedsAuthentication() → Does the source need auth to become usable?
 *
 * Use this to prompt users for authentication, not for filtering sources.
 * For filtering sources, use isSourceUsable() from storage.ts.
 *
 * This correctly handles:
 * - MCP sources with authType: "none" → never needs auth
 * - MCP sources with stdio transport → never needs auth (runs locally)
 * - MCP sources with oauth/bearer → needs auth if not authenticated
 * - API sources with authType: "none" → never needs auth
 * - API sources with bearer/basic/header/query auth → needs auth if not authenticated
 */
export function sourceNeedsAuthentication(source: LoadedSource): boolean {
  const mcp = source.config.mcp;
  const api = source.config.api;

  // MCP sources with oauth/bearer auth (stdio transport never needs auth)
  if (source.config.type === 'mcp' && mcp) {
    if (mcp.transport === 'stdio') {
      // Stdio sources run locally and don't need authentication
      return false;
    }
    // Only require auth if authType is explicitly set to 'oauth' or 'bearer'
    // Undefined or 'none' means no authentication required
    if (mcp.authType && mcp.authType !== 'none' && !source.config.isAuthenticated) {
      return true;
    }
  }

  // API sources with auth requirements
  if (source.config.type === 'api' && api) {
    if (api.authType !== 'none' && api.authType !== undefined && !source.config.isAuthenticated) {
      return true;
    }
  }

  return false;
}

/**
 * Get sources that need authentication
 * Returns enabled sources that require auth but aren't yet authenticated
 */
export function getSourcesNeedingAuth(sources: LoadedSource[]): LoadedSource[] {
  return sources.filter((source) => {
    if (!source.config.enabled) return false;
    return sourceNeedsAuthentication(source);
  });
}

// Singleton instance
let instance: SourceCredentialManager | null = null;

/**
 * Get shared SourceCredentialManager instance
 */
export function getSourceCredentialManager(): SourceCredentialManager {
  if (!instance) {
    instance = new SourceCredentialManager();
  }
  return instance;
}
