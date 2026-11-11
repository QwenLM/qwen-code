/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_ENV_PREFIX } from '../../config/brand.js';

/**
 * Qoder account region. One binary can connect to either account region; the
 * region selects both the OAuth hosts and the inference gateway.
 */
export type QoderAccountRegion = 'global' | 'cn';

export interface QoderRegionEndpoints {
  /** Website hosting the browser authorization page. */
  readonly websiteBaseUrl: string;
  /** Host serving device token, userinfo, and refresh endpoints. */
  readonly openApiBaseUrl: string;
  /** Production gateway origin for model catalog and Responses inference. */
  readonly gatewayBaseUrl: string;
}

export const QODER_ACCOUNT_REGIONS: readonly QoderAccountRegion[] = [
  'global',
  'cn',
];

/** Public CLI OAuth client id; both regions accept it. */
export const QODER_CLIENT_ID = 'ecaf4a7a-5e5b-4659-9a95-7a1570012a41';

/** Query value required by the Responses gateway. */
export const QODER_AGENT_ID = 'agent_common';

/** Product attribution header value for the qcode scene. */
export const QODER_CLIENT_TYPE = '13';

/** Billing scene carried in Responses metadata. */
export const QODER_SESSION_TYPE = 'qcode';

export const QODER_REGION_ENDPOINTS: Readonly<
  Record<QoderAccountRegion, QoderRegionEndpoints>
> = {
  global: {
    websiteBaseUrl: 'https://qoder.com',
    openApiBaseUrl: 'https://openapi.qoder.sh',
    gatewayBaseUrl: 'https://api2.qoder.sh/qsvr',
  },
  cn: {
    websiteBaseUrl: 'https://qoder.cn',
    openApiBaseUrl: 'https://openapi.qoder.com.cn',
    gatewayBaseUrl: 'https://gateway.qoder.com.cn/qsvr',
  },
};

/**
 * Qwen Code environment names. These are deliberately independent
 * of any product brand prefix so this module never reads QODER_* names.
 */
const QWEN_QODER_ENV_PREFIX = 'QWEN_QODER_';

/** Account region selector: `global` or `cn`. */
export const QODER_ENV_ACCOUNT_REGION = `${QWEN_QODER_ENV_PREFIX}REGION`;
export const QODER_ENV_AUTH_BASE_URL = `${QWEN_QODER_ENV_PREFIX}AUTH_BASE_URL`;
export const QODER_ENV_OPENAPI_BASE_URL = `${QWEN_QODER_ENV_PREFIX}OPENAPI_BASE_URL`;
export const QODER_ENV_GATEWAY_BASE_URL = `${QWEN_QODER_ENV_PREFIX}GATEWAY_BASE_URL`;
export const QODER_ENV_OAUTH_CLIENT_ID = `${QWEN_QODER_ENV_PREFIX}CLIENT_ID`;

export function isQoderAccountRegion(
  value: unknown,
): value is QoderAccountRegion {
  return (QODER_ACCOUNT_REGIONS as readonly unknown[]).includes(value);
}

/**
 * Effective account region: explicit env override, then the build's home site.
 * Account region is independent from the transport region (US/SG/JP) used by
 * other stacks.
 */
export function resolveQoderAccountRegion(
  env: NodeJS.ProcessEnv = process.env,
): QoderAccountRegion {
  const explicit = env[QODER_ENV_ACCOUNT_REGION]?.trim().toLowerCase();
  if (isQoderAccountRegion(explicit)) {
    return explicit;
  }
  return BRAND_ENV_PREFIX === 'QODERCN_' ? 'cn' : 'global';
}

export function resolveQoderClientId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[QODER_ENV_OAUTH_CLIENT_ID]?.trim();
  return override || QODER_CLIENT_ID;
}

/**
 * Region endpoints with optional local overrides. Overrides exist so
 * deployments can point at their own gateway without changing code.
 */
export function resolveQoderRegionEndpoints(
  region: QoderAccountRegion,
  env: NodeJS.ProcessEnv = process.env,
): QoderRegionEndpoints {
  const defaults = QODER_REGION_ENDPOINTS[region];
  return {
    websiteBaseUrl: normalizeBaseUrl(
      env[QODER_ENV_AUTH_BASE_URL]?.trim(),
      defaults.websiteBaseUrl,
    ),
    openApiBaseUrl: normalizeBaseUrl(
      env[QODER_ENV_OPENAPI_BASE_URL]?.trim(),
      defaults.openApiBaseUrl,
    ),
    gatewayBaseUrl: normalizeBaseUrl(
      env[QODER_ENV_GATEWAY_BASE_URL]?.trim(),
      defaults.gatewayBaseUrl,
    ),
  };
}

function normalizeBaseUrl(
  override: string | undefined,
  fallback: string,
): string {
  return (override || fallback).replace(/\/+$/, '');
}
