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

  const ID = '12345';
  const USER_SERVICE = 'Qwen Code Extensions test-ext 12345';
  const userKeychain = () => new KeychainTokenStorage(USER_SERVICE);
  const workspaceKeychain = () =>
    new KeychainTokenStorage(`${USER_SERVICE} ${tempWorkspaceDir}`);
  /** Setting `n`: `{ name: 'sN', description: 'dN', envVar: 'VARN' }`, with `extra` keys overriding or added. */
  const setting = (
    n: number,
    extra: Partial<ExtensionSetting> = {},
  ): ExtensionSetting => ({
    name: `s${n}`,
    description: `d${n}`,
    envVar: `VAR${n}`,
    ...extra,
  });
  /** The `test-ext` config; `settings` is omitted entirely when not given. */
  const extConfig = (
    settings?: ExtensionSetting[],
    version = '1.0.0',
  ): ExtensionConfig => ({
    name: 'test-ext',
    version,
    ...(settings ? { settings } : {}),
  });
  const userContents = (config: ExtensionConfig) =>
    getScopedEnvContents(config, ID, ExtensionSettingScope.USER);
  /** Prepare settings into `envFile` with keychain mutations deferred until commit. */
  const stage = (
    config: ExtensionConfig,
    request: (setting: ExtensionSetting) => Promise<string>,
    envFile: string,
  ) =>
    maybePromptForSettings(
      config,
      ID,
      request,
      undefined,
      undefined,
      envFile,
      true,
    );
  const userEnvPath = () => path.join(extensionDir, '.env');
  const readText = (file: string) => fsPromises.readFile(file, 'utf-8');
  /** Make `envPath` a symlink to a home-dir file `targetName` holding `content`; returns the target. */
  async function linkEnv(envPath: string, targetName: string, content: string) {
    const target = path.join(tempHomeDir, targetName);
    await fsPromises.writeFile(target, content);
    await fsPromises.symlink(target, envPath);
    return target;
  }
  /** The write replaced the `envPath` symlink with a file and left its old target alone. */
  async function expectLinkReplaced(
    envPath: string,
    target: string,
    content: string,
  ) {
    expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(false);
    expect(await readText(target)).toBe(content);
  }

  describe('maybePromptForSettings', () => {
    const mockRequestSetting = vi.fn(
      async (setting: ExtensionSetting) => `mock-${setting.envVar}`,
    );
    const apiKey: ExtensionSetting = {
      name: 'API key',
      description: 'API key',
      envVar: 'API_KEY',
      sensitive: true,
    };
    const apiKeyConfig = extConfig([apiKey]);
    /** Prompt with mockRequestSetting (no env-file override, keychain mutated immediately). */
    const promptWith = (
      config: ExtensionConfig,
      previousConfig?: ExtensionConfig,
      previousSettings?: Record<string, string>,
    ) =>
      maybePromptForSettings(
        config,
        ID,
        mockRequestSetting,
        previousConfig,
        previousSettings,
      );
    /** Stage the API key config into a fresh workspace subdirectory `name`; returns the dir and the prepared mutation. */
    async function stageIn(name: string, request: () => Promise<string>) {
      const dir = path.join(tempWorkspaceDir, name);
      fs.mkdirSync(dir);
      return {
        dir,
        prepared: await stage(apiKeyConfig, request, path.join(dir, '.env')),
      };
    }
    const bundleKeyIn = (dir: string) =>
      (
        JSON.parse(
          fs.readFileSync(
            path.join(dir, '.qwen-extension-settings.json'),
            'utf8',
          ),
        ) as { bundleKey: string }
      ).bundleKey;

    beforeEach(() => {
      mockRequestSetting.mockClear();
    });

    it('should do nothing if settings are undefined', async () => {
      await promptWith(extConfig());
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('should do nothing if settings are empty', async () => {
      await promptWith(extConfig([]));
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('defers adding sensitive settings until commit', async () => {
      const config = apiKeyConfig;
      const keychain = userKeychain();

      const commit = await stage(
        config,
        mockRequestSetting,
        path.join(tempWorkspaceDir, 'staged.env'),
      );

      expect(await keychain.getSecret('API_KEY')).toBeNull();
      expect(await userContents(config)).toEqual({});
      fs.renameSync(
        path.join(tempWorkspaceDir, '.qwen-extension-settings.json'),
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );
      expect(await userContents(config)).toEqual({ API_KEY: 'mock-API_KEY' });
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBe('mock-API_KEY');
      await keychain.setSecret('API_KEY', 'rotated');
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBe('rotated');
    });

    it('isolates concurrent prepared sensitive settings snapshots', async () => {
      const first = await stageIn('first', async () => 'first-secret');
      const second = await stageIn('second', async () => 'second-secret');

      const firstKey = bundleKeyIn(first.dir);
      const secondKey = bundleKeyIn(second.dir);
      expect(firstKey).not.toBe(secondKey);
      const storage = mockKeychainData[USER_SERVICE];
      expect(JSON.parse(storage![firstKey]!)).toEqual({
        API_KEY: 'first-secret',
      });
      expect(JSON.parse(storage![secondKey]!)).toEqual({
        API_KEY: 'second-secret',
      });
    });

    it('discards an uncommitted sensitive settings snapshot', async () => {
      const { dir, prepared } = await stageIn(
        'discard',
        async () => 'temporary-secret',
      );
      const bundleKey = bundleKeyIn(dir);
      const storage = mockKeychainData[USER_SERVICE]!;
      expect(storage[bundleKey]).toBeDefined();

      await prepared?.discard();

      expect(storage[bundleKey]).toBeUndefined();
    });

    it('deletes the previous sensitive settings snapshot after commit', async () => {
      const config = apiKeyConfig;
      await stage(config, async () => 'old-secret', userEnvPath());
      const oldKey = bundleKeyIn(extensionDir);
      const storage = mockKeychainData[USER_SERVICE]!;
      storage[`${oldKey}:override:API_KEY`] = 'old-override';

      const stagingDir = path.join(tempWorkspaceDir, 'replacement');
      fs.mkdirSync(stagingDir);
      const prepared = await maybePromptForSettings(
        { ...config, version: '2.0.0' },
        ID,
        async () => 'new-secret',
        config,
        { API_KEY: 'old-secret' },
        path.join(stagingDir, '.env'),
        true,
      );
      const newKey = bundleKeyIn(stagingDir);
      fs.copyFileSync(
        path.join(stagingDir, '.qwen-extension-settings.json'),
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );

      await prepared?.commit();

      expect(storage[oldKey]).toBeUndefined();
      expect(storage[`${oldKey}:override:API_KEY`]).toBeUndefined();
      expect(JSON.parse(storage[newKey]!)).toEqual({ API_KEY: 'old-secret' });
      await expect(userContents(config)).resolves.toEqual({
        API_KEY: 'old-secret',
      });
    });

    it('does not fall back to stale legacy secrets when a selected bundle is missing', async () => {
      const config = apiKeyConfig;
      await stage(config, async () => 'new-secret', userEnvPath());
      const bundleKey = bundleKeyIn(extensionDir);
      const storage = mockKeychainData[USER_SERVICE]!;
      storage['API_KEY'] = 'stale-secret';
      delete storage[bundleKey];

      await expect(userContents(config)).rejects.toThrow(
        'Stored extension settings bundle is missing.',
      );
    });

    it('defers clearing sensitive settings until commit', async () => {
      const keychain = userKeychain();
      await keychain.setSecret('API_KEY', 'old-secret');

      const commit = await maybePromptForSettings(
        extConfig([], '2.0.0'),
        ID,
        mockRequestSetting,
        apiKeyConfig,
        { API_KEY: 'old-secret' },
        path.join(tempWorkspaceDir, 'staged.env'),
        true,
      );

      expect(await keychain.getSecret('API_KEY')).toBe('old-secret');
      await commit?.commit();
      expect(await keychain.getSecret('API_KEY')).toBeNull();
    });

    it('rejects invalid environment variable names before prompting', async () => {
      const config = extConfig([
        { name: 'API key', description: 'API key', envVar: 'API_KEY\nforged' },
      ]);

      await expect(promptWith(config)).rejects.toThrow(
        'Extension setting "envVar" must be a valid environment variable name.',
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
    });

    it('rejects invalid previous environment variable names before mutation', async () => {
      const config = extConfig(
        [
          {
            name: 'Current key',
            description: 'Current key',
            envVar: 'API_KEY',
          },
        ],
        '2.0.0',
      );
      const previousConfig = extConfig([
        {
          name: 'Previous key',
          description: 'Previous key',
          envVar: 'OLD_KEY\nforged',
        },
      ]);

      await expect(
        promptWith(config, previousConfig, { OLD_KEY: 'previous' }),
      ).rejects.toThrow(
        'Extension setting "envVar" must be a valid environment variable name.',
      );
      expect(mockRequestSetting).not.toHaveBeenCalled();
      expect(KeychainTokenStorage).not.toHaveBeenCalled();
      expect(fs.existsSync(userEnvPath())).toBe(false);
    });

    it('should prompt for all settings if there is no previous config', async () => {
      const config = extConfig([setting(1), setting(2)]);
      await promptWith(config);
      expect(mockRequestSetting).toHaveBeenCalledTimes(2);
      expect(mockRequestSetting).toHaveBeenCalledWith(config.settings![0]);
      expect(mockRequestSetting).toHaveBeenCalledWith(config.settings![1]);
    });

    it('should only prompt for new settings', async () => {
      const newConfig = extConfig([setting(1), setting(2)]);
      const expectedEnvPath = userEnvPath();
      const symlinkTarget = await linkEnv(
        expectedEnvPath,
        'prompt-target.env',
        'ORIGINAL',
      );

      await promptWith(newConfig, extConfig([setting(1)]), {
        VAR1: 'previous-VAR1',
      });

      expect(mockRequestSetting).toHaveBeenCalledTimes(1);
      expect(mockRequestSetting).toHaveBeenCalledWith(newConfig.settings![1]);
      expect(await readText(expectedEnvPath)).toBe(
        'VAR1=previous-VAR1\nVAR2=mock-VAR2\n',
      );
      await expectLinkReplaced(expectedEnvPath, symlinkTarget, 'ORIGINAL');
    });

    it('should clear settings if new config has no settings', async () => {
      const previousConfig = extConfig([
        setting(1),
        setting(2, { envVar: 'SENSITIVE_VAR', sensitive: true }),
      ]);
      const keychain = userKeychain();
      await keychain.setSecret('SENSITIVE_VAR', 'secret');
      const envPath = userEnvPath();
      const symlinkTarget = await linkEnv(
        envPath,
        'clear-target.env',
        'VAR1=previous-VAR1',
      );

      await promptWith(extConfig([]), previousConfig, {
        VAR1: 'previous-VAR1',
        SENSITIVE_VAR: 'secret',
      });

      expect(mockRequestSetting).not.toHaveBeenCalled();
      expect(await readText(envPath)).toBe('');
      await expectLinkReplaced(envPath, symlinkTarget, 'VAR1=previous-VAR1');
      expect(await keychain.getSecret('SENSITIVE_VAR')).toBeNull();
    });

    it('should remove sensitive settings from keychain', async () => {
      const keychain = userKeychain();
      await keychain.setSecret('SENSITIVE_VAR', 'secret');

      await promptWith(
        extConfig([]),
        extConfig([setting(1, { envVar: 'SENSITIVE_VAR', sensitive: true })]),
        { SENSITIVE_VAR: 'secret' },
      );

      expect(await keychain.getSecret('SENSITIVE_VAR')).toBeNull();
    });

    it('should remove settings that are no longer in the config', async () => {
      await promptWith(
        extConfig([setting(1)]),
        extConfig([setting(1), setting(2)]),
        { VAR1: 'previous-VAR1', VAR2: 'previous-VAR2' },
      );

      expect(mockRequestSetting).not.toHaveBeenCalled();
      expect(await readText(userEnvPath())).toBe('VAR1=previous-VAR1\n');
    });

    it('should reprompt if a setting changes sensitivity', async () => {
      const newConfig = extConfig([setting(1, { sensitive: true })]);

      await promptWith(
        newConfig,
        extConfig([setting(1, { sensitive: false })]),
        {
          VAR1: 'previous-VAR1',
        },
      );

      expect(mockRequestSetting).toHaveBeenCalledTimes(1);
      expect(mockRequestSetting).toHaveBeenCalledWith(newConfig.settings![0]);
      // The value should now be in keychain, not the .env file.
      expect(await readText(userEnvPath())).toBe('');
    });

    it('should not prompt if settings are identical', async () => {
      await promptWith(
        extConfig([setting(1), setting(2)]),
        extConfig([setting(1), setting(2)]),
        { VAR1: 'previous-VAR1', VAR2: 'previous-VAR2' },
      );

      expect(mockRequestSetting).not.toHaveBeenCalled();
      expect(await readText(userEnvPath())).toBe(
        'VAR1=previous-VAR1\nVAR2=previous-VAR2\n',
      );
    });

    it('should wrap values with spaces in quotes', async () => {
      mockRequestSetting.mockResolvedValue('a value with spaces');

      await promptWith(extConfig([setting(1)]));

      expect(await readText(userEnvPath())).toBe(
        'VAR1="a value with spaces"\n',
      );
    });

    it('should not attempt to clear secrets if keychain is unavailable', async () => {
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

      // Empty settings trigger clearSettings.
      await promptWith(extConfig([]), extConfig([setting(1)]));

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
    const config = extConfig([
      setting(1),
      setting(2, { envVar: 'SENSITIVE_VAR', sensitive: true }),
    ]);

    it('should return combined contents from user .env and keychain for USER scope', async () => {
      await fsPromises.writeFile(
        path.join(extensionDir, EXTENSION_SETTINGS_FILENAME),
        'VAR1=user-value1',
      );
      await userKeychain().setSecret('SENSITIVE_VAR', 'user-secret');

      const contents = await userContents(config);

      expect(contents).toEqual({
        VAR1: 'user-value1',
        SENSITIVE_VAR: 'user-secret',
      });
    });

    it('should return combined contents from workspace .env and keychain for WORKSPACE scope', async () => {
      await fsPromises.writeFile(
        path.join(tempWorkspaceDir, EXTENSION_SETTINGS_FILENAME),
        'VAR1=workspace-value1',
      );
      await workspaceKeychain().setSecret('SENSITIVE_VAR', 'workspace-secret');

      const contents = await getScopedEnvContents(
        config,
        ID,
        ExtensionSettingScope.WORKSPACE,
      );

      expect(contents).toEqual({
        VAR1: 'workspace-value1',
        SENSITIVE_VAR: 'workspace-secret',
      });
    });
  });

  describe('getEnvContents (merged)', () => {
    const config = extConfig([
      setting(1),
      setting(2, { sensitive: true }),
      setting(3),
    ]);

    it('should merge user and workspace settings, with workspace taking precedence', async () => {
      await fsPromises.writeFile(
        path.join(extensionDir, EXTENSION_SETTINGS_FILENAME),
        'VAR1=user-value1\nVAR3=user-value3',
      );
      await userKeychain().setSecret('VAR2', 'user-secret2');
      await fsPromises.writeFile(
        path.join(tempWorkspaceDir, EXTENSION_SETTINGS_FILENAME),
        'VAR1=workspace-value1',
      );
      await workspaceKeychain().setSecret('VAR2', 'workspace-secret2');

      const contents = await getEnvContents(config, ID);

      expect(contents).toEqual({
        VAR1: 'workspace-value1',
        VAR2: 'workspace-secret2',
        VAR3: 'user-value3',
      });
    });
  });

  describe('updateSetting', () => {
    const config = extConfig([setting(1), setting(2, { sensitive: true })]);
    const mockRequestSetting = vi.fn();
    /** updateSetting for `envVar`, answering with mockRequestSetting unless `request` is given. */
    const update = (
      envVar: string,
      scope: ExtensionSettingScope,
      request: () => Promise<string> = mockRequestSetting,
      cfg = config,
    ) => updateSetting(cfg, ID, envVar, request, scope);

    beforeEach(async () => {
      await fsPromises.writeFile(userEnvPath(), 'VAR1=value1\n');
      await userKeychain().setSecret('VAR2', 'value2');
      mockRequestSetting.mockClear();
    });

    it('should update a non-sensitive setting in USER scope', async () => {
      mockRequestSetting.mockResolvedValue('new-value1');
      const expectedEnvPath = userEnvPath();
      await fsPromises.rm(expectedEnvPath);
      const symlinkTarget = await linkEnv(
        expectedEnvPath,
        'update-target.env',
        'VAR1=value1\n',
      );

      await update('VAR1', ExtensionSettingScope.USER);

      expect(await readText(expectedEnvPath)).toContain('VAR1=new-value1');
      await expectLinkReplaced(expectedEnvPath, symlinkTarget, 'VAR1=value1\n');
    });

    it('should update a non-sensitive setting in WORKSPACE scope', async () => {
      mockRequestSetting.mockResolvedValue('new-workspace-value');

      await update('VAR1', ExtensionSettingScope.WORKSPACE);

      expect(await readText(path.join(tempWorkspaceDir, '.env'))).toContain(
        'VAR1=new-workspace-value',
      );
    });

    it('should update a sensitive setting in USER scope', async () => {
      mockRequestSetting.mockResolvedValue('new-value2');

      await update('VAR2', ExtensionSettingScope.USER);

      expect(await userKeychain().getSecret('VAR2')).toBe('new-value2');
    });

    it('synchronizes legacy sensitive settings through the current backend', async () => {
      const previousStorageOverride =
        process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
      process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = 'true';
      try {
        await maybePromptForSettings(
          config,
          ID,
          async () => 'initial-value2',
          undefined,
          undefined,
          userEnvPath(),
        );
      } finally {
        if (previousStorageOverride === undefined) {
          delete process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
        } else {
          process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = previousStorageOverride;
        }
      }

      await update(
        'VAR2',
        ExtensionSettingScope.USER,
        async () => 'new-value2',
      );

      await fsPromises.rm(
        path.join(extensionDir, '.qwen-extension-settings.json'),
      );
      await expect(userContents(config)).resolves.toEqual({
        VAR1: 'initial-value2',
        VAR2: 'new-value2',
      });
    });

    it('should update a sensitive setting in WORKSPACE scope', async () => {
      mockRequestSetting.mockResolvedValue('new-workspace-secret');

      await update('VAR2', ExtensionSettingScope.WORKSPACE);

      expect(await workspaceKeychain().getSecret('VAR2')).toBe(
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

      await expect(update('VAR2', ExtensionSettingScope.USER)).rejects.toThrow(
        'write failed',
      );
    });

    it('does not lose concurrent user-scope sensitive setting updates', async () => {
      const sensitiveConfig = extConfig([
        setting(2, { sensitive: true }),
        setting(3, { sensitive: true }),
      ]);
      await stage(
        sensitiveConfig,
        async (s) => `initial-${s.envVar}`,
        userEnvPath(),
      );

      await Promise.all([
        update(
          'VAR2',
          ExtensionSettingScope.USER,
          async () => 'updated-VAR2',
          sensitiveConfig,
        ),
        update(
          'VAR3',
          ExtensionSettingScope.USER,
          async () => 'updated-VAR3',
          sensitiveConfig,
        ),
      ]);

      await expect(userContents(sensitiveConfig)).resolves.toEqual({
        VAR2: 'updated-VAR2',
        VAR3: 'updated-VAR3',
      });
    });

    it('should leave existing, unmanaged .env variables intact when updating in WORKSPACE scope', async () => {
      // A workspace .env with unmanaged variables; VAR1 is managed by the extension.
      const workspaceEnvPath = path.join(tempWorkspaceDir, '.env');
      await fsPromises.writeFile(
        workspaceEnvPath,
        'PROJECT_VAR_1=value_1\nPROJECT_VAR_2=value_2\nVAR1=original-value',
      );

      mockRequestSetting.mockResolvedValue('updated-value');
      await update('VAR1', ExtensionSettingScope.WORKSPACE);

      // Unmanaged variables are intact and the managed one is updated...
      const actualContent = await readText(workspaceEnvPath);
      expect(actualContent).toContain('PROJECT_VAR_1=value_1');
      expect(actualContent).toContain('PROJECT_VAR_2=value_2');
      expect(actualContent).toContain('VAR1=updated-value');

      // ...with no other additions or deletions.
      const lines = actualContent.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(3);
    });
  });
});
