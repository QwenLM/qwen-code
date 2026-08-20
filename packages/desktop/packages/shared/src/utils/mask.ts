/**
 * Credential masking utilities
 *
 * Provides consistent masking of sensitive credentials for display.
 */

export type CredentialType = 'api_key' | 'oauth_token' | 'generic';

export interface MaskOptions {
  /** Type of credential for type-specific masking */
  type?: CredentialType;
  /** Text to show when value is null/undefined */
  notSetText?: string;
}

/**
 * Mask a credential value for safe display.
 *
 * - For API keys (sk-qwen-...): shows first 7 chars + last 4
 * - For OAuth tokens: shows first 3 chars + last 3
 * - For generic/unknown: shows first 3 chars + last 3
 * - For null/undefined: returns notSetText (default: '(not set)')
 * - For short values: returns asterisks
 *
 * @param value - The credential value to mask
 * @param options - Masking options
 * @returns Masked credential string
 */
export function maskCredential(
  value: string | undefined | null,
  options: MaskOptions = {}
): string {
  const { type = 'generic', notSetText = '(not set)' } = options;

  if (!value) {
    return notSetText;
  }

  // API keys get special treatment to show recognizable prefix
  if (type === 'api_key') {
    if (value.length > 11) {
      return `${value.slice(0, 7)}...${value.slice(-4)}`;
    }
    if (value.length > 4) {
      return `${value.slice(0, 4)}...`;
    }
    return '******';
  }

  // OAuth tokens and generic credentials
  if (value.length > 6) {
    return `${value.slice(0, 3)}...${value.slice(-3)}`;
  }

  return '******';
}
