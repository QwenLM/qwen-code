/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { BRAND_ENV_PREFIX } from '../../config/brand.js';
import {
  QODER_CLIENT_ID,
  QODER_ENV_ACCOUNT_REGION,
  QODER_ENV_GATEWAY_BASE_URL,
  QODER_ENV_OAUTH_CLIENT_ID,
  QODER_REGION_ENDPOINTS,
  isQoderAccountRegion,
  resolveQoderAccountRegion,
  resolveQoderClientId,
  resolveQoderRegionEndpoints,
} from './regions.js';

describe('Qoder account regions', () => {
  it('exposes global and cn endpoints', () => {
    expect(QODER_REGION_ENDPOINTS.global).toEqual({
      websiteBaseUrl: 'https://qoder.com',
      openApiBaseUrl: 'https://openapi.qoder.sh',
      gatewayBaseUrl: 'https://api2.qoder.sh/qsvr',
    });
    expect(QODER_REGION_ENDPOINTS.cn).toEqual({
      websiteBaseUrl: 'https://qoder.cn',
      openApiBaseUrl: 'https://openapi.qoder.com.cn',
      gatewayBaseUrl: 'https://gateway.qoder.com.cn/qsvr',
    });
  });

  it('recognizes known regions', () => {
    expect(isQoderAccountRegion('global')).toBe(true);
    expect(isQoderAccountRegion('cn')).toBe(true);
    expect(isQoderAccountRegion('us')).toBe(false);
  });

  it('defaults to the build region and honors the env override', () => {
    const buildRegion = BRAND_ENV_PREFIX === 'QODERCN_' ? 'cn' : 'global';
    expect(resolveQoderAccountRegion({})).toBe(buildRegion);
    expect(resolveQoderAccountRegion({ [QODER_ENV_ACCOUNT_REGION]: 'cn' })).toBe(
      'cn',
    );
    expect(
      resolveQoderAccountRegion({ [QODER_ENV_ACCOUNT_REGION]: 'bogus' }),
    ).toBe(buildRegion);
  });

  it('applies endpoint overrides and trims trailing slashes', () => {
    const endpoints = resolveQoderRegionEndpoints('global', {
      [QODER_ENV_GATEWAY_BASE_URL]: 'https://gateway.example.com/',
    });
    expect(endpoints.gatewayBaseUrl).toBe('https://gateway.example.com');
    expect(endpoints.openApiBaseUrl).toBe(
      QODER_REGION_ENDPOINTS.global.openApiBaseUrl,
    );
  });

  it('resolves the production client id by default', () => {
    expect(resolveQoderClientId({})).toBe(QODER_CLIENT_ID);
  });

  it('lets an explicit client id override win', () => {
    expect(
      resolveQoderClientId({
        [QODER_ENV_OAUTH_CLIENT_ID]: 'custom-client',
      }),
    ).toBe('custom-client');
  });
});
