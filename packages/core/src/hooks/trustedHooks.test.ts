/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import { TrustedHooksManager } from './trustedHooks.js';
import { HookType, type HookConfig } from './types.js';

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('../config/storage.js', () => ({
  Storage: {
    getGlobalQwenDir: vi.fn(() => '/mock/home/.qwen'),
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '{}'),
  mkdirSync: vi.fn(),
}));

describe('TrustedHooksManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('trustHooks writes via atomicWriteFileSync with credentials-grade options', () => {
    const manager = new TrustedHooksManager();
    const hook: HookConfig = {
      type: HookType.Command,
      command: 'echo trusted',
    };

    manager.trustHooks('/project/a', { PreToolUse: [{ hooks: [hook] }] });

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    const [, , options] = vi.mocked(atomicWriteFileSync).mock.calls[0];
    // mode 0o600 + forceMode: + noFollow:true — mirrors the credential
    // write sites (sharedTokenManager / oauth-token-storage /
    // file-token-storage). noFollow prevents a pre-placed symlink at
    // the config path from redirecting the executable-trust list.
    expect(options).toEqual({
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  });

  it('trustHooks writes the configPath under the global qwen dir', () => {
    const manager = new TrustedHooksManager();
    manager.trustHooks('/project/a', {
      PreToolUse: [
        { hooks: [{ type: HookType.Command, command: 'echo trusted' }] },
      ],
    });

    const [configPath] = vi.mocked(atomicWriteFileSync).mock.calls[0];
    expect(configPath).toBe(
      path.join('/mock/home/.qwen', 'trusted_hooks.json'),
    );
  });

  it('trustHooks persists the hook key derived from the hook config', () => {
    const manager = new TrustedHooksManager();
    manager.trustHooks('/project/a', {
      PreToolUse: [
        { hooks: [{ type: HookType.Command, command: 'echo trusted' }] },
      ],
    });

    const [, content] = vi.mocked(atomicWriteFileSync).mock.calls[0];
    const saved = JSON.parse(content as string);
    expect(saved['/project/a']).toEqual(['echo trusted']);
  });

  it('getUntrustedHooks returns the hook identifier when not previously trusted', () => {
    const manager = new TrustedHooksManager();
    const untrusted = manager.getUntrustedHooks('/project/a', {
      PreToolUse: [
        {
          hooks: [
            { type: HookType.Command, command: 'rm -rf /' },
            { type: HookType.Command, command: 'echo safe' },
          ],
        },
      ],
    });

    expect(untrusted).toEqual(['rm -rf /', 'echo safe']);
  });

  it('getUntrustedHooks returns empty after the hooks are trusted', () => {
    const manager = new TrustedHooksManager();
    manager.trustHooks('/project/a', {
      PreToolUse: [
        {
          hooks: [
            { type: HookType.Command, command: 'rm -rf /' },
            { type: HookType.Command, command: 'echo safe' },
          ],
        },
      ],
    });

    const untrusted = manager.getUntrustedHooks('/project/a', {
      PreToolUse: [
        {
          hooks: [
            { type: HookType.Command, command: 'rm -rf /' },
            { type: HookType.Command, command: 'echo safe' },
          ],
        },
      ],
    });

    expect(untrusted).toEqual([]);
  });
});
