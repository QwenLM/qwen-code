/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { ExtensionStorage } from './storage.js';
import type { ExtensionConfig } from './extensionManager.js';
import prompts from 'prompts';
import { EXTENSION_SETTINGS_FILENAME } from './variables.js';
import { HybridTokenStorage } from '../mcp/token-storage/hybrid-token-storage.js';
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import {
  TokenStorageType,
  type SecretStorage,
} from '../mcp/token-storage/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { atomicWriteFile, atomicWriteJSON } from '../utils/atomicFileWrite.js';

const debugLogger = createDebugLogger('EXT_SETTINGS');

export interface ExtensionSetting {
  name: string;
  description: string;
  envVar: string;
  sensitive?: boolean;
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTINGS_SELECTOR_FILENAME = '.qwen-extension-settings.json';
const SETTINGS_BUNDLE_PREFIX = '$qwen:extension-settings:v2:';

interface ExtensionSettingsSelector {
  version: 1;
  backend: TokenStorageType;
  bundleKey: string;
}

function getSettingsSelectorPath(
  extensionName: string,
  envFilePathOverride?: string,
): string {
  return path.join(
    envFilePathOverride
      ? path.dirname(envFilePathOverride)
      : new ExtensionStorage(extensionName).getExtensionDir(),
    SETTINGS_SELECTOR_FILENAME,
  );
}

async function readSettingsSelector(
  extensionName: string,
): Promise<ExtensionSettingsSelector | undefined> {
  const selectorPath = getSettingsSelectorPath(extensionName);
  if (!fsSync.existsSync(selectorPath)) return undefined;
  const parsed: unknown = JSON.parse(await fs.readFile(selectorPath, 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('backend' in parsed) ||
    !Object.values(TokenStorageType).includes(
      parsed.backend as TokenStorageType,
    ) ||
    !('bundleKey' in parsed) ||
    typeof parsed.bundleKey !== 'string' ||
    !parsed.bundleKey.startsWith(SETTINGS_BUNDLE_PREFIX)
  ) {
    throw new Error('Stored extension settings selector is invalid.');
  }
  return parsed as ExtensionSettingsSelector;
}

function createSelectedStorage(
  serviceName: string,
  backend: TokenStorageType,
): SecretStorage {
  return backend === TokenStorageType.KEYCHAIN
    ? new KeychainTokenStorage(serviceName)
    : new FileTokenStorage(serviceName);
}

async function deleteSettingsSnapshot(
  selector: ExtensionSettingsSelector,
  serviceName: string,
): Promise<void> {
  const storage = createSelectedStorage(serviceName, selector.backend);
  if ((await storage.getSecret(selector.bundleKey)) !== null) {
    await storage.deleteSecret(selector.bundleKey);
  }
  const keys = await storage.listSecrets();
  for (const key of keys) {
    if (key.startsWith(`${selector.bundleKey}:override:`)) {
      await storage.deleteSecret(key);
    }
  }
}

function parseSensitiveSettingsBundle(content: string): Record<string, string> {
  const parsed: unknown = JSON.parse(content);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new Error('Stored extension settings bundle is invalid.');
  }
  return parsed as Record<string, string>;
}

export function validateExtensionSettingEnvVars(
  settings: readonly ExtensionSetting[] | undefined,
): void {
  if (settings?.some((setting) => !ENV_VAR_NAME_PATTERN.test(setting.envVar))) {
    throw new Error(
      'Extension setting "envVar" must be a valid environment variable name.',
    );
  }
}

export interface ResolvedExtensionSetting {
  name: string;
  envVar: string;
  value: string;
  sensitive: boolean;
}

export enum ExtensionSettingScope {
  USER = 'user',
  WORKSPACE = 'workspace',
}

export interface PreparedExtensionSettingsMutation {
  commit(): Promise<void>;
  discard(): Promise<void>;
}

export interface ExtensionSetting {
  name: string;
  description: string;
  envVar: string;
  // NOTE: If no value is set, this setting will be considered NOT sensitive.
  sensitive?: boolean;
}

const getKeychainStorageName = (
  extensionName: string,
  extensionId: string,
  scope: ExtensionSettingScope,
): string => {
  const base = `Qwen Code Extensions ${extensionName} ${extensionId}`;
  if (scope === ExtensionSettingScope.WORKSPACE) {
    return `${base} ${process.cwd()}`;
  }
  return base;
};

const getEnvFilePath = (
  extensionName: string,
  scope: ExtensionSettingScope,
): string => {
  if (scope === ExtensionSettingScope.WORKSPACE) {
    return path.join(process.cwd(), EXTENSION_SETTINGS_FILENAME);
  }
  return new ExtensionStorage(extensionName).getEnvFilePath();
};

export async function maybePromptForSettings(
  extensionConfig: ExtensionConfig,
  extensionId: string,
  requestSetting: (setting: ExtensionSetting) => Promise<string>,
  previousExtensionConfig?: ExtensionConfig,
  previousSettings?: Record<string, string>,
  envFilePathOverride?: string,
  deferKeychainMutations = false,
): Promise<PreparedExtensionSettingsMutation | undefined> {
  const { name: extensionName, settings } = extensionConfig;
  validateExtensionSettingEnvVars(settings);
  validateExtensionSettingEnvVars(previousExtensionConfig?.settings);
  if (
    (!settings || settings.length === 0) &&
    (!previousExtensionConfig?.settings ||
      previousExtensionConfig.settings.length === 0)
  ) {
    if (envFilePathOverride) {
      await fs.rm(getSettingsSelectorPath(extensionName, envFilePathOverride), {
        force: true,
      });
    }
    return;
  }
  // We assume user scope here because we don't have a way to ask the user for scope during the initial setup.
  // The user can change the scope later using the `settings set` command.
  const scope = ExtensionSettingScope.USER;
  const envFilePath =
    envFilePathOverride ?? getEnvFilePath(extensionName, scope);
  const selectorPath = getSettingsSelectorPath(
    extensionName,
    envFilePathOverride,
  );
  const keychain = new HybridTokenStorage(
    getKeychainStorageName(extensionName, extensionId, scope),
  );
  const serviceName = getKeychainStorageName(extensionName, extensionId, scope);
  const previousSelector = await readSettingsSelector(extensionName);
  const keychainMutations: Array<() => Promise<void>> = [];
  let newSelector: ExtensionSettingsSelector | undefined;

  if (!settings || settings.length === 0) {
    if (fsSync.existsSync(envFilePath)) {
      await atomicWriteFile(envFilePath, '', { noFollow: true });
    }
    await fs.rm(selectorPath, { force: true });
    keychainMutations.push(async () => await clearKeychainSettings(keychain));
    return await applyOrDeferKeychainMutations(
      keychainMutations,
      deferKeychainMutations,
      previousSelector,
      undefined,
      serviceName,
    );
  }

  const settingsChanges = getSettingsChanges(
    settings,
    previousExtensionConfig?.settings ?? [],
  );

  const allSettings: Record<string, string> = { ...previousSettings };

  for (const removedEnvSetting of settingsChanges.removeEnv) {
    delete allSettings[removedEnvSetting.envVar];
  }

  for (const removedSensitiveSetting of settingsChanges.removeSensitive) {
    keychainMutations.push(
      async () => await keychain.deleteSecret(removedSensitiveSetting.envVar),
    );
  }

  for (const setting of settingsChanges.promptForSensitive.concat(
    settingsChanges.promptForEnv,
  )) {
    const answer = await requestSetting(setting);
    allSettings[setting.envVar] = answer;
  }

  const nonSensitiveSettings: Record<string, string> = {};
  const sensitiveSettings: Record<string, string> = {};
  for (const setting of settings) {
    const value = allSettings[setting.envVar];
    if (value === undefined) {
      continue;
    }
    if (setting.sensitive) {
      sensitiveSettings[setting.envVar] = value;
      keychainMutations.push(
        async () => await keychain.setSecret(setting.envVar, value),
      );
    } else {
      nonSensitiveSettings[setting.envVar] = value;
    }
  }

  const envContent = formatEnvContent(nonSensitiveSettings);

  await atomicWriteFile(envFilePath, envContent, { noFollow: true });
  if (Object.keys(sensitiveSettings).length > 0) {
    const bundleKey = `${SETTINGS_BUNDLE_PREFIX}${randomUUID()}`;
    await keychain.setSecret(bundleKey, JSON.stringify(sensitiveSettings));
    newSelector = {
      version: 1,
      backend: await keychain.getStorageType(),
      bundleKey,
    };
    try {
      await atomicWriteJSON(selectorPath, newSelector, {
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });
    } catch (error) {
      try {
        await keychain.deleteSecret(bundleKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Failed to stage extension settings and clean its secret snapshot.',
          { cause: error },
        );
      }
      throw error;
    }
  } else {
    await fs.rm(selectorPath, { force: true });
  }
  return await applyOrDeferKeychainMutations(
    keychainMutations,
    deferKeychainMutations,
    previousSelector,
    newSelector,
    serviceName,
  );
}

async function applyOrDeferKeychainMutations(
  mutations: ReadonlyArray<() => Promise<void>>,
  defer: boolean,
  previousSelector: ExtensionSettingsSelector | undefined,
  newSelector: ExtensionSettingsSelector | undefined,
  serviceName: string,
): Promise<PreparedExtensionSettingsMutation | undefined> {
  if (mutations.length === 0 && !previousSelector && !newSelector) {
    return undefined;
  }
  let applied = false;
  const apply = async () => {
    if (applied) return;
    for (const mutation of mutations) await mutation();
    applied = true;
  };
  if (!defer) await apply();
  let previousDiscarded = false;
  let newDiscarded = false;
  return {
    commit: async () => {
      await apply();
      if (previousSelector && !previousDiscarded) {
        await deleteSettingsSnapshot(previousSelector, serviceName);
        previousDiscarded = true;
      }
    },
    discard: async () => {
      if (newSelector && !newDiscarded) {
        await deleteSettingsSnapshot(newSelector, serviceName);
        newDiscarded = true;
      }
    },
  };
}

function formatEnvContent(settings: Record<string, string>): string {
  let envContent = '';
  for (const [key, value] of Object.entries(settings)) {
    const formattedValue = value.includes(' ') ? `"${value}"` : value;
    envContent += `${key}=${formattedValue}\n`;
  }
  return envContent;
}

export async function promptForSetting(
  setting: ExtensionSetting,
): Promise<string> {
  const response = await prompts({
    type: setting.sensitive ? 'password' : 'text',
    name: 'value',
    message: `${setting.name}\n${setting.description}`,
  });
  return response.value;
}

export async function getScopedEnvContents(
  extensionConfig: ExtensionConfig,
  extensionId: string,
  scope: ExtensionSettingScope,
): Promise<Record<string, string>> {
  const { name: extensionName } = extensionConfig;
  const keychain = new HybridTokenStorage(
    getKeychainStorageName(extensionName, extensionId, scope),
  );
  const selector =
    scope === ExtensionSettingScope.USER
      ? await readSettingsSelector(extensionName)
      : undefined;
  const settingsStorage = selector
    ? createSelectedStorage(
        getKeychainStorageName(extensionName, extensionId, scope),
        selector.backend,
      )
    : keychain;
  const envFilePath = getEnvFilePath(extensionName, scope);
  let customEnv: Record<string, string> = {};
  if (fsSync.existsSync(envFilePath)) {
    const envFile = fsSync.readFileSync(envFilePath, 'utf-8');
    customEnv = dotenv.parse(envFile);
  }

  if (extensionConfig.settings) {
    const bundleContent = selector
      ? await settingsStorage.getSecret(selector.bundleKey)
      : null;
    if (selector && bundleContent === null) {
      throw new Error('Stored extension settings bundle is missing.');
    }
    const bundle = bundleContent
      ? parseSensitiveSettingsBundle(bundleContent)
      : undefined;
    for (const setting of extensionConfig.settings) {
      if (!setting.sensitive) continue;
      const override = selector
        ? await settingsStorage.getSecret(
            `${selector.bundleKey}:override:${setting.envVar}`,
          )
        : null;
      const secret =
        override ??
        (selector
          ? bundle?.[setting.envVar]
          : await settingsStorage.getSecret(setting.envVar));
      if (secret) {
        customEnv[setting.envVar] = secret;
      }
    }
  }
  return customEnv;
}

export async function getEnvContents(
  extensionConfig: ExtensionConfig,
  extensionId: string,
): Promise<Record<string, string>> {
  if (!extensionConfig.settings || extensionConfig.settings.length === 0) {
    return Promise.resolve({});
  }

  const userSettings = await getScopedEnvContents(
    extensionConfig,
    extensionId,
    ExtensionSettingScope.USER,
  );
  const workspaceSettings = await getScopedEnvContents(
    extensionConfig,
    extensionId,
    ExtensionSettingScope.WORKSPACE,
  );

  return { ...userSettings, ...workspaceSettings };
}

export async function updateSetting(
  extensionConfig: ExtensionConfig,
  extensionId: string,
  settingKey: string,
  requestSetting: (setting: ExtensionSetting) => Promise<string>,
  scope: ExtensionSettingScope,
): Promise<void> {
  const { name: extensionName, settings } = extensionConfig;
  if (!settings || settings.length === 0) {
    debugLogger.debug(
      `updateSetting: Extension "${extensionName}" has no settings`,
    );
    return;
  }

  const settingToUpdate = settings.find(
    (s) => s.name === settingKey || s.envVar === settingKey,
  );

  if (!settingToUpdate) {
    debugLogger.debug(
      `updateSetting: Setting "${settingKey}" not found for extension "${extensionName}"`,
    );
    return;
  }

  const newValue = await requestSetting(settingToUpdate);
  const keychain = new HybridTokenStorage(
    getKeychainStorageName(extensionName, extensionId, scope),
  );

  if (settingToUpdate.sensitive) {
    const selector =
      scope === ExtensionSettingScope.USER
        ? await readSettingsSelector(extensionName)
        : undefined;
    const settingsStorage = selector
      ? createSelectedStorage(
          getKeychainStorageName(extensionName, extensionId, scope),
          selector.backend,
        )
      : keychain;
    if (selector) {
      await settingsStorage.setSecret(
        `${selector.bundleKey}:override:${settingToUpdate.envVar}`,
        newValue,
      );
      try {
        await settingsStorage.setSecret(settingToUpdate.envVar, newValue);
      } catch (error) {
        debugLogger.warn(
          `Failed to synchronize legacy extension setting "${settingToUpdate.envVar}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      await settingsStorage.setSecret(settingToUpdate.envVar, newValue);
    }
    return;
  }

  // For non-sensitive settings, we need to read the existing .env file,
  // update the value, and write it back, preserving any other values.
  const envFilePath = getEnvFilePath(extensionName, scope);
  let envContent = '';
  if (fsSync.existsSync(envFilePath)) {
    envContent = await fs.readFile(envFilePath, 'utf-8');
  }

  const parsedEnv = dotenv.parse(envContent);
  parsedEnv[settingToUpdate.envVar] = newValue;

  // We only want to write back the variables that are not sensitive.
  const nonSensitiveSettings: Record<string, string> = {};
  const sensitiveEnvVars = new Set(
    settings.filter((s) => s.sensitive).map((s) => s.envVar),
  );
  for (const [key, value] of Object.entries(parsedEnv)) {
    if (!sensitiveEnvVars.has(key)) {
      nonSensitiveSettings[key] = value;
    }
  }

  const newEnvContent = formatEnvContent(nonSensitiveSettings);
  await atomicWriteFile(envFilePath, newEnvContent, { noFollow: true });
}

interface settingsChanges {
  promptForSensitive: ExtensionSetting[];
  removeSensitive: ExtensionSetting[];
  promptForEnv: ExtensionSetting[];
  removeEnv: ExtensionSetting[];
}
function getSettingsChanges(
  settings: ExtensionSetting[],
  oldSettings: ExtensionSetting[],
): settingsChanges {
  const isSameSetting = (a: ExtensionSetting, b: ExtensionSetting) =>
    a.envVar === b.envVar && (a.sensitive ?? false) === (b.sensitive ?? false);

  const sensitiveOld = oldSettings.filter((s) => s.sensitive ?? false);
  const sensitiveNew = settings.filter((s) => s.sensitive ?? false);
  const envOld = oldSettings.filter((s) => !(s.sensitive ?? false));
  const envNew = settings.filter((s) => !(s.sensitive ?? false));

  return {
    promptForSensitive: sensitiveNew.filter(
      (s) => !sensitiveOld.some((old) => isSameSetting(s, old)),
    ),
    removeSensitive: sensitiveOld.filter(
      (s) => !sensitiveNew.some((neu) => isSameSetting(s, neu)),
    ),
    promptForEnv: envNew.filter(
      (s) => !envOld.some((old) => isSameSetting(s, old)),
    ),
    removeEnv: envOld.filter(
      (s) => !envNew.some((neu) => isSameSetting(s, neu)),
    ),
  };
}

async function clearKeychainSettings(keychain: HybridTokenStorage) {
  if (!(await keychain.isAvailable())) {
    return;
  }
  const secrets = await keychain.listSecrets();
  for (const secret of secrets) {
    await keychain.deleteSecret(secret);
  }
  return;
}
