/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/core';
import type { SessionModelInfo } from '../session/sessionModels.js';
import { buildSessionModelList } from '../session/buildSessionModelList.js';

interface AvailableModelsSnapshot {
  models: SessionModelInfo[];
  currentModel: string;
  fingerprint: string;
}

/**
 * Read the Worker-owned model state once so every projection observes the
 * same catalog/current-model pair.
 */
export async function buildAvailableModelsSnapshot(
  config: Config,
  prebuiltModels?: SessionModelInfo[],
): Promise<AvailableModelsSnapshot> {
  const currentModel = config.getModel() ?? '';
  const models = prebuiltModels ?? (await buildSessionModelList(config));
  return {
    models,
    currentModel,
    fingerprint: JSON.stringify({ currentModel, models }),
  };
}
