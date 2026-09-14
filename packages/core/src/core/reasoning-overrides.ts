/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import type {
  AvailableModel,
  ModelReasoningCapabilities,
} from '../models/types.js';
import { ALL_PROVIDERS } from '../providers/all-providers.js';
import { normalize } from './tokenLimits.js';
import { isOpenRouterHostname } from './openaiContentGenerator/provider/openrouter.js';
import {
  parseClaudeModelVersion,
  anthropicSupportedEffortTiers,
} from './anthropic-reasoning.js';
import {
  clampReasoningEffort,
  getGptReasoningCapabilities,
  parseModelReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from './reasoning-effort.js';

export const REASONING_PROFILES = [
  'openai-effort',
  'openai-reasoning',
  'deepseek-openai',
  'dashscope-effort',
  'dashscope-thinking',
  'qwen-chat-template',
  'anthropic-manual',
  'anthropic-adaptive',
  'deepseek-anthropic',
  'gemini',
] as const;
export type ReasoningProfile = (typeof REASONING_PROFILES)[number];
export type ModelReasoningOverride = {
  profile?: ReasoningProfile;
  efforts?: readonly ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  thinking?: true;
  toggleOnly?: boolean;
  canDisable?: false;
  disableField?: ModelReasoningCapabilities['disableField'];
};
export type ResolvedReasoning = ModelReasoningCapabilities & {
  profile?: ReasoningProfile;
  defaultEnabled?: boolean;
};
export type ReasoningSnapshot = ReadonlyArray<
  Readonly<
    Pick<AvailableModel, 'id' | 'authType' | 'baseUrl' | 'registryBaseUrl'> & {
      reasoning: ModelReasoningOverride | undefined;
    }
  >
>;
type Route = Pick<
  ContentGeneratorConfig,
  'model' | 'authType' | 'baseUrl' | 'thinkingMandatory'
>;

export function validateReasoningDeclaration(
  route: Route,
  declaration: unknown,
): ModelReasoningOverride | undefined {
  if (declaration === undefined) return undefined;
  const fail = (): never => {
    throw new Error(
      `Model "${route.model}" capabilities.reasoning: invalid profile, efforts or defaultEffort`,
    );
  };
  if (
    !declaration ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration)
  )
    return fail();
  const input = declaration as ModelReasoningOverride;
  const legacy = parseModelReasoningCapabilities(input);
  if (
    input.profile === undefined &&
    ('thinking' in input || 'disableField' in input)
  )
    return legacy;
  if (
    !Object.keys(input).length ||
    Object.keys(input).some(
      (key) =>
        ![
          'profile',
          'efforts',
          'defaultEffort',
          'thinking',
          'toggleOnly',
          'canDisable',
          'disableField',
        ].includes(key),
    )
  )
    return fail();
  if (
    (input.profile !== undefined &&
      !REASONING_PROFILES.includes(input.profile)) ||
    (input.thinking !== undefined && input.thinking !== true) ||
    (input.toggleOnly !== undefined && typeof input.toggleOnly !== 'boolean') ||
    (input.canDisable !== undefined && input.canDisable !== false)
  )
    return fail();
  if (
    input.efforts !== undefined &&
    (!Array.isArray(input.efforts) ||
      !input.efforts.length ||
      input.efforts.some((tier) => !REASONING_EFFORT_TIERS.includes(tier)) ||
      new Set(input.efforts).size !== input.efforts.length)
  )
    return fail();
  if (
    input.defaultEffort !== undefined &&
    (!REASONING_EFFORT_TIERS.includes(input.defaultEffort) ||
      (input.efforts && !input.efforts.includes(input.defaultEffort)))
  )
    return fail();
  if (
    !input.profile &&
    !getGptReasoningCapabilities(route.model) &&
    !(route.authType === 'anthropic' && parseClaudeModelVersion(route.model)) &&
    !ALL_PROVIDERS.some((provider) =>
      provider.models?.some(
        (model) =>
          model.capabilities?.reasoning &&
          (model.id === route.model || model.id === normalize(route.model)),
      ),
    )
  )
    return fail();
  return input;
}

export function resolveReasoningCapabilities(
  route: Route,
  declaration: unknown,
): ResolvedReasoning | undefined {
  try {
    return validateReasoningCapabilities(route, declaration);
  } catch {
    return undefined;
  }
}

