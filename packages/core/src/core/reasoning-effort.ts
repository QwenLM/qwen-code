/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { normalize } from './tokenLimits.js';
import type { ModelReasoningCapabilities } from '../models/types.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';

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
  const normalized = normalize(
    (model ?? '').trim().replace(/:batch(?=:|$)/gi, ''),
  )
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

/**
 * Write `effort` onto a content-generator config's `reasoning` block. This is
 * the one rule for putting a tier on a config: `/effort` applies it to the
 * session (`Config.setReasoningEffort`) and a workflow `agent({ effort })`
 * applies it to that agent's own copy of the config.
 *
 * A config with thinking explicitly turned off (`reasoning: false`) is left
 * alone and `false` is returned. Otherwise the tier replaces `reasoning.effort`
 * while sibling fields such as `budget_tokens` survive, and `undefined`
 * removes the tier. Removing the last key collapses `reasoning` back to
 * `undefined` rather than leaving an empty `{}`: an empty object is truthy, so
 * downstream `if (cfg.reasoning)` checks would treat reasoning as active and
 * the pipeline would emit `reasoning: {}` as wire noise.
 *
 * The block is replaced, never mutated, so a config that shares its
 * `reasoning` object with another — a per-agent config spread from the
 * session's — never changes the other one. No clamping happens here: each
 * provider maps the tier onto what the target model accepts when it builds a
 * request.
 */
export function setGeneratorReasoningEffort(
  cfg: { reasoning?: ContentGeneratorConfig['reasoning'] } | undefined,
  effort: ReasoningEffort | undefined,
): boolean {
  if (!cfg || cfg.reasoning === false) {
    return false;
  }
  const next: { effort?: ReasoningEffort; budget_tokens?: number } = {
    ...(cfg.reasoning ?? {}),
  };
  if (effort) {
    next.effort = effort;
  } else {
    delete next.effort;
  }
  cfg.reasoning = Object.keys(next).length > 0 ? next : undefined;
  return true;
}

/**
 * The tiers `/effort` offers for a model with this parsed reasoning
 * capability: none for a toggle-only model, the declared list otherwise, and
 * the whole ladder when the model declares nothing (the provider clamps then).
 * The one tier rule shared by `/effort` (the CLI's picker and command) and a
 * workflow agent's per-call effort; each site keeps its own capability lookup.
 */
export function reasoningEffortsForCapability(
  reasoning:
    | { readonly toggleOnly: true }
    | {
        readonly toggleOnly?: false;
        readonly efforts: readonly ReasoningEffort[];
      }
    | undefined,
): readonly ReasoningEffort[] {
  if (!reasoning) return REASONING_EFFORT_TIERS;
  return reasoning.toggleOnly ? [] : reasoning.efforts;
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
  if (
    ('toggleOnly' in candidate &&
      typeof candidate['toggleOnly'] !== 'boolean') ||
    ('canDisable' in candidate && candidate['canDisable'] !== false)
  ) {
    return undefined;
  }
  if (candidate['toggleOnly'] === true) {
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
