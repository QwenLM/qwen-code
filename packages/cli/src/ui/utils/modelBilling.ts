/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelMetricsCore } from '@qwen-code/qwen-code-core';
import type {
  BillingSettings,
  ModelTokenDiscounts,
  ModelTokenPrice,
} from '../../config/settingsSchema.js';

const TOKENS_PER_MILLION = 1_000_000;

export interface ModelBillingBreakdown {
  currency: string;
  priceKey: string;
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  totalCost: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function isValidPrice(price: unknown): price is ModelTokenPrice {
  if (!price || typeof price !== 'object') {
    return false;
  }
  const candidate = price as Partial<ModelTokenPrice>;
  const hasPriceBucket = [
    candidate.input,
    candidate.output,
    candidate.cachedInput,
  ].some((value) => value !== undefined);
  return (
    hasPriceBucket &&
    (candidate.input === undefined ||
      (typeof candidate.input === 'number' &&
        Number.isFinite(candidate.input) &&
        candidate.input >= 0)) &&
    (candidate.output === undefined ||
      (typeof candidate.output === 'number' &&
        Number.isFinite(candidate.output) &&
        candidate.output >= 0)) &&
    (candidate.cachedInput === undefined ||
      (typeof candidate.cachedInput === 'number' &&
        Number.isFinite(candidate.cachedInput) &&
        candidate.cachedInput >= 0)) &&
    isValidDiscounts(candidate.discounts)
  );
}

function isValidDiscounts(discounts: ModelTokenDiscounts | undefined): boolean {
  if (discounts === undefined) {
    return true;
  }
  if (!discounts || typeof discounts !== 'object') {
    return false;
  }

  return ['input', 'cachedInput', 'output'].every((key) => {
    const value = discounts[key as keyof ModelTokenDiscounts];
    return (
      value === undefined ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    );
  });
}

function applyDiscount(price: number, discount: number | undefined): number {
  return price * (discount ?? 1);
}

function priceOrZero(price: number | undefined): number {
  return price ?? 0;
}

function normalizeCurrency(currency: string | undefined): string {
  const normalized = currency?.trim().toUpperCase();
  return normalized || 'USD';
}

function getModelPrice(
  billing: BillingSettings | undefined,
  modelName: string,
  authTypes: readonly string[] | undefined,
): { key: string; price: ModelTokenPrice } | undefined {
  const prices = billing?.modelPrices;
  if (!prices) {
    return undefined;
  }

  const candidateKeys: string[] = [];
  if (authTypes?.length === 1) {
    candidateKeys.push(`${authTypes[0]}:${modelName}`);
  }
  candidateKeys.push(modelName);

  for (const key of candidateKeys) {
    const price = prices[key];
    if (isValidPrice(price)) {
      return { key, price };
    }
  }

  return undefined;
}

function calculateModelBillingBreakdown(
  billing: BillingSettings | undefined,
  modelName: string,
  metrics: ModelMetricsCore,
  authTypes?: readonly string[],
): ModelBillingBreakdown | undefined {
  const matched = getModelPrice(billing, modelName, authTypes);
  if (!matched) {
    return undefined;
  }

  const promptTokens = Math.max(metrics.tokens.prompt, 0);
  const cachedInputTokens = Math.min(
    Math.max(metrics.tokens.cached, 0),
    promptTokens,
  );
  const uncachedInputTokens = promptTokens - cachedInputTokens;
  const outputTokens = Math.max(metrics.tokens.candidates, 0);
  if (promptTokens === 0 && outputTokens === 0) {
    return undefined;
  }
  const inputPrice = applyDiscount(
    priceOrZero(matched.price.input),
    matched.price.discounts?.input,
  );
  const cachedInputPrice = applyDiscount(
    matched.price.cachedInput === undefined
      ? priceOrZero(matched.price.input)
      : matched.price.cachedInput,
    matched.price.discounts?.cachedInput ??
      (matched.price.cachedInput === undefined
        ? matched.price.discounts?.input
        : undefined),
  );
  const outputPrice = applyDiscount(
    priceOrZero(matched.price.output),
    matched.price.discounts?.output,
  );

  const inputCost = (uncachedInputTokens / TOKENS_PER_MILLION) * inputPrice;
  const cachedInputCost =
    (cachedInputTokens / TOKENS_PER_MILLION) * cachedInputPrice;
  const outputCost = (outputTokens / TOKENS_PER_MILLION) * outputPrice;

  return {
    currency: normalizeCurrency(billing?.currency),
    priceKey: matched.key,
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost: inputCost + cachedInputCost + outputCost,
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

export function getModelBillingBreakdown(
  billing: BillingSettings | undefined,
  modelName: string,
  metrics: ModelMetricsCore,
  authTypes?: readonly string[],
  authTypeMetrics?: Readonly<Record<string, ModelMetricsCore>>,
): ModelBillingBreakdown | undefined {
  const authTypeEntries = Object.entries(authTypeMetrics ?? {}).filter(
    ([, authMetrics]) => authMetrics.api.totalRequests > 0,
  );

  if (authTypeEntries.length > 1) {
    const breakdowns: ModelBillingBreakdown[] = [];
    for (const [authType, authMetrics] of authTypeEntries) {
      const breakdown = calculateModelBillingBreakdown(
        billing,
        modelName,
        authMetrics,
        [authType],
      );
      if (!breakdown) {
        return undefined;
      }
      breakdowns.push(breakdown);
    }

    return {
      currency: breakdowns[0]?.currency ?? normalizeCurrency(billing?.currency),
      priceKey: breakdowns.map((breakdown) => breakdown.priceKey).join(','),
      inputCost: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.inputCost,
        0,
      ),
      cachedInputCost: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.cachedInputCost,
        0,
      ),
      outputCost: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.outputCost,
        0,
      ),
      totalCost: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.totalCost,
        0,
      ),
      uncachedInputTokens: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.uncachedInputTokens,
        0,
      ),
      cachedInputTokens: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.cachedInputTokens,
        0,
      ),
      outputTokens: breakdowns.reduce(
        (sum, breakdown) => sum + breakdown.outputTokens,
        0,
      ),
    };
  }

  return calculateModelBillingBreakdown(billing, modelName, metrics, authTypes);
}

export function formatModelCost(cost: number, currency = 'USD'): string {
  const normalizedCurrency = normalizeCurrency(currency);
  const abs = Math.abs(cost);
  const decimals = abs > 0 && abs < 0.01 ? 6 : 4;
  const amount = cost
    .toFixed(decimals)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '.00');

  if (normalizedCurrency === 'USD') {
    return `$${amount}`;
  }
  if (normalizedCurrency === 'CNY') {
    return `CNY ${amount}`;
  }
  return `${normalizedCurrency} ${amount}`;
}
