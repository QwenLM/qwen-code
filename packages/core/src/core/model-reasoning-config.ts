/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from './contentGenerator.js';
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from './reasoning-effort.js';
import {
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
} from './modalityDefaults.js';

export type ModelReasoningConfiguration =
  | {
      readonly thinking: true;
      readonly toggleOnly: true;
      readonly canDisable?: true;
    }
  | {
      readonly thinking: true;
      readonly toggleOnly?: false;
      readonly canDisable?: false;
      readonly efforts: readonly ReasoningEffort[];
      readonly defaultEffort: ReasoningEffort;
    };

export type ModelReasoningEndpointFamily =
  | 'alibaba-coding-plan'
  | 'alibaba-standard'
  | 'alibaba-token-plan'
  | 'deepseek'
  | 'moonshot'
  | 'zai'
  | 'unknown';

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

export function isMoonshotModelReasoningHostname(hostname: string): boolean {
  // First-party Moonshot routes: the built-in Kimi preset defaults to the
  // international host, so both first-party hosts share one gate.
  return hostname === 'api.moonshot.cn' || hostname === 'api.moonshot.ai';
}

export function isZaiModelReasoningHostname(hostname: string): boolean {
  return (
    isHostOrSubdomain(hostname, 'z.ai') ||
    isHostOrSubdomain(hostname, 'bigmodel.cn')
  );
}

const TOGGLE_ONLY: ModelReasoningConfiguration = {
  thinking: true,
  toggleOnly: true,
};

const QWEN_CONFIGURATIONS: Readonly<
  Record<string, ModelReasoningConfiguration>
> = {
  'qwen3.5-plus': TOGGLE_ONLY,
  'qwen3.6-plus': TOGGLE_ONLY,
  'qwen3.6-flash': TOGGLE_ONLY,
  'qwen3.7-plus': TOGGLE_ONLY,
  'qwen3.7-max': TOGGLE_ONLY,
  'qwen3.8-max': {
    thinking: true,
    efforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'xhigh',
  },
};

const HIGH_MAX: ModelReasoningConfiguration = {
  thinking: true,
  efforts: ['high', 'max'],
  defaultEffort: 'high',
};

const DEEPSEEK_0731: ModelReasoningConfiguration = {
  thinking: true,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
};

const GLM_52_ZAI: ModelReasoningConfiguration = {
  thinking: true,
  efforts: ['high', 'max'],
  defaultEffort: 'max',
};

const KIMI_K3: ModelReasoningConfiguration = {
  thinking: true,
  canDisable: false,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
};

const GLM_52_WORKSPACE_REGIONS = [
  'cn-beijing',
  'ap-southeast-1',
  'eu-central-1',
  'us-east-1',
  'ap-northeast-1',
] as const;

export function classifyModelReasoningEndpoint(
  input: Pick<ModelReasoningConfigInput, 'authType' | 'baseUrl'>,
): ModelReasoningEndpointFamily {
  if (input.authType !== AuthType.USE_OPENAI || !input.baseUrl) {
    return 'unknown';
  }

  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
  } catch {
    return 'unknown';
  }
  const hostname = endpoint.hostname.toLowerCase();

  if (hostname === 'api.deepseek.com') {
    return 'deepseek';
  }
  if (isMoonshotModelReasoningHostname(hostname)) {
    return 'moonshot';
  }
  if (isZaiModelReasoningHostname(hostname)) {
    return 'zai';
  }
  if (
    hostname.startsWith('token-plan.') &&
    hostname.endsWith('.maas.aliyuncs.com')
  ) {
    return 'alibaba-token-plan';
  }
  if (isHostOrSubdomain(hostname, 'maas.aliyuncs.com')) {
    return 'alibaba-standard';
  }
  if (
    hostname === 'coding.dashscope.aliyuncs.com' ||
    hostname === 'coding-intl.dashscope.aliyuncs.com' ||
    hostname === 'coding-intl.dashscope-intl.aliyuncs.com'
  ) {
    return 'alibaba-coding-plan';
  }
  if (
    DASHSCOPE_REGIONAL_HOSTS.some((host) => isHostOrSubdomain(hostname, host))
  ) {
    return 'alibaba-standard';
  }
  return 'unknown';
}

