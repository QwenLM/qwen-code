/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from './contentGenerator.js';
import type { ReasoningEffort } from './reasoning-effort.js';

export type ModelReasoningEndpointFamily =
  | 'alibaba-coding-plan'
  | 'alibaba-standard'
  | 'alibaba-token-plan'
  | 'deepseek'
  | 'moonshot'
  | 'qwen-oauth'
  | 'zai'
  | 'unknown';

export type ModelReasoningWireShape =
  | 'alibaba-effort'
  | 'alibaba-toggle'
  | 'qwen-effort'
  | 'qwen-toggle'
  | 'thinking-effort'
  | 'thinking-toggle';

type ToggleReasoningConfiguration = {
  readonly thinking: true;
  readonly toggleOnly: true;
  readonly canDisable?: true;
};

type TieredReasoningConfiguration = {
  readonly thinking: true;
  readonly toggleOnly?: false;
  readonly canDisable?: boolean;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort;
};

export type ModelReasoningConfiguration = (
  | ToggleReasoningConfiguration
  | TieredReasoningConfiguration
) & {
  readonly endpointFamily: ModelReasoningEndpointFamily;
  readonly wireShape: ModelReasoningWireShape;
};

export interface ModelReasoningConfigInput {
  readonly modelId: string | undefined;
  readonly authType?: AuthType;
  readonly baseUrl?: string;
}

export interface MandatoryReasoningDefaultInput
  extends ModelReasoningConfigInput {
  readonly thinkingMandatory?: boolean;
}

export const DASHSCOPE_REGIONAL_HOSTS: readonly string[] = [
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
];

const QWEN_TOGGLE_MODELS = new Set([
  'qwen3.5-plus',
  'qwen3.6-plus',
  'qwen3.6-flash',
  'qwen3.7-plus',
  'qwen3.7-max',
]);

const QWEN_TIERED_MODELS = new Set([
  'qwen3.8-max',
  'qwen3.8-max-0902',
  'qwen3.8-flash',
]);

const DEEPSEEK_STABLE_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]);

const DEEPSEEK_SNAPSHOT_MODELS = new Set([
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
]);

const QWEN_TIERS = ['low', 'medium', 'xhigh'] as const;
const HIGH_MAX = ['high', 'max'] as const;
const LOW_HIGH_MAX = ['low', 'high', 'max'] as const;

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isDashScopeModelStudioHostname(hostname: string): boolean {
  return (
    DASHSCOPE_REGIONAL_HOSTS.some((host) =>
      isHostOrSubdomain(hostname, host),
    ) || isHostOrSubdomain(hostname, 'maas.aliyuncs.com')
  );
}

export function classifyModelReasoningEndpoint(
  input: Pick<ModelReasoningConfigInput, 'authType' | 'baseUrl'>,
): ModelReasoningEndpointFamily {
  if (input.authType === AuthType.QWEN_OAUTH) return 'qwen-oauth';
  if (input.authType !== AuthType.USE_OPENAI) {
    return 'unknown';
  }
  if (!input.baseUrl) return 'alibaba-standard';

  let hostname: string;
  try {
    hostname = new URL(input.baseUrl).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }

  if (hostname === 'api.deepseek.com') return 'deepseek';
  if (hostname === 'api.moonshot.cn' || hostname === 'api.moonshot.ai') {
    return 'moonshot';
  }
  if (
    isHostOrSubdomain(hostname, 'z.ai') ||
    isHostOrSubdomain(hostname, 'bigmodel.cn')
  ) {
    return 'zai';
  }
  if (
    hostname === 'coding.dashscope.aliyuncs.com' ||
    hostname === 'coding-intl.dashscope.aliyuncs.com' ||
    hostname === 'coding-intl.dashscope-intl.aliyuncs.com'
  ) {
    return 'alibaba-coding-plan';
  }
  if (
    hostname.startsWith('token-plan.') &&
    hostname.endsWith('.maas.aliyuncs.com')
  ) {
    return 'alibaba-token-plan';
  }
  return isDashScopeModelStudioHostname(hostname)
    ? 'alibaba-standard'
    : 'unknown';
}

function toggle(
  endpointFamily: ModelReasoningEndpointFamily,
  wireShape: ModelReasoningWireShape,
): ModelReasoningConfiguration {
  return { thinking: true, toggleOnly: true, endpointFamily, wireShape };
}

