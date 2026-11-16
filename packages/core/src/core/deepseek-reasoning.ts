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
 * The exact model/host combinations the built-in DeepSeek recognizer
 * accepted before third-party prefix recognition: known ids on the official
 * endpoint (plus the retired vision alias), known ids on the MaaS/DashScope
 * whitelist, and the exact V4.1 Flash ids on the internal proxies. There the
 * normalizer keeps its established interaction with explicit declarations;
 * every newly recognized combination stands it down, so a declaration on a
 * new alias keeps its own wire semantics even on a MaaS host.
 */
export function isDeepSeekEstablishedHost(
  baseUrl: string | undefined,
  model: string | undefined,
): boolean {
  const hostname = hostnameOf(baseUrl);
  if (hostname === undefined) return false;
  const normalized = (model ?? '').toLowerCase();
  const known = FLASH_MODELS.has(normalized) || LEGACY_MODELS.has(normalized);
  if (isDeepSeekOfficialBaseUrl(baseUrl))
    return known || normalized === 'deepseek-v4-flash-vision-exp';
  if (isDeepSeekMaasHostname(hostname)) return known;
  return (
    /^deepseek-v4\.1-flash(?:-1017)?$/.test(normalized) &&
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
  if (isDeepSeekOfficialBaseUrl(baseUrl)) return 'official';
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
): { enabled: boolean; effort?: ReasoningEffort } | undefined {
  const model = getRequestModel(config);
  if (
    !getBuiltinDeepSeekReasoning({ ...config, model }) ||
    !resolved ||
    (resolved.profile !== undefined &&
      resolved.profile !== 'deepseek-openai') ||
    resolved.toggleOnly ||
    // A profile-less resolved capability is an explicit declaration; on
    // newly recognized model/host combinations it governs the wire, so the
    // built-in normalizer stands down.
    (resolved.profile === undefined &&
      !isDeepSeekEstablishedHost(config.baseUrl, model))
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
