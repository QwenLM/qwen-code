/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';

const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';
const CP_CHINA_PROVIDER_ID = '_cp-china';
const CP_GLOBAL_PROVIDER_ID = '_cp-global';
const CP_CHINA_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const CP_GLOBAL_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

interface LegacyModel {
  id: string;
  name?: string;
  description?: string;
  envKey?: string;
  baseUrl?: string;
  generationConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

interface V4Model {
  id: string;
  name?: string;
  description?: string;
  generationConfig?: Record<string, unknown>;
}

interface V4Provider {
  authType: string;
  baseUrl?: string;
  envKey?: string;
  managed?: boolean;
  models: V4Model[];
}

interface ProviderGroup {
  authType: string;
  baseUrl: string | undefined;
  envKey: string | undefined;
  models: LegacyModel[];
  sortKey: string;
}

function canonicalBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  let url = baseUrl.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
}

function makeGroupKey(
  authType: string,
  baseUrl: string | undefined,
  envKey: string | undefined,
): string {
  return `${authType}\0${canonicalBaseUrl(baseUrl)}\0${envKey || ''}`;
}

function toV4Model(model: LegacyModel): V4Model {
  const v4: V4Model = { id: model.id };
  if (model.name !== undefined) v4.name = model.name;
  if (model.description !== undefined) v4.description = model.description;
  if (model.generationConfig !== undefined)
    v4.generationConfig = model.generationConfig;
  return v4;
}

function detectCodingPlanRegion(
  baseUrl: string | undefined,
  envKey: string | undefined,
): 'china' | 'global' | false {
  if (!baseUrl || !envKey) return false;
  if (envKey !== CODING_PLAN_ENV_KEY) return false;
  const canonical = canonicalBaseUrl(baseUrl);
  if (canonical === CP_CHINA_BASE_URL) return 'china';
  if (canonical === CP_GLOBAL_BASE_URL) return 'global';
  return false;
}

function groupLegacyModels(
  legacyProviders: Record<string, unknown>,
  warnings: string[],
): ProviderGroup[] {
  const groupMap = new Map<string, ProviderGroup>();

  for (const [authType, models] of Object.entries(legacyProviders)) {
    if (!Array.isArray(models)) {
      warnings.push(
        `Skipped non-array modelProviders entry for authType '${authType}'.`,
      );
      continue;
    }

    for (const model of models) {
      if (!model || typeof model !== 'object' || !model.id) continue;

      const key = makeGroupKey(authType, model.baseUrl, model.envKey);
      let group = groupMap.get(key);
      if (!group) {
        group = {
          authType,
          baseUrl: model.baseUrl,
          envKey: model.envKey,
          models: [],
          sortKey: key,
        };
        groupMap.set(key, group);
      }
      group.models.push(model as LegacyModel);
    }
  }

  return [...groupMap.values()].sort((a, b) =>
    a.sortKey.localeCompare(b.sortKey),
  );
}

function generateProviderIdFromBaseUrl(
  baseUrl: string | undefined,
): string | null {
  if (!baseUrl) return null;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length === 0) return null;

    // Prefer the domain label right before TLD, e.g. api.openai.com -> openai.
    let providerName =
      labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;

    // If the label is too generic, fallback one step left when possible.
    const genericLabels = new Set([
      'api',
      'www',
      'gateway',
      'proxy',
      'service',
      'services',
    ]);
    if (genericLabels.has(providerName) && labels.length >= 3) {
      providerName = labels[labels.length - 3]!;
    }

    providerName = providerName.replace(/\./g, '-');
    providerName = providerName.replace(/[^a-z0-9-]/g, '-');
    providerName = providerName.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return providerName || null;
  } catch {
    return null;
  }
}

