/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { MCPOAuthProvider, type MCPOAuthConfig } from './provider.js';
import { MCPOAuthTokenStorage } from '../../oauth-token-storage.js';
import type { OAuthToken } from '../../token-storage/types.js';
import { buildMcpClientMetadata } from './utils.js';
import { runLogger } from '../../../utils/runLogger.js';
import { BRAND_PROTOCOL_NAMESPACE } from '../../../config/brand.js';

/**
 * Dynamically provides OAuth tokens to the SDK transport on every request,
 * enabling automatic token refresh when tokens expire mid-session.
 */
export class McpOAuthTokenProvider implements OAuthClientProvider {
  private readonly mcpAuthProvider: MCPOAuthProvider;
  private readonly tokenStorage: MCPOAuthTokenStorage;
  private cachedToken?: OAuthTokens;
  private cacheExpiresAt = 0;
  private cachedClientId?: string;
  /** Bumped by every save and clear; see {@link fetchTokens}. */
  private generation = 0;
  /** The fetch in progress, shared by concurrent callers. */
  private pending?: Promise<OAuthTokens | undefined>;
  /**
   * The token behind what {@link tokens} last handed out, taken as the one
   * an SDK refresh started from. The SDK may run two refreshes at once; a
   * late one can then be matched to a token handed out after it began. The
   * stored-state check bounds the damage: only a token this instance handed
   * out can be replaced or removed.
   */
  private handedOut?: OAuthToken;

