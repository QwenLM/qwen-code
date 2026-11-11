/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContextWindowCapableModel {
  available_context_windows?: readonly number[] | null;
  availableContextWindows?: readonly number[] | null;
  default_context_window?: number | null;
  defaultContextWindow?: number | null;
  max_input_tokens?: number | null;
  maxInputTokens?: number | null;
}

export interface ParsedContextWindowConfig {
  windows: number[];
  defaultWindow?: number;
}

function normalizeContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return undefined;
}

function getExplicitContextWindows(
  model: ContextWindowCapableModel | undefined,
): number[] | undefined {
  if (!model) return undefined;
  return normalizeContextWindows(
    model.available_context_windows ?? model.availableContextWindows,
  );
}

export function normalizeContextWindows(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const parsed = normalizeContextWindow(item);
    if (parsed === undefined || seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out.length > 0 ? out : undefined;
}

export function parseContextWindowConfig(
  contextConfig: unknown,
): ParsedContextWindowConfig | undefined {
  if (!contextConfig || typeof contextConfig !== 'object') return undefined;

  const windows: number[] = [];
  const seen = new Set<number>();
  let defaultWindow: number | undefined;

  for (const config of Object.values(
    contextConfig as Record<string, unknown>,
  )) {
    if (!config || typeof config !== 'object') continue;
    const cfg = config as Record<string, unknown>;
    const tokenCount = normalizeContextWindow(cfg['token_count']);
    if (tokenCount === undefined) continue;

    if (!seen.has(tokenCount)) {
      seen.add(tokenCount);
      windows.push(tokenCount);
    }
    if (parseBoolean(cfg['is_default']) === true) {
      defaultWindow = tokenCount;
    }
  }

  if (windows.length === 0) return undefined;
  windows.sort((a, b) => a - b);
  return defaultWindow === undefined ? { windows } : { windows, defaultWindow };
}

export function getSupportedContextWindows(
  model: ContextWindowCapableModel | undefined,
): number[] {
  if (!model) return [];
  const configured = getExplicitContextWindows(model);
  if (configured) return configured;

  const maxInputTokens = normalizeContextWindow(
    model.max_input_tokens ?? model.maxInputTokens,
  );
  if (maxInputTokens === undefined) return [];

  const out: number[] = [];
  const add = (value: number) => {
    if (value > 0 && value <= maxInputTokens && !out.includes(value)) {
      out.push(value);
    }
  };
  add(128_000);
  add(200_000);
  add(maxInputTokens);
  return out;
}

/**
 * Resolve the context window that should actually be used for a model.
 *
 * - A configured window the model still supports is used as-is.
 * - A configured window the model no longer supports is discarded in favour of
 *   the model's default window — an invalid window is never clamped onto an
 *   equally invalid value.
 * - For an unknown model (no catalog entry) we can only best-effort clamp the
 *   configured value to `fallbackLimit`.
 * - With no usable configured window we fall back to the model's default
 *   window, then to `fallbackLimit`.
 */
export function resolveContextWindow(
  model: ContextWindowCapableModel | undefined,
  configured: number | undefined,
  fallbackLimit: number,
): number {
  if (configured !== undefined) {
    if (model && supportsContextWindow(model, configured)) {
      return configured;
    }
    if (!model) {
      return Math.min(configured, fallbackLimit);
    }
    // Known model but the configured window is no longer a valid option →
    // fall back to the model's default window below.
  }
  const defaultWindow =
    model?.default_context_window ?? model?.defaultContextWindow;
  if (defaultWindow != null && supportsContextWindow(model, defaultWindow)) {
    return defaultWindow;
  }
  return fallbackLimit;
}

export function supportsContextWindow(
  model: ContextWindowCapableModel | undefined,
  contextWindow: number,
): boolean {
  const normalized = normalizeContextWindow(contextWindow);
  if (normalized === undefined) return false;
  const configured = getExplicitContextWindows(model);
  if (configured) return configured.includes(normalized);

  const maxInputTokens = normalizeContextWindow(
    model?.max_input_tokens ?? model?.maxInputTokens,
  );
  return maxInputTokens === undefined || normalized <= maxInputTokens;
}
