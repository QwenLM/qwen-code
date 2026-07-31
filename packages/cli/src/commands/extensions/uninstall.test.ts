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
  loadSettings: vi.fn(() => ({ merged: {} })),
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn(() => ({ isTrusted: true })),
}));

describe('extensions uninstall command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshCache.mockResolvedValue(undefined);
    mockUninstallExtension.mockResolvedValue({ warnings: [] });
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
});
