/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { loadRewriteConfig } from './config.js';
import type { LoadedSettings } from '../../../config/settings.js';

/**
 * Build a minimal LoadedSettings stub with only the fields
 * that loadRewriteConfig actually reads (user/workspace originalSettings + isTrusted).
 */
function makeSettings(
  overrides: {
    userRewrite?: Record<string, unknown>;
    workspaceRewrite?: Record<string, unknown>;
    isTrusted?: boolean;
  } = {},
): LoadedSettings {
  return {
    user: {
      originalSettings: overrides.userRewrite
        ? { messageRewrite: overrides.userRewrite }
        : {},
    },
    workspace: {
      originalSettings: overrides.workspaceRewrite
        ? { messageRewrite: overrides.workspaceRewrite }
        : {},
    },
    isTrusted: overrides.isTrusted ?? true,
  } as unknown as LoadedSettings;
}

describe('loadRewriteConfig', () => {
  it('should return undefined when no config is set', () => {
    const settings = makeSettings();
    expect(loadRewriteConfig(settings)).toBeUndefined();
  });

  it('should return user config when only user config is set', () => {
    const settings = makeSettings({
      userRewrite: { enabled: true, target: 'both', prompt: 'user prompt' },
    });
    const config = loadRewriteConfig(settings);
    expect(config).toEqual({
      enabled: true,
      target: 'both',
      prompt: 'user prompt',
    });
  });

  it('should return workspace config when trusted', () => {
    const settings = makeSettings({
      userRewrite: { enabled: false, target: 'message' },
      workspaceRewrite: { enabled: true, target: 'both', prompt: 'ws prompt' },
      isTrusted: true,
    });
    const config = loadRewriteConfig(settings);
    expect(config?.enabled).toBe(true);
    expect(config?.prompt).toBe('ws prompt');
  });

  it('should ignore workspace config when untrusted', () => {
    const settings = makeSettings({
      userRewrite: { enabled: false, target: 'message' },
      workspaceRewrite: { enabled: true, target: 'both', prompt: 'malicious' },
      isTrusted: false,
    });
    const config = loadRewriteConfig(settings);
    expect(config?.enabled).toBe(false);
    expect(config?.prompt).toBeUndefined();
  });

  it('should fall back to user config when workspace has no rewrite config', () => {
    const settings = makeSettings({
      userRewrite: { enabled: true, target: 'thought' },
      isTrusted: true,
    });
    const config = loadRewriteConfig(settings);
    expect(config?.target).toBe('thought');
  });
});
