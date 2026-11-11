/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  customModelProviderConfigError,
  parseCustomProviderSettings,
  type Config,
  type CustomModelProviderConfigInput,
  type CustomProviderModelEdit,
} from '@qwen-code/core';
import { resolveEnvVarsInObject } from '@qwen-code/resource';

/** TUI 只编排会话准入与刷新；配置读写交给共享管理器。 */
export async function createLocalProviderFromTui(
  config: Config,
  input: CustomModelProviderConfigInput,
): Promise<{ modelKey: string; applied: boolean }> {
  await ensureLocalAccess(config);
  if (config.getLoadedSettings().user.readOnly) {
    throw customModelProviderConfigError(
      'persistFailed',
      'User settings are not writable',
    );
  }
  const manager = config.getCustomProviderManager();
  await manager.check(input);
  const { providerId, ...setting } = input;
  const parsed = parseCustomProviderSettings(
    resolveEnvVarsInObject({ [providerId]: setting }),
  );
  for (const model of parsed.providers[0]!.models.values()) {
    if (
      await config
        .getModelProviderManager()
        .getModel(`${providerId}/${model.modelId}`)
    ) {
      throw customModelProviderConfigError(
        'alreadyExists',
        'Model key already exists',
      );
    }
  }
  await manager.create(input);
  const modelKey = `${providerId}/${parsed.providers[0]!.models.keys().next().value}`;
  return applySavedModel(config, modelKey);
}

export async function refreshLocalProvidersFromTui(
  config: Config,
): ReturnType<Config['replaceCustomProviderSettings']> {
  await config.reloadModelConfigFromDisk();
  return config.getCustomProvidersState();
}

/** 会话只允许操作没有受信任来源覆盖的单模型 user 配置。 */
export function getLocalProviderDeletionBlock(
  config: Config,
  modelKey: string,
): 'source' | 'shared' | 'unavailable' | undefined {
  const settings = config.getLoadedSettings();
  if (config.getCustomProviderAccessMode() !== 'local') return 'unavailable';
  const slash = modelKey.indexOf('/');
  if (slash <= 0) return 'unavailable';
  const providerId = modelKey.slice(0, slash);
  const overrides = [
    settings.flag,
    ...(settings.isTrusted ? [settings.project, settings.local] : []),
  ];
  if (
    settings.errors.length ||
    settings.user.readOnly ||
    overrides.some((file) =>
      Object.hasOwn(file.settings.providers ?? {}, providerId),
    )
  )
    return 'source';
  const own = settings.user.settings.providers?.[providerId];
  if (!own) return 'source';
  const parsed = parseCustomProviderSettings(
    resolveEnvVarsInObject({ [providerId]: own }),
  );
  const models = parsed.providers[0]?.models;
  if (!models || parsed.issues.length) return 'unavailable';
  if (models.size !== 1) return 'shared';
  if (`${providerId}/${models.keys().next().value}` !== modelKey)
    return 'source';
  return undefined;
}

export function getLocalModelEdit(
  config: Config,
  modelKey: string,
): CustomProviderModelEdit | undefined {
  if (getLocalProviderDeletionBlock(config, modelKey)) return undefined;
  return config.getCustomProviderManager().getModelEdit(modelKey);
}

export async function updateLocalModelFromTui(
  config: Config,
  original: CustomProviderModelEdit,
  input: {
    baseUrl: string;
    apiKey?: string;
    model: CustomProviderModelEdit['model'];
  },
): Promise<{ modelKey: string; applied: boolean }> {
  await ensureLocalAccess(config);
  ensureUserOwnedModel(config, original.modelKey);
  await config.getCustomProviderManager().updateModel(original, input);
  return applySavedModel(config, original.modelKey);
}

export async function deleteLocalProviderFromTui(
  config: Config,
  modelKey: string,
): Promise<void> {
  await ensureLocalAccess(config);
  ensureUserOwnedModel(config, modelKey);
  await config.getCustomProviderManager().deleteModel(modelKey);
  await refreshLocalProvidersFromTui(config);
}

async function ensureLocalAccess(config: Config): Promise<void> {
  if (
    config.getCustomProviderAccessMode() !== 'local' ||
    !(await config.ensureCustomProvidersAccess())
  ) {
    throw customModelProviderConfigError(
      'accessDenied',
      'Local Custom Providers are unavailable',
    );
  }
}

function ensureUserOwnedModel(config: Config, modelKey: string): void {
  if (getLocalProviderDeletionBlock(config, modelKey)) {
    throw customModelProviderConfigError(
      'accessDenied',
      'This configuration must be edited in its source settings',
    );
  }
}

async function applySavedModel(
  config: Config,
  modelKey: string,
): Promise<{ modelKey: string; applied: boolean }> {
  try {
    const state = await refreshLocalProvidersFromTui(config);
    return {
      modelKey,
      applied:
        state.status === 'active' &&
        (await config.getModelProviderManager().getModel(modelKey)) !==
          undefined,
    };
  } catch {
    // 写入已完成，刷新失败不能诱导用户重复创建。
    return { modelKey, applied: false };
  }
}
