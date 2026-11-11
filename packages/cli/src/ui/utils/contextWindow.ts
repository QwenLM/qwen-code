/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getSupportedContextWindows,
  isContextWindowSelectionEnabled,
} from '@qwen-code/core';

export interface ContextWindowCapableModel {
  key: string;
  display_name: string;
  available_context_windows?: readonly number[] | null;
  availableContextWindows?: readonly number[] | null;
  default_context_window?: number | null;
  defaultContextWindow?: number | null;
  max_input_tokens?: number | null;
  maxInputTokens?: number | null;
}

export function getDefaultContextWindow(
  model: ContextWindowCapableModel | undefined,
): number | undefined {
  if (!model) return undefined;
  const raw = model.default_context_window ?? model.defaultContextWindow;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
    ? raw
    : undefined;
}

function getMaxInputContextWindow(
  model: ContextWindowCapableModel | undefined,
): number | undefined {
  if (!model) return undefined;
  const raw = model.max_input_tokens ?? model.maxInputTokens;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
    ? raw
    : undefined;
}

function hasExplicitContextWindowList(
  model: ContextWindowCapableModel | undefined,
): boolean {
  const raw =
    model?.available_context_windows ?? model?.availableContextWindows;
  return Boolean(
    Array.isArray(raw) &&
      raw.some(
        (value) =>
          typeof value === 'number' && Number.isInteger(value) && value > 0,
      ),
  );
}

/**
 * The context window to display/use for a model when the user hasn't picked one
 * this session. Prefers the model's explicit default, but falls back to its
 * first explicit supported window. When the server only exposes max_input_tokens,
 * that max is the effective runtime default, so display it instead of the first
 * generated selectable fallback (128K).
 */
export function getEffectiveDefaultContextWindow(
  model: ContextWindowCapableModel | undefined,
): number | undefined {
  const defaultWindow = getDefaultContextWindow(model);
  if (defaultWindow !== undefined) return defaultWindow;
  if (!isContextWindowSelectionEnabled()) return undefined;
  if (hasExplicitContextWindowList(model))
    return getModelContextWindows(model)[0];
  return getMaxInputContextWindow(model) ?? getModelContextWindows(model)[0];
}

export function formatContextWindowValueLabel(value?: number): string {
  if (value === undefined) return '';
  // Decimal SI units: 1K = 1,000 / 1M = 1,000,000. The server returns tier
  // labels like "200K" / "1M" using these conventions, so the UI must match.
  const oneMillion = 1_000_000;
  if (value >= oneMillion && value % oneMillion === 0) {
    return `${value / oneMillion}M`;
  }
  if (value >= 1_000 && value % 1_000 === 0) {
    return `${value / 1_000}K`;
  }
  return value.toLocaleString('en-US');
}

export function formatContextWindowLabel(value?: number): string {
  const label = formatContextWindowValueLabel(value);
  return label ? `${label} context` : '';
}

export function getModelContextWindows(
  model: ContextWindowCapableModel | undefined,
): number[] {
  if (!isContextWindowSelectionEnabled()) return [];
  return getSupportedContextWindows(model);
}

export function formatContextWindowCommandSuffix(
  contextWindow?: number,
): string {
  return contextWindow !== undefined
    ? ` (context: ${formatContextWindowValueLabel(contextWindow)})`
    : '';
}
