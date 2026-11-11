/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isRecord,
  parseReasoningEffortLevel,
  readNonNegativeNumber,
  readNumberStrict,
  reasoningEffortFromThinkingBudget,
  type ReasoningEffortLevel,
} from './model-values.js';
import type {
  ModelConfig,
  ModelThinkingConfig,
} from '../provider/model/model.js';

/**
 * Unified client-side reasoning configuration. This is the single internal
 * representation; each transport projects it to its own wire field names.
 */
export interface LlmReasoningConfig {
  /** Explicit provider-independent thinking mode. */
  thinking?: LlmThinkingConfig;
  /** Whether thinking is enabled using the model's provider-native mode. */
  enabled?: boolean;
  effort?: ReasoningEffortLevel;
  /** @deprecated Compatibility input only. Use `thinking.budgetTokens`. */
  budgetTokens?: number;
  /** Preserve prior thinking across turns. */
  preserve?: boolean;
}

export type LlmThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

/**
 * Unified client-side generation parameters. Stored as flattened fields under
 * `model.preferences[modelId]` and carried structurally on
 * {@link ModelTransportRequest.generation} down to each transport.
 */
export interface LlmGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  reasoning?: LlmReasoningConfig;
}

/**
 * Merges generation configuration from lowest to highest priority.
 *
 * Sampling fields use normal last-writer-wins semantics. `reasoning` is merged
 * independently so a narrow override such as `{ preserve: false }` does not
 * erase an inherited effort or thinking choice. The final value is normalized
 * once, making this the single precedence boundary shared by transports.
 */
export function mergeLlmGenerationConfigs(
  ...configs: Array<LlmGenerationConfig | undefined>
): LlmGenerationConfig | undefined {
  const merged: LlmGenerationConfig = {};
  let reasoning: LlmReasoningConfig | undefined;

  for (const config of configs) {
    const normalized = normalizeLlmGenerationConfig(config);
    if (!normalized) continue;
    const { reasoning: nextReasoning, ...sampling } = normalized;
    Object.assign(merged, sampling);
    if (nextReasoning) {
      reasoning = mergeReasoningConfigs(reasoning, nextReasoning);
    }
  }

  if (reasoning) merged.reasoning = reasoning;
  return normalizeLlmGenerationConfig(merged);
}

function mergeReasoningConfigs(
  lowerPriority: LlmReasoningConfig | undefined,
  higherPriority: LlmReasoningConfig,
): LlmReasoningConfig {
  const merged = { ...(lowerPriority ?? {}) };

  // `enabled` and `thinking` are two atomic forms of the same intent. A
  // higher-priority choice must replace, rather than combine with, the lower
  // layer's choice. Other reasoning controls still deep-merge independently.
  if (higherPriority.thinking) {
    delete merged.enabled;
  } else if (higherPriority.enabled !== undefined) {
    delete merged.thinking;
  }
  return {
    ...merged,
    ...higherPriority,
    ...(higherPriority.thinking
      ? { thinking: { ...higherPriority.thinking } }
      : {}),
  };
}

/**
 * Deep-clones a generation config (including its nested `reasoning`) so mutating
 * the copy never touches shared defaults.
 */
