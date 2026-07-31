/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0
 *
 * Implements RFC 7636 for secure authorization code exchange.
 */

import crypto from 'crypto';

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generate a PKCE code verifier and challenge pair.
 *
 * The code verifier is a cryptographically random string.
 * The code challenge is a base64url-encoded SHA256 hash of the verifier.
 *
 * @returns PKCE challenge pair
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Generate a cryptographically secure state parameter for CSRF protection.
 *
 * @returns Random state string
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}
