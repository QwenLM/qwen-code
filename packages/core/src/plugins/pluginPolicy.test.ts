/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getEffectiveBlockedMarketplaces,
  isPluginBlockedByPolicy,
} from './pluginPolicy.js';

describe('pluginPolicy', () => {
  it('normalizes and deduplicates configured marketplace blocks', () => {
    expect(getEffectiveBlockedMarketplaces([])).toEqual([]);
    expect(getEffectiveBlockedMarketplaces(['Enterprise', 'enterprise'])).toEqual([
      'enterprise',
    ]);
  });

  it('does not treat qoder-bundler as an implicit policy block', () => {
    expect(
      isPluginBlockedByPolicy('qoder-create-plugin@qoder-bundler', {
        plugins: {},
      }),
    ).toBe(false);
  });

  it('matches configured marketplace blocks case-insensitively', () => {
    expect(
      isPluginBlockedByPolicy('demo@QODER-BUNDLER', {
        plugins: { blockedMarketplaces: ['qoder-bundler'] },
      }),
    ).toBe(true);
  });
});