export function resolveModelReasoningConfiguration(
  input: ModelReasoningConfigInput,
): ModelReasoningConfiguration | undefined {
  if (!input.modelId) {
    return undefined;
  }

  const modelId = input.modelId.toLowerCase();
  const qwen = Object.hasOwn(QWEN_CONFIGURATIONS, modelId)
    ? QWEN_CONFIGURATIONS[modelId]
    : undefined;
  if (qwen) {
    return qwen;
  }

  const endpoint = classifyModelReasoningEndpoint(input);
  switch (endpoint) {
    case 'deepseek':
      return modelId === 'deepseek-v4-pro' || modelId === 'deepseek-v4-flash'
        ? HIGH_MAX
        : undefined;
    case 'moonshot':
      if (modelId === 'kimi-k3') {
        return KIMI_K3;
      }
      return modelId === 'kimi-k2.6' ? TOGGLE_ONLY : undefined;
    case 'zai':
      if (modelId === 'glm-5.2') {
        return GLM_52_ZAI;
      }
      return undefined;
    case 'alibaba-standard':
      return resolveAlibabaStandardConfiguration(modelId, input.baseUrl);
    case 'alibaba-token-plan':
      return resolveAlibabaTokenPlanConfiguration(modelId);
    case 'alibaba-coding-plan':
      return modelId === 'kimi-k2.5' ? TOGGLE_ONLY : undefined;
    case 'unknown':
    default:
      return undefined;
  }
}

export function usesMandatoryReasoningDefaultOnly(
  input: MandatoryReasoningDefaultInput,
): boolean {
  if (
    input.thinkingMandatory !== true ||
    !input.modelId ||
    resolveModelReasoningConfiguration(input)
  ) {
    return false;
  }
  const modelId = input.modelId.toLowerCase();
  const endpoint = classifyModelReasoningEndpoint(input);
  if (endpoint === 'moonshot') {
    return true;
  }
  return (
    endpoint.startsWith('alibaba-') &&
    !isTieredEffortWireModel(modelId) &&
    !isQwenFamilyWireModel(modelId)
  );
}

export function normalizeModelReasoningEffort(
  configuration: ModelReasoningConfiguration,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!effort || configuration.toggleOnly) {
    return undefined;
  }
  return clampReasoningEffort(effort, configuration.efforts);
}

function resolveAlibabaStandardConfiguration(
  modelId: string,
  baseUrl: string | undefined,
): ModelReasoningConfiguration | undefined {
  if (modelId === 'deepseek-v4-pro' || modelId === 'deepseek-v4-flash') {
    return HIGH_MAX;
  }
  if (modelId === 'deepseek-v4-flash-0731') {
    return DEEPSEEK_0731;
  }
  if (modelId === 'glm-5.2' && isAlibabaGlm52Endpoint(baseUrl)) {
    return HIGH_MAX;
  }
  return undefined;
}

function isAlibabaGlm52Endpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (DASHSCOPE_REGIONAL_HOSTS.some((host) => hostname === host)) {
    return true;
  }
  return GLM_52_WORKSPACE_REGIONS.some((region) =>
    hostname.endsWith(`.${region}.maas.aliyuncs.com`),
  );
}

function resolveAlibabaTokenPlanConfiguration(
  modelId: string,
): ModelReasoningConfiguration | undefined {
  if (modelId === 'deepseek-v4-pro' || modelId === 'deepseek-v4-flash') {
    return HIGH_MAX;
  }
  if (modelId === 'deepseek-v4-flash-0731') {
    return DEEPSEEK_0731;
  }
  return ['glm-5.2', 'kimi-k2.5', 'kimi-k2.6'].includes(modelId)
    ? TOGGLE_ONLY
    : undefined;
}
