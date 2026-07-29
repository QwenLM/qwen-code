/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleInstall, installCommand } from './install.js';
import yargs from 'yargs';

const mockInstallExtension = vi.hoisted(() => vi.fn());
const mockRefreshCache = vi.hoisted(() => vi.fn());
const mockSetExtensionScope = vi.hoisted(() => vi.fn());
const mockParseInstallSource = vi.hoisted(() => vi.fn());
const mockRequestConsentNonInteractive = vi.hoisted(() => vi.fn());
const mockRequestConsentOrFail = vi.hoisted(() => vi.fn());
const mockIsWorkspaceTrusted = vi.hoisted(() => vi.fn());
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  ExtensionManager: vi.fn().mockImplementation(() => ({
    installExtension: mockInstallExtension,
    refreshCache: mockRefreshCache,
    setExtensionScope: mockSetExtensionScope,
  })),
  parseInstallSource: mockParseInstallSource,
  isExtensionCommittedWithWarningsError: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: string; committed?: boolean }).code ===
      'extension_committed_with_warnings' &&
    (error as Error & { committed?: boolean }).committed === true,
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
  SettingScope: {
    User: 'User',
    Workspace: 'Workspace',
    System: 'System',
    SystemDefaults: 'SystemDefaults',
  },
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
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
  beforeEach(() => {
    mockRefreshCache.mockResolvedValue(undefined);
    mockLoadSettings.mockReturnValue({ merged: {} });
    mockIsWorkspaceTrusted.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should install an extension from a http source', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'http',
      url: 'http://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'http-extension' });

    await handleInstall({
      source: 'http://google.com',
    });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "http-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('should install an extension from a https source', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'https',
      url: 'https://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'https-extension' });

    await handleInstall({
      source: 'https://google.com',
    });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "https-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('should install an extension from a git source', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'git-extension' });

    await handleInstall({
      source: 'git@some-url',
    });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "git-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('throws an error from an unknown source', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockRejectedValue(
      new Error('Install source not found.'),
    );
    await handleInstall({
      source: 'test://google.com',
    });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Install source not found.',
    );
    expect(processSpy).toHaveBeenCalledWith(1);

    processSpy.mockRestore();
  });

  it('should install an extension from a sso source', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'sso',
      url: 'sso://google.com',
    });
    mockInstallExtension.mockResolvedValue({ name: 'sso-extension' });

    await handleInstall({
      source: 'sso://google.com',
    });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "sso-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('should install an extension from a local path', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'local',
      path: '/some/path',
    });
    mockInstallExtension.mockResolvedValue({ name: 'local-extension' });

    await handleInstall({
      source: '/some/path',
    });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "local-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('should install an extension from an archive URL', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'archive-url',
      source: 'https://example.com/extension.zip',
    });
    mockInstallExtension.mockResolvedValue({ name: 'archive-extension' });

    await handleInstall({
      source: 'https://example.com/extension.zip',
      autoUpdate: true,
    });

    expect(mockInstallExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'https://example.com/extension.zip',
        type: 'archive-url',
        autoUpdate: true,
      }),
      expect.any(Function),
      undefined,
      expect.any(String),
      undefined,
      { scope: 'user' },
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "archive-extension" installed successfully and enabled.',
    );

    processSpy.mockRestore();
  });

  it('should reject --ref for archive URL extensions', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'archive-url',
      source: 'https://example.com/extension.zip',
    });

    await handleInstall({
      source: 'https://example.com/extension.zip',
      ref: 'v1.0.0',
    });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '--ref is not applicable for archive URL extensions.',
    );
    expect(mockInstallExtension).not.toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalledWith(1);

    processSpy.mockRestore();
  });

  it('should throw an error if install extension fails', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockRejectedValue(
      new Error('Install extension failed'),
    );

    await handleInstall({ source: 'git@some-url' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Install extension failed',
    );
    expect(processSpy).toHaveBeenCalledWith(1);

    processSpy.mockRestore();
  });

  it('reports a committed install warning without failing', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockRejectedValue(
      Object.assign(
        new Error('Extension committed but could not be reloaded.'),
        {
          code: 'extension_committed_with_warnings',
          committed: true,
          identity: { id: 'extension-id', name: 'scoped-extension' },
          warnings: [],
        },
      ),
    );

    await handleInstall({ source: 'git@some-url', scope: 'project' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Warning: Extension committed but could not be reloaded.',
    );
    expect(mockSetExtensionScope).toHaveBeenCalledWith(
      'scoped-extension',
      'project',
    );
    expect(processSpy).not.toHaveBeenCalled();

    processSpy.mockRestore();
  });

  it('commits project-scope activation with the install', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'scoped-extension' });

    await handleInstall({ source: 'git@some-url', scope: 'project' });

    expect(mockSetExtensionScope).toHaveBeenCalledWith(
      'scoped-extension',
      'project',
    );
    expect(mockInstallExtension).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      undefined,
      expect.any(String),
      undefined,
      {
        scope: 'workspace',
        workspacePath: expect.any(String),
      },
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "scoped-extension" installed successfully and enabled for the current workspace.',
    );
  });

  it('keeps a committed install successful when saving scope preference fails', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'scoped-extension' });
    mockSetExtensionScope.mockImplementationOnce(() => {
      throw new Error('preference denied');
    });

    await handleInstall({ source: 'git@some-url', scope: 'project' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "scoped-extension" installed successfully and enabled for the current workspace.',
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Warning: Extension installed, but failed to save scope preference: preference denied',
    );
  });

  it('reports a failed project-scope install without a follow-up scope mutation', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockRejectedValue(new Error('atomic install failed'));

    await handleInstall({ source: 'git@some-url', scope: 'project' });

    expect(mockSetExtensionScope).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith('atomic install failed');
    expect(processSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
  });

  it('should accept workspace as an alias of project scope', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'scoped-extension' });

    await handleInstall({ source: 'git@some-url', scope: 'workspace' });

    expect(mockSetExtensionScope).toHaveBeenCalledWith(
      'scoped-extension',
      'project',
    );
    expect(mockInstallExtension).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      undefined,
      expect.any(String),
      undefined,
      expect.objectContaining({ scope: 'workspace' }),
    );
  });

  it('should record user scope without re-scoping enablement', async () => {
    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      url: 'git@some-url',
    });
    mockInstallExtension.mockResolvedValue({ name: 'user-extension' });

    await handleInstall({ source: 'git@some-url', scope: 'user' });

    expect(mockSetExtensionScope).toHaveBeenCalledWith(
      'user-extension',
      'user',
    );
    expect(mockInstallExtension).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Function),
      undefined,
      expect.any(String),
      undefined,
      { scope: 'user' },
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Extension "user-extension" installed successfully and enabled.',
    );
  });

  it('should print archive validation errors from the extension manager', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockParseInstallSource.mockResolvedValue({
      type: 'git',
      source: 'owner/repo',
    });
    mockInstallExtension.mockRejectedValue(
      new Error(
        'Extension archive is missing a supported extension manifest. Expected qwen-extension.json, gemini-extension.json, .claude-plugin/marketplace.json, or .claude-plugin/plugin.json at the archive root, or inside a single top-level extension directory.',
      ),
    );

    await handleInstall({ source: 'owner/repo' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Extension archive is missing a supported extension manifest. Expected qwen-extension.json, gemini-extension.json, .claude-plugin/marketplace.json, or .claude-plugin/plugin.json at the archive root, or inside a single top-level extension directory.',
    );
    expect(processSpy).toHaveBeenCalledWith(1);

    processSpy.mockRestore();
  });
});
