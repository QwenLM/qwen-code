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
  return CREDENTIAL_WORDS.test(
    name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]/g, '_'),
  );
}
