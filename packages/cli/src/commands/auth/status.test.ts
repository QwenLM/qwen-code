/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showAuthStatus } from './handler.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import { CODING_PLAN_ENV_KEY } from '../../constants/codingPlan.js';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

import { loadSettings } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

describe('showAuthStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  const createMockSettings = (
    merged: Record<string, unknown>,
  ): LoadedSettings =>
    ({
      merged,
      system: { settings: {}, path: '/system.json' },
      systemDefaults: { settings: {}, path: '/system-defaults.json' },
      user: { settings: {}, path: '/user.json' },
      workspace: { settings: {}, path: '/workspace.json' },
      forScope: vi.fn(),
      setValue: vi.fn(),
      isTrusted: true,
    }) as unknown as LoadedSettings;

  it('should show message when no authentication is configured', async () => {
    vi.mocked(loadSettings).mockReturnValue(createMockSettings({}));

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('No authentication method configured'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth qwen-oauth'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth code-plan'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show Qwen OAuth status when configured', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.QWEN_OAUTH,
          },
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Qwen OAuth'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Free tier'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('1,000 requests/day'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show Coding Plan status when configured with API key', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'china',
          version: 'abc123def456',
        },
        model: {
          name: 'qwen3.5-plus',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Alibaba Cloud Coding Plan'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('API key configured'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show Coding Plan as incomplete when API key is missing', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'global',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('API key not found'),
    );
  });

  it('should show Coding Plan region for china', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'china',
        },
        model: {
          name: 'qwen3.5-plus',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('中国 (China)'),
    );
  });

  it('should show Coding Plan region for global', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'global',
        },
        model: {
          name: 'qwen3-coder-plus',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Global'),
    );
  });

  it('should show current model name', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'china',
        },
        model: {
          name: 'qwen3.5-plus',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen3.5-plus'),
    );
  });

  it('should show config version (truncated)', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        codingPlan: {
          region: 'china',
          version: 'abc123def456789',
        },
        model: {
          name: 'qwen3.5-plus',
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('abc123de...'),
    );
  });

  it('should handle errors and exit with code 1', async () => {
    const error = new Error('Settings load failed');
    vi.mocked(loadSettings).mockImplementation(() => {
      throw error;
    });

    await showAuthStatus();

    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to check authentication status'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
