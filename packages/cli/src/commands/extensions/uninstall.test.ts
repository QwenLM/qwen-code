/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { handleUninstall, uninstallCommand } from './uninstall.js';
import yargs from 'yargs';

const mockRefreshCache = vi.hoisted(() => vi.fn());
const mockUninstallExtension = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ warnings: [] }),
);
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    ExtensionManager: vi.fn(() => ({
      refreshCache: mockRefreshCache,
      uninstallExtension: mockUninstallExtension,
    })),
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => ({ isTrusted: true })),
}));

describe('extensions uninstall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshCache.mockResolvedValue(undefined);
    mockUninstallExtension.mockResolvedValue({ warnings: [] });
    mockLoadSettings.mockReturnValue({ merged: {} });
  });

  it('should fail if no source is provided', () => {
    const validationParser = yargs([])
      .command(uninstallCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('uninstall')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('prints committed uninstall warnings', async () => {
    mockUninstallExtension.mockResolvedValueOnce({
      warnings: [
        {
          code: 'extension_preferences_cleanup_failed',
          error: 'cleanup failed',
        },
      ],
    });

    await handleUninstall({ name: 'test-extension' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "test-extension" successfully uninstalled.',
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'extension_preferences_cleanup_failed: cleanup failed',
    );
  });

  it('forwards the resolved telemetry opt-out and proxy to the ExtensionManager', async () => {
    const { ExtensionManager } = await import('@qwen-code/qwen-code-core');
    mockLoadSettings.mockReturnValue({
      merged: {
        privacy: { usageStatisticsEnabled: false },
        proxy: 'http://settings-proxy:8080',
      },
    });
    // The real resolvers consult the ambient env; pin it out of the
    // assertion so the test decides the outcome, not the runner's env.
    const envKeys = [
      'QWEN_USAGE_STATISTICS_ENABLED',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ];
    const saved = envKeys.map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    for (const key of envKeys) delete process.env[key];
    try {
      await handleUninstall({ name: 'test-extension' });

      expect(ExtensionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          usageStatisticsEnabled: false,
          proxy: 'http://settings-proxy:8080',
        }),
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('resolves consent from the env term and the proxy from the env fallback at this call site', async () => {
    const { ExtensionManager } = await import('@qwen-code/qwen-code-core');
    // Settings alone would opt out and declare no proxy, so only the env terms
    // can produce the expected values: replacing the two resolver calls in
    // `uninstall.ts` with raw `settings.privacy?.usageStatisticsEnabled ??
    // true` / `settings.proxy` reads reds this case. The winners are opposite
    // on purpose — consent is env-then-settings, proxy settings-then-env.
    mockLoadSettings.mockReturnValue({
      merged: { privacy: { usageStatisticsEnabled: false } },
    });
    const envKeys = [
      'QWEN_USAGE_STATISTICS_ENABLED',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ];
    const saved = envKeys.map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    for (const key of envKeys) delete process.env[key];
    process.env['QWEN_USAGE_STATISTICS_ENABLED'] = 'true';
    process.env['HTTPS_PROXY'] = 'http://env-proxy:3128';
    try {
      await handleUninstall({ name: 'test-extension' });

      expect(ExtensionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          usageStatisticsEnabled: true,
          proxy: 'http://env-proxy:3128',
        }),
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
