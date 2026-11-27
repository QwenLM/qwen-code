/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveEnvVarsInString } from '@qwen-code/qwen-code-core/envVarResolver';
import {
  credentialNameFilter,
  findCredentialAliases,
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
type GetSelectorEnvironment = () => Readonly<Record<string, string>>;
const settingsCredentialSelectors = new WeakMap<
  object,
  {
    selectors: readonly string[];
    settingsEnv: Readonly<Record<string, unknown>> | undefined;
    substitutions: ReadonlyArray<readonly [string, string]>;
  }
>();
// Keep the credential classification for the value actually installed.
const installedCredentialAliases = new Map<string, string>();

export function envKeyIdentity(key: string): string {
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

export function registerSettingsCredentialSelectors(
  settings: object,
  selectors: readonly string[],
  settingsEnv: Readonly<Record<string, unknown>> | undefined,
  substitutions: ReadonlyArray<readonly [string, string]>,
): void {
  settingsCredentialSelectors.set(settings, {
    selectors,
    settingsEnv,
    substitutions,
  });
}

function settingsCredentialNameFilter(
  settings: object,
  getSelectorEnvironment?: GetSelectorEnvironment,
): (name: string) => boolean {
  const references = settingsCredentialReferences.get(settings) ?? [];
  const selectors = settingsCredentialSelectors.get(settings)?.selectors;
  if (!selectors)
    return credentialNameFilter([settings], references, envKeyIdentity);
  const sourceEnv = getSelectorEnvironment?.();
  const names = [...references];
  for (const selector of selectors) {
    const name = resolveEnvVarsInString(selector, sourceEnv, {
      processEnvFallback: sourceEnv === undefined,
    });
    names.push(name, name.trim());
  }
  return credentialNameFilter([settings], names, envKeyIdentity);
}

export function getLateSettingsCredentialAliases(
  settings: object,
  getSelectorEnvironment?: GetSelectorEnvironment,
): ReadonlySet<string> | undefined {
  const metadata = settingsCredentialSelectors.get(settings);
  if (!metadata?.settingsEnv || !metadata.substitutions.length)
    return undefined;
  return findCredentialAliases(
    metadata.settingsEnv,
    metadata.substitutions,
    settingsCredentialNameFilter(settings, getSelectorEnvironment),
  );
}

export function* settingsCredentialSourceEntries(
  settings: object,
  env: Readonly<NodeJS.ProcessEnv>,
  getSelectorEnvironment?: GetSelectorEnvironment,
): Generator<[string, string]> {
  const hidden = settingsCredentialNameFilter(settings, getSelectorEnvironment);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && hidden(key) && !isCredentialName(key)) {
      yield [key, value];
    }
  }
}

// The process environment can change before existing sessions update settings.
export function recordSettingsCredentialSources(
  settings: object,
  installedSettingsKeys: Iterable<string> = [],
): void {
  const lateAliases = getLateSettingsCredentialAliases(settings);
  for (const key of installedSettingsKeys) {
    const value = process.env[key];
    if (lateAliases?.has(key) && value !== undefined) {
      installedCredentialAliases.set(envKeyIdentity(key), value);
    }
  }
  for (const [key, value] of settingsCredentialSourceEntries(
    settings,
    process.env,
  )) {
    installedCredentialAliases.set(envKeyIdentity(key), value);
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
