/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getDisabledPluginIds, getEnabledPluginIds } from './pluginManager.js';
import { createCorePluginManager } from './pluginManagerSettings.js';

it('wires the Core ZIP installer when creating a configured manager', async () => {
  await expect(
    createCorePluginManager().install({
      plugin: 'http://example.test/demo.zip',
      scope: 'user',
    }),
  ).rejects.toThrow('Remote plugin install requires an HTTPS .zip URL.');
});

describe('plugin enabled settings', () => {
  const settings = {
    enabledPlugins: {
      'regular@host-market': true,
      'host-context@host-market': true,
      'host-scan@host-market': false,
      'disabled@other': false,
    },
  };

  it('reads all enabled inventory without a product policy', () => {
    expect(getEnabledPluginIds(settings)).toEqual([
      'regular@host-market',
      'host-context@host-market',
    ]);
  });

  it('reads all disabled inventory without a product policy', () => {
    expect(getDisabledPluginIds(settings)).toEqual([
      'host-scan@host-market',
      'disabled@other',
    ]);
  });
});
