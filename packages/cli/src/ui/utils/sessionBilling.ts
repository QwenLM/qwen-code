/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelMetricsCore,
  SessionMetrics,
} from '@qwen-code/qwen-code-core';
import type { BillingSettings } from '../../config/settingsSchema.js';
import { getModelBillingBreakdown } from './modelBilling.js';

export interface SessionBillingTotal {
  currency: string;
  totalCost: number;
}

interface BillingUsage {
  model: string;
  authType?: string;
  metrics: ModelMetricsCore;
}

function subtractMetrics(
  total: ModelMetricsCore,
  parts: ModelMetricsCore[],
): ModelMetricsCore {
  const subtract = (getter: (metrics: ModelMetricsCore) => number): number =>
    Math.max(
      0,
      getter(total) - parts.reduce((sum, part) => sum + getter(part), 0),
    );

  return {
    api: {
      totalRequests: subtract((metrics) => metrics.api.totalRequests),
      totalErrors: subtract((metrics) => metrics.api.totalErrors),
      totalLatencyMs: subtract((metrics) => metrics.api.totalLatencyMs),
    },
    tokens: {
      prompt: subtract((metrics) => metrics.tokens.prompt),
      candidates: subtract((metrics) => metrics.tokens.candidates),
      total: subtract((metrics) => metrics.tokens.total),
      cached: subtract((metrics) => metrics.tokens.cached),
      thoughts: subtract((metrics) => metrics.tokens.thoughts),
      tool: subtract((metrics) => metrics.tokens.tool),
    },
  };
}

function hasBillableActivity(metrics: ModelMetricsCore): boolean {
  return (
    metrics.api.totalRequests > 0 ||
    metrics.tokens.prompt > 0 ||
    metrics.tokens.candidates > 0 ||
    metrics.tokens.cached > 0 ||
    metrics.tokens.thoughts > 0 ||
    metrics.tokens.tool > 0
  );
}

function getCurrentSessionBillingUsages(
  metrics: SessionMetrics,
): BillingUsage[] {
  const usages: BillingUsage[] = [];

  for (const [model, modelMetrics] of Object.entries(metrics.models)) {
    const authEntries = Object.entries(modelMetrics.byAuthType ?? {}).filter(
      ([, authMetrics]) => hasBillableActivity(authMetrics),
    );

    if (authEntries.length > 0) {
      const authMetrics = authEntries.map(
        ([, metricsForAuth]) => metricsForAuth,
      );
      for (const [authType, metricsForAuth] of authEntries) {
        usages.push({
          model,
          authType,
          metrics: metricsForAuth,
        });
      }

      const remainder = subtractMetrics(modelMetrics, authMetrics);
      if (hasBillableActivity(remainder)) {
        usages.push({ model, metrics: remainder });
      }
      continue;
    }

    usages.push({
      model,
      authType:
        modelMetrics.authTypes?.length === 1
          ? modelMetrics.authTypes[0]
          : undefined,
      metrics: modelMetrics,
    });
  }

  return usages;
}

function calculateUsagesCost(
  usages: BillingUsage[],
  billing: BillingSettings,
): { cost: number; pricedCallCount: number; currency?: string } {
  let cost = 0;
  let pricedCallCount = 0;
  let currency: string | undefined;

  for (const usage of usages) {
    const breakdown = getModelBillingBreakdown(
      billing,
      usage.model,
      usage.metrics,
      usage.authType ? [usage.authType] : undefined,
    );
    if (!breakdown) {
      continue;
    }

    currency = breakdown.currency;
    cost += breakdown.totalCost;
    pricedCallCount++;
  }

  return { cost, pricedCallCount, currency };
}

function hasConfiguredPrices(
  billing: BillingSettings | undefined,
): billing is BillingSettings & {
  modelPrices: NonNullable<BillingSettings['modelPrices']>;
} {
  return !!billing?.modelPrices && Object.keys(billing.modelPrices).length > 0;
}

export function getCurrentSessionBillingTotal(
  billing: BillingSettings | undefined,
  metrics: SessionMetrics,
): SessionBillingTotal | undefined {
  if (!hasConfiguredPrices(billing)) {
    return undefined;
  }

  const currentCost = calculateUsagesCost(
    getCurrentSessionBillingUsages(metrics),
    billing,
  );
  if (currentCost.pricedCallCount === 0) {
    return undefined;
  }

  return {
    currency: currentCost.currency ?? billing.currency ?? 'USD',
    totalCost: currentCost.cost,
  };
}
