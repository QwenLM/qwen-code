/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from './reasoning-effort.js';
import type { ResolvedReasoning } from './reasoning-overrides.js';
import { getRequestModel } from './request-model.js';
import { AuthType } from '../utils/auth-type.js';

const FLASH_MODELS = new Set([
  'deepseek-flash',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017',
]);
const LEGACY_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
]);

function getDeepSeekEndpoint(
  baseUrl: string | undefined,
): 'official' | 'maas' | undefined {
  let hostname: string;
  try {
    hostname = new URL(baseUrl ?? '').hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com'))
    return 'official';
  if (
    hostname.endsWith('.maas.aliyuncs.com') ||
    /^(?:dashscope(?:-intl|-us)?|cn-hongkong\.dashscope)\.aliyuncs\.com$/.test(
      hostname,
    )
  )
    return 'maas';
  return undefined;
}

export function getBuiltinDeepSeekReasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  const endpoint = getDeepSeekEndpoint(config.baseUrl);
  const model = config.model?.toLowerCase() ?? '';
  if (
    config.authType !== AuthType.USE_OPENAI ||
    !endpoint ||
    (!FLASH_MODELS.has(model) &&
      !LEGACY_MODELS.has(model) &&
      !(endpoint === 'official' && model === 'deepseek-v4-flash-vision-exp'))
  )
    return undefined;
  return {
    profile: 'deepseek-openai',
    thinking: true,
    efforts:
      endpoint === 'maas' &&
      (model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash')
        ? ['high', 'max']
        : ['low', 'high', 'max'],
    defaultEffort: 'high',
    disableField: endpoint === 'official' ? 'thinking' : 'enable_thinking',
    ...(config.thinkingMandatory ? { canDisable: false } : {}),
  };
}

export function normalizeDeepSeekReasoningEffort(
  effort: string,
  model: string | undefined,
  baseUrl: string | undefined,
): string {
  const builtin = getBuiltinDeepSeekReasoning({
    authType: AuthType.USE_OPENAI,
    model,
    baseUrl,
  });
  if (effort === 'low')
    return builtin && !builtin.toggleOnly && builtin.efforts.includes('low')
      ? 'low'
      : 'high';
  if (effort === 'medium') return 'high';
  // MaaS does not specify xhigh; keep max for legacy models and follow the
  // current official mapping for the newer Flash aliases.
  if (effort === 'xhigh')
    return (builtin && getDeepSeekEndpoint(baseUrl) === 'official') ||
      (FLASH_MODELS.has(model?.toLowerCase() ?? '') &&
        model?.toLowerCase() !== 'deepseek-v4-flash')
      ? 'high'
      : 'max';
  return effort;
}

export function applyDeepSeekReasoningEffort<T extends object>(
  request: T,
  baseUrl: string | undefined,
  configuredEffort?: ReasoningEffort,
): T {
  const body = request as Record<string, unknown>;
  const model = typeof body['model'] === 'string' ? body['model'] : undefined;
  if (
    getDeepSeekEndpoint(baseUrl) !== 'official' &&
    !getBuiltinDeepSeekReasoning({
      authType: AuthType.USE_OPENAI,
      model,
      baseUrl,
    })
  )
    return request;
  const reasoning = body['reasoning'] as Record<string, unknown> | undefined;
  const nestedEffort = reasoning?.['effort'];
  const effort = nestedEffort ?? configuredEffort;
  if (typeof effort !== 'string' || !effort) return request;
  const next = { ...body };
  if (typeof next['reasoning_effort'] !== 'string' || !next['reasoning_effort'])
    next['reasoning_effort'] =
      nestedEffort === undefined
        ? effort
        : normalizeDeepSeekReasoningEffort(effort, model, baseUrl);
  const { effort: _effort, ...rest } = reasoning ?? {};
  if (Object.keys(rest).length > 0) next['reasoning'] = rest;
  else delete next['reasoning'];
  return next as T;
}

export function getDeepSeekReasoningState(
  config: Partial<ContentGeneratorConfig>,
  resolved: ResolvedReasoning | undefined,
): { enabled: boolean; effort?: ReasoningEffort } | undefined {
  const model = getRequestModel(config);
  if (
    !getBuiltinDeepSeekReasoning({ ...config, model }) ||
    !resolved ||
    (resolved.profile !== undefined &&
      resolved.profile !== 'deepseek-openai') ||
    resolved.toggleOnly
  )
    return undefined;
  const defaultEffort = resolved.defaultEffort;
  const configured = (config.reasoning || undefined)?.effort;
  const effort = configured ?? defaultEffort;
  const normalized =
    effort === undefined || resolved.efforts.includes(effort)
      ? effort
      : normalizeDeepSeekReasoningEffort(effort, model, config.baseUrl);
  const body: Record<string, unknown> = applyDeepSeekReasoningEffort(
    { model: config.model, ...config.samplingParams, ...config.extra_body },
    config.baseUrl,
    normalized === undefined
      ? undefined
      : clampReasoningEffort(normalized as ReasoningEffort, resolved.efforts),
  );
  const disabled =
    resolved.canDisable !== false &&
    (config.reasoning === false ||
      (resolved.disableField === 'thinking'
        ? (body['thinking'] as { type?: string } | undefined)?.type ===
          'disabled'
        : body['enable_thinking'] === false) ||
      body['reasoning_effort'] === 'none');
  const wireEffort =
    config.reasoning !== false && typeof body['reasoning_effort'] === 'string'
      ? body['reasoning_effort']
      : defaultEffort;
  const effective =
    wireEffort === undefined ||
    resolved.efforts.includes(wireEffort as ReasoningEffort)
      ? wireEffort
      : normalizeDeepSeekReasoningEffort(wireEffort, model, config.baseUrl);
  return {
    enabled: !disabled,
    effort: resolved.efforts.includes(effective as ReasoningEffort)
      ? (effective as ReasoningEffort)
      : defaultEffort,
  };
}
