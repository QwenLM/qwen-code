/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ModelProvidersConfig, ProviderModelConfig } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { getPersistScopeForModelSelection } from '../config/modelProvidersScope.js';
import {
  type CodingPlanRegion,
  getCodingPlanConfig,
  isCodingPlanConfig,
  CODING_PLAN_ENV_KEY,
} from '../constants/codingPlan.js';

export async function applyCodingPlanAuth(
  apiKey: string,
  region: CodingPlanRegion,
  settings: LoadedSettings,
  config: Config
): Promise<void> {
  const { template, version } = getCodingPlanConfig(region);
  const persistScope = getPersistScopeForModelSelection(settings);

  settings.setValue(persistScope, `env.${CODING_PLAN_ENV_KEY}`, apiKey);
  process.env[CODING_PLAN_ENV_KEY] = apiKey;

  const newConfigs: ProviderModelConfig[] = template.map((templateConfig) => ({
    ...templateConfig,
    envKey: CODING_PLAN_ENV_KEY,
  }));

  const existingConfigs =
    (settings.merged.modelProviders as ModelProvidersConfig | undefined)?.[AuthType.USE_OPENAI] || [];

  const nonCodingPlanConfigs = existingConfigs.filter(
    (existing) => !isCodingPlanConfig(existing.baseUrl, existing.envKey)
  );

  const updatedConfigs = [...newConfigs, ...nonCodingPlanConfigs];

  settings.setValue(
    persistScope,
    `modelProviders.${AuthType.USE_OPENAI}`,
    updatedConfigs
  );

  settings.setValue(
    persistScope,
    'security.auth.selectedType',
    AuthType.USE_OPENAI
  );

  settings.setValue(persistScope, 'codingPlan.region', region);
  settings.setValue(persistScope, 'codingPlan.version', version);

  if (updatedConfigs.length > 0 && updatedConfigs[0]?.id) {
    settings.setValue(persistScope, 'model.name', updatedConfigs[0].id);
  }

  const updatedModelProviders: ModelProvidersConfig = {
    ...(settings.merged.modelProviders as ModelProvidersConfig | undefined),
    [AuthType.USE_OPENAI]: updatedConfigs,
  };
  config.reloadModelProvidersConfig(updatedModelProviders);

  await config.refreshAuth(AuthType.USE_OPENAI);
}
