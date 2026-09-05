/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ModelReasoningCapabilities } from '../models/types.js';

/**
 * Unified reasoning-effort ladder exposed to users (e.g. via `/effort`).
 *
 * Providers accept different subsets and use different wire fields
 * (`reasoning_effort`, `output_config.effort`, `thinking_level`,
 * `enable_thinking`, ...). Each provider adapter maps and clamps this canonical
 * tier onto what the active model supports. The ordered ladder + numeric ranks
 * are borrowed from openclaw's thinking-level model so a new provider only needs
 * to declare its supported subset.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ordered weakest → strongest. Drives the `/effort` picker and clamping. */
export const REASONING_EFFORT_TIERS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * Numeric strength used when clamping a requested tier down to what a model
 * supports. Gaps are intentional so future intermediate tiers (e.g. a
 * `minimal: 10`) can slot in without renumbering.
 */
export const REASONING_EFFORT_RANKS: Record<ReasoningEffort, number> = {
  low: 20,
  medium: 30,
  high: 40,
  xhigh: 60,
  max: 70,
};

/**
 * Normalize free-form user input to a canonical tier. Accepts separators and a
 * few common aliases (`x-high`, `extra-high`, `maximum`). Returns `undefined`
 * for anything unrecognized so callers can surface a helpful error.
 */
export function normalizeReasoningEffort(
  raw?: string | null,
): ReasoningEffort | undefined {
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  switch (key) {
    case 'low':
      return 'low';
    case 'medium':
    case 'med':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'extrahigh':
      return 'xhigh';
    case 'max':
    case 'maximum':
      return 'max';
    default:
      return undefined;
  }
}

/**
 * Clamp a requested tier to the nearest tier a model/provider actually supports.
 *
 * Rank-based, mirroring openclaw's `clampThinkingLevel`: if the exact tier is
 * supported, keep it; otherwise prefer the next stronger supported tier, and
 * only walk down when nothing at or above the request is available. Because an
 * unsupported `xhigh`/`max` will have no supported tier at or above it (the
 * model's supported list omits them), this naturally caps over-strong requests
 * to the model ceiling without raising cost.
 *
 * `supported` defaults to the full ladder (no clamping).
 */
export function clampReasoningEffort(
  requested: ReasoningEffort,
  supported?: readonly ReasoningEffort[],
): ReasoningEffort {
  const set =
    supported && supported.length > 0 ? supported : REASONING_EFFORT_TIERS;
  if (set.includes(requested)) {
    return requested;
  }
  const requestedRank = REASONING_EFFORT_RANKS[requested];
  const ranked = [...set].sort(
    (a, b) => REASONING_EFFORT_RANKS[a] - REASONING_EFFORT_RANKS[b],
  );
  // Prefer the next stronger supported tier (smallest rank >= request).
  for (const tier of ranked) {
    if (REASONING_EFFORT_RANKS[tier] >= requestedRank) {
      return tier;
    }
  }
  // Nothing at or above the request: fall back to the strongest available.
  return ranked[ranked.length - 1]!;
}

/**
 * Set `effort` and read it back to confirm the config actually accepted it.
 * `Config.setReasoningEffort` is a documented no-op when thinking is
 * explicitly disabled (`reasoning: false`); returns false when the requested
 * tier did not land so each surface can report the discard its own way
 * instead of reporting success. Clearing the override (`undefined`) always
 * reports true.
 */
export function applyReasoningEffort(
  config: Config,
  effort: ReasoningEffort | undefined,
): boolean {
  config.setReasoningEffort(effort);
  return config.getReasoningEffort() === effort;
}

/**
 * Parse a `ModelConfig.capabilities.reasoning` value into the capability both
 * the reasoning controls and the request pipeline honour.
 *
 * The value arrives from a settings file, so an incomplete entry is reachable,
 * and `disableField` is its only member with no fallback. Returning `undefined`
 * for one keeps the model on its pre-capability behavior everywhere: a
 * capability the pickers refuse must not reshape the wire anyway.
 */
export function parseModelReasoningCapabilities(
  value: unknown,
): ModelReasoningCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate['thinking'] !== true) return undefined;
  const disableField = candidate['disableField'];
  if (
    disableField !== 'enable_thinking' &&
    disableField !== 'reasoning_effort' &&
    disableField !== 'thinking'
  ) {
    return undefined;
  }
  // Downstream reads `toggleOnly` by truthiness and `canDisable` by
  // `=== false`, so a mistyped value would silently change the declaration
  // instead of failing the entry.
  const toggleOnly = candidate['toggleOnly'];
  if (toggleOnly !== undefined && typeof toggleOnly !== 'boolean') {
    return undefined;
  }
  const canDisable = candidate['canDisable'];
  if (canDisable !== undefined && canDisable !== false) {
    return undefined;
  }
  if (toggleOnly === true) {
    return candidate as unknown as ModelReasoningCapabilities;
  }
  const efforts = candidate['efforts'];
  if (
    !Array.isArray(efforts) ||
    efforts.length === 0 ||
    !efforts.every(
      (effort) =>
        typeof effort === 'string' &&
        REASONING_EFFORT_TIERS.includes(effort as ReasoningEffort),
    ) ||
    new Set(efforts).size !== efforts.length
  ) {
    return undefined;
  }
  const defaultEffort = candidate['defaultEffort'];
  if (defaultEffort !== undefined && !efforts.includes(defaultEffort)) {
    return undefined;
  }
  return candidate as unknown as ModelReasoningCapabilities;
}
