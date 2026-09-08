/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { normalize } from './tokenLimits.js';

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
  const normalized = normalize(model ?? '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^(gpt-5\.\d+)(?:\.\d+)+(?=-|$)/, '$1');
  switch (normalized) {
    case 'gpt-5':
    case 'gpt-5-mini':
    case 'gpt-5-nano':
    case 'gpt-5.1-codex':
      return {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    case 'gpt-5-pro':
      return {
        efforts: ['high'],
        defaultEffort: 'high',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    case 'gpt-5.1':
      return {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        defaultEnabled: false,
        thinkingMandatory: false,
      };
    case 'gpt-5.2':
    case 'gpt-5.4':
    case 'gpt-5.4-mini':
    case 'gpt-5.4-nano':
      return {
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        defaultEnabled: false,
        thinkingMandatory: false,
      };
    case 'gpt-5.1-codex-max':
    case 'gpt-5.2-codex':
    case 'gpt-5.3-codex':
      return {
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    case 'gpt-5.2-pro':
    case 'gpt-5.4-pro':
      return {
        efforts: ['medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    case 'gpt-5.5':
      return {
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: false,
      };
    case 'gpt-5.5-pro':
      return {
        efforts: ['medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    case 'gpt-5.6':
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna':
      return {
        efforts: REASONING_EFFORT_TIERS,
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: false,
      };
    case 'gpt-6-astra':
      return {
        efforts: REASONING_EFFORT_TIERS,
        defaultEffort: 'medium',
        defaultEnabled: true,
        thinkingMandatory: true,
      };
    default:
      return undefined;
  }
}

export function isReasoningEffortPlaceholder(value: unknown): boolean {
  return value == null || value === '';
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
