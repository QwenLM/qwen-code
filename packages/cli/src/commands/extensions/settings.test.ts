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
  type MockInstance,
} from 'vitest';
import { settingsCommand } from './settings.js';
import yargs from 'yargs';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockGetScopedEnvContents = vi.hoisted(() => vi.fn());
const mockUpdateSetting = vi.hoisted(() => vi.fn());
const mockPromptForSetting = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
  }),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  ExtensionSettingScope: {
    USER: 'user',
    WORKSPACE: 'workspace',
  },
  getScopedEnvContents: mockGetScopedEnvContents,
  promptForSetting: mockPromptForSetting,
  updateSetting: mockUpdateSetting,
}));

describe('extensions settings command', () => {
  it('should fail if no subcommand is provided', () => {
    const validationParser = yargs([])
      .command(settingsCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('settings')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should register set subcommand', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() => parser.parse('settings set')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should register list subcommand', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() => parser.parse('settings list')).toThrow(
      'Not enough non-option arguments',
    );
  });

  it('should accept set command with name and setting', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() =>
      parser.parse('settings set my-extension API_KEY'),
    ).not.toThrow();
  });

  it('should accept set command with scope option', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() =>
      parser.parse('settings set my-extension API_KEY --scope=workspace'),
    ).not.toThrow();
  });

  it('should fail set command with invalid scope', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() =>
      parser.parse('settings set my-extension API_KEY --scope=invalid'),
    ).toThrow();
  });

  it('should accept list command with name', () => {
    const parser = yargs([]).command(settingsCommand).fail(false).locale('en');
    expect(() => parser.parse('settings list my-extension')).not.toThrow();
  });
});

describe('settings set handler', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it('should return early if extension manager is not available', async () => {
    const { getExtensionManager } = await import('./utils.js');
    vi.mocked(getExtensionManager).mockResolvedValueOnce(null as never);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings set my-extension API_KEY');

    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('should return early if no extensions are loaded', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings set my-extension API_KEY');

    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('should log error if extension is not found', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      { name: 'other-extension', id: 'other-id', config: {} },
    ]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings set my-extension API_KEY');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "my-extension" not found.',
    );
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it('should call updateSetting with correct arguments for user scope', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension', settings: [] },
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings set my-extension API_KEY');

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      mockExtension.config,
      mockExtension.id,
      'API_KEY',
      mockPromptForSetting,
      'user',
    );
  });

  it('should call updateSetting with workspace scope when specified', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension', settings: [] },
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync(
      'settings set my-extension API_KEY --scope=workspace',
    );

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      mockExtension.config,
      mockExtension.id,
      'API_KEY',
      mockPromptForSetting,
      'workspace',
    );
  });
});

describe('settings list handler', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  it('should return early if extension manager is not available', async () => {
    const { getExtensionManager } = await import('./utils.js');
    vi.mocked(getExtensionManager).mockResolvedValueOnce(null as never);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(mockGetScopedEnvContents).not.toHaveBeenCalled();
  });

  it('should return early if no extensions are loaded', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(mockGetScopedEnvContents).not.toHaveBeenCalled();
  });

  it('should log error if extension is not found', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([
      { name: 'other-extension', id: 'other-id', config: {} },
    ]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "my-extension" not found.',
    );
  });

  it('should log message if extension has no settings', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension' },
      settings: [],
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "my-extension" has no settings to configure.',
    );
  });

  it('should list settings with their values', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension' },
      settings: [
        {
          name: 'API Key',
          envVar: 'API_KEY',
          description: 'Your API key',
          sensitive: false,
        },
        {
          name: 'Secret Token',
          envVar: 'SECRET_TOKEN',
          description: 'A secret token',
          sensitive: true,
        },
      ],
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
    mockGetScopedEnvContents
      .mockResolvedValueOnce({ API_KEY: 'my-api-key' }) // user scope
      .mockResolvedValueOnce({}); // workspace scope

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(consoleLogSpy).toHaveBeenCalledWith('Settings for "my-extension":');
    expect(consoleLogSpy).toHaveBeenCalledWith('\n- API Key (API_KEY)');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Description: Your API key');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Value: my-api-key (user)');
  });

  it('should show workspace scope for workspace-scoped settings', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension' },
      settings: [
        {
          name: 'API Key',
          envVar: 'API_KEY',
          description: 'Your API key',
          sensitive: false,
        },
      ],
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
    mockGetScopedEnvContents
      .mockResolvedValueOnce({ API_KEY: 'user-value' }) // user scope
      .mockResolvedValueOnce({ API_KEY: 'workspace-value' }); // workspace scope

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    // Workspace should override user, and show (workspace) scope
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Value: workspace-value (workspace)',
    );
  });

  it('should show [not set] for undefined settings', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension' },
      settings: [
        {
          name: 'API Key',
          envVar: 'API_KEY',
          description: 'Your API key',
          sensitive: false,
        },
      ],
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
    mockGetScopedEnvContents
      .mockResolvedValueOnce({}) // user scope
      .mockResolvedValueOnce({}); // workspace scope

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(consoleLogSpy).toHaveBeenCalledWith('  Value: [not set]');
  });

  it('should show [value stored in keychain] for sensitive settings', async () => {
    const mockExtension = {
      name: 'my-extension',
      id: 'ext-id-123',
      config: { name: 'my-extension' },
      settings: [
        {
          name: 'Secret Token',
          envVar: 'SECRET_TOKEN',
          description: 'A secret token',
          sensitive: true,
        },
      ],
    };
    mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
    mockGetScopedEnvContents
      .mockResolvedValueOnce({ SECRET_TOKEN: 'secret-value' }) // user scope
      .mockResolvedValueOnce({}); // workspace scope

    const parser = yargs([]).command(settingsCommand);
    await parser.parseAsync('settings list my-extension');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Value: [value stored in keychain] (user)',
    );
  });
});
