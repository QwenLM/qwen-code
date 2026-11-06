/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const DASHSCOPE_SOURCE_CONFIG_HEADER = 'X-DashScope-Source-Config';

/** Token Plan subscription endpoints are these hosts behind this prefix. */
const TOKEN_PLAN_HOST_PREFIX = 'token-plan.';

const SITE_CHANNELS: ReadonlyArray<readonly [host: string, channel: string]> = [
  ['maas.qianwenaiapi.com', 'qianwenai-inner-agents'],
  ['maas.qwencloudapi.com', 'qwencloud-inner-agents'],
];

const SITE_CHANNEL_BY_HOST: ReadonlyMap<string, string> = new Map(
  SITE_CHANNELS,
);

/**
 * 千问AI平台 (China) / QwenCloud (International) MaaS hosts. A request reaches
 * one of them either as the bare pay-as-you-go host or behind the
 * `token-plan.` prefix; attribution matches those two forms exactly.
 */
export const QWENCLOUD_MAAS_HOSTS: readonly string[] = SITE_CHANNELS.map(
  ([host]) => host,
);

/**
 * The 千问AI平台 / QwenCloud usage-attribution header value for a request
 * sent to `baseUrl`, or undefined when the endpoint is not one of those
 * platforms. Token Plan endpoints omit `t2`: the client cannot tell the
 * Personal and Team editions apart, and the platform resolves the plan from
 * the API key.
 */
export function buildDashScopeSourceConfig(
  baseUrl: string | undefined,
  runtimeChannel?: string,
): string | undefined {
  if (!baseUrl) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const isTokenPlan = hostname.startsWith(TOKEN_PLAN_HOST_PREFIX);
  const channel = SITE_CHANNEL_BY_HOST.get(
    isTokenPlan ? hostname.slice(TOKEN_PLAN_HOST_PREFIX.length) : hostname,
  );
  if (!channel) return undefined;
  const t1 =
    runtimeChannel === 'desktop' ? 'qwen-code-desktop' : 'qwen-code-cli';
  return JSON.stringify({
    channel,
    source: 'model',
    tags: isTokenPlan ? { t1 } : { t1, t2: 'payg' },
  });
}

/**
 * `headers` with the attribution header added when `baseUrl` is a 千问AI平台 /
 * QwenCloud endpoint. Attribution is first-party: an existing entry in any
 * casing is replaced, so a user header can neither override it nor reach the
 * wire as a second value.
 */
export function withDashScopeSourceConfig<T extends string | undefined>(
  headers: Record<string, T>,
  baseUrl: string | undefined,
  runtimeChannel?: string,
): Record<string, T | string> {
  const value = buildDashScopeSourceConfig(baseUrl, runtimeChannel);
  if (!value) return headers;
  const name = DASHSCOPE_SOURCE_CONFIG_HEADER.toLowerCase();
  const result: Record<string, T | string> = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== name),
  );
  result[DASHSCOPE_SOURCE_CONFIG_HEADER] = value;
  return result;
}

/**
 * `headers` without the attribution header, in any casing. Callers hand this —
 * not the raw `customHeaders` — to the session-header wrapper, whose job is to
 * decide whether a `${session_id}` placeholder may be expanded and to warn when
 * the switch is off. A value under this name can never reach the wire, because
 * the first-party attribution replaces it, so expanding it or warning that it
 * "will not be sent" describes the wrong thing (#15107 item 2).
 */
export function withoutDashScopeSourceConfig<T>(
  headers: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!headers) return undefined;
  const name = DASHSCOPE_SOURCE_CONFIG_HEADER.toLowerCase();
  const kept = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() !== name,
  );
  // Unchanged input keeps its identity: the wrapper treats an empty result and
  // `undefined` alike, and most callers have no attribution entry at all.
  return kept.length === Object.keys(headers).length
    ? headers
    : Object.fromEntries(kept);
}
