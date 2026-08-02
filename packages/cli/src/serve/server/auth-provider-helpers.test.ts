/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ServeAuthProviderBaseUrlOption } from '../types.js';
import { buildAuthProviderCatalog } from './auth-provider-helpers.js';

describe('buildAuthProviderCatalog', () => {
  it('serializes endpoint-specific Kimi models', () => {
    const catalog = buildAuthProviderCatalog('/workspace');
    const kimi = catalog.providers.find((provider) => provider.id === 'kimi');

    expect(kimi?.models?.map((model) => model.id)).toEqual([
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);

    const options = kimi?.baseUrl as ServeAuthProviderBaseUrlOption[];
    expect(options).toHaveLength(3);
    expect(options[0]?.models?.map((model) => model.id)).toEqual([
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(options[1]?.models?.map((model) => model.id)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);
    expect(options[2]?.models).toEqual(options[1]?.models);
  });
});
