/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildAuthProviderCatalog } from './auth-provider-helpers.js';

describe('buildAuthProviderCatalog', () => {
  it('exposes preset modalities to daemon clients', () => {
    const catalog = buildAuthProviderCatalog('/workspace');
    const minimax = catalog.providers.find(
      (provider) => provider.id === 'minimax',
    );

    expect(
      minimax?.models?.find((model) => model.id === 'MiniMax-M3')?.modalities,
    ).toEqual({ image: true, video: true });
  });
});
