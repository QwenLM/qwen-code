/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { reloadEnvCommand } from './reload-env-command.js';
import type { CommandContext } from './types.js';
import { reloadEnvironment } from '../../config/settings.js';
import type { EnvReloadResult } from '../../config/environment.js';

vi.mock('../../config/settings.js', () => ({
  reloadEnvironment: vi.fn(),
  getUserSettingsPath: vi.fn(() => '/mock/.qwen/settings.json'),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
}));

vi.mock('strip-json-comments', () => ({
  default: (s: string) => s,
}));

vi.mock('../../i18n/index.js', () => ({
  t: vi.fn((s: string) => s),
}));

describe('reloadEnvCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: [],
      removedKeys: [],
    } as EnvReloadResult);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeContext(
    overrides: Partial<CommandContext> = {},
  ): CommandContext {
    const settings = {
      merged: {},
      reloadScopeFromDisk: vi.fn(),
    };
    const config = {
      getCwd: () => '/mock/cwd',
      getContentGeneratorConfig: () => ({ authType: 'gemini' }),
      refreshAuth: vi.fn(async () => {}),
    } as unknown as Config;
    return {
      services: { settings, config },
      ...overrides,
    } as unknown as CommandContext;
  }

  it('has correct command metadata', () => {
    expect(reloadEnvCommand.name).toBe('reload-env');
    expect(reloadEnvCommand.altNames).toEqual(['reload-key', 'refresh-env']);
  });

  it('reports no changes when nothing changed', async () => {
    const ctx = makeContext();
    const result = await reloadEnvCommand.action?.(ctx, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No environment changes detected.',
    });
  });

  it('reports updated keys and refreshes auth on success', async () => {
    process.env['TEST_API_KEY'] = 'sk-1234567890abcdef';
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: ['TEST_API_KEY'],
      removedKeys: [],
    });

    const ctx = makeContext();
    const result = await reloadEnvCommand.action?.(ctx, '');

    const content = (result as { content: string }).content;
    expect(content).toContain('Updated keys');
    expect(content).toContain('TEST_API_KEY');
    expect(content).toContain('sk-1...cdef');
    expect(content).toContain('New keys are live.');

    const config = ctx.services.config as unknown as {
      refreshAuth: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshAuth).toHaveBeenCalledWith('gemini');

    delete process.env['TEST_API_KEY'];
  });

  it('triggers refreshAuth when keys are removed (not just updated)', async () => {
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: [],
      removedKeys: ['OLD_API_KEY'],
    });

    const ctx = makeContext();
    await reloadEnvCommand.action?.(ctx, '');

    const config = ctx.services.config as unknown as {
      refreshAuth: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshAuth).toHaveBeenCalledWith('gemini');
  });

  it('shows failure message when refreshAuth throws', async () => {
    process.env['TEST_API_KEY'] = 'sk-newkey123456';
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: ['TEST_API_KEY'],
      removedKeys: [],
    });

    const ctx = makeContext();
    const config = ctx.services.config as unknown as {
      refreshAuth: ReturnType<typeof vi.fn>;
    };
    config.refreshAuth.mockRejectedValueOnce(new Error('network error'));

    const result = await reloadEnvCommand.action?.(ctx, '');
    const content = (result as { content: string }).content;

    expect(content).toContain('API client refresh failed');
    expect(content).toContain('Restart the CLI');

    delete process.env['TEST_API_KEY'];
  });

  it('shows not-attempted message when no authType configured', async () => {
    process.env['TEST_API_KEY'] = 'sk-newkey123456';
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: ['TEST_API_KEY'],
      removedKeys: [],
    });

    const ctx = makeContext({
      services: {
        settings: { merged: {}, reloadScopeFromDisk: vi.fn() },
        config: {
          getCwd: () => '/mock/cwd',
          getContentGeneratorConfig: () => ({ authType: undefined }),
          refreshAuth: vi.fn(async () => {}),
        } as unknown as Config,
      },
    });

    const result = await reloadEnvCommand.action?.(ctx, '');
    const content = (result as { content: string }).content;

    expect(content).toContain('will take effect on the next request');

    delete process.env['TEST_API_KEY'];
  });

  it('masks short key values as ***', async () => {
    process.env['SHORT_KEY'] = 'abc';
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: ['SHORT_KEY'],
      removedKeys: [],
    });

    const ctx = makeContext();
    const result = await reloadEnvCommand.action?.(ctx, '');
    const content = (result as { content: string }).content;

    expect(content).toContain('SHORT_KEY → ***');

    delete process.env['SHORT_KEY'];
  });

  it('lists removed keys', async () => {
    vi.mocked(reloadEnvironment).mockReturnValue({
      updatedKeys: [],
      removedKeys: ['OLD_KEY_1', 'OLD_KEY_2'],
    });

    const ctx = makeContext();
    const result = await reloadEnvCommand.action?.(ctx, '');
    const content = (result as { content: string }).content;

    expect(content).toContain('Removed keys');
    expect(content).toContain('OLD_KEY_1, OLD_KEY_2');
  });

  it('warns when settings file has invalid JSON', async () => {
    const fs = (await import('fs')).default as unknown as {
      existsSync: ReturnType<typeof vi.fn>;
      readFileSync: ReturnType<typeof vi.fn>;
    };
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('{ invalid json }');

    const ctx = makeContext();
    const result = await reloadEnvCommand.action?.(ctx, '');
    const content = (result as { content: string }).content;

    expect(content).toContain('Warning');
    expect(content).toContain('JSON syntax errors');
  });
});