export function validateReasoningCapabilities(
  route: Route,
  declaration: unknown,
): ResolvedReasoning | undefined {
  const input = validateReasoningDeclaration(route, declaration);
  if (!input) return undefined;
  if (input.profile === undefined && 'thinking' in input)
    return parseModelReasoningCapabilities(input);
  const fail = (): never => {
    throw new Error(
      `Model "${route.model}" capabilities.reasoning: invalid profile, efforts or defaultEffort`,
    );
  };
  const model = normalize(route.model);
  const provider = ALL_PROVIDERS.find((candidate) =>
    typeof candidate.baseUrl === 'string'
      ? candidate.baseUrl === route.baseUrl
      : candidate.baseUrl?.some((option) => option.url === route.baseUrl),
  );
  const known = (
    provider?.models?.find((candidate) => candidate.id === route.model) ??
    provider?.models?.find((candidate) => candidate.id === model)
  )?.capabilities?.reasoning;
  const inherited = parseModelReasoningCapabilities(known);
  const gpt = getGptReasoningCapabilities(model);
  const claude =
    route.authType === 'anthropic'
      ? parseClaudeModelVersion(route.model)
      : undefined;
  if (!inherited && !gpt && !claude && !input.profile) return fail();
  const auth = route.authType;
  let host = '';
  try {
    host = new URL(route.baseUrl ?? '').hostname.toLowerCase();
  } catch {
    host = '';
  }
  const dashscope =
    auth === 'qwen-oauth' ||
    /(^|\.)(dashscope(?:-intl|-us)?\.aliyuncs\.com|alibaba-inc\.com|aliyun-inc\.com|alicloudapi\.com)$/.test(
      host,
    ) ||
    /^token-plan\..+\.maas\.aliyuncs\.com$/.test(host);
  const profile =
    input.profile ??
    (auth === 'gemini' || auth === 'vertex-ai'
      ? 'gemini'
      : auth === 'openai-responses'
        ? 'openai-reasoning'
        : auth === 'openai' && isOpenRouterHostname(route)
          ? 'openai-reasoning'
          : auth === 'anthropic'
            ? model.includes('deepseek')
              ? 'deepseek-anthropic'
              : claude &&
                  (claude.major > 4 ||
                    (claude.major === 4 && claude.minor >= 6))
                ? 'anthropic-adaptive'
                : 'anthropic-manual'
            : inherited?.toggleOnly
              ? dashscope
                ? 'dashscope-thinking'
                : 'qwen-chat-template'
              : model.startsWith('qwen')
                ? dashscope
                  ? inherited?.disableField === 'reasoning_effort'
                    ? 'dashscope-effort'
                    : 'dashscope-thinking'
                  : 'qwen-chat-template'
                : inherited?.disableField === 'thinking'
                  ? 'deepseek-openai'
                  : 'openai-effort');
  const protocol =
    profile === 'gemini'
      ? 'gemini'
      : profile.startsWith('anthropic-') || profile === 'deepseek-anthropic'
        ? 'anthropic'
        : 'openai';
  if (
    (auth === 'openai-responses' && profile !== 'openai-reasoning') ||
    (auth &&
      protocol !==
        (auth === 'vertex-ai'
          ? 'gemini'
          : auth === 'qwen-oauth' || auth === 'openai-responses'
            ? 'openai'
            : auth))
  )
    return fail();
  const toggleOnly =
    profile === 'dashscope-thinking' || profile === 'qwen-chat-template';
  const disableField =
    (!input.profile && inherited?.disableField) ||
    (toggleOnly
      ? 'enable_thinking'
      : profile === 'openai-effort' || profile === 'dashscope-effort'
        ? 'reasoning_effort'
        : 'thinking');
  const inheritedEfforts =
    inherited && !inherited.toggleOnly
      ? inherited.efforts
      : (gpt?.efforts ??
        (claude ? anthropicSupportedEffortTiers(route.model) : undefined));
  const efforts = input.efforts ?? inheritedEfforts;
  const inheritedDefault =
    inherited && !inherited.toggleOnly
      ? inherited.defaultEffort
      : gpt?.defaultEffort;
  const defaultEffort =
    input.defaultEffort ??
    (inheritedDefault && efforts
      ? clampReasoningEffort(inheritedDefault, efforts)
      : undefined);
  if (
    (toggleOnly &&
      (input.efforts !== undefined || input.defaultEffort !== undefined)) ||
    (!toggleOnly && (!efforts || !defaultEffort)) ||
    (profile === 'gemini' &&
      efforts?.some((tier) => tier === 'xhigh' || tier === 'max'))
  )
    return fail();
  const result = {
    ...input,
    thinking: true,
    profile,
    toggleOnly,
    disableField,
    ...(toggleOnly ? {} : { efforts, defaultEffort }),
    ...(route.thinkingMandatory ||
    inherited?.canDisable === false ||
    gpt?.thinkingMandatory
      ? { canDisable: false }
      : {}),
  };
  const parsed = parseModelReasoningCapabilities(result);
  if (!parsed) return fail();
  return {
    ...parsed,
    profile,
    ...(gpt && input.defaultEffort === undefined
      ? { defaultEnabled: gpt.defaultEnabled }
      : {}),
  };
}