export function cloneLlmGenerationConfig(
  gen: LlmGenerationConfig,
): LlmGenerationConfig {
  return {
    ...gen,
    ...(gen.reasoning
      ? {
          reasoning: {
            ...gen.reasoning,
            ...(gen.reasoning.thinking
              ? { thinking: { ...gen.reasoning.thinking } }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * 把按模型存储的生成偏好投影为 select 契约的 {@link ModelConfig}。
 * `enabled: false` 等价于显式关闭思考；`enabled: true` 表示沿用模型原生行为，
 * 不产生 thinking 字段。独立 effort 优先，否则保留生成配置自身的 effort。
 */
export function modelConfigFromGeneration(
  gen: LlmGenerationConfig | undefined,
  effort?: ReasoningEffortLevel,
  contextWindow?: number,
): ModelConfig {
  const reasoning = normalizeReasoningConfig(gen?.reasoning);
  const effectiveEffort = effort ?? parseReasoningEffortLevel(gen?.reasoning?.effort);
  const thinking: ModelThinkingConfig | undefined = reasoning?.thinking
    ? { ...reasoning.thinking }
    : reasoning?.enabled === false
      ? { type: 'disabled' }
      : undefined;
  const sampling = {
    ...(gen?.temperature !== undefined ? { temperature: gen.temperature } : {}),
    ...(gen?.topP !== undefined ? { topP: gen.topP } : {}),
    ...(gen?.topK !== undefined ? { topK: gen.topK } : {}),
  };
  return {
    reasoning: {
      ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
      ...(thinking ? { thinking } : {}),
      ...(reasoning?.preserve !== undefined
        ? { preserve: reasoning.preserve }
        : {}),
    },
    ...(contextWindow !== undefined || gen?.maxTokens !== undefined
      ? {
          context: {
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            ...(gen?.maxTokens !== undefined ? { maxOutputTokens: gen.maxTokens } : {}),
          },
        }
      : {}),
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
  };
}

/**
 * select 结果投影为会话快照与压缩记录的生成配置；推理直接消费 ModelConfig。
 * effort 'none' 折叠为关闭思考。
 */
export function generationFromModelConfig(
  config: ModelConfig,
): LlmGenerationConfig | undefined {
  const { reasoning, sampling } = config;
  return normalizeLlmGenerationConfig({
    temperature: sampling?.temperature,
    topP: sampling?.topP,
    topK: sampling?.topK,
    maxTokens: config.context?.maxOutputTokens,
    reasoning: reasoning
      ? {
          ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
          ...(reasoning.effort !== undefined
            ? { effort: reasoning.effort }
            : {}),
          ...(reasoning.preserve !== undefined
            ? { preserve: reasoning.preserve }
            : {}),
        }
      : undefined,
  });
}

/** Custom-provider (OpenAI-compatible) wire field names. */
export interface CustomProviderWireGenerationFields {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
  thinking_budget?: number;
  preserve_thinking?: boolean;
  reasoning_effort?: ReasoningEffortLevel;
}

/** Accepts a probability in the provider-independent top_p range [0, 1]. */
function normalizeProbability(value: unknown): number | undefined {
  const n = readNumberStrict(value);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

/** Accepts a strictly positive integer (top_k / max_tokens / budgetTokens). */
function normalizePositiveInt(value: unknown): number | undefined {
  const n = readNumberStrict(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Normalizes a raw reasoning object into {@link LlmReasoningConfig}.
 *
 * The normalized representation keeps the high-level `enabled` intent,
 * explicit thinking mode, and effort independent. The legacy `budgetTokens`
 * input is converted to an explicit fixed-budget thinking mode;
 * `effort: none` remains a compatibility alias for disabled thinking.
 */
export function normalizeReasoningConfig(
  raw: unknown,
): LlmReasoningConfig | undefined {
  if (!isRecord(raw)) return undefined;

  const effort = parseReasoningEffortLevel(raw['effort']);
  const rawEnabled = raw['enabled'];
  const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : undefined;
  const budgetTokens = normalizePositiveInt(raw['budgetTokens']);
  const rawPreserve = raw['preserve'];
  const preserve = typeof rawPreserve === 'boolean' ? rawPreserve : undefined;

  const result: LlmReasoningConfig = {};

  const thinking = normalizeThinkingConfig(raw['thinking']);
  if (thinking) {
    result.thinking = thinking;
  } else if (enabled === false || effort === 'none') {
    result.enabled = false;
  } else if (budgetTokens !== undefined) {
    result.thinking = { type: 'enabled', budgetTokens };
  } else if (enabled === true) {
    result.enabled = true;
  }

  if (effort && effort !== 'none') result.effort = effort;

  if (preserve !== undefined) result.preserve = preserve;

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeThinkingConfig(raw: unknown): LlmThinkingConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const type = raw['type'];
  if (type === 'adaptive' || type === 'disabled') {
    return { type };
  }
  if (type !== 'enabled') return undefined;
  const budgetTokens = normalizePositiveInt(raw['budgetTokens']);
  return budgetTokens === undefined
    ? undefined
    : { type: 'enabled', budgetTokens };
}

/**
 * Validates and normalizes an arbitrary object into {@link LlmGenerationConfig}.
 * Returns `undefined` when nothing usable remains.
 */
export function normalizeLlmGenerationConfig(
  raw: unknown,
): LlmGenerationConfig | undefined {
  if (!isRecord(raw)) return undefined;

  const result: LlmGenerationConfig = {};
  const temperature = readNonNegativeNumber(raw['temperature']);
  if (temperature !== undefined) result.temperature = temperature;
  const topP = normalizeProbability(raw['topP']);
  if (topP !== undefined) result.topP = topP;
  const topK = normalizePositiveInt(raw['topK']);
  if (topK !== undefined) result.topK = topK;
  const maxTokens = normalizePositiveInt(raw['maxTokens']);
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  const reasoning = normalizeReasoningConfig(raw['reasoning']);
  if (reasoning) result.reasoning = reasoning;

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Resolves the effective reasoning effort level from a generation config.
 * Disabled thinking resolves to `'none'`; otherwise returns the explicit
 * effort, falling back to a level derived from a fixed thinking budget. This
 * compatibility projection is used only by the remote chat protocol.
 */
export function resolveEffectiveReasoningEffort(
  gen: LlmGenerationConfig | undefined,
): ReasoningEffortLevel | undefined {
  return reasoningEffortOf(normalizeReasoningConfig(gen?.reasoning), true);
}

/** Returns only a user-configured effort; fixed budgets are not converted. */
export function resolveExplicitReasoningEffort(
  gen: LlmGenerationConfig | undefined,
): ReasoningEffortLevel | undefined {
  return reasoningEffortOf(normalizeReasoningConfig(gen?.reasoning), false);
}

/**
 * Reads the effort out of an *already normalized* reasoning block. Callers that
 * hold a normalized config (e.g. the output of
 * {@link resolveCustomProviderGenerationConfig}) use this directly so a single
 * request never re-normalizes the same object several times.
 */
export function reasoningEffortOf(
  reasoning: LlmReasoningConfig | undefined,
  deriveFromBudget: boolean,
): ReasoningEffortLevel | undefined {
  if (!reasoning) return undefined;
  const disabled =
    reasoning.enabled === false || reasoning.thinking?.type === 'disabled';
  if (disabled && (deriveFromBudget || reasoning.effort === undefined)) {
    return 'none';
  }
  if (reasoning.effort) return reasoning.effort;
  return deriveFromBudget
    ? reasoningEffortFromThinkingBudget(
        reasoning.thinking?.type === 'enabled'
          ? reasoning.thinking.budgetTokens
          : undefined,
      )
    : undefined;
}

/**
 * Returns a copy of `gen` with its reasoning effort overridden (e.g. by an SDK
 * pull-mode policy). `undefined` effort leaves `gen` unchanged. Effort `'none'`
 * disables thinking; any other effort enables it.
 */
export function withReasoningEffortOverride(
  gen: LlmGenerationConfig | undefined,
  effort: ReasoningEffortLevel | undefined,
): LlmGenerationConfig | undefined {
  if (effort === undefined) return gen;
  const existing = normalizeReasoningConfig(gen?.reasoning);
  // Common case (no real override): the config already resolves to this effort,
  // so avoid re-allocating.
  if (reasoningEffortOf(existing, true) === effort) return gen;
  // A fixed budget already implies an effort for transports that only support
  // effort levels. Replacing that derived value must also remove the budget;
  // otherwise the request would carry two conflicting controls.
  const reasoningBase =
    existing?.thinking?.type === 'enabled'
      ? { ...existing, thinking: undefined }
      : existing;
  const reasoning = foldReasoningEffort(reasoningBase, effort, {
    enableWhenDisabled: true,
  });
  return { ...(gen ?? {}), ...(reasoning ? { reasoning } : {}) };
}

/**
 * Folds a canonical effort into a reasoning block. Effort `'none'` is the
 * compatibility alias for disabled thinking, so it always clears an explicit
 * thinking mode; `enableWhenDisabled` additionally lets a real effort override
 * re-enable thinking that the block had turned off.
 *
 * Single owner of the effort/thinking coupling rule — callers must not restate
 * it, or the two copies will drift.
 */
export function foldReasoningEffort(
  reasoning: LlmReasoningConfig | undefined,
  effort: ReasoningEffortLevel | undefined,
  { enableWhenDisabled }: { enableWhenDisabled: boolean },
): LlmReasoningConfig | undefined {
  const existing = reasoning ?? {};
  const { effort: _dropped, ...withoutEffort } = existing;
  if (effort === 'none') {
    return normalizeReasoningConfig({
      ...withoutEffort,
      thinking: undefined,
      enabled: false,
    });
  }
  // Thinking counts as "off" when it was disabled explicitly, or never
  // configured at all — both cases a real effort override may re-enable.
  const thinkingWasOff =
    existing.enabled === false ||
    existing.thinking?.type === 'disabled' ||
    (existing.enabled === undefined && existing.thinking === undefined);
  const shouldReEnable =
    enableWhenDisabled && effort !== undefined && thinkingWasOff;
  return normalizeReasoningConfig({
    ...withoutEffort,
    ...(effort !== undefined ? { effort } : {}),
    ...(shouldReEnable ? { thinking: undefined, enabled: true } : {}),
  });
}

/**
 * Returns a copy of `gen` with the reasoning *effort* removed, keeping only the
 * reasoning extras (enabled/thinking/preserve). Effort is stored canonically
 * elsewhere (e.g. Config.reasoningEffort), so it must not be duplicated here.
 */
export function stripReasoningEffort(
  gen: LlmGenerationConfig | undefined,
): LlmGenerationConfig {
  if (!gen) return {};
  const { reasoning, ...sampling } = gen;
  const result: LlmGenerationConfig = { ...sampling };
  if (reasoning) {
    const { effort: _droppedEffort, ...reasoningExtras } = reasoning;
    if (Object.keys(reasoningExtras).length > 0) {
      result.reasoning = reasoningExtras;
    }
  }
  return result;
}

/** Builds a generation config carrying only a reasoning effort, or undefined. */
function generationConfigFromEffort(
  rawEffort: unknown,
): LlmGenerationConfig | undefined {
  const effort = parseReasoningEffortLevel(rawEffort);
  if (!effort) return undefined;
  const reasoning = normalizeReasoningConfig({ effort });
  return reasoning ? { reasoning } : undefined;
}

/**
 * Builds a generation config from the legacy flat settings fields, used during
 * migration. `contextWindow` is intentionally NOT part of generation.
 */
export function generationConfigFromLegacyFields(fields: {
  reasoningEffort?: unknown;
}): LlmGenerationConfig | undefined {
  return generationConfigFromEffort(fields.reasoningEffort);
}

/**
 * Builds a default generation config from a server model entry's advertised
 * defaults, for example for UI prefill. Request defaults are materialized by
 * buildRemoteChatAskForLoop after applying explicit generation preferences.
 */
export function generationConfigFromServerModel(entry: {
  default_effort?: string;
}): LlmGenerationConfig | undefined {
  return generationConfigFromEffort(entry.default_effort);
}

/**
 * Every wire parameter name that carries reasoning state. Kept adjacent to
 * {@link generationConfigFromWireParameters}, the only reader of these keys, so
 * the strip below cannot drift from what the reader consumes.
 */
const REASONING_WIRE_PARAMETER_KEYS = [
  'reasoning_effort',
  'enable_thinking',
  'reasoning_budget_tokens',
  'thinking_budget',
  'preserve_thinking',
] as const;

/**
 * Reconstructs a generation config from wire `parameters` (reverse of
 * {@link toRemoteWireParameters}). Used as a fallback when a structured
 * `generation` was not carried explicitly.
 */
export function generationConfigFromWireParameters(
  parameters: Record<string, unknown> | undefined,
): LlmGenerationConfig | undefined {
  if (!parameters) return undefined;
  return normalizeLlmGenerationConfig({
    temperature: parameters['temperature'],
    topP: parameters['top_p'],
    topK: parameters['top_k'],
    maxTokens: parameters['max_tokens'],
    reasoning: {
      effort: parameters['reasoning_effort'],
      enabled: parameters['enable_thinking'],
      budgetTokens:
        parameters['reasoning_budget_tokens'] ?? parameters['thinking_budget'],
      preserve: parameters['preserve_thinking'],
    },
  });
}

/**
 * Resolves the effective generation config for a custom-provider request by
 * layering the model's advertised defaults, a legacy config reconstructed from
 * the flat wire fields, and the structured `request.generation` override. Shared
 * by the OpenAI- and Anthropic-compatible transports so the precedence order
 * stays identical between them.
 */
export function resolveCustomProviderGenerationConfig(
  request: {
    parameters?: Record<string, unknown>;
    temperature?: number;
    max_tokens?: number;
    reasoningEffort?: ReasoningEffortLevel;
    generation?: LlmGenerationConfig;
  },
  generationDefaults: LlmGenerationConfig | undefined,
): LlmGenerationConfig | undefined {
  // A structured reasoning block is authoritative. In particular, a
  // request may carry a compatibility effort derived from a fixed budget on
  // the flat request fields; custom provider transports must not mistake that value
  // for an explicitly configured effort.
  const hasStructuredReasoning = request.generation?.reasoning !== undefined;
  let legacyParameters = request.parameters;
  if (hasStructuredReasoning && legacyParameters) {
    legacyParameters = { ...legacyParameters };
    for (const key of REASONING_WIRE_PARAMETER_KEYS) {
      delete legacyParameters[key];
    }
  }
  const legacyGeneration = generationConfigFromWireParameters({
    ...legacyParameters,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.max_tokens !== undefined
      ? { max_tokens: request.max_tokens }
      : {}),
    ...(!hasStructuredReasoning && request.reasoningEffort !== undefined
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
  });
  return mergeLlmGenerationConfigs(
    generationDefaults,
    legacyGeneration,
    request.generation,
  );
}

/**
 * Shared wire projection for generation configs. Sampling and reasoning fields
 * map to identical wire keys across transports; only the reasoning-budget key
 * differs (`reasoning_budget_tokens` for the remote server vs `thinking_budget`
 * for custom providers). Undefined fields are omitted.
 */
function projectWireFields(
  gen: LlmGenerationConfig | undefined,
  budgetKey: string,
  deriveEffortFromBudget: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const normalized = normalizeLlmGenerationConfig(gen);
  if (!normalized) return out;
  if (normalized.temperature !== undefined)
    out['temperature'] = normalized.temperature;
  if (normalized.topP !== undefined) out['top_p'] = normalized.topP;
  if (normalized.topK !== undefined) out['top_k'] = normalized.topK;
  if (normalized.maxTokens !== undefined)
    out['max_tokens'] = normalized.maxTokens;

  const r = normalized.reasoning;
  if (r) {
    const effort = reasoningEffortOf(r, deriveEffortFromBudget);
    if (effort) out['reasoning_effort'] = effort;
    // `normalizeReasoningConfig` never emits `enabled` alongside `thinking`, so
    // exactly one of these cases applies.
    switch (r.thinking?.type) {
      case 'disabled':
        out['enable_thinking'] = false;
        break;
      case 'adaptive':
        if (deriveEffortFromBudget) out['enable_thinking'] = true;
        break;
      case 'enabled':
        out['enable_thinking'] = true;
        out[budgetKey] = r.thinking.budgetTokens;
        break;
      default:
        if (r.enabled !== undefined) out['enable_thinking'] = r.enabled;
    }
    if (r.preserve !== undefined) out['preserve_thinking'] = r.preserve;
  }
  return out;
}

/**
 * Projects a generation config to the remote chat wire parameter names
 * (used by the Legacy transport). Undefined fields are omitted.
 */
export function toRemoteWireParameters(
  gen: LlmGenerationConfig | undefined,
): Record<string, unknown> {
  return projectWireFields(gen, 'reasoning_budget_tokens', true);
}

/**
 * Projects a generation config to custom-provider (OpenAI-compatible) wire
 * field names. Undefined fields are omitted so callers can merge over
 * provider-configured defaults.
 */
export function toCustomProviderWireFields(
  gen: LlmGenerationConfig | undefined,
): CustomProviderWireGenerationFields {
  return projectWireFields(
    gen,
    'thinking_budget',
    false,
  ) as CustomProviderWireGenerationFields;
}
