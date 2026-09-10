/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import { isDashScopeProvider } from './openaiContentGenerator/provider/dashscope-origin.js';
import type { Config } from '../config/config.js';
import type { ModelReasoningCapabilities } from '../models/types.js';
import {
  clampReasoningEffort,
  getGptReasoningCapabilities,
  OPENAI_COMPATIBLE_EFFORTS,
  parseModelReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from './reasoning-effort.js';
import {
  anthropicSupportedEffortTiers,
  parseClaudeModelVersion,
} from './anthropic-reasoning.js';
import { isDeepSeekHostname } from './openaiContentGenerator/provider/deepseek.js';
import { isOpenRouterHostname } from './openaiContentGenerator/provider/openrouter.js';

export const REASONING_PROFILES = [
  'openai-reasoning',
  'openai-effort',
  'deepseek-openai',
  'dashscope-thinking',
  'dashscope-effort',
  'qwen-chat-template',
  'anthropic-manual',
  'anthropic-adaptive',
  'anthropic-adaptive-only',
  'deepseek-anthropic',
  'gemini',
] as const;

export type ReasoningProfile = (typeof REASONING_PROFILES)[number];

export interface ModelReasoningConfig {
  profile?: ReasoningProfile;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export type ResolvedModelReasoningConfig = ModelReasoningCapabilities & {
  profile: ReasoningProfile;
  defaultEnabled?: boolean;
};

type ModelRoute = Pick<
  ContentGeneratorConfig,
  'model' | 'authType' | 'baseUrl' | 'thinkingMandatory' | 'reasoningConfig'
>;

function hostname(baseUrl: string | undefined): string {
  try {
    return new URL(baseUrl ?? '').hostname.toLowerCase();
  } catch {
    return '';
  }
}

function inferProfile(
  route: ModelRoute,
  legacy?: ModelReasoningCapabilities,
): ReasoningProfile {
  const host = hostname(route.baseUrl);
  const deepseek = isDeepSeekHostname(route);
  if (route.authType === 'gemini' || route.authType === 'vertex-ai')
    return 'gemini';
  if (route.authType === 'openai-responses') return 'openai-reasoning';
  if (route.authType === 'anthropic') {
    if (deepseek) return 'deepseek-anthropic';
    const version = parseClaudeModelVersion(route.model);
    if (
      version &&
      (version.major > 4 || (version.major === 4 && version.minor >= 7))
    )
      return 'anthropic-adaptive-only';
    if (
      version &&
      (version.major > 4 || (version.major === 4 && version.minor >= 6))
    )
      return 'anthropic-adaptive';
    return 'anthropic-manual';
  }
  if (isOpenRouterHostname(route)) return 'openai-reasoning';
  if (deepseek || legacy?.disableField === 'thinking') return 'deepseek-openai';
  const qwen = /^(qwen|coder-model)/i.test(route.model);
  const dashscope = isDashScopeProvider(route);
  if (legacy?.disableField === 'enable_thinking') return 'dashscope-thinking';
  if (qwen && dashscope)
    return /^qwen3\.8-max/i.test(route.model) ||
      legacy?.disableField === 'reasoning_effort'
      ? 'dashscope-effort'
      : 'dashscope-thinking';
  if (
    legacy?.disableField === 'reasoning_effort' ||
    getGptReasoningCapabilities(route.model)
  )
    return 'openai-effort';
  if (qwen) return 'qwen-chat-template';
  if (/(^|\.)(z\.ai|bigmodel\.cn)$/.test(host)) return 'openai-effort';
  return 'openai-reasoning';
}

export function resolveModelReasoningConfig(
  route: ModelRoute,
  legacyCapabilities?: unknown,
): ResolvedModelReasoningConfig | undefined {
  const input = route.reasoningConfig;
  if (input === undefined) return undefined;
  const fail = (field: string, detail: string): never => {
    throw new Error(
      `Model "${route.model}" generationConfig.reasoningConfig.${field}: ${detail}`,
    );
  };
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('profile', 'expected an object');
  const keys = Object.keys(input);
  if (keys.length === 0)
    fail(
      'profile',
      'expected at least one of profile, supportedEfforts, or defaultEffort',
    );
  for (const key of keys) {
    if (!['profile', 'supportedEfforts', 'defaultEffort'].includes(key))
      fail(key, 'unknown field');
  }
  if (
    input.profile !== undefined &&
    !REASONING_PROFILES.includes(input.profile)
  )
    fail('profile', 'unknown profile');
  if (
    input.supportedEfforts !== undefined &&
    !Array.isArray(input.supportedEfforts)
  )
    fail('supportedEfforts', 'expected an array');
  if (
    input.defaultEffort !== undefined &&
    !REASONING_EFFORT_TIERS.includes(input.defaultEffort)
  )
    fail('defaultEffort', 'expected a reasoning effort');
  const legacy = parseModelReasoningCapabilities(legacyCapabilities);
  const profile = input.profile ?? inferProfile(route, legacy);
  if (!REASONING_PROFILES.includes(profile)) fail('profile', 'unknown profile');
  const protocol =
    profile === 'gemini'
      ? 'gemini'
      : profile.startsWith('anthropic-') || profile === 'deepseek-anthropic'
        ? 'anthropic'
        : 'openai';
  const routeProtocol =
    route.authType === 'vertex-ai'
      ? 'gemini'
      : route.authType === 'qwen-oauth'
        ? 'openai'
        : route.authType === 'openai-responses'
          ? 'openai'
          : route.authType;
  if (route.authType === 'openai-responses' && profile !== 'openai-reasoning') {
    fail('profile', '"openai-responses" requires openai-reasoning');
  }
  if (routeProtocol && protocol !== routeProtocol)
    fail('profile', `"${profile}" requires ${protocol}, got ${route.authType}`);
  const explicitProfile = input.profile !== undefined;
  const toggleOnly =
    profile === 'dashscope-thinking' ||
    profile === 'qwen-chat-template' ||
    (!explicitProfile && legacy?.toggleOnly === true);
  const gpt = getGptReasoningCapabilities(route.model);
  const mandatory =
    route.thinkingMandatory ??
    (!explicitProfile &&
      (legacy?.canDisable === false || gpt?.thinkingMandatory === true));
  const common = {
    thinking: true as const,
    profile,
    disableField: (profile === 'dashscope-thinking' ||
    profile === 'qwen-chat-template'
      ? 'enable_thinking'
      : profile === 'openai-effort' || profile === 'dashscope-effort'
        ? 'reasoning_effort'
        : 'thinking') as ModelReasoningCapabilities['disableField'],
    ...(mandatory ? { canDisable: false as const } : {}),
  };
  if (toggleOnly) {
    if (input.supportedEfforts !== undefined)
      fail('supportedEfforts', 'this profile supports only thinking on/off');
    if (input.defaultEffort !== undefined)
      fail('defaultEffort', 'this profile supports only thinking on/off');
    return { ...common, toggleOnly: true };
  }
  const profileEfforts: readonly ReasoningEffort[] = profile.startsWith(
    'deepseek-',
  )
    ? ['high', 'max']
    : profile === 'gemini'
      ? ['low', 'medium', 'high']
      : protocol === 'anthropic'
        ? anthropicSupportedEffortTiers(route.model)
        : profile === 'dashscope-effort'
          ? ['low', 'medium', 'xhigh']
          : OPENAI_COMPATIBLE_EFFORTS;
  const inferredEfforts =
    legacy && !legacy.toggleOnly ? legacy.efforts : gpt?.efforts;
  const inheritedEfforts = inferredEfforts ?? profileEfforts;
  const efforts =
    input.supportedEfforts ??
    (input.defaultEffort && !inheritedEfforts.includes(input.defaultEffort)
      ? REASONING_EFFORT_TIERS.filter(
          (tier) =>
            inheritedEfforts.includes(tier) || tier === input.defaultEffort,
        )
      : inheritedEfforts);
  if (
    !Array.isArray(efforts) ||
    !efforts.length ||
    efforts.some((tier) => !REASONING_EFFORT_TIERS.includes(tier)) ||
    new Set(efforts).size !== efforts.length
  )
    fail(
      'supportedEfforts',
      'expected a nonempty, unique subset of low/medium/high/xhigh/max',
    );
  if (
    profile === 'gemini' &&
    efforts.some((tier) => tier === 'xhigh' || tier === 'max')
  )
    fail('supportedEfforts', 'Gemini supports low/medium/high');
  const inheritedDefault =
    legacy && !legacy.toggleOnly ? legacy.defaultEffort : gpt?.defaultEffort;
  const defaultEffort =
    input.defaultEffort ??
    (inheritedDefault
      ? clampReasoningEffort(inheritedDefault, efforts)
      : undefined);
  if (defaultEffort !== undefined && !efforts.includes(defaultEffort))
    fail('defaultEffort', 'must belong to supportedEfforts');
  return {
    ...common,
    efforts: [...efforts],
    defaultEffort,
    ...(gpt && input.defaultEffort === undefined
      ? { defaultEnabled: gpt.defaultEnabled }
      : {}),
  };
}

export function resolveEffectiveReasoning(
  generation: Pick<ContentGeneratorConfig, 'reasoning'>,
  resolved: ResolvedModelReasoningConfig | undefined,
): ContentGeneratorConfig['reasoning'] {
  if (!resolved) return generation.reasoning;
  const reasoning =
    generation.reasoning === false && resolved.canDisable === false
      ? undefined
      : generation.reasoning;
  if (reasoning === false) return false;
  if (resolved.toggleOnly) return reasoning;
  if (reasoning === undefined && resolved.defaultEnabled === false)
    return false;
  const requested = reasoning?.effort ?? resolved.defaultEffort;
  if (requested && !REASONING_EFFORT_TIERS.includes(requested)) {
    return { ...reasoning, effort: requested };
  }
  return requested
    ? {
        ...reasoning,
        effort: clampReasoningEffort(requested, resolved.efforts),
      }
    : reasoning;
}

export function getModelReasoningConfig(
  config: Pick<Config, 'getResolvedModelConfig'> | undefined,
  generation: ContentGeneratorConfig,
  model = generation.model,
): ResolvedModelReasoningConfig | undefined {
  if (generation.reasoningConfig === undefined && model === generation.model)
    return undefined;
  const registered = generation.authType
    ? config?.getResolvedModelConfig?.(
        generation.authType,
        model,
        generation.baseUrl,
      )
    : undefined;
  return resolveModelReasoningConfig(
    {
      ...generation,
      model,
      ...(model !== generation.model
        ? {
            reasoningConfig: registered?.generationConfig.reasoningConfig,
            thinkingMandatory: registered?.generationConfig.thinkingMandatory,
          }
        : {}),
    },
    registered?.capabilities.reasoning,
  );
}
