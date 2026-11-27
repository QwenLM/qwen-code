/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEnvVarReferences } from '@qwen-code/qwen-code-core/envVarResolver';

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

function collectStringSettings(
  value: unknown,
  visit: (key: string, value: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStringSettings(item, visit);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') {
        visit(key, item);
      } else {
        collectStringSettings(item, visit);
      }
    }
  }
}

export function configuredCredentialVariables(settings: unknown): Set<string> {
  const names = new Set<string>();
  collectStringSettings(settings, (key, value) => {
    if (CREDENTIAL_VARIABLE_FIELD.test(key)) names.add(value);
  });
  return names;
}

export function credentialFieldReferences(
  settings: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const addReferences = (value: string) => {
    for (const name of getEnvVarReferences(value)) names.add(name);
  };
  collectStringSettings(settings, (key, value) => {
    if (isCredentialName(key)) addReferences(value);
  });
  const servers = settings['mcpServers'];
  if (servers && typeof servers === 'object') {
    for (const server of Object.values(servers) as unknown[]) {
      if (server && typeof server === 'object' && 'headers' in server) {
        collectStringSettings(server.headers, (_key, value) =>
          addReferences(value),
        );
      }
    }
  }
  return names;
}

export function credentialNameFilter(
  scopes: unknown[],
  references: Iterable<string>,
): (name: string) => boolean {
  const names = new Set(
    [...configuredCredentialVariables(scopes), ...references].map((name) =>
      name.toUpperCase(),
    ),
  );
  return (name) => isCredentialName(name) || names.has(name.toUpperCase());
}

export function findCredentialAliases(
  env: Readonly<Record<string, unknown>>,
  substitutions: Iterable<readonly [string, string]>,
  hidden: (name: string) => boolean,
): Set<string> {
  const secretValues = [...substitutions]
    .filter(
      ([name, value]) =>
        value.length >= MIN_CREDENTIAL_VALUE_LENGTH && hidden(name),
    )
    .map(([, value]) => value);
  const aliases = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === 'string' &&
      secretValues.some((secret) => value.includes(secret))
    ) {
      aliases.add(key);
    }
  }
  return aliases;
}
