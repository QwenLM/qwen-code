import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getEnvContents,
  maybePromptForSettings,
  promptForSetting,
  type ExtensionSetting,
  updateSetting,
  ExtensionSettingScope,
  getScopedEnvContents,
} from './extensionSettings.js';
import type { ExtensionConfig } from './extensionManager.js';
import { ExtensionStorage } from './storage.js';
import prompts from 'prompts';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import { KeychainTokenStorage } from '../mcp/token-storage/keychain-token-storage.js';
import { EXTENSION_SETTINGS_FILENAME } from './variables.js';

vi.mock('prompts');
vi.mock('os', async (importOriginal) => {
  const mockedOs = await importOriginal<typeof os>();
  return {
    ...mockedOs,
    homedir: vi.fn(),
  };
});

vi.mock(
  '../mcp/token-storage/keychain-token-storage.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../mcp/token-storage/keychain-token-storage.js')
      >();
    return {
      ...actual,
      KeychainTokenStorage: vi.fn(),
    };
  },
);

describe('extensionSettings', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let extensionDir: string;
  let mockKeychainData: Record<string, Record<string, string>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKeychainData = {};
    vi.mocked(KeychainTokenStorage).mockImplementation(
      (serviceName: string) => {
        if (!mockKeychainData[serviceName]) {
          mockKeychainData[serviceName] = {};
        }
        const keychainData = mockKeychainData[serviceName];
        return {
          getSecret: vi
            .fn()
            .mockImplementation(
              async (key: string) => keychainData[key] || null,
            ),
          setSecret: vi
            .fn()
            .mockImplementation(async (key: string, value: string) => {
              keychainData[key] = value;
            }),
          deleteSecret: vi.fn().mockImplementation(async (key: string) => {
            delete keychainData[key];
          }),
          listSecrets: vi
            .fn()
            .mockImplementation(async () => Object.keys(keychainData)),
          isAvailable: vi.fn().mockResolvedValue(true),
        } as unknown as KeychainTokenStorage;
      },
    );
    tempHomeDir = os.tmpdir() + path.sep + `gemini-cli-test-home-${Date.now()}`;
    tempWorkspaceDir = path.join(
      os.tmpdir(),
      `gemini-cli-test-workspace-${Date.now()}`,
    );
    extensionDir = path.join(tempHomeDir, '.gemini', 'extensions', 'test-ext');
    // Spy and mock the method, but also create the directory so we can write to it.
    vi.spyOn(ExtensionStorage.prototype, 'getExtensionDir').mockReturnValue(
      extensionDir,
    );
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.mkdirSync(tempWorkspaceDir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(tempHomeDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkspaceDir);
    vi.mocked(prompts).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('maybePromptForSettings', () => {
    const mockRequestSetting = vi.fn(
      async (setting: ExtensionSetting) => `mock-${setting.envVar}`,
    );

    beforeEach(() => {
      mockRequestSetting.mockClear();
    });

    it('should do nothing if settings are undefined', async () => {
      const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
      await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        undefined,
        undefined,
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('should do nothing if settings are empty', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [],
      };
      await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        undefined,
        undefined,
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('defers adding sensitive settings until commit', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      const keychain = new KeychainTokenStorage(
        'Qwen Code Extensions test-ext 12345',
      );

      const commit = await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        undefined,
        undefined,
        path.join(tempWorkspaceDir, 'staged.env'),
        true,
      );

      expect(await keychain.getSecret('API_KEY')).toBeNull();
      expect(
        await getScopedEnvContents(config, '12345', ExtensionSettingScope.USER),
      ).toEqual({});
      fs.renameSync(
        path.join(tempWorkspaceDir, '.qwen-extension-settings.json'),
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );
      expect(
        await getScopedEnvContents(config, '12345', ExtensionSettingScope.USER),
      ).toEqual({ API_KEY: 'mock-API_KEY' });
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBe('mock-API_KEY');
      await keychain.setSecret('API_KEY', 'rotated');
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBe('rotated');
    });

    it('isolates concurrent prepared sensitive settings snapshots', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      const firstDir = path.join(tempWorkspaceDir, 'first');
      const secondDir = path.join(tempWorkspaceDir, 'second');
      fs.mkdirSync(firstDir);
      fs.mkdirSync(secondDir);

      await maybePromptForSettings(
        config,
        '12345',
        async () => 'first-secret',
        undefined,
        undefined,
        path.join(firstDir, '.env'),
        true,
      );
      await maybePromptForSettings(
        config,
        '12345',
        async () => 'second-secret',
        undefined,
        undefined,
        path.join(secondDir, '.env'),
        true,
      );

      const firstSelector = JSON.parse(
        fs.readFileSync(
          path.join(firstDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      const secondSelector = JSON.parse(
        fs.readFileSync(
          path.join(secondDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      expect(firstSelector.bundleKey).not.toBe(secondSelector.bundleKey);
      const storage = mockKeychainData['Qwen Code Extensions test-ext 12345'];
      expect(JSON.parse(storage![firstSelector.bundleKey]!)).toEqual({
        API_KEY: 'first-secret',
      });
      expect(JSON.parse(storage![secondSelector.bundleKey]!)).toEqual({
        API_KEY: 'second-secret',
      });
    });

    it('discards an uncommitted sensitive settings snapshot', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      const stagingDir = path.join(tempWorkspaceDir, 'discard');
      fs.mkdirSync(stagingDir);
      const prepared = await maybePromptForSettings(
        config,
        '12345',
        async () => 'temporary-secret',
        undefined,
        undefined,
        path.join(stagingDir, '.env'),
        true,
      );
      const selector = JSON.parse(
        fs.readFileSync(
          path.join(stagingDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      const storage = mockKeychainData['Qwen Code Extensions test-ext 12345']!;
      expect(storage[selector.bundleKey]).toBeDefined();

      await prepared?.discard();

      expect(storage[selector.bundleKey]).toBeUndefined();
    });

    it('deletes the previous sensitive settings snapshot after commit', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      await maybePromptForSettings(
        config,
        '12345',
        async () => 'old-secret',
        undefined,
        undefined,
        path.join(extensionDir, '.env'),
        true,
      );
      const oldSelector = JSON.parse(
        fs.readFileSync(
          path.join(extensionDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      const storage = mockKeychainData['Qwen Code Extensions test-ext 12345']!;
      storage[`${oldSelector.bundleKey}:override:API_KEY`] = 'old-override';

      const stagingDir = path.join(tempWorkspaceDir, 'replacement');
      fs.mkdirSync(stagingDir);
      const prepared = await maybePromptForSettings(
        { ...config, version: '2.0.0' },
        '12345',
        async () => 'new-secret',
        config,
        { API_KEY: 'old-secret' },
        path.join(stagingDir, '.env'),
        true,
      );
      const newSelector = JSON.parse(
        fs.readFileSync(
          path.join(stagingDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      fs.copyFileSync(
        path.join(stagingDir, '.qwen-extension-settings.json'),
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );

      await prepared?.commit();

      expect(storage[oldSelector.bundleKey]).toBeUndefined();
      expect(
        storage[`${oldSelector.bundleKey}:override:API_KEY`],
      ).toBeUndefined();
      expect(JSON.parse(storage[newSelector.bundleKey]!)).toEqual({
        API_KEY: 'old-secret',
      });
      await expect(
        getScopedEnvContents(config, '12345', ExtensionSettingScope.USER),
      ).resolves.toEqual({ API_KEY: 'old-secret' });
    });

    it('does not fall back to stale legacy secrets when a selected bundle is missing', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      await maybePromptForSettings(
        config,
        '12345',
        async () => 'new-secret',
        undefined,
        undefined,
        path.join(extensionDir, '.env'),
        true,
      );
      const selector = JSON.parse(
        fs.readFileSync(
          path.join(extensionDir, '.qwen-extension-settings.json'),
          'utf8',
        ),
      ) as { bundleKey: string };
      const storage = mockKeychainData['Qwen Code Extensions test-ext 12345']!;
      storage['API_KEY'] = 'stale-secret';
      delete storage[selector.bundleKey];

      await expect(
        getScopedEnvContents(config, '12345', ExtensionSettingScope.USER),
      ).rejects.toThrow('Stored extension settings bundle is missing.');
    });

    it('defers clearing sensitive settings until commit', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY',
            sensitive: true,
          },
        ],
      };
      const keychain = new KeychainTokenStorage(
        'Qwen Code Extensions test-ext 12345',
      );
      await keychain.setSecret('API_KEY', 'old-secret');

      const commit = await maybePromptForSettings(
        { name: 'test-ext', version: '2.0.0', settings: [] },
        '12345',
        mockRequestSetting,
        previousConfig,
        { API_KEY: 'old-secret' },
        path.join(tempWorkspaceDir, 'staged.env'),
        true,
      );

      expect(await keychain.getSecret('API_KEY')).toBe('old-secret');
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBeNull();
    });

    it('rejects invalid environment variable names before prompting', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY\nforged',
          },
        ],
      };

      await expect(
        maybePromptForSettings(
          config,
          '12345',
          mockRequestSetting,
          undefined,
          undefined,
        ),
      ).rejects.toThrow(
        'Extension setting "envVar" must be a valid environment variable name.',
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('rejects invalid previous environment variable names before mutation', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '2.0.0',
        settings: [
          {
            name: 'Current key',
            description: 'Current key',
            envVar: 'API_KEY',
          },
        ],
      };
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'Previous key',
            description: 'Previous key',
            envVar: 'OLD_KEY\nforged',
          },
        ],
      };

      await expect(
        maybePromptForSettings(
          config,
          '12345',
          mockRequestSetting,
          previousConfig,
          { OLD_KEY: 'previous' },
        ),
      ).rejects.toThrow(
        'Extension setting "envVar" must be a valid environment variable name.',
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
      expect(KeychainTokenStorage).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(extensionDir, '.env'))).toBe(false);
    });

    it('should prompt for all settings if there is no previous config', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          { name: 's2', description: 'd2', envVar: 'VAR2' },
        ],
      };
      await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        undefined,
        undefined,
      );
      expect(mockRequestSetting).toHaveBeenCalledTimes(2);
      expect(mockRequestSetting).toHaveBeenCalledWith(config.settings![0]);
      expect(mockRequestSetting).toHaveBeenCalledWith(config.settings![1]);
    });

    it('should only prompt for new settings', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [{ name: 's1', description: 'd1', envVar: 'VAR1' }],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          { name: 's2', description: 'd2', envVar: 'VAR2' },
        ],
      };
      const previousSettings = { VAR1: 'previous-VAR1' };
      const expectedEnvPath = path.join(extensionDir, '.env');
      const symlinkTarget = path.join(tempHomeDir, 'prompt-target.env');
      await fsPromises.writeFile(symlinkTarget, 'ORIGINAL');
      await fsPromises.symlink(symlinkTarget, expectedEnvPath);

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(mockRequestSetting).toHaveBeenCalledTimes(1);
      expect(mockRequestSetting).toHaveBeenCalledWith(newConfig.settings![1]);

      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      const expectedContent = 'VAR1=previous-VAR1\nVAR2=mock-VAR2\n';
      expect(actualContent).toBe(expectedContent);
      expect(fs.lstatSync(expectedEnvPath).isSymbolicLink()).toBe(false);
      expect(await fsPromises.readFile(symlinkTarget, 'utf-8')).toBe(
        'ORIGINAL',
      );
    });

    it('should clear settings if new config has no settings', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          {
            name: 's2',
            description: 'd2',
            envVar: 'SENSITIVE_VAR',
            sensitive: true,
          },
        ],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [],
      };
      const previousSettings = {
        VAR1: 'previous-VAR1',
        SENSITIVE_VAR: 'secret',
      };
      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345`,
      );
      await userKeychain.setSecret('SENSITIVE_VAR', 'secret');
      const envPath = path.join(extensionDir, '.env');
      const symlinkTarget = path.join(tempHomeDir, 'clear-target.env');
      await fsPromises.writeFile(symlinkTarget, 'VAR1=previous-VAR1');
      await fsPromises.symlink(symlinkTarget, envPath);

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(mockRequestSetting).not.toHaveBeenCalled();
      const actualContent = await fsPromises.readFile(envPath, 'utf-8');
      expect(actualContent).toBe('');
      expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(false);
      expect(await fsPromises.readFile(symlinkTarget, 'utf-8')).toBe(
        'VAR1=previous-VAR1',
      );
      expect(await userKeychain.getSecret('SENSITIVE_VAR')).toBeNull();
    });

    it('should remove sensitive settings from keychain', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          {
            name: 's1',
            description: 'd1',
            envVar: 'SENSITIVE_VAR',
            sensitive: true,
          },
        ],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [],
      };
      const previousSettings = { SENSITIVE_VAR: 'secret' };
      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345`,
      );
      await userKeychain.setSecret('SENSITIVE_VAR', 'secret');

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(await userKeychain.getSecret('SENSITIVE_VAR')).toBeNull();
    });

    it('should remove settings that are no longer in the config', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          { name: 's2', description: 'd2', envVar: 'VAR2' },
        ],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [{ name: 's1', description: 'd1', envVar: 'VAR1' }],
      };
      const previousSettings = {
        VAR1: 'previous-VAR1',
        VAR2: 'previous-VAR2',
      };

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(mockRequestSetting).not.toHaveBeenCalled();

      const expectedEnvPath = path.join(extensionDir, '.env');
      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      const expectedContent = 'VAR1=previous-VAR1\n';
      expect(actualContent).toBe(expectedContent);
    });

    it('should reprompt if a setting changes sensitivity', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1', sensitive: false },
        ],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1', sensitive: true },
        ],
      };
      const previousSettings = { VAR1: 'previous-VAR1' };

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(mockRequestSetting).toHaveBeenCalledTimes(1);
      expect(mockRequestSetting).toHaveBeenCalledWith(newConfig.settings![0]);

      // The value should now be in keychain, not the .env file.
      const expectedEnvPath = path.join(extensionDir, '.env');
      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      expect(actualContent).toBe('');
    });

    it('should not prompt if settings are identical', async () => {
      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          { name: 's2', description: 'd2', envVar: 'VAR2' },
        ],
      };
      const newConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's1', description: 'd1', envVar: 'VAR1' },
          { name: 's2', description: 'd2', envVar: 'VAR2' },
        ],
      };
      const previousSettings = {
        VAR1: 'previous-VAR1',
        VAR2: 'previous-VAR2',
      };

      await maybePromptForSettings(
        newConfig,
        '12345',
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );

      expect(mockRequestSetting).not.toHaveBeenCalled();
      const expectedEnvPath = path.join(extensionDir, '.env');
      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      const expectedContent = 'VAR1=previous-VAR1\nVAR2=previous-VAR2\n';
      expect(actualContent).toBe(expectedContent);
    });

    it('should wrap values with spaces in quotes', async () => {
      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [{ name: 's1', description: 'd1', envVar: 'VAR1' }],
      };
      mockRequestSetting.mockResolvedValue('a value with spaces');

      await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        undefined,
        undefined,
      );

      const expectedEnvPath = path.join(extensionDir, '.env');
      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      expect(actualContent).toBe('VAR1="a value with spaces"\n');
    });

    it('should not attempt to clear secrets if keychain is unavailable', async () => {
      // Arrange
      const mockIsAvailable = vi.fn().mockResolvedValue(false);
      const mockListSecrets = vi.fn();

      vi.mocked(KeychainTokenStorage).mockImplementation(
        () =>
          ({
            isAvailable: mockIsAvailable,
            listSecrets: mockListSecrets,
            deleteSecret: vi.fn(),
            getSecret: vi.fn(),
            setSecret: vi.fn(),
          }) as unknown as KeychainTokenStorage,
      );

      const config: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [], // Empty settings triggers clearSettings
      };

      const previousConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [{ name: 's1', description: 'd1', envVar: 'VAR1' }],
      };

      // Act
      await maybePromptForSettings(
        config,
        '12345',
        mockRequestSetting,
        previousConfig,
        undefined,
      );

      // Assert
      expect(mockIsAvailable).toHaveBeenCalled();
      expect(mockListSecrets).not.toHaveBeenCalled();
    });
  });

  describe('promptForSetting', () => {
    it.each([
      {
        description:
          'should use prompts with type "password" for sensitive settings',
        setting: {
          name: 'API Key',
          description: 'Your secret key',
          envVar: 'API_KEY',
          sensitive: true,
        },
        expectedType: 'password',
        promptValue: 'secret-key',
      },
      {
        description:
          'should use prompts with type "text" for non-sensitive settings',
        setting: {
          name: 'Username',
          description: 'Your public username',
          envVar: 'USERNAME',
          sensitive: false,
        },
        expectedType: 'text',
        promptValue: 'test-user',
      },
      {
        description: 'should default to "text" if sensitive is undefined',
        setting: {
          name: 'Username',
          description: 'Your public username',
          envVar: 'USERNAME',
        },
        expectedType: 'text',
        promptValue: 'test-user',
      },
    ])('$description', async ({ setting, expectedType, promptValue }) => {
      vi.mocked(prompts).mockResolvedValue({ value: promptValue });

      const result = await promptForSetting(setting as ExtensionSetting);

      expect(prompts).toHaveBeenCalledWith({
        type: expectedType,
        name: 'value',
        message: `${setting.name}\n${setting.description}`,
      });
      expect(result).toBe(promptValue);
    });

    it('should return undefined if the user cancels the prompt', async () => {
      vi.mocked(prompts).mockResolvedValue({ value: undefined });
      const result = await promptForSetting({
        name: 'Test',
        description: 'Test desc',
        envVar: 'TEST_VAR',
      });
      expect(result).toBeUndefined();
    });
  });

  describe('getScopedEnvContents', () => {
    const config: ExtensionConfig = {
      name: 'test-ext',
      version: '1.0.0',
      settings: [
        { name: 's1', description: 'd1', envVar: 'VAR1' },
        {
          name: 's2',
          description: 'd2',
          envVar: 'SENSITIVE_VAR',
          sensitive: true,
        },
      ],
    };
    const extensionId = '12345';

    it('should return combined contents from user .env and keychain for USER scope', async () => {
      const userEnvPath = path.join(extensionDir, EXTENSION_SETTINGS_FILENAME);
      await fsPromises.writeFile(userEnvPath, 'VAR1=user-value1');
      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345`,
      );
      await userKeychain.setSecret('SENSITIVE_VAR', 'user-secret');

      const contents = await getScopedEnvContents(
        config,
        extensionId,
        ExtensionSettingScope.USER,
      );

      expect(contents).toEqual({
        VAR1: 'user-value1',
        SENSITIVE_VAR: 'user-secret',
      });
    });

    it('should return combined contents from workspace .env and keychain for WORKSPACE scope', async () => {
      const workspaceEnvPath = path.join(
        tempWorkspaceDir,
        EXTENSION_SETTINGS_FILENAME,
      );
      await fsPromises.writeFile(workspaceEnvPath, 'VAR1=workspace-value1');
      const workspaceKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345 ${tempWorkspaceDir}`,
      );
      await workspaceKeychain.setSecret('SENSITIVE_VAR', 'workspace-secret');

      const contents = await getScopedEnvContents(
        config,
        extensionId,
        ExtensionSettingScope.WORKSPACE,
      );

      expect(contents).toEqual({
        VAR1: 'workspace-value1',
        SENSITIVE_VAR: 'workspace-secret',
      });
    });
  });

  describe('getEnvContents (merged)', () => {
    const config: ExtensionConfig = {
      name: 'test-ext',
      version: '1.0.0',
      settings: [
        { name: 's1', description: 'd1', envVar: 'VAR1' },
        { name: 's2', description: 'd2', envVar: 'VAR2', sensitive: true },
        { name: 's3', description: 'd3', envVar: 'VAR3' },
      ],
    };
    const extensionId = '12345';

    it('should merge user and workspace settings, with workspace taking precedence', async () => {
      // User settings
      const userEnvPath = path.join(extensionDir, EXTENSION_SETTINGS_FILENAME);
      await fsPromises.writeFile(
        userEnvPath,
        'VAR1=user-value1\nVAR3=user-value3',
      );
      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext ${extensionId}`,
      );
      await userKeychain.setSecret('VAR2', 'user-secret2');

      // Workspace settings
      const workspaceEnvPath = path.join(
        tempWorkspaceDir,
        EXTENSION_SETTINGS_FILENAME,
      );
      await fsPromises.writeFile(workspaceEnvPath, 'VAR1=workspace-value1');
      const workspaceKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext ${extensionId} ${tempWorkspaceDir}`,
      );
      await workspaceKeychain.setSecret('VAR2', 'workspace-secret2');

      const contents = await getEnvContents(config, extensionId);

      expect(contents).toEqual({
        VAR1: 'workspace-value1',
        VAR2: 'workspace-secret2',
        VAR3: 'user-value3',
      });
    });
  });

  describe('updateSetting', () => {
    const config: ExtensionConfig = {
      name: 'test-ext',
      version: '1.0.0',
      settings: [
        { name: 's1', description: 'd1', envVar: 'VAR1' },
        { name: 's2', description: 'd2', envVar: 'VAR2', sensitive: true },
      ],
    };
    const mockRequestSetting = vi.fn();

    beforeEach(async () => {
      const userEnvPath = path.join(extensionDir, '.env');
      await fsPromises.writeFile(userEnvPath, 'VAR1=value1\n');
      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345`,
      );
      await userKeychain.setSecret('VAR2', 'value2');
      mockRequestSetting.mockClear();
    });

    it('should update a non-sensitive setting in USER scope', async () => {
      mockRequestSetting.mockResolvedValue('new-value1');
      const expectedEnvPath = path.join(extensionDir, '.env');
      const symlinkTarget = path.join(tempHomeDir, 'update-target.env');
      await fsPromises.rm(expectedEnvPath);
      await fsPromises.writeFile(symlinkTarget, 'VAR1=value1\n');
      await fsPromises.symlink(symlinkTarget, expectedEnvPath);

      await updateSetting(
        config,
        '12345',
        'VAR1',
        mockRequestSetting,
        ExtensionSettingScope.USER,
      );

      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      expect(actualContent).toContain('VAR1=new-value1');
      expect(fs.lstatSync(expectedEnvPath).isSymbolicLink()).toBe(false);
      expect(await fsPromises.readFile(symlinkTarget, 'utf-8')).toBe(
        'VAR1=value1\n',
      );
    });

    it('should update a non-sensitive setting in WORKSPACE scope', async () => {
      mockRequestSetting.mockResolvedValue('new-workspace-value');

      await updateSetting(
        config,
        '12345',
        'VAR1',
        mockRequestSetting,
        ExtensionSettingScope.WORKSPACE,
      );

      const expectedEnvPath = path.join(tempWorkspaceDir, '.env');
      const actualContent = await fsPromises.readFile(expectedEnvPath, 'utf-8');
      expect(actualContent).toContain('VAR1=new-workspace-value');
    });

    it('should update a sensitive setting in USER scope', async () => {
      mockRequestSetting.mockResolvedValue('new-value2');

      await updateSetting(
        config,
        '12345',
        'VAR2',
        mockRequestSetting,
        ExtensionSettingScope.USER,
      );

      const userKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345`,
      );
      expect(await userKeychain.getSecret('VAR2')).toBe('new-value2');
    });

    it('synchronizes legacy sensitive settings through the current backend', async () => {
      const previousStorageOverride =
        process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
      process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = 'true';
      try {
        await maybePromptForSettings(
          config,
          '12345',
          async () => 'initial-value2',
          undefined,
          undefined,
          path.join(extensionDir, '.env'),
        );
      } finally {
        if (previousStorageOverride === undefined) {
          delete process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
        } else {
          process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = previousStorageOverride;
        }
      }

      await updateSetting(
        config,
        '12345',
        'VAR2',
        async () => 'new-value2',
        ExtensionSettingScope.USER,
      );

      await fsPromises.rm(
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );
      await expect(
        getScopedEnvContents(config, '12345', ExtensionSettingScope.USER),
      ).resolves.toEqual({
        VAR1: 'initial-value2',
        VAR2: 'new-value2',
      });
    });

    it('should update a sensitive setting in WORKSPACE scope', async () => {
      mockRequestSetting.mockResolvedValue('new-workspace-secret');

      await updateSetting(
        config,
        '12345',
        'VAR2',
        mockRequestSetting,
        ExtensionSettingScope.WORKSPACE,
      );

      const workspaceKeychain = new KeychainTokenStorage(
        `Qwen Code Extensions test-ext 12345 ${tempWorkspaceDir}`,
      );
      expect(await workspaceKeychain.getSecret('VAR2')).toBe(
        'new-workspace-secret',
      );
    });

    it('surfaces authoritative sensitive setting write failures', async () => {
      mockRequestSetting.mockResolvedValue('new-value2');
      vi.mocked(KeychainTokenStorage).mockImplementationOnce(
        () =>
          ({
            isAvailable: vi.fn().mockResolvedValue(true),
            setSecret: vi.fn().mockRejectedValue(new Error('write failed')),
          }) as unknown as KeychainTokenStorage,
      );

      await expect(
        updateSetting(
          config,
          '12345',
          'VAR2',
          mockRequestSetting,
          ExtensionSettingScope.USER,
        ),
      ).rejects.toThrow('write failed');
    });

    it('does not lose concurrent user-scope sensitive setting updates', async () => {
      const sensitiveConfig: ExtensionConfig = {
        name: 'test-ext',
        version: '1.0.0',
        settings: [
          { name: 's2', description: 'd2', envVar: 'VAR2', sensitive: true },
          { name: 's3', description: 'd3', envVar: 'VAR3', sensitive: true },
        ],
      };
      await maybePromptForSettings(
        sensitiveConfig,
        '12345',
        async (setting) => `initial-${setting.envVar}`,
        undefined,
        undefined,
        path.join(extensionDir, '.env'),
        true,
      );

      await Promise.all([
        updateSetting(
          sensitiveConfig,
          '12345',
          'VAR2',
          async () => 'updated-VAR2',
          ExtensionSettingScope.USER,
        ),
        updateSetting(
          sensitiveConfig,
          '12345',
          'VAR3',
          async () => 'updated-VAR3',
          ExtensionSettingScope.USER,
        ),
      ]);

      await expect(
        getScopedEnvContents(
          sensitiveConfig,
          '12345',
          ExtensionSettingScope.USER,
        ),
      ).resolves.toEqual({
        VAR2: 'updated-VAR2',
        VAR3: 'updated-VAR3',
      });
    });

    it('should leave existing, unmanaged .env variables intact when updating in WORKSPACE scope', async () => {
      // Setup a pre-existing .env file in the workspace with unmanaged variables
      const workspaceEnvPath = path.join(tempWorkspaceDir, '.env');
      const originalEnvContent =
        'PROJECT_VAR_1=value_1\nPROJECT_VAR_2=value_2\nVAR1=original-value'; // VAR1 is managed by extension
      await fsPromises.writeFile(workspaceEnvPath, originalEnvContent);

      // Simulate updating an extension-managed non-sensitive setting
      mockRequestSetting.mockResolvedValue('updated-value');
      await updateSetting(
        config,
        '12345',
        'VAR1',
        mockRequestSetting,
        ExtensionSettingScope.WORKSPACE,
      );

      // Read the .env file after update
      const actualContent = await fsPromises.readFile(
        workspaceEnvPath,
        'utf-8',
      );

      // Assert that original variables are intact and extension variable is updated
      expect(actualContent).toContain('PROJECT_VAR_1=value_1');
      expect(actualContent).toContain('PROJECT_VAR_2=value_2');
      expect(actualContent).toContain('VAR1=updated-value');

      // Ensure no other unexpected changes or deletions
      const lines = actualContent.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(3); // Should only have the three variables
    });
  });
});
