/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import type { ResolvedModelConfig } from '../models/types.js';
import {
  AuthType,
  createContentGenerator,
  type ContentGenerator,
} from './contentGenerator.js';

export type ContentGeneratorForModel = (
  model: string,
) => Promise<ContentGenerator>;

function resolveModelAcrossAuthTypes(
  config: Config,
  model: string,
): ResolvedModelConfig | undefined {
  const modelsConfig = config.getModelsConfig();
  const allAuthTypes: AuthType[] = [
    AuthType.QWEN_OAUTH,
    AuthType.USE_OPENAI,
    AuthType.USE_VERTEX_AI,
    AuthType.USE_ANTHROPIC,
    AuthType.USE_GEMINI,
  ];

  const mainAuthType = config.getContentGeneratorConfig()?.authType;
  if (mainAuthType) {
    const resolved = modelsConfig.getResolvedModel(mainAuthType, model);
    if (resolved) {
      return resolved;
    }
  }

  for (const authType of allAuthTypes) {
    if (authType === mainAuthType) {
      continue;
    }
    const resolved = modelsConfig.getResolvedModel(authType, model);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

export function createRetryAuthTypeForModel(
  config: Config,
  model: string,
): string | undefined {
  return resolveModelAcrossAuthTypes(config, model)?.authType;
}

export function createContentGeneratorForModelResolver(
  config: Config,
  getOwnContentGenerator: () => ContentGenerator,
): ContentGeneratorForModel {
  // This cache follows the owning client/resolver lifetime, not resetChat().
  // resetChat only resets conversation state; config changes that should affect
  // model/provider resolution must recreate the owning client.
  const contentGeneratorsByModel = new Map<string, Promise<ContentGenerator>>();

  return (model: string): Promise<ContentGenerator> => {
    if (model === config.getModel()) {
      return Promise.resolve(getOwnContentGenerator());
    }

    const cached = contentGeneratorsByModel.get(model);
    if (cached) {
      return cached;
    }

    const resolvedModel = resolveModelAcrossAuthTypes(config, model);
    const authType =
      resolvedModel?.authType ?? config.getContentGeneratorConfig().authType;
    if (!authType) {
      return Promise.reject(
        new Error(
          `Cannot create content generator for model ${model}: authType is not configured.`,
        ),
      );
    }

    const generatorConfig = buildAgentContentGeneratorConfig(config, model, {
      authType,
      apiKey: resolvedModel?.envKey
        ? (process.env[resolvedModel.envKey] ?? undefined)
        : undefined,
      baseUrl: resolvedModel?.baseUrl,
    });
    const generatorPromise = createContentGenerator(
      generatorConfig,
      config,
    ).catch((error: unknown) => {
      contentGeneratorsByModel.delete(model);
      throw error;
    });
    contentGeneratorsByModel.set(model, generatorPromise);
    return generatorPromise;
  };
}