function assignProviderIds(
  allGroups: ProviderGroup[],
  warnings: string[],
): Record<string, V4Provider> {
  const v4Providers: Record<string, V4Provider> = {};
  const usedIds = new Set<string>();

  // Phase 1: Coding Plan groups get fixed providerIds
  const regularGroups: ProviderGroup[] = [];
  for (const group of allGroups) {
    const region = detectCodingPlanRegion(group.baseUrl, group.envKey);
    if (!region) {
      regularGroups.push(group);
      continue;
    }

    const providerId =
      region === 'china' ? CP_CHINA_PROVIDER_ID : CP_GLOBAL_PROVIDER_ID;

    if (usedIds.has(providerId)) {
      warnings.push(
        `Duplicate Coding Plan provider for region '${region}'. Merging models.`,
      );
      v4Providers[providerId]!.models.push(...group.models.map(toV4Model));
      continue;
    }

    usedIds.add(providerId);
    v4Providers[providerId] = {
      authType: group.authType,
      baseUrl: group.baseUrl,
      envKey: group.envKey,
      managed: true,
      models: group.models.map(toV4Model),
    };
  }

  // Phase 2: Regular groups get deterministic providerIds
  // Try to generate readable ID from baseUrl first, fallback to authType-based ID
  const byAuthType = new Map<string, ProviderGroup[]>();
  for (const group of regularGroups) {
    const list = byAuthType.get(group.authType) || [];
    list.push(group);
    byAuthType.set(group.authType, list);
  }

  for (const [authType, groups] of byAuthType) {
    const sanitizedAuthType = authType
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;

      // Try to generate readable ID from baseUrl
      let candidateId = generateProviderIdFromBaseUrl(group.baseUrl);

      // Fallback to {authType}-{index} if generation failed
      if (!candidateId) {
        candidateId = `${sanitizedAuthType || 'provider'}-${i + 1}`;
      }

      // Ensure uniqueness
      if (usedIds.has(candidateId)) {
        let dedupeIndex = 2;
        const baseId = candidateId;
        while (usedIds.has(candidateId)) {
          candidateId = `${baseId}-${dedupeIndex}`;
          dedupeIndex++;
        }
      }

      usedIds.add(candidateId);

      const provider: V4Provider = {
        authType: group.authType,
        models: group.models.map(toV4Model),
      };
      if (group.baseUrl) provider.baseUrl = group.baseUrl;
      if (group.envKey) provider.envKey = group.envKey;

      v4Providers[candidateId] = provider;
    }
  }

  return v4Providers;
}

function migrateModelProviders(
  legacyProviders: Record<string, unknown>,
  warnings: string[],
): Record<string, V4Provider> {
  const groups = groupLegacyModels(legacyProviders, warnings);
  return assignProviderIds(groups, warnings);
}

function migrateModelSelection(
  settings: Record<string, unknown>,
  v4Providers: Record<string, V4Provider>,
  warnings: string[],
): void {
  const model = settings['model'] as Record<string, unknown> | undefined;
  if (!model || typeof model !== 'object') return;

  const modelName = model['name'] as string | undefined;
  if (!modelName) return;

  const security = settings['security'] as Record<string, unknown> | undefined;
  const auth = security?.['auth'] as Record<string, unknown> | undefined;
  const selectedType = auth?.['selectedType'] as string | undefined;

  const matchingIds: string[] = [];
  for (const [providerId, provider] of Object.entries(v4Providers)) {
    if (provider.models.some((m) => m.id === modelName)) {
      matchingIds.push(providerId);
    }
  }

  if (matchingIds.length === 1) {
    model['providerId'] = matchingIds[0];
    return;
  }

  if (selectedType && matchingIds.length > 1) {
    const narrowed = matchingIds.filter(
      (id) => v4Providers[id]?.authType === selectedType,
    );
    if (narrowed.length === 1) {
      model['providerId'] = narrowed[0];
      return;
    }
  }

  if (matchingIds.length > 1) {
    warnings.push(
      `Model '${modelName}' found in multiple providers (${matchingIds.join(', ')}). ` +
        `Skipping providerId assignment; runtime fallback will resolve this.`,
    );
  }
}

/**
 * V3 -> V4 migration: provider-id structure for modelProviders.
 *
 * Transforms legacy `modelProviders.<authType> = Model[]` into
 * `modelProviders.<providerId> = ProviderConfig` with deterministic
 * providerId generation and Coding Plan mapping.
 *
 * Also migrates `model.name` selection state to include `model.providerId`
 * when unique provider resolution is possible.
 */
export class V3ToV4Migration implements SettingsMigration {
  readonly fromVersion = 3;
  readonly toVersion = 4;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) return false;
    return (settings as Record<string, unknown>)['$version'] === 3;
  }

  migrate(
    settings: unknown,
    _scope: string,
  ): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    const result = structuredClone(settings) as Record<string, unknown>;
    const warnings: string[] = [];

    const legacyProviders = result['modelProviders'];
    if (
      legacyProviders &&
      typeof legacyProviders === 'object' &&
      !Array.isArray(legacyProviders)
    ) {
      const hasArrayValues = Object.values(
        legacyProviders as Record<string, unknown>,
      ).some((v) => Array.isArray(v));

      if (hasArrayValues) {
        const v4Providers = migrateModelProviders(
          legacyProviders as Record<string, unknown>,
          warnings,
        );
        result['modelProviders'] = v4Providers;
        migrateModelSelection(result, v4Providers, warnings);
      }
    }

    result['$version'] = 4;
    return { settings: result, warnings };
  }
}

export const v3ToV4Migration = new V3ToV4Migration();

export const TEST_ONLY = {
  canonicalBaseUrl,
  makeGroupKey,
  toV4Model,
  detectCodingPlanRegion,
  groupLegacyModels,
  assignProviderIds,
  migrateModelProviders,
  migrateModelSelection,
  generateProviderIdFromBaseUrl,
  CP_CHINA_PROVIDER_ID,
  CP_GLOBAL_PROVIDER_ID,
};