export function captureReasoningSnapshot(
  models: readonly AvailableModel[],
): ReasoningSnapshot {
  return Object.freeze(
    models.map((model) =>
      Object.freeze({
        id: model.id,
        authType: model.authType,
        baseUrl: model.baseUrl,
        registryBaseUrl: model.registryBaseUrl,
        reasoning:
          model.capabilities?.reasoning &&
          typeof model.capabilities.reasoning === 'object'
            ? Object.freeze({
                ...structuredClone(model.capabilities.reasoning),
                ...('efforts' in model.capabilities.reasoning &&
                Array.isArray(model.capabilities.reasoning.efforts)
                  ? {
                      efforts: Object.freeze([
                        ...model.capabilities.reasoning.efforts,
                      ]),
                    }
                  : {}),
              })
            : model.capabilities?.reasoning,
      }),
    ),
  );
}

export function resolveReasoningForModel(
  config: Pick<Config, 'getResolvedModelConfig'> | undefined,
  generation: ContentGeneratorConfig,
  model = generation.model,
  strict = false,
): ResolvedReasoning | undefined {
  let declaration: unknown;
  if (generation.reasoningSnapshot) {
    const rows = generation.reasoningSnapshot.filter(
      (row) => row.authType === generation.authType && row.id === model,
    );
    const row =
      generation.reasoningRouteBaseUrl === null && model === generation.model
        ? rows.find((row) => row.registryBaseUrl === undefined)
        : typeof generation.reasoningRouteBaseUrl === 'string' &&
            model === generation.model
          ? rows.find(
              (row) => row.registryBaseUrl === generation.reasoningRouteBaseUrl,
            )
          : (rows.find((row) => row.registryBaseUrl === generation.baseUrl) ??
            rows.find(
              (row) =>
                row.registryBaseUrl === undefined &&
                row.baseUrl === generation.baseUrl,
            ));
    declaration = row?.reasoning;
  } else {
    declaration = generation.authType
      ? config?.getResolvedModelConfig?.(
          generation.authType,
          model,
          generation.baseUrl,
        )?.capabilities?.reasoning
      : undefined;
  }
  return (
    strict ? validateReasoningCapabilities : resolveReasoningCapabilities
  )({ ...generation, model }, declaration);
}

export function getEffectiveReasoning(
  generation: Pick<ContentGeneratorConfig, 'reasoning'>,
  resolved?: ResolvedReasoning,
): ContentGeneratorConfig['reasoning'] {
  if (!resolved) return generation.reasoning;
  if (generation.reasoning === false && resolved.canDisable !== false)
    return false;
  const selected = generation.reasoning || undefined;
  if (
    !selected &&
    resolved.defaultEnabled === false &&
    resolved.canDisable !== false
  )
    return false;
  if (resolved.toggleOnly)
    return selected ?? (resolved.profile ? {} : undefined);
  const effort = selected?.effort ?? resolved.defaultEffort;
  return effort
    ? {
        ...selected,
        effort:
          resolved.profile && REASONING_EFFORT_TIERS.includes(effort)
            ? clampReasoningEffort(effort, resolved.efforts)
            : effort,
      }
    : selected;
}
