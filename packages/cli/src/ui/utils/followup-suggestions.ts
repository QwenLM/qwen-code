/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type Config,
  type ContentGeneratorConfig,
  resolveModelId,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

type FollowupSuggestionSettings = Partial<
  Pick<
    LoadedSettings,
    'isTrusted' | 'systemDefaults' | 'user' | 'workspace' | 'system' | 'merged'
  >
>;

type FollowupSuggestionConfig = Partial<
  Pick<
    Config,
    | 'getAllConfiguredModels'
    | 'getContentGeneratorConfig'
    | 'getFastModel'
    | 'getModel'
    | 'getModelsConfig'
    | 'getActiveRuntimeModelSnapshot'
  >
>;

export type FollowupSuggestionFeatureDecision = {
  enabled: boolean;
  suppressedReason?: 'loopback_openai_default';
};

export function isFollowupSuggestionSettingConfigured(
  settings: FollowupSuggestionSettings,
): boolean {
  return (
    typeof settings.systemDefaults?.settings?.ui?.enableFollowupSuggestions ===
      'boolean' ||
    typeof settings.user?.settings?.ui?.enableFollowupSuggestions ===
      'boolean' ||
    (settings.isTrusted === true &&
      typeof settings.workspace?.settings?.ui?.enableFollowupSuggestions ===
        'boolean') ||
    typeof settings.system?.settings?.ui?.enableFollowupSuggestions ===
      'boolean'
  );
}

export function getFollowupSuggestionProviderConfig(
  config: FollowupSuggestionConfig,
): Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'> | undefined {
  const modelsConfig = config.getModelsConfig?.();
  const generationConfig =
    config.getContentGeneratorConfig?.() ??
    modelsConfig?.getGenerationConfig?.();
  const authType =
    generationConfig?.authType ?? modelsConfig?.getCurrentAuthType();
  const primaryProvider = toProviderConfig(authType, generationConfig?.baseUrl);

  const fastModel = config.getFastModel?.();
  if (fastModel) {
    const selector = (() => {
      try {
        return resolveModelId(fastModel, {
          currentAuthType: authType,
          currentModel: config.getModel?.(),
          getAvailableModels: (authTypes) =>
            config.getAllConfiguredModels?.(authTypes) ?? [],
        });
      } catch {
        return undefined;
      }
    })();
    if (!selector) return primaryProvider;

    const resolvedModel = selector.authType
      ? modelsConfig?.getResolvedModel?.(selector.authType, selector.modelId)
      : undefined;

    if (resolvedModel) {
      return {
        authType: resolvedModel.authType,
        baseUrl: resolvedModel.baseUrl,
      };
    }

    if (selector.authType) {
      const availableModelProviderConfig = findAvailableModelProviderConfig(
        config,
        selector.authType,
        selector.modelId,
      );
      if (availableModelProviderConfig) {
        return availableModelProviderConfig;
      }
      if (selector.authType !== authType) {
        return primaryProvider;
      }
    }
  }

  return primaryProvider;
}

function toProviderConfig(
  authType: AuthType | undefined,
  baseUrl: string | undefined,
): Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'> | undefined {
  if (authType === undefined && baseUrl === undefined) {
    return undefined;
  }

  return { authType, baseUrl };
}

function findAvailableModelProviderConfig(
  config: FollowupSuggestionConfig,
  authType: AuthType,
  modelId: string,
): Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'> | undefined {
  const model = config
    .getAllConfiguredModels?.([authType])
    .find(
      (candidate) =>
        candidate.authType === authType && candidate.id === modelId,
    );
  if (!model) return undefined;

  if (model.baseUrl) {
    return toProviderConfig(model.authType, model.baseUrl);
  }

  if (model.isRuntimeModel && model.runtimeSnapshotId) {
    const activeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    if (activeSnapshot?.id === model.runtimeSnapshotId) {
      return toProviderConfig(activeSnapshot.authType, activeSnapshot.baseUrl);
    }
  }

  return undefined;
}

export function getFollowupSuggestionFeatureDecision(
  settings: FollowupSuggestionSettings,
  config: FollowupSuggestionConfig,
): FollowupSuggestionFeatureDecision {
  const setting = {
    value: settings.merged?.ui?.enableFollowupSuggestions,
    configured: isFollowupSuggestionSettingConfigured(settings),
  };
  const providerConfig = getFollowupSuggestionProviderConfig(config);

  return getDecisionForProviderConfig(setting, providerConfig);
}

export function shouldEnableFollowupSuggestions(
  setting: { value: boolean | undefined; configured: boolean },
  contentGeneratorConfig:
    | Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'>
    | undefined,
): boolean {
  return getDecisionForProviderConfig(setting, contentGeneratorConfig).enabled;
}

function getDecisionForProviderConfig(
  setting: { value: boolean | undefined; configured: boolean },
  contentGeneratorConfig:
    | Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'>
    | undefined,
): FollowupSuggestionFeatureDecision {
  if (setting.value === false) {
    return { enabled: false, suppressedReason: undefined };
  }

  const suppressedByLoopbackDefault =
    !(setting.value === true && setting.configured) &&
    isLoopbackOpenAiCompatible(contentGeneratorConfig);

  return {
    enabled: !suppressedByLoopbackDefault,
    suppressedReason: suppressedByLoopbackDefault
      ? 'loopback_openai_default'
      : undefined,
  };
}

function isLoopbackOpenAiCompatible(
  contentGeneratorConfig:
    | Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'>
    | undefined,
): boolean {
  if (
    !contentGeneratorConfig ||
    !isOpenAiCompatibleAuthType(contentGeneratorConfig.authType)
  ) {
    return false;
  }
  const baseUrl = contentGeneratorConfig.baseUrl;
  if (!baseUrl) return false;

  const hostname = normalizeHostname(parseHostname(baseUrl));
  return (
    hostname === 'localhost' ||
    isIPv4Loopback(hostname) ||
    hostname === '0.0.0.0' ||
    hostname === '[::]' ||
    hostname === '[::1]' ||
    isIPv4MappedLocalAddress(hostname)
  );
}

function isOpenAiCompatibleAuthType(authType: AuthType | undefined): boolean {
  // Only USE_OPENAI accepts arbitrary OpenAI-compatible base URLs today.
  return authType === AuthType.USE_OPENAI;
}

function normalizeHostname(hostname: string | undefined): string | undefined {
  return hostname?.replace(/\.$/, '');
}

function isIPv4Loopback(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => Number(part));
  return (
    octets.every((octet, index) => {
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
      return String(octet) === parts[index];
    }) && octets[0] === 127
  );
}

function isIPv4MappedLocalAddress(hostname: string | undefined): boolean {
  const match = hostname?.match(
    /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i,
  );
  if (!match) return false;

  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return false;
  }

  return (high === 0 && low === 0) || (high >= 0x7f00 && high <= 0x7fff);
}

function parseHostname(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) return undefined;

  const direct = parseUrlHostname(trimmed);
  if (direct) return direct;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return parseUrlHostname(`http://${trimmed}`);
  }

  return undefined;
}

function parseUrlHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
