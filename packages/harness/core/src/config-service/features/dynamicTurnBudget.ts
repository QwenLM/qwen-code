/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../../provider/model/model.js';
import { QODER_PROVIDER_ID } from '../../provider/modelProvider.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  ensureConfigReadyForRequest,
  getConfigValue,
  subscribeConfigValue,
} from '../index.js';
import { parseObjectGateValue } from './gateParseUtils.js';

export const DYNAMIC_TURN_BUDGET_GATE = 'dynamic_turn_budget';
export const DEFAULT_DYNAMIC_TURN_LIMITS: readonly number[] = [24, 48, 96, 192, 384];

interface DynamicTurnBudgetConfig {
  readonly models: Readonly<Record<string, readonly number[]>>;
}

function parseConfig(value: unknown): DynamicTurnBudgetConfig | undefined {
  const record = parseObjectGateValue(value);
  if (record?.['enabled'] !== true) return undefined;
  const models = record['models'];
  if (!models || typeof models !== 'object' || Array.isArray(models))
    return undefined;
  const enabledModels: Array<[string, number[]]> = [];
  for (const [key, policy] of Object.entries(models)) {
    if (
      !key ||
      key.trim() !== key ||
      !policy ||
      typeof policy !== 'object' ||
      Array.isArray(policy) ||
      policy.enabled !== true
    )
      continue;
    const limits =
      policy.limits === undefined ? DEFAULT_DYNAMIC_TURN_LIMITS : policy.limits;
    if (
      !Array.isArray(limits) ||
      limits.length === 0 ||
      !limits.every(
        (limit, index) =>
          Number.isSafeInteger(limit) &&
          limit > 0 &&
          (index === 0 || limit > limits[index - 1]),
      )
    )
      continue;
    enabledModels.push([key, [...limits]]);
  }
  return { models: Object.fromEntries(enabledModels) };
}

/** Resolve against the selected Qoder model, then freeze the limits for one query. */
export async function resolveDynamicTurnLimits(
  model: Model,
  signal?: AbortSignal,
): Promise<readonly number[] | undefined> {
  if (model.source !== QODER_PROVIDER_ID) return undefined;
  try {
    await ensureConfigReadyForRequest({ signal });
  } catch (error) {
    signal?.throwIfAborted();
    runLogger.warn(
      '[config-service] Dynamic turn budget configuration unavailable',
      error,
    );
    return undefined;
  }
  const config = parseConfig(getConfigValue(DYNAMIC_TURN_BUDGET_GATE));
  return config && Object.hasOwn(config.models, model.key)
    ? config.models[model.key]
    : undefined;
}

export function registerDynamicTurnBudgetFeature(): void {
  subscribeConfigValue(DYNAMIC_TURN_BUDGET_GATE, (value) => {
    const config = parseConfig(value);
    runLogger.log(
      '[config-service] dynamic_turn_budget feature gate value received',
      {
        enabled: config !== undefined,
        ...config,
      },
    );
  });
}
