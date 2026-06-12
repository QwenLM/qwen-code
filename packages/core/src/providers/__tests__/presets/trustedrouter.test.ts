/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  trustedRouterProvider,
  TRUSTEDROUTER_ENV_KEY,
} from '../../presets/trustedrouter.js';

describe('trustedRouterProvider', () => {
  it('uses the TrustedRouter OpenAI-compatible API endpoint', () => {
    expect(trustedRouterProvider.baseUrl).toBe(
      'https://api.trustedrouter.com/v1',
    );
    expect(trustedRouterProvider.models?.map((model) => model.id)).toEqual([
      'trustedrouter/auto',
      'trustedrouter/zdr',
      'trustedrouter/e2e',
    ]);
  });

  it('owns models that match BOTH the envKey and api.trustedrouter.com host', () => {
    expect(
      trustedRouterProvider.ownsModel?.({
        id: 'trustedrouter/auto',
        baseUrl: 'https://api.trustedrouter.com/v1',
        envKey: TRUSTEDROUTER_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership over a different envKey on the same host', () => {
    expect(
      trustedRouterProvider.ownsModel?.({
        id: 'trustedrouter/auto',
        baseUrl: 'https://api.trustedrouter.com/v1',
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
  });

  it('refuses ownership over unrelated or malformed base URLs', () => {
    expect(
      trustedRouterProvider.ownsModel?.({
        id: 'trustedrouter/auto',
        baseUrl: 'https://api.example.com/v1',
        envKey: TRUSTEDROUTER_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      trustedRouterProvider.ownsModel?.({
        id: 'bad-url',
        baseUrl: 'not a url',
        envKey: TRUSTEDROUTER_ENV_KEY,
      }),
    ).toBe(false);
  });
});
