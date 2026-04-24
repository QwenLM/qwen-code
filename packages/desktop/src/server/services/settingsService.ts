/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  AuthType,
  CODING_PLAN_ENV_KEY,
  CodingPlanRegion,
  Storage,
  getCodingPlanConfig,
} from '@qwen-code/qwen-code-core';
import { DesktopHttpError } from '../http/errors.js';

export type DesktopSettingsProvider = 'api-key' | 'coding-plan' | 'none';
export type DesktopCodingPlanRegion = 'china' | 'global';

export interface DesktopModelProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
}

export interface DesktopUserSettingsResponse {
  ok: true;
  settingsPath: string;
  provider: DesktopSettingsProvider;
  selectedAuthType: string | null;
  model: {
    name: string | null;
  };
  codingPlan: {
    region: DesktopCodingPlanRegion;
    hasApiKey: boolean;
    version: string | null;
  };
  openai: {
    hasApiKey: boolean;
    providers: DesktopModelProviderEntry[];
  };
}

export interface DesktopUpdateUserSettingsRequest {
  provider: 'api-key' | 'coding-plan';
  apiKey?: string;
  codingPlanRegion?: DesktopCodingPlanRegion;
  activeModel?: string;
  modelProviders?: Record<string, string>;
}

export class DesktopSettingsService {
  constructor(
    private readonly settingsPath = Storage.getGlobalSettingsPath(),
  ) {}

  async readUserSettings(): Promise<DesktopUserSettingsResponse> {
    const settings = await this.readSettings();
    return this.describeSettings(settings);
  }

  async updateUserSettings(
    request: DesktopUpdateUserSettingsRequest,
  ): Promise<DesktopUserSettingsResponse> {
    if (request.provider === 'coding-plan') {
      await this.writeCodingPlanConfig(request);
    } else {
      await this.writeApiKeyConfig(request);
    }

    return this.readUserSettings();
  }

  async clearPersistedAuth(): Promise<DesktopUserSettingsResponse> {
    const settings = await this.readSettings();
    const security = asRecord(settings['security']);
    const auth = asRecord(security?.['auth']);
    if (auth) {
      delete auth['selectedType'];
    }

    const env = asRecord(settings['env']);
    if (env) {
      delete env[CODING_PLAN_ENV_KEY];
      delete env['OPENAI_API_KEY'];
    }

    delete settings['codingPlan'];
    await this.writeSettings(settings);
    return this.describeSettings(settings);
  }

  private async writeCodingPlanConfig(
    request: DesktopUpdateUserSettingsRequest,
  ): Promise<void> {
    const settings = await this.readSettings();
    const region =
      request.codingPlanRegion === 'global'
        ? CodingPlanRegion.GLOBAL
        : CodingPlanRegion.CHINA;
    const planConfig = getCodingPlanConfig(region);

    const env = ensureNestedObject(settings, 'env');
    const apiKey = getIncomingSecret(request.apiKey, env[CODING_PLAN_ENV_KEY]);
    if (!apiKey) {
      throw new DesktopHttpError(
        400,
        'missing_api_key',
        'Coding Plan API key is required.',
      );
    }

    const auth = ensureNestedObject(settings, 'security', 'auth');
    auth['selectedType'] = AuthType.USE_OPENAI;
    env[CODING_PLAN_ENV_KEY] = apiKey;

    const providers = ensureNestedObject(settings, 'modelProviders');
    const existing = findOpenAiProviderEntries(settings['modelProviders']);
    const nonCodingPlan = existing.filter(
      (entry) => entry['envKey'] !== CODING_PLAN_ENV_KEY,
    );
    providers[AuthType.USE_OPENAI] = [...planConfig.template, ...nonCodingPlan];

    settings['codingPlan'] = {
      region,
      version: planConfig.version,
    };
    const defaultModelId = planConfig.template[0]?.id ?? 'qwen3.5-plus';
    settings['model'] = { name: defaultModelId };

    await this.writeSettings(settings);
  }

