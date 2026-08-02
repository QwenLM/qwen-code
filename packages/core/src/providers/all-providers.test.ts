/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ALL_PROVIDERS, THIRD_PARTY_PROVIDERS } from './all-providers.js';

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
});
