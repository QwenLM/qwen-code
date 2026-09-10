/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../../utils/auth-type.js';
import { DASHSCOPE_PROXY_BASE_URL } from '../constants.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';

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
 * Token Plan endpoints under token-plan.<region>.maas.aliyuncs.com,
 * internal Alibaba domains (*.alibaba-inc.com, *.aliyun-inc.com),
 * Alibaba Cloud API Gateway domains (*.alicloudapi.com),
 * and proxy matches.
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

  const isTokenPlanOrigin =
    hostname !== null &&
    hostname.startsWith('token-plan.') &&
    hostname.endsWith('.maas.aliyuncs.com');

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
  const normalizedProxyUrl = DASHSCOPE_PROXY_BASE_URL?.endsWith('/')
    ? DASHSCOPE_PROXY_BASE_URL.slice(0, -1)
    : DASHSCOPE_PROXY_BASE_URL;

  const isProxyMatch = Boolean(
    normalizedProxyUrl &&
      normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase(),
  );

  if (
    normalizedProxyUrl &&
    !isDashscopeOrigin &&
    !isTokenPlanOrigin &&
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
    isTokenPlanOrigin ||
    isInternalOrigin ||
    isAliCloudApiOrigin ||
    isProxyMatch
  );
}
