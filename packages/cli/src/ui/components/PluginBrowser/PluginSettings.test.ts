/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getPluginBrowserTabs } from './PluginSettings.js';

describe('getPluginBrowserTabs', () => {
  it('shows the error count without hiding marketplace tabs', () => {
    expect(getPluginBrowserTabs(3)).toEqual([
      { key: 'discover', label: 'Discover' },
      { key: 'installed', label: 'Installed' },
      { key: 'marketplaces', label: 'Marketplaces' },
      { key: 'errors', label: 'Errors (3)' },
    ]);
  });

  it('keeps all formal plugin tabs when there are no errors', () => {
    expect(getPluginBrowserTabs(0)).toEqual([
      { key: 'discover', label: 'Discover' },
      { key: 'installed', label: 'Installed' },
      { key: 'marketplaces', label: 'Marketplaces' },
      { key: 'errors', label: 'Errors' },
    ]);
  });
});
