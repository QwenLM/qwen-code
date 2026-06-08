/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uninstallCommand, handleUninstall } from './uninstall.js';
import yargs from 'yargs';

const mockUninstallExtension = vi.hoisted(() => vi.fn());
const mockRefreshCache = vi.hoisted(() => vi.fn());
const mockIsWorkspaceTrusted = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  ExtensionManager: vi.fn().mockImplementation(() => ({
    uninstallExtension: mockUninstallExtension,
    refreshCache: mockRefreshCache,
  })),
  ExtensionScope: { User: 'user', Project: 'project' },
}));

vi.mock('./consent.js', () => ({
  requestConsentNonInteractive: vi.fn(),
  requestConsentOrFail: vi.fn(),
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: mockIsWorkspaceTrusted,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

describe('extensions uninstall command', () => {
  it('should fail if no source is provided', () => {
    const validationParser = yargs([])
      .command(uninstallCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('uninstall')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });
});

describe('handleUninstall', () => {
  beforeEach(() => {
    mockRefreshCache.mockResolvedValue(undefined);
    mockUninstallExtension.mockResolvedValue(undefined);
    mockLoadSettings.mockReturnValue({ merged: {} });
    mockIsWorkspaceTrusted.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards an explicit --scope to uninstallExtension', async () => {
    await handleUninstall({ name: 'my-ext', scope: 'project' });

    expect(mockUninstallExtension).toHaveBeenCalledWith(
      'my-ext',
      false,
      process.cwd(),
      'project',
    );
  });

  it('passes undefined scope when no --scope flag is given', async () => {
    await handleUninstall({ name: 'my-ext' });

    expect(mockUninstallExtension).toHaveBeenCalledWith(
      'my-ext',
      false,
      process.cwd(),
      undefined,
    );
  });
});
