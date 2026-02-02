/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { handleInstall, installCommand } from './install.js';
import yargs from 'yargs';

const mockInstallExtension = vi.hoisted(() => vi.fn());
const mockRefreshCache = vi.hoisted(() => vi.fn());
const mockParseInstallSource = vi.hoisted(() => vi.fn());
const mockRequestConsentNonInteractive = vi.hoisted(() => vi.fn());
const mockRequestConsentOrFail = vi.hoisted(() => vi.fn());
const mockIsWorkspaceTrusted = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  ExtensionManager: vi.fn().mockImplementation(() => ({
    installExtension: mockInstallExtension,
    refreshCache: mockRefreshCache,
  })),
  parseInstallSource: mockParseInstallSource,
}));

vi.mock('./consent.js', () => ({
  requestConsentNonInteractive: mockRequestConsentNonInteractive,
  requestConsentOrFail: mockRequestConsentOrFail,
  requestChoicePluginNonInteractive: vi.fn(),
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

describe('extensions install command', () => {
  it('should fail if no source is provided', () => {
    const validationParser = yargs([])
      .locale('en')
      .command(installCommand)
      .fail(false);
    expect(() => validationParser.parse('install')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });
});

describe('handleInstall', () => {
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let processSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log');
    consoleErrorSpy = vi.spyOn(console, 'error');
    processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockRefreshCache.mockResolvedValue(undefined);
    mockLoadSettings.mockReturnValue({ merged: {} });
    mockIsWorkspaceTrusted.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should install an extension from a http source', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'http',
      url: 'http://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'http-extension' });

    await handleInstall({
      source: 'http://google.com',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "http-extension" installed successfully and enabled.',
    );
  });

  it('should install an extension from a https source', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'https',
      url: 'https://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'https-extension' });

    await handleInstall({
      source: 'https://google.com',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "https-extension" installed successfully and enabled.',
    );
  });

  it('should install an extension from a git source', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'git-extension' });

    await handleInstall({
      source: 'git@some-url',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "git-extension" installed successfully and enabled.',
    );
  });

  it('throws an error from an unknown source', async () => {
    mockParseInstallSource.mockRejectedValue(
      new Error('Install source not found.'),
    );
    await handleInstall({
      source: 'test://google.com',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Install source not found.');
    expect(processSpy).toHaveBeenCalledWith(1);
  });

  it('should install an extension from a sso source', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'sso',
      url: 'sso://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'sso-extension' });

    await handleInstall({
      source: 'sso://google.com',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "sso-extension" installed successfully and enabled.',
    );
  });

  it('should install an extension from a local path', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'local',
      path: '/some/path',
    });
    mockInstallExtension.mockResolvedValue({ name: 'local-extension' });

    await handleInstall({
      source: '/some/path',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "local-extension" installed successfully and enabled.',
    );
  });

  it('should throw an error if install extension fails', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockRejectedValue(
      new Error('Install extension failed'),
    );

    await handleInstall({ source: 'git@some-url' });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Install extension failed');
    expect(processSpy).toHaveBeenCalledWith(1);
  });
});
