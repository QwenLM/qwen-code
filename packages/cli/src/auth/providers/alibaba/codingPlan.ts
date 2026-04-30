/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { LlmProvider, ProviderInstallPlan } from '../../types.js';
import { ALIBABA_MODELSTUDIO_MODELS } from './modelStudioModels.js';

export const CODING_PLAN_ENV_KEY = 'BAILIAN_CODING_PLAN_API_KEY';
export const CODING_PLAN_CHINA_BASE_URL =
  'https://coding.dashscope.aliyuncs.com/v1';
export const CODING_PLAN_GLOBAL_BASE_URL =
  'https://coding-intl.dashscope.aliyuncs.com/v1';

export interface CodingPlanEndpoint {
  id: string;
  title: string;
  baseUrl: string;
  documentationUrl: string;
  apiKeyUrl?: string;
  modelNamePrefix?: string;
}

export interface CodingPlanConfig {
  id: 'coding';
  option: 'CODING_PLAN';
  displayName: string;
  title: string;
  description: string;
  authEventType: 'coding-plan';
  envKey: typeof CODING_PLAN_ENV_KEY;
  metadataKey: 'codingPlan';
  template: ProviderModelConfig[];
  version: string;
  baseUrl: string;
  documentationUrl: string;
  apiKeyUrl?: string;
}

export interface CodingPlanInstallInput {
  apiKey?: string;
  baseUrl?: string;
}

export const CODING_PLAN_ENDPOINTS: readonly CodingPlanEndpoint[] = [
  {
    id: 'aliyun',
    title: '阿里云百炼 (aliyun.com)',
    baseUrl: CODING_PLAN_CHINA_BASE_URL,
    documentationUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
  },
  {
    id: 'alibabacloud',
    title: 'Alibaba Cloud (alibabacloud.com)',
    baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
    documentationUrl:
      'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    modelNamePrefix: 'ModelStudio Coding Plan for Global/Intl',
  },
];

export const CODING_PLAN_OPTION = {
  id: 'coding',
  option: 'CODING_PLAN',
  title: 'Alibaba Cloud Coding Plan',
  description:
    'For individual developers · Pay per model call · 5-hour/weekly quotas',
} as const;

export function computeCodingPlanVersion(
  template: ProviderModelConfig[],
): string {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex');
}

export function resolveCodingPlanEndpoint(
  baseUrl?: string,
): CodingPlanEndpoint {
  return (
    CODING_PLAN_ENDPOINTS.find((endpoint) => endpoint.baseUrl === baseUrl) ||
    CODING_PLAN_ENDPOINTS[0]
  );
}

export function buildCodingPlanTemplate(
  baseUrl?: string,
): ProviderModelConfig[] {
  const endpoint = resolveCodingPlanEndpoint(baseUrl);
  const modelNamePrefix = endpoint.modelNamePrefix || 'ModelStudio Coding Plan';

  return ALIBABA_MODELSTUDIO_MODELS.map((model) => ({
    id: model.id,
    name: `[${modelNamePrefix}] ${model.id}`,
    ...(model.description ? { description: model.description } : {}),
    baseUrl: endpoint.baseUrl,
    envKey: CODING_PLAN_ENV_KEY,
    generationConfig: {
      ...(model.enableThinking
        ? { extra_body: { enable_thinking: true } }
        : {}),
      contextWindowSize: model.contextWindowSize,
    },
  }));
}

export function getCodingPlanConfig(baseUrl?: string): CodingPlanConfig {
  const endpoint = resolveCodingPlanEndpoint(baseUrl);
  const template = buildCodingPlanTemplate(endpoint.baseUrl);

  return {
    id: CODING_PLAN_OPTION.id,
    option: CODING_PLAN_OPTION.option,
    displayName: CODING_PLAN_OPTION.title,
    title: CODING_PLAN_OPTION.title,
    description: CODING_PLAN_OPTION.description,
    authEventType: 'coding-plan',
    envKey: CODING_PLAN_ENV_KEY,
    metadataKey: 'codingPlan',
    template,
    version: computeCodingPlanVersion(template),
    baseUrl: endpoint.baseUrl,
    documentationUrl: endpoint.documentationUrl,
    apiKeyUrl: endpoint.apiKeyUrl,
  };
}

export function createCodingPlanInstallPlan({
  apiKey,
  baseUrl,
}: CodingPlanInstallInput): ProviderInstallPlan {
  const plan = getCodingPlanConfig(baseUrl);
  const models: ProviderModelConfig[] = plan.template.map((templateConfig) => ({
    ...templateConfig,
    envKey: plan.envKey,
  }));
  const firstModel = models[0]?.id;

  return {
    providerId: codingPlanProvider.id,
    authType: AuthType.USE_OPENAI,
    ...(apiKey
      ? {
          env: {
            [plan.envKey]: apiKey,
          },
        }
      : {}),
    ...(firstModel
      ? {
          modelSelection: {
            modelId: firstModel,
          },
        }
      : {}),
    modelProviders: [
      {
        authType: AuthType.USE_OPENAI,
        models,
        mergeStrategy: 'prepend-and-remove-owned',
      },
    ],
    providerState: {
      codingPlan: {
        version: plan.version,
        baseUrl: plan.baseUrl,
      },
    },
  };
}

export function findCodingPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): CodingPlanConfig | undefined {
  if (!baseUrl || envKey !== CODING_PLAN_ENV_KEY) {
    return undefined;
  }

  return CODING_PLAN_ENDPOINTS.some((endpoint) => endpoint.baseUrl === baseUrl)
    ? getCodingPlanConfig(baseUrl)
    : undefined;
}

export function isCodingPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): boolean {
  return findCodingPlanConfig(baseUrl, envKey) !== undefined;
}

export const codingPlanProvider: LlmProvider = {
  id: 'coding-plan',
  label: 'Alibaba Cloud Coding Plan',
  category: 'recommended',
  protocol: AuthType.USE_OPENAI,
  setupMethods: [{ type: 'subscription' }],
  ownsModel(model) {
    return isCodingPlanConfig(model.baseUrl, model.envKey);
  },
  async createInstallPlan(input) {
    return createCodingPlanInstallPlan(
      input as unknown as CodingPlanInstallInput,
    );
  },
};
