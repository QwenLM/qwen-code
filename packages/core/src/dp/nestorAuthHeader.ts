import {
  BLAZE_DP_JWT_ENV,
  LEGACY_NESSY_DP_AUTH_TOKEN_ENV,
} from './dpConfig.js';

/**
 * Nestor accepts two auth conventions:
 * - Nestor-issued JWT from DP token exchange: `Nestor-Token: <jwt>`.
 * - Delegated Spirit IAM JWT supplied by env: `Authorization: Bearer <jwt>`.
 */
export function buildNestorAuthHeaders(jwt: string): Record<string, string> {
  const delegatedToken =
    process.env[BLAZE_DP_JWT_ENV] ||
    process.env[LEGACY_NESSY_DP_AUTH_TOKEN_ENV];
  if (delegatedToken && delegatedToken === jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  return { 'Nestor-Token': jwt };
}
