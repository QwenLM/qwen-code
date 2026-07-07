/**
 * Shared types for the server-owned OAuth prepare/exchange flow.
 *
 * These types decouple the two halves of an OAuth flow:
 *   1. prepare  — build the authUrl + PKCE (server-side)
 *   2. exchange — swap the authorization code for tokens (server-side)
 *
 * The client's only job is to open the browser and forward the code.
 */

export type OAuthProvider = 'mcp' | 'google' | 'slack' | 'microsoft' | 'generic'

/**
 * Everything the server produces during the "prepare" phase.
 * Stored in the OAuthFlowStore and used later during "exchange".
 */
export interface PreparedOAuthFlow {
  authUrl: string
  state: string
  codeVerifier: string       // PKCE verifier (empty string for providers that don't use PKCE)
  tokenEndpoint: string
  clientId: string
  clientSecret?: string      // Google requires client_secret for Desktop apps
  redirectUri: string        // provider-specific redirect URI used in auth URL + token exchange
  provider: OAuthProvider
}

/**
 * Parameters needed to exchange an authorization code for tokens.
 * These come from the flow store (populated during prepare) + the code from the client.
 */
export interface OAuthExchangeParams {
  code: string
  codeVerifier: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  redirectUri: string
}

/**
 * Raw result from a provider's token exchange.
 * Contains the actual tokens — only the server sees this.
 */
export interface OAuthExchangeResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  /** Identifier for the authenticated user/workspace (Google email, Slack teamName, Microsoft UPN) */
  email?: string
  /** OAuth client_id for storage (MCP dynamic registration) */
  oauthClientId?: string
  /** OAuth client_secret for storage (Google needs it for refresh) */
  oauthClientSecret?: string
  error?: string
}
