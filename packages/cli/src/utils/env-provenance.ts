/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  credentialNameFilter,
  isCredentialName,
  MIN_CREDENTIAL_VALUE_LENGTH,
} from './credential-names.js';

export const PRIVATE_RELAUNCH_ENV_PROVENANCE =
  'QWEN_CODE_PRIVATE_RELAUNCH_ENV_PROVENANCE';

// Set only on a child that a relaunch supervisor spawned with an IPC channel.
export const RELAUNCH_SUPERVISED_ENV = 'QWEN_CODE_RELAUNCH_SUPERVISED';

export const CHECKED_NODE_VERSION_ENV = 'QWEN_CODE_CHECKED_NODE_VERSION';

export const NPM_RUNTIME_CONTEXT = 'QWEN_CODE_NPM_RUNTIME_CONTEXT';

interface RelaunchEnvProvenance {
  dotEnv: string[];
  settingsEnv: string[];
  credentialAliases?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string');
}

export function parseRelaunchEnvProvenance(
  encoded: string | undefined,
): RelaunchEnvProvenance | undefined {
  if (!encoded) return undefined;
  const sources: unknown = JSON.parse(encoded);
  if (
    !sources ||
    typeof sources !== 'object' ||
    !('dotEnv' in sources) ||
    !('settingsEnv' in sources) ||
    !isStringArray(sources.dotEnv) ||
    !isStringArray(sources.settingsEnv)
  ) {
    throw new Error('Invalid inherited environment provenance.');
  }
  const credentialAliases =
    'credentialAliases' in sources ? sources.credentialAliases : undefined;
  if (credentialAliases !== undefined && !isStringArray(credentialAliases)) {
    throw new Error('Invalid inherited environment provenance.');
  }
  return {
    dotEnv: sources.dotEnv,
    settingsEnv: sources.settingsEnv,
    credentialAliases,
  };
}

export function writeRelaunchCredentialAliases(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): void {
  const provenance = parseRelaunchEnvProvenance(
    env[PRIVATE_RELAUNCH_ENV_PROVENANCE],
  );
  if (!provenance?.credentialAliases && !names.length) return;
  env[PRIVATE_RELAUNCH_ENV_PROVENANCE] = JSON.stringify({
    dotEnv: provenance?.dotEnv ?? [],
    settingsEnv: provenance?.settingsEnv ?? [],
    ...(names.length > 0 && { credentialAliases: names }),
  });
}

const settingsCredentialAliases = new WeakMap<object, ReadonlySet<string>>();
const settingsCredentialReferences = new WeakMap<object, readonly string[]>();
// Keep the credential classification for the value actually installed.
const installedCredentialAliases = new Map<string, string>();

function envKeyIdentity(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

export function registerSettingsCredentialAliases(
  settings: object,
  aliases: ReadonlySet<string>,
): void {
  if (aliases.size) settingsCredentialAliases.set(settings, aliases);
}

export function isSettingsCredentialAlias(
  settings: object,
  key: string,
): boolean {
  return settingsCredentialAliases.get(settings)?.has(key) === true;
}

export function registerSettingsCredentialReferences(
  settings: object,
  names: readonly string[],
): void {
  if (names.length) settingsCredentialReferences.set(settings, names);
}

// The process environment can change before existing sessions update settings.
export function recordSettingsCredentialSources(settings: object): void {
  const hidden = credentialNameFilter(
    [settings],
    settingsCredentialReferences.get(settings) ?? [],
  );
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isCredentialName(key) && hidden(key)) {
      installedCredentialAliases.set(envKeyIdentity(key), value);
    }
  }
}

export function recordCredentialAliasWrite(
  key: string,
  settings?: object,
): void {
  const identity = envKeyIdentity(key);
  const value = process.env[key];
  if (
    value !== undefined &&
    value.length >= MIN_CREDENTIAL_VALUE_LENGTH &&
    settings &&
    isSettingsCredentialAlias(settings, key)
  ) {
    installedCredentialAliases.set(identity, value);
  } else if (installedCredentialAliases.get(identity) !== value) {
    installedCredentialAliases.delete(identity);
  }
}

export function restoreCredentialAliases(names: readonly string[]): void {
  for (const key of names) {
    const value = process.env[key];
    if (value !== undefined)
      installedCredentialAliases.set(envKeyIdentity(key), value);
  }
}

export function liveCredentialAliases(): ReadonlyMap<string, string> {
  for (const [key, value] of installedCredentialAliases) {
    if (process.env[key] !== value) installedCredentialAliases.delete(key);
  }
  return installedCredentialAliases;
}

export function resetCredentialAliasesForTesting(): void {
  installedCredentialAliases.clear();
}
