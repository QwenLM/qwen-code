/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const DASHSCOPE_SOURCE_CONFIG_HEADER = 'X-DashScope-Source-Config';

const SITE_CHANNELS: ReadonlyArray<readonly [host: string, channel: string]> = [
  ['maas.qianwenaiapi.com', 'qianwenai-inner-agents'],
  ['maas.qwencloudapi.com', 'qwencloud-inner-agents'],
];

/**
 * 千问AI平台 (China) / QwenCloud (International) MaaS hosts. Both the
 * pay-as-you-go endpoints and the `token-plan.`-prefixed subscription
 * endpoints are subdomains of these, so one suffix match covers all four.
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
  const t1 =
    runtimeChannel === 'desktop' ? 'qwen-code-desktop' : 'qwen-code-cli';
  for (const [host, channel] of SITE_CHANNELS) {
    const tags =
      hostname === host
        ? { t1, t2: 'payg' }
        : hostname === `token-plan.${host}`
          ? { t1 }
          : undefined;
    if (tags) return JSON.stringify({ channel, source: 'model', tags });
  }
  return undefined;
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
