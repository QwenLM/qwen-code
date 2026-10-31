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

// The one case-insensitive choke point for the DeepSeek-V4 family: every id
// under the prefix (dated snapshots and gateway aliases included) speaks the
// same effort contract.
function isDeepSeekV4Model(model: string | undefined): boolean {
  return /^deepseek-v4/i.test(model ?? '');
}

// Newer Flash aliases — the stable ids and any suffixed gateway alias under
// the v4.1-flash prefix — share the official xhigh→high mapping. The legacy
// deepseek-v4-flash id and the pro family keep the MaaS xhigh→max rule.
function isNewerFlashAlias(model: string | undefined): boolean {
  const normalized = model?.toLowerCase() ?? '';
  return (
    (FLASH_MODELS.has(normalized) && normalized !== 'deepseek-v4-flash') ||
    normalized.startsWith('deepseek-v4.1-flash')
  );
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
  try {
    return new URL(baseUrl ?? '').hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isDeepSeekOfficialBaseUrl(
  baseUrl: string | undefined,
): boolean {
  const hostname = hostnameOf(baseUrl);
  return (
    hostname !== undefined &&
    (hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com'))
  );
}

function isDeepSeekMaasHostname(hostname: string): boolean {
  return (
    hostname.endsWith('.maas.aliyuncs.com') ||
    /^(?:dashscope(?:-intl|-us)?|cn-hongkong\.dashscope)\.aliyuncs\.com$/.test(
      hostname,
    )
  );
}

/**
 * Routes where the built-in DeepSeek contract shipped before third-party
 * prefix recognition: the official endpoint, the MaaS/DashScope whitelist,
 * and the internal-proxy exception for the V4.1 Flash aliases. There the
 * normalizer keeps its established interaction with explicit declarations;
 * only on newly recognized third-party hosts does a declaration stand it
 * down.
 */
export function isDeepSeekEstablishedHost(
  baseUrl: string | undefined,
  model: string | undefined,
): boolean {
  const hostname = hostnameOf(baseUrl);
  if (hostname === undefined) return false;
  if (hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com'))
    return true;
  if (isDeepSeekMaasHostname(hostname)) return true;
  return (
    /^deepseek-v4\.1-flash(?:-1017)?$/i.test(model ?? '') &&
    (hostname.endsWith('.alibaba-inc.com') ||
      hostname.endsWith('.aliyun-inc.com') ||
      hostname.endsWith('.alicloudapi.com'))
  );
}

function getDeepSeekEndpoint(
  baseUrl: string | undefined,
  model: string | undefined,
): 'official' | 'maas' | undefined {
  const hostname = hostnameOf(baseUrl);
  if (hostname === undefined) return undefined;
  if (hostname === 'api.deepseek.com' || hostname.endsWith('.api.deepseek.com'))
    return 'official';
  if (isDeepSeekMaasHostname(hostname)) return 'maas';
  // DeepSeek-V4 models are hosted by many third-party OpenAI-compatible
  // gateways (PAI-EAS, internal proxies, ...); the model id alone identifies
  // the MaaS-style wire contract there, so no hostname whitelist applies.
  if (isDeepSeekV4Model(model)) return 'maas';
  return undefined;
}

export function getBuiltinDeepSeekReasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  const model = config.model?.toLowerCase() ?? '';
  const endpoint = getDeepSeekEndpoint(config.baseUrl, model);
  if (
    config.authType !== AuthType.USE_OPENAI ||
    !endpoint ||
    (!isDeepSeekV4Model(model) && !FLASH_MODELS.has(model))
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
    return (builtin && getDeepSeekEndpoint(baseUrl, model) === 'official') ||
      isNewerFlashAlias(model)
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
    getDeepSeekEndpoint(baseUrl, model) !== 'official' &&
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
  declared = false,
): { enabled: boolean; effort?: ReasoningEffort } | undefined {
  const model = getRequestModel(config);
  if (
    !getBuiltinDeepSeekReasoning({ ...config, model }) ||
    !resolved ||
    (resolved.profile !== undefined &&
      resolved.profile !== 'deepseek-openai') ||
    resolved.toggleOnly ||
    // An explicit declaration governs the wire on newly recognized
    // third-party hosts; the built-in normalizer must not override its
    // declared/static effort there.
    (declared && !isDeepSeekEstablishedHost(config.baseUrl, model))
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
