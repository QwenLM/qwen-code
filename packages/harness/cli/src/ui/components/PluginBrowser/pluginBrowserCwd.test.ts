/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getPluginBrowserCwd } from './pluginBrowserCwd.js';

describe('getPluginBrowserCwd', () => {
  it('keeps project plugin scope anchored to the original project in a worktree', () => {
    const config = {
      getWorkingDir: () => '/session/worktree',
      getSessionArtifactProjectRoot: () => '/session/original',
    };

    expect(getPluginBrowserCwd(config)).toBe('/session/original');
  });

  it('falls back to process.cwd() when Config is unavailable', () => {
    expect(getPluginBrowserCwd(null)).toBe(process.cwd());
  });
});
