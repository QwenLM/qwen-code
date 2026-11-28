/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../../utils/auth-type.js';
import { getDashscopeProxyBaseUrl } from '../constants.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { QWENCLOUD_MAAS_HOSTS } from '../../dashscope-source-config.js';

const debugLogger = createDebugLogger('DashScopeOpenAICompatibleProvider');

/**
 * Official DashScope regional API hosts (matched exactly or as a parent
 * domain of the endpoint hostname). Shared with the WebSearch side channel's
 * endpoint gate (tools/web-search.ts) so a new region is added in one place.
 */
export const DASHSCOPE_REGIONAL_HOSTS: readonly string[] = [
  'dashscope.aliyuncs.com',
  'dashscope-intl.aliyuncs.com',
  'dashscope-us.aliyuncs.com',
];

/**
 * Determines whether to use the DashScope-compatible provider.
 * Covers the official regional hosts (DASHSCOPE_REGIONAL_HOSTS),
 * Model Studio endpoints under *.maas.aliyuncs.com (workspace-dedicated
 * <WorkspaceId>.<region>, trial.<region> and token-plan.<region> hosts),
 * QwenCloud MaaS hosts (QWENCLOUD_MAAS_HOSTS),
 * internal Alibaba domains (*.alibaba-inc.com, *.aliyun-inc.com),
 * Alibaba Cloud API Gateway domains (*.alicloudapi.com),
 * and proxy matches.
 *
 * Kept in a lightweight leaf module with zero `openai` SDK imports so
 * Responses wire dialect resolution and logging helpers do not pull the
 * `openai` SDK into their static module graph.
 *
 * Note: any *.alibaba-inc.com / *.aliyun-inc.com host is treated as a
 * DashScope-compatible endpoint by design. Keep this generic and avoid
 * embedding individual private gateway hostnames in provider detection.
 */
export function isDashScopeProvider(
  contentGeneratorConfig: Pick<ContentGeneratorConfig, 'authType' | 'baseUrl'>,
): boolean {
  const { authType, baseUrl } = contentGeneratorConfig;

  if (authType === AuthType.QWEN_OAUTH) return true;
  if (!baseUrl) return true;

  const normalizedBaseUrl = baseUrl.endsWith('/')
    ? baseUrl.slice(0, -1)
    : baseUrl;

  // Parse the URL and check hostname instead of regex to avoid ReDoS on
  // attacker-controlled baseUrl and to reject path-only matches like
  // https://evil.example/dashscope.aliyuncs.com/...
  let hostname: string | null = null;
  try {
    hostname = new URL(normalizedBaseUrl).hostname.toLowerCase();
  } catch {
    hostname = null;
  }

  // Matches an official regional host or any subdomain of one.
  const isDashscopeOrigin =
    hostname !== null &&
    DASHSCOPE_REGIONAL_HOSTS.some(
      (host) => hostname === host || hostname.endsWith('.' + host),
    );

  // Every Model Studio host under maas.aliyuncs.com serves the DashScope
  // API: workspace-dedicated domains (the recommended production entry),
  // trial domains and Token Plan domains.
  const isMaasOrigin =
    hostname !== null && hostname.endsWith('.maas.aliyuncs.com');

  // 千问AI平台 / QwenCloud MaaS hosts, including their `token-plan.`
  // subscription subdomains.
  const isQwenCloudOrigin =
    hostname !== null &&
    QWENCLOUD_MAAS_HOSTS.some(
      (host) => hostname === host || hostname.endsWith('.' + host),
    );

  // Internal Alibaba domains proxying to DashScope-compatible APIs.
  // Covers *.alibaba-inc.com and *.aliyun-inc.com.
  const isInternalOrigin =
    hostname !== null &&
    (hostname.endsWith('.alibaba-inc.com') ||
      hostname.endsWith('.aliyun-inc.com'));

  // Alibaba Cloud API Gateway domains proxying to DashScope-compatible
  // APIs. Covers *.alicloudapi.com.
  const isAliCloudApiOrigin =
    hostname !== null && hostname.endsWith('.alicloudapi.com');

  // Check if proxy is configured and matches
  const proxyBaseUrl = getDashscopeProxyBaseUrl();
  const normalizedProxyUrl = proxyBaseUrl?.endsWith('/')
    ? proxyBaseUrl.slice(0, -1)
    : proxyBaseUrl;

  const isProxyMatch = Boolean(
    normalizedProxyUrl &&
      normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase(),
  );

  if (
    normalizedProxyUrl &&
    !isDashscopeOrigin &&
    !isMaasOrigin &&
    !isQwenCloudOrigin &&
    !isInternalOrigin &&
    !isAliCloudApiOrigin &&
    !isProxyMatch
  ) {
    debugLogger.debug(
      `DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match. DashScope headers/cache control will be skipped.`,
    );
  }

  if (isInternalOrigin) {
    debugLogger.debug(
      `DashScope provider activated via internal origin: ${hostname}`,
    );
  }

  if (isAliCloudApiOrigin) {
    debugLogger.debug(
      `DashScope provider activated via alicloudapi origin: ${hostname}`,
    );
  }

  return (
    isDashscopeOrigin ||
    isMaasOrigin ||
    isQwenCloudOrigin ||
    isInternalOrigin ||
    isAliCloudApiOrigin ||
    isProxyMatch
  );
}
