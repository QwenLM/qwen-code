/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
  findProviderByCredentials,
} from './all-providers.js';
import { kimiProvider } from './presets/kimi.js';
import { moonshotProvider } from './presets/moonshot.js';

describe('provider registry', () => {
  it('sorts third-party providers alphabetically by label', () => {
    const labels = THIRD_PARTY_PROVIDERS.map((provider) => provider.label);
    const registryLabels = ALL_PROVIDERS.filter(
      (provider) => provider.uiGroup === 'third-party',
    ).map((provider) => provider.label);
    const sortedLabels = [...labels].sort((left, right) =>
      left.localeCompare(right, 'en'),
    );

    expect(labels).toEqual(sortedLabels);
    expect(registryLabels).toEqual(sortedLabels);
  });

  it('resolves the shared MOONSHOT_API_KEY space to moonshot over kimi', () => {
    // kimi derives MOONSHOT_API_KEY for its regional API endpoints while
    // moonshot declares the key statically; the static owner must win
    // regardless of registration order.
    for (const baseUrl of [
      'https://api.moonshot.ai/v1',
      'https://api.moonshot.cn/v1',
    ]) {
      expect(findProviderByCredentials(baseUrl, 'MOONSHOT_API_KEY')).toBe(
        moonshotProvider,
      );
    }
    // Kimi still uniquely owns its Coding Plan credential space.
    expect(
      findProviderByCredentials(
        'https://api.kimi.com/coding/v1',
        'KIMI_CODE_API_KEY',
      ),
    ).toBe(kimiProvider);
  });
});