  // Must be truthy so the SDK treats this as an interactive-flow provider
  // and reaches the refresh_token path in authInternal(). Never used for
  // actual redirection (redirectToAuthorization is a no-op).
  readonly redirectUrl = `urn:${BRAND_PROTOCOL_NAMESPACE}:oauth:token-provider`;

  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    private readonly serverName: string,
    private readonly oauthConfig: MCPOAuthConfig,
    tokenStorage: MCPOAuthTokenStorage = new MCPOAuthTokenStorage(),
  ) {
    this.tokenStorage = tokenStorage;
    this.mcpAuthProvider = new MCPOAuthProvider(this.tokenStorage);
    this.clientMetadata = buildMcpClientMetadata(serverName);
  }

  /**
   * The tokens to use now. Concurrent callers share one fetch, so a token
   * expiring under several requests is refreshed once. A token only counts
   * when no save or clear came in while it was fetched; after a change the
   * fetch reads storage again, and gives up — no token rather than a stale
   * one — if changes keep coming.
   *
   * The result is also kept briefly because every transport request asks for
   * tokens and reading the OS keychain each time is costly. That is only an
   * optimisation: every save and clear drops it, and nothing decides
   * validity from it.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedToken && Date.now() < this.cacheExpiresAt) {
      return this.cachedToken;
    }
    this.pending ??= this.readTokens();
    return this.pending;
  }

  private readTokens(): Promise<OAuthTokens | undefined> {
    const pending = this.fetchTokens().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }

  /** One fetch: a preemptive refresh on the first attempt, then storage. */
  private async fetchTokens(): Promise<OAuthTokens | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = this.generation;
      const token =
        (attempt === 0 ? await this.refreshedToken() : undefined) ??
        (await this.tokenStorage.getCredentials(this.serverName))?.token;
      // No await from this check on: nothing can change before it is used.
      if (generation === this.generation) return this.handOut(token);
    }
    runLogger.warn(
      `McpOAuthTokenProvider: token lookup for '${this.serverName}' abandoned after 3 concurrent credential changes`,
    );
    return undefined;
  }

  /**
   * A preemptive refresh (cross-process-safe via the refresh lock), used as
   * returned: it may not have been saved. Undefined when there is no valid
   * token; what is stored then still goes to the SDK, as an expired token
   * with a refresh token lets it refresh.
   */
  private async refreshedToken(): Promise<OAuthToken | undefined> {
    try {
      return (
        (await this.mcpAuthProvider.getValidOAuthToken(
          this.serverName,
          this.oauthConfig,
        )) ?? undefined
      );
    } catch (error) {
      runLogger.log(
        `McpOAuthTokenProvider: proactive refresh failed for '${this.serverName}': ${error}`,
      );
      return undefined;
    }
  }

  /** Converts, caches and records `token` as handed out. Synchronous. */
  private handOut(token: OAuthToken | undefined): OAuthTokens | undefined {
    if (!token || (this.tokenStorage.isTokenExpired(token) && !token.refreshToken)) {
      this.invalidateCache();
      return undefined;
    }

    const sdkTokens: OAuthTokens = {
      access_token: token.accessToken,
      token_type: token.tokenType || 'Bearer',
    };

    if (token.refreshToken) {
      sdkTokens.refresh_token = token.refreshToken;
    }

    if (token.expiresAt) {
      sdkTokens.expires_in = Math.max(
        0,
        Math.floor((token.expiresAt - Date.now()) / 1000),
      );
    }

    if (token.scope) {
      sdkTokens.scope = token.scope;
    }

    this.handedOut = token;
    this.cachedToken = sdkTokens;
    this.cacheExpiresAt = Date.now() + 60_000;
    return sdkTokens;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.cachedClientId) {
      return { client_id: this.cachedClientId };
    }
    const credentials = await this.tokenStorage.getCredentials(
      this.serverName,
    );
    const clientId =
      credentials?.clientId ?? this.oauthConfig.clientId;
    if (clientId) {
      this.cachedClientId = clientId;
      return { client_id: clientId };
    }
    return undefined;
  }

  // Client info is persisted during OAuth authentication; this SDK callback is
  // a no-op here.
  saveClientInformation(_clientInformation: OAuthClientInformation): void {}

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const oauthToken: OAuthToken = {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type || 'Bearer',
    };

    if (tokens.refresh_token) {
      oauthToken.refreshToken = tokens.refresh_token;
    }

    if (tokens.expires_in !== undefined) {
      oauthToken.expiresAt = Date.now() + tokens.expires_in * 1000;
    }

    if (tokens.scope) {
      oauthToken.scope = tokens.scope;
    }

    // The SDK refreshed the token it was handed, so that is the one these
    // replace: when the stored one is no longer it — cleared or signed in
    // again meanwhile — that is the newer state and nothing is saved.
    const refreshedFrom = this.handedOut;
    if (!refreshedFrom) {
      runLogger.debug(
        `McpOAuthTokenProvider: SDK token save for '${this.serverName}' skipped because no token was handed out`,
      );
      this.invalidateCache();
      return;
    }
    const existing = await this.tokenStorage.getCredentials(this.serverName);

    try {
      await this.tokenStorage.saveRefreshedToken(
        this.serverName,
        refreshedFrom,
        oauthToken,
        existing?.clientId ?? this.oauthConfig.clientId,
        existing?.tokenUrl ?? this.oauthConfig.tokenUrl,
        existing?.mcpServerUrl,
        existing?.resource ?? this.oauthConfig.resource,
      );
    } finally {
      // The SDK refreshed because the cached token was rejected; it is no
      // use whether or not the new one was stored.
      this.invalidateCache();
    }
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    // The SDK calls this when the server rejected the credentials it was
    // handed, so those are what go — not a sign-in made since.
    const rejected = this.handedOut;
    try {
      if ((scope === 'all' || scope === 'tokens') && rejected) {
        await this.tokenStorage.deleteInvalidToken(this.serverName, rejected);
      }
    } finally {
      // A clear that failed still ends what this instance hands out.
      if (scope === 'all' || scope === 'client') {
        this.cachedClientId = undefined;
      }
      this.invalidateCache();
    }
  }

  async redirectToAuthorization(_authorizationUrl: URL): Promise<void> {}

  saveCodeVerifier(_codeVerifier: string): void {}

  codeVerifier(): string {
    return '';
  }

  /** Also ends the validity of whatever a `tokens()` still in flight found. */
  private invalidateCache(): void {
    this.cachedToken = undefined;
    this.cacheExpiresAt = 0;
    this.generation += 1;
  }
}
