/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Config } from './config.js';
import type { PluginError } from '../plugins/types.js';

describe('Config plugin error partitions', () => {
  it('updates synchronization errors without erasing local loader errors', () => {
    const config = Object.create(Config.prototype) as Config;
    const localError: PluginError = {
      type: 'generic-error',
      source: 'local',
      plugin: 'local-plugin',
      error: 'local load failed',
    };
    const syncError: PluginError = {
      type: 'generic-error',
      source: 'sync',
      plugin: 'synced-plugin',
      pluginId: 'synced-plugin',
      error: 'download failed',
      hint: 'Retry after the source has been fixed.',
    };

    config.setPluginErrors([localError]);
    config.setPluginSyncErrors([syncError]);
    expect(config.getPluginErrors()).toEqual([localError, syncError]);

    config.setPluginSyncErrors([]);
    expect(config.getPluginErrors()).toEqual([localError]);
  });
});