  private async writeApiKeyConfig(
    request: DesktopUpdateUserSettingsRequest,
  ): Promise<void> {
    const settings = await this.readSettings();
    const env = ensureNestedObject(settings, 'env');
    const apiKey = getIncomingSecret(request.apiKey, env['OPENAI_API_KEY']);
    if (!apiKey) {
      throw new DesktopHttpError(
        400,
        'missing_api_key',
        'OpenAI-compatible API key is required.',
      );
    }

    const providerMap =
      request.modelProviders ??
      buildProviderMap(findOpenAiProviderEntries(settings['modelProviders']));
    const activeModel =
      request.activeModel?.trim() || Object.keys(providerMap)[0] || '';

    if (!activeModel) {
      throw new DesktopHttpError(
        400,
        'missing_model',
        'At least one model is required.',
      );
    }

    const providers = ensureNestedObject(settings, 'modelProviders');
    const modelProviders = {
      ...providerMap,
      ...(providerMap[activeModel] === undefined
        ? { [activeModel]: 'https://api.openai.com/v1' }
        : {}),
    };
    const modelArray = Object.entries(modelProviders).map(([id, baseUrl]) => ({
      id,
      name: id,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
    }));
    const existing = findOpenAiProviderEntries(settings['modelProviders']);
    const nonTarget = existing.filter(
      (entry) => entry['envKey'] !== 'OPENAI_API_KEY',
    );

    const auth = ensureNestedObject(settings, 'security', 'auth');
    auth['selectedType'] = AuthType.USE_OPENAI;
    env['OPENAI_API_KEY'] = apiKey;
    delete env[CODING_PLAN_ENV_KEY];
    providers[AuthType.USE_OPENAI] = [...modelArray, ...nonTarget];
    settings['model'] = { name: activeModel };
    delete settings['codingPlan'];

    await this.writeSettings(settings);
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return asMutableRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }

  private async writeSettings(
    settings: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    await writeFile(
      this.settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf8',
    );
  }

  private describeSettings(
    settings: Record<string, unknown>,
  ): DesktopUserSettingsResponse {
    const security = asRecord(settings['security']);
    const auth = asRecord(security?.['auth']);
    const selectedAuthType =
      typeof auth?.['selectedType'] === 'string' ? auth['selectedType'] : null;
    const env = asRecord(settings['env']) ?? {};
    const model = asRecord(settings['model']);
    const codingPlan = asRecord(settings['codingPlan']);
    const providers = findOpenAiProviderEntries(settings['modelProviders']);
    const codingRegion =
      codingPlan?.['region'] === CodingPlanRegion.GLOBAL ? 'global' : 'china';
    const hasCodingPlanApiKey =
      typeof env[CODING_PLAN_ENV_KEY] === 'string' &&
      env[CODING_PLAN_ENV_KEY].length > 0;
    const hasOpenAiApiKey =
      typeof env['OPENAI_API_KEY'] === 'string' &&
      env['OPENAI_API_KEY'].length > 0;

    return {
      ok: true,
      settingsPath: this.settingsPath,
      provider: hasCodingPlanApiKey
        ? 'coding-plan'
        : hasOpenAiApiKey || providers.length > 0
          ? 'api-key'
          : 'none',
      selectedAuthType,
      model: {
        name: typeof model?.['name'] === 'string' ? model['name'] : null,
      },
      codingPlan: {
        region: codingRegion,
        hasApiKey: hasCodingPlanApiKey,
        version:
          typeof codingPlan?.['version'] === 'string'
            ? codingPlan['version']
            : null,
      },
      openai: {
        hasApiKey: hasOpenAiApiKey,
        providers: providers.map((entry) => ({
          id: String(entry['id']),
          name:
            typeof entry['name'] === 'string'
              ? entry['name']
              : String(entry['id']),
          baseUrl:
            typeof entry['baseUrl'] === 'string'
              ? entry['baseUrl']
              : 'https://api.openai.com/v1',
          envKey:
            typeof entry['envKey'] === 'string'
              ? entry['envKey']
              : 'OPENAI_API_KEY',
        })),
      },
    };
  }
}

function ensureNestedObject(
  obj: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  let current = obj;
  for (const key of keys) {
    const value = current[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  return current;
}

function findOpenAiProviderEntries(
  modelProviders: unknown,
): Array<Record<string, unknown>> {
  const providers = asRecord(modelProviders);
  if (!providers) {
    return [];
  }

  for (const key of [AuthType.USE_OPENAI, 'use_openai']) {
    const value = providers[key];
    if (Array.isArray(value)) {
      return value
        .map(asMutableRecord)
        .filter((entry): entry is Record<string, unknown> =>
          isProviderEntry(entry),
        );
    }
  }

  return [];
}

function buildProviderMap(
  providers: Array<Record<string, unknown>>,
): Record<string, string> {
  const entries = providers
    .filter((entry) => entry['envKey'] === 'OPENAI_API_KEY')
    .map((entry) => [
      String(entry['id']),
      typeof entry['baseUrl'] === 'string'
        ? entry['baseUrl']
        : 'https://api.openai.com/v1',
    ]);

  return Object.fromEntries(entries);
}

function getIncomingSecret(
  incoming: string | undefined,
  existing: unknown,
): string | undefined {
  const trimmed = incoming?.trim();
  if (trimmed) {
    return trimmed;
  }

  return typeof existing === 'string' && existing.length > 0
    ? existing
    : undefined;
}

function isProviderEntry(
  entry: Record<string, unknown> | undefined,
): entry is Record<string, unknown> {
  return !!entry && typeof entry['id'] === 'string' && entry['id'].length > 0;
}

function asMutableRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
