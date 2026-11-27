/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const CREDENTIAL_WORDS =
  /(^|_)(TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSWORD|PASSWD|PASSPHRASE|BASIC_AUTH|AUTH_TOKEN|AUTHORIZATION|SESSION_SECRET|SESSION_TOKEN|SESSION_KEY|SESSION_COOKIE|DSN|CONNECTION_STRING)($|_)/i;

/**
 * Whether a variable, settings key or header by this name holds a
 * credential, in any spelling: `OPENAI_API_KEY`, `apiKey`, `X-Api-Key`.
 */
export function isCredentialName(name: string): boolean {
  return (
    CREDENTIAL_WORDS.test(name) ||
    CREDENTIAL_WORDS.test(
      name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]/g, '_'),
    )
  );
}

const CREDENTIAL_VARIABLE_FIELD = /^envKey$|Env$/;
export const MIN_CREDENTIAL_VALUE_LENGTH = 4;

function collectCredentialVariables(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialVariables(item, names);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && CREDENTIAL_VARIABLE_FIELD.test(key)) {
        names.add(item.toUpperCase());
      } else {
        collectCredentialVariables(item, names);
      }
    }
  }
}

export function credentialNameFilter(
  scopes: unknown[],
): (name: string) => boolean {
  const names = new Set<string>();
  collectCredentialVariables(scopes, names);
  return (name) => isCredentialName(name) || names.has(name.toUpperCase());
}
