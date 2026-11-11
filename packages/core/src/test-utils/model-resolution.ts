/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { CustomProviderAccess } from '../config/custom-provider-access.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import { CronManager } from '../cron/cronManager.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { Model } from '../provider/model/model.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import {
  mergeModelConfig,
  type ModelConfig,
} from '../provider/model/modelConfig.js';
import { CustomProviderRegistry } from '../provider/custom/registry.js';

/** Minimal provider model for selections that never reach a Provider. */
export function testProviderModel(key: string): Model {
  return {
    source: 'qoder',
    key,
    displayName: key,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported: false, supportedEfforts: [] },
      contextWindows: [],
    },
    limits: { maxContextTokens: 200_000 },
  };
}

export function testModelResolution(
  model: string | Model,
  overrides: {
    reasoningEffort?: ReasoningEffortLevel;
    contextWindow?: number;
    config?: ModelConfig;
  } = {},
): ModelSelection {
  return {
    model: typeof model === 'string' ? testProviderModel(model) : model,
    config: mergeModelConfig(
      {
        ...(overrides.reasoningEffort !== undefined
          ? { reasoning: { effort: overrides.reasoningEffort } }
          : {}),
        ...(overrides.contextWindow !== undefined
          ? { context: { contextWindow: overrides.contextWindow } }
          : {}),
      },
      overrides.config,
    ),
  };
}

/**
 * Real registry/access behavior, without unrelated Config startup dependencies.
 *
 * `getCronManager` belongs here even though it is not about model resolution:
 * the agent loop reaches the session's parked-fire registry, prompt-cache clock
 * and user-presence clock through it, and most tests hand the loop an object
 * literal cast to `Config`. A real manager is the cheapest correct answer —
 * constructing one schedules nothing, so the loop's calls behave as they do in
 * production, and no defensive `?.` is needed in the loop. One instance per
 * call, because the loop asks more than once per turn and a fresh manager each
 * time would have forgotten the fire the previous call claimed.
 */
export function testRequestConfig(
  registry = new CustomProviderRegistry(),
): Pick<
  Config,
  | 'getModelRequestIdentity'
  | 'getCustomProviderRegistry'
  | 'canUseCustomProviders'
  | 'isConfiguredCustomProviderModelKey'
  | 'waitForCustomProviderAccess'
  | 'assertCustomProviderAccess'
  | 'getCronManager'
  | 'getWorkspaceContext'
> {
  const getModelRequestIdentity = () => 'test-account';
  const access = new CustomProviderAccess({
    getIdentity: getModelRequestIdentity,
    isEnabled: () => true,
    check: async () => true,
  });
  const cronManager = new CronManager({ getSessionId: () => 'test-session' });
  return {
    getModelRequestIdentity,
    getCronManager: () => cronManager,
    getWorkspaceContext: () => ({ getDirectories: () => [] }) as unknown as WorkspaceContext,
    getCustomProviderRegistry: () => registry,
    isConfiguredCustomProviderModelKey: (model) =>
      !!model && registry.isCustomProviderModel(model),
    canUseCustomProviders: () => access.state === 'allowed',
    waitForCustomProviderAccess: access.waitUntilReady.bind(access),
    assertCustomProviderAccess: access.assertReady.bind(access),
  };
}
