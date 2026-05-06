/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AuthType, type ProviderModelConfig } from '@qwen-code/qwen-code-core';
import type { LlmProvider, ProviderInstallPlan } from '../../types.js';
import type { AlibabaModelStudioModelSpec } from './modelStudioModels.js';

export const TOKEN_PLAN_ENV_KEY = 'BAILIAN_TOKEN_PLAN_API_KEY';
export const TOKEN_PLAN_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const TOKEN_PLAN_MODELS: readonly AlibabaModelStudioModelSpec[] = [
  { id: 'qwen3.6-plus', contextWindowSize: 1000000, enableThinking: true },
  { id: 'deepseek-v3.2', contextWindowSize: 131072, enableThinking: true },
  { id: 'glm-5', contextWindowSize: 202752, enableThinking: true },
  { id: 'MiniMax-M2.5', contextWindowSize: 196608, enableThinking: true },
];

export interface TokenPlanConfig {
  id: 'token';
  option: 'TOKEN_PLAN';
  displayName: string;
  title: string;
  description: string;
  authEventType: 'coding-plan';
  envKey: typeof TOKEN_PLAN_ENV_KEY;
  metadataKey: 'tokenPlan';
  template: ProviderModelConfig[];
  version: string;
  baseUrl: typeof TOKEN_PLAN_BASE_URL;
  documentationUrl: string;
  apiKeyUrl: string;
  usageDocumentationUrl: string;
}

export interface TokenPlanInstallInput {
  apiKey?: string;
}

export const TOKEN_PLAN_OPTION = {
  id: 'token',
  option: 'TOKEN_PLAN',
  title: 'Token Plan',
  description:
    'For teams and companies · Usage-based billing with dedicated endpoint',
} as const;

export function computeTokenPlanVersion(
  template: ProviderModelConfig[],
): string {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex');
}

export function buildTokenPlanTemplate(): ProviderModelConfig[] {
  return TOKEN_PLAN_MODELS.map((model) => ({
    id: model.id,
    name: `[ModelStudio Token Plan] ${model.id}`,
    ...(model.description ? { description: model.description } : {}),
    baseUrl: TOKEN_PLAN_BASE_URL,
    envKey: TOKEN_PLAN_ENV_KEY,
    generationConfig: {
      ...(model.enableThinking
        ? { extra_body: { enable_thinking: true } }
        : {}),
      contextWindowSize: model.contextWindowSize,
    },
  }));
}

export function getTokenPlanConfig(): TokenPlanConfig {
  const template = buildTokenPlanTemplate();

  return {
    id: TOKEN_PLAN_OPTION.id,
    option: TOKEN_PLAN_OPTION.option,
    displayName: TOKEN_PLAN_OPTION.title,
    title: TOKEN_PLAN_OPTION.title,
    description: TOKEN_PLAN_OPTION.description,
    authEventType: 'coding-plan',
    envKey: TOKEN_PLAN_ENV_KEY,
    metadataKey: 'tokenPlan',
    template,
    version: computeTokenPlanVersion(template),
    baseUrl: TOKEN_PLAN_BASE_URL,
    documentationUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856',
    apiKeyUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856',
    usageDocumentationUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856',
  };
}

export function createTokenPlanInstallPlan({
  apiKey,
}: TokenPlanInstallInput): ProviderInstallPlan {
  const plan = getTokenPlanConfig();
  const models: ProviderModelConfig[] = plan.template.map((templateConfig) => ({
    ...templateConfig,
    envKey: plan.envKey,
  }));
  const firstModel = models[0]?.id;

  return {
    providerId: tokenPlanProvider.id,
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
      tokenPlan: {
        version: plan.version,
        baseUrl: plan.baseUrl,
      },
    },
  };
}

export function findTokenPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): TokenPlanConfig | undefined {
  return baseUrl === TOKEN_PLAN_BASE_URL && envKey === TOKEN_PLAN_ENV_KEY
    ? getTokenPlanConfig()
    : undefined;
}

export function isTokenPlanConfig(
  baseUrl: string | undefined,
  envKey: string | undefined,
): boolean {
  return findTokenPlanConfig(baseUrl, envKey) !== undefined;
}

export const tokenPlanProvider: LlmProvider = {
  id: 'token-plan',
  label: 'Alibaba Cloud Token Plan',
  category: 'recommended',
  protocol: AuthType.USE_OPENAI,
  setupMethods: [{ type: 'subscription' }],
  ownsModel(model) {
    return isTokenPlanConfig(model.baseUrl, model.envKey);
  },
  async createInstallPlan(input) {
    return createTokenPlanInstallPlan(
      input as unknown as TokenPlanInstallInput,
    );
  },
};
