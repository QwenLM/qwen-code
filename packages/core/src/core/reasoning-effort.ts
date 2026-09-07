/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

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

export function getGptReasoningCapabilities(model: string | undefined):
  | {
      efforts: readonly ReasoningEffort[];
      defaultEffort: ReasoningEffort;
      defaultEnabled: boolean;
      thinkingMandatory: boolean;
    }
  | undefined {
  const normalized = (model?.toLowerCase() ?? '').replace(/:[\w.+-]+$/, '');
  if (/^(?:openai\/)?gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(normalized)) {
    return {
      efforts: REASONING_EFFORT_TIERS,
      defaultEffort: 'medium',
      defaultEnabled: true,
      thinkingMandatory: true,
    };
  }
  const match = /^(?:openai\/)?gpt-5(?:\.(\d+))?(?:\.\d+)*(?:-|$)/.exec(
    normalized,
  );
  if (!match || /-chat(?:-|$)/.test(normalized)) return undefined;

  const minor = Number(match[1] ?? 0);
  const pro = /-pro(?:-|$)/.test(normalized);
  const codex = /-codex(?:-|$)/.test(normalized);
  const thinkingMandatory = minor === 0 || pro || codex;
  const efforts: ReasoningEffort[] = pro
    ? minor === 0
      ? ['high']
      : ['medium', 'high', 'xhigh']
    : [
        'low',
        'medium',
        'high',
        ...(minor >= 2 || /-codex-max(?:-|$)/.test(normalized)
          ? (['xhigh'] as const)
          : []),
        ...(minor >= 6 ? (['max'] as const) : []),
      ];
  return {
    efforts,
    defaultEffort: pro && (minor === 0 || minor >= 5) ? 'high' : 'medium',
    defaultEnabled: thinkingMandatory || minor >= 5,
    thinkingMandatory,
  };
}

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
 * only walk down when nothing at or above the request is available. Requests
 * above the model ceiling are capped; requests below its floor are raised to
 * the weakest supported tier.
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
