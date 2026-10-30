/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { ModelsConfig } from '@qwen-code/qwen-code-core/models/modelsConfig.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';

export interface ManagedLocalModel {
  modelId: string;
  label: string;
}

export function loadManagedLocalModels(): {
  models: ManagedLocalModel[];
  defaultModelId?: string;
} {
  const { merged } = loadSettings(process.cwd(), {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: false,
  });
  const configured = new ModelsConfig({
    modelProvidersConfig: merged.modelProviders,
    providerProtocolConfig: merged.providerProtocol,
  }).getAllConfiguredModels();
  const selection = resolveCliGenerationConfig({
    argv: {},
    settings: merged,
    selectedAuthType:
      merged.security?.auth?.selectedType ?? getAuthTypeFromEnv(),
  });
  const models = configured
    .filter(
      (model) =>
        model.authType !== AuthType.QWEN_OAUTH &&
        !model.fastOnly &&
        !model.voiceOnly &&
        !model.visionOnly &&
        !model.imageOnly &&
        configured.filter((candidate) => candidate.id === model.id).length ===
          1,
    )
    .map((model) => ({ modelId: model.id, label: model.label || model.id }));
  const selected = models.findIndex(
    (model) =>
      model.modelId === selection.model &&
      configured.some(
        (candidate) =>
          candidate.id === model.modelId &&
          candidate.authType === selection.authType,
      ),
  );
  if (selected > 0) models.unshift(...models.splice(selected, 1));
  return {
    models,
    defaultModelId: selected >= 0 ? selection.model : undefined,
  };
}