function tiered(
  endpointFamily: ModelReasoningEndpointFamily,
  wireShape: ModelReasoningWireShape,
  efforts: readonly ReasoningEffort[],
  defaultEffort: ReasoningEffort,
  canDisable = true,
): ModelReasoningConfiguration {
  return {
    thinking: true,
    toggleOnly: false,
    efforts,
    defaultEffort,
    ...(canDisable ? {} : { canDisable: false }),
    endpointFamily,
    wireShape,
  };
}

function resolveQwenConfiguration(
  modelId: string,
  endpointFamily: ModelReasoningEndpointFamily,
): ModelReasoningConfiguration | undefined {
  if (QWEN_TOGGLE_MODELS.has(modelId)) {
    return toggle(endpointFamily, 'qwen-toggle');
  }
  if (
    endpointFamily !== 'alibaba-coding-plan' &&
    QWEN_TIERED_MODELS.has(modelId)
  ) {
    return tiered(endpointFamily, 'qwen-effort', QWEN_TIERS, 'xhigh');
  }
  return undefined;
}

export function resolveModelReasoningConfiguration(
  input: ModelReasoningConfigInput,
): ModelReasoningConfiguration | undefined {
  if (!input.modelId) return undefined;
  const modelId = input.modelId.toLowerCase();
  const endpointFamily = classifyModelReasoningEndpoint(input);

  if (
    endpointFamily === 'qwen-oauth' ||
    endpointFamily.startsWith('alibaba-')
  ) {
    const qwen = resolveQwenConfiguration(modelId, endpointFamily);
    if (qwen) return qwen;
  }

  switch (endpointFamily) {
    case 'deepseek':
      return DEEPSEEK_STABLE_MODELS.has(modelId)
        ? tiered(endpointFamily, 'thinking-effort', HIGH_MAX, 'high')
        : undefined;
    case 'moonshot':
      if (modelId === 'kimi-k3') {
        return tiered(
          endpointFamily,
          'thinking-effort',
          LOW_HIGH_MAX,
          'max',
          false,
        );
      }
      return modelId === 'kimi-k2.6'
        ? toggle(endpointFamily, 'thinking-toggle')
        : undefined;
    case 'zai':
      return modelId === 'glm-5.2'
        ? tiered(endpointFamily, 'thinking-effort', HIGH_MAX, 'max')
        : undefined;
    case 'alibaba-standard':
      if (DEEPSEEK_STABLE_MODELS.has(modelId) || modelId === 'glm-5.2') {
        return tiered(endpointFamily, 'alibaba-effort', HIGH_MAX, 'high');
      }
      if (DEEPSEEK_SNAPSHOT_MODELS.has(modelId)) {
        return tiered(endpointFamily, 'alibaba-effort', LOW_HIGH_MAX, 'high');
      }
      if (
        modelId === 'kimi-k3' ||
        modelId === 'zhipu/glm-5.3' ||
        modelId === 'zhipu/glm-5.3-flash'
      ) {
        return tiered(
          endpointFamily,
          'alibaba-effort',
          LOW_HIGH_MAX,
          'max',
          false,
        );
      }
      return undefined;
    case 'alibaba-token-plan':
      if (DEEPSEEK_STABLE_MODELS.has(modelId)) {
        return tiered(endpointFamily, 'alibaba-effort', HIGH_MAX, 'high');
      }
      if (DEEPSEEK_SNAPSHOT_MODELS.has(modelId)) {
        return tiered(endpointFamily, 'alibaba-effort', LOW_HIGH_MAX, 'high');
      }
      return modelId === 'glm-5.2' ||
        modelId === 'kimi-k2.5' ||
        modelId === 'kimi-k2.6'
        ? toggle(endpointFamily, 'alibaba-toggle')
        : undefined;
    case 'alibaba-coding-plan':
      return modelId === 'kimi-k2.5'
        ? toggle(endpointFamily, 'alibaba-toggle')
        : undefined;
    case 'qwen-oauth':
    case 'unknown':
    default:
      return undefined;
  }
}

export function normalizeModelReasoningEffort(
  configuration: ModelReasoningConfiguration,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!effort || configuration.toggleOnly) return undefined;
  return configuration.efforts.find((candidate) => candidate === effort);
}

export function supportsGenericReasoningEffort(
  modelId: string | undefined,
): boolean {
  if (!modelId) return false;
  const normalized = modelId.toLowerCase();
  return !normalized.startsWith('qwen') && normalized !== 'coder-model';
}

export function usesMandatoryReasoningDefaultOnly(
  input: MandatoryReasoningDefaultInput,
): boolean {
  return (
    input.thinkingMandatory === true &&
    resolveModelReasoningConfiguration(input) === undefined
  );
}
