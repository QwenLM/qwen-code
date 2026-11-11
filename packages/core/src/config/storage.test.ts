/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.unmock('./storage.js');

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

import { Storage } from './storage.js';
import { ENV_CONFIG_DIR } from './brand.js';
import * as pathsModule from '../utils/paths.js';
import {
  CONFIG_DIR,
  homedir,
  resolveToRealPath,
  sanitizePath,
} from '../utils/paths.js';

describe('Storage – initialize', () => {
  const projectRoot = '/tmp/project';
  const PROJECT_ID = sanitizePath(projectRoot);
  let storage: Storage;

  beforeEach(() => {
    storage = new Storage(projectRoot);
    vi.clearAllMocks();
  });

  it('derives the project identifier deterministically via sanitizePath', async () => {
    await storage.initialize();
    expect(storage.getProjectTempDir()).toBe(
      path.join(os.homedir(), CONFIG_DIR, 'tmp', PROJECT_ID),
    );

    // Verify identifier is set by checking a path
    expect(storage.getProjectTempDir()).toContain(PROJECT_ID);
  });
});

vi.mock('../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/paths.js')>();
  const { ENV_CONFIG_DIR } = await import('./brand.js');
  const pathModule = await import('node:path');
  const osModule = await import('node:os');
  const mockHomedir = vi.fn(actual.homedir);
  return {
    ...actual,
    homedir: mockHomedir,
    getConfigHomeDir: vi.fn(() => {
      const configured = process.env[ENV_CONFIG_DIR];
      if (configured) {
        return pathModule.resolve(configured).normalize('NFC');
      }
      const home = mockHomedir();
      return home
        ? pathModule.join(home, actual.CONFIG_DIR).normalize('NFC')
        : pathModule
            .join(osModule.tmpdir(), actual.CONFIG_DIR)
            .normalize('NFC');
    }),
  };
});

describe('Storage – getGlobalSettingsPath', () => {
  it(`returns path to ~/${CONFIG_DIR}/settings.json`, () => {
    const expected = path.join(os.homedir(), CONFIG_DIR, 'settings.json');
    expect(Storage.getGlobalSettingsPath()).toBe(expected);
  });

  it('uses ENV_CONFIG_DIR as the complete user config root', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/test-config-root');
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join('/tmp/test-config-root', 'settings.json'),
    );
    vi.unstubAllEnvs();
  });
});

describe('Storage - Security', () => {
  it('falls back to tmp for config dir if the home directory cannot be determined', () => {
    vi.mocked(homedir).mockReturnValue('');

    // getConfigHomeDir() falls back to tmpdir when homedir is empty
    expect(Storage.getGlobalConfigDir()).toBe(
      path.join(os.tmpdir(), CONFIG_DIR),
    );

    vi.mocked(homedir).mockReturnValue(os.homedir());
  });
});

describe('Storage – additional helpers', () => {
  const projectRoot = resolveToRealPath(path.resolve('/tmp/project'));
  const storage = new Storage(projectRoot);
  const PROJECT_ID = sanitizePath(projectRoot);

  it(`getWorkspaceSettingsPath returns project/${CONFIG_DIR}/settings.json`, () => {
    const expected = path.join(projectRoot, CONFIG_DIR, 'settings.json');
    expect(storage.getWorkspaceSettingsPath()).toBe(expected);
  });

  it(`getUserCommandsDir returns ~/${CONFIG_DIR}/commands`, () => {
    const expected = path.join(os.homedir(), CONFIG_DIR, 'commands');
    expect(Storage.getUserCommandsDir()).toBe(expected);
  });

  it(`getProjectCommandsDir returns project/${CONFIG_DIR}/commands`, () => {
    const expected = path.join(projectRoot, CONFIG_DIR, 'commands');
    expect(storage.getProjectCommandsDir()).toBe(expected);
  });

  it(`getUserSkillsDir returns ~/${CONFIG_DIR}/skills`, () => {
    const expected = path.join(os.homedir(), CONFIG_DIR, 'skills');
    expect(Storage.getUserSkillsDir()).toBe(expected);
  });

  it('getUserAgentSkillsDir returns ~/.agents/skills', () => {
    expect(Storage.getUserAgentSkillsDir()).toBe(
      path.join(os.homedir(), '.agents', 'skills'),
    );
  });

  it(`getProjectSkillsDir returns project/${CONFIG_DIR}/skills`, () => {
    const expected = path.join(projectRoot, CONFIG_DIR, 'skills');
    expect(storage.getProjectSkillsDir()).toBe(expected);
  });

  it('getProjectAgentSkillsDir returns project/.agents/skills', () => {
    expect(storage.getProjectAgentSkillsDir()).toBe(
      path.join(projectRoot, '.agents', 'skills'),
    );
  });

  it(`getUserAgentsDir returns ~/${CONFIG_DIR}/agents`, () => {
    const expected = path.join(os.homedir(), CONFIG_DIR, 'agents');
    expect(Storage.getUserAgentsDir()).toBe(expected);
  });

  it(`getProjectAgentsDir returns project/${CONFIG_DIR}/agents`, () => {
    const expected = path.join(projectRoot, CONFIG_DIR, 'agents');
    expect(storage.getProjectAgentsDir()).toBe(expected);
  });

  it(`getProjectMemoryDir returns ~/${CONFIG_DIR}/projects/<identifier>/memory`, async () => {
    await storage.initialize();
    const expected = path.join(
      os.homedir(),
      CONFIG_DIR,
      'projects',
      PROJECT_ID,
      'memory',
    );
    expect(storage.getProjectMemoryDir()).toBe(expected);
  });

  it(`getMcpOAuthTokensPath returns ~/${CONFIG_DIR}/mcp-oauth-tokens.json`, () => {
    const expected = path.join(
      os.homedir(),
      CONFIG_DIR,
      'mcp-oauth-tokens.json',
    );
    expect(Storage.getMcpOAuthTokensPath()).toBe(expected);
  });

  it(`getGlobalBinDir returns ~/${CONFIG_DIR}/tmp/bin`, () => {
    const expected = path.join(os.homedir(), CONFIG_DIR, 'tmp', 'bin');
    expect(Storage.getGlobalBinDir()).toBe(expected);
  });

  it(`getProjectTempPlansDir returns ~/${CONFIG_DIR}/tmp/<identifier>/plans when no sessionId is provided`, async () => {
    await storage.initialize();
    const tempDir = storage.getProjectTempDir();
    const expected = path.join(tempDir, 'plans');
    expect(storage.getProjectTempPlansDir()).toBe(expected);
  });

  it(`getProjectTempPlansDir returns ~/${CONFIG_DIR}/tmp/<identifier>/<sessionId>/plans when sessionId is provided`, async () => {
    const sessionId = 'test-session-id';
    const storageWithSession = new Storage(projectRoot, sessionId);
    await storageWithSession.initialize();
    const tempDir = storageWithSession.getProjectTempDir();
    const expected = path.join(tempDir, sessionId, 'plans');
    expect(storageWithSession.getProjectTempPlansDir()).toBe(expected);
  });

  it('getProjectTempToolResultsDir stays inside the project temp dir', async () => {
    await storage.initialize();
    expect(storage.getProjectTempToolResultsDir()).toBe(
      path.join(storage.getProjectTempDir(), 'tool-results'),
    );

    const sessionId = 'test-session-id';
    const storageWithSession = new Storage(projectRoot, sessionId);
    await storageWithSession.initialize();
    expect(storageWithSession.getProjectTempToolResultsDir()).toBe(
      path.join(
        storageWithSession.getProjectTempDir(),
        sessionId,
        'tool-results',
      ),
    );
  });

  describe('Project Temp File Loading', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    it('loadProjectTempFile loads and parses JSON from relative path', async () => {
      const readFileSpy = vi
        .spyOn(fs.promises, 'readFile')
        .mockResolvedValue(JSON.stringify({ hello: 'world' }));

      const result = await storage.loadProjectTempFile<{ hello: string }>(
        'some/file.json',
      );

      expect(readFileSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join(PROJECT_ID, 'some/file.json')),
        'utf8',
      );
      expect(result).toEqual({ hello: 'world' });

      readFileSpy.mockRestore();
    });

    it('loadProjectTempFile returns null if file does not exist', async () => {
      const error = new Error('File not found');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any).code = 'ENOENT';
      const readFileSpy = vi
        .spyOn(fs.promises, 'readFile')
        .mockRejectedValue(error);

      const result = await storage.loadProjectTempFile('missing.json');

      expect(result).toBeNull();

      readFileSpy.mockRestore();
    });
  });

  describe('getPlansDir', () => {
    interface TestCase {
      name: string;
      customDir: string | undefined;
      expected: string | (() => string);
      expectedError?: string;
      setup?: () => () => void;
    }

    const testCases: TestCase[] = [
      {
        name: 'custom relative path',
        customDir: '.my-plans',
        expected: path.resolve(projectRoot, '.my-plans'),
      },
      {
        name: 'custom absolute path outside throws',
        customDir: path.resolve('/absolute/path/to/plans'),
        expected: '',
        expectedError: `Custom plans directory '${path.resolve('/absolute/path/to/plans')}' resolves to '${path.resolve('/absolute/path/to/plans')}', which is outside the project root '${resolveToRealPath(projectRoot)}'.`,
      },
      {
        name: 'absolute path that happens to be inside project root',
        customDir: path.join(projectRoot, 'internal-plans'),
        expected: path.join(projectRoot, 'internal-plans'),
      },
      {
        name: 'relative path that stays within project root',
        customDir: 'subdir/../plans',
        expected: path.resolve(projectRoot, 'plans'),
      },
      {
        name: 'dot path',
        customDir: '.',
        expected: projectRoot,
      },
      {
        name: 'default behavior when customDir is undefined',
        customDir: undefined,
        expected: () => path.join(os.homedir(), CONFIG_DIR, 'plans'),
      },
      {
        name: 'escaping relative path throws',
        customDir: '../escaped-plans',
        expected: '',
        expectedError: `Custom plans directory '../escaped-plans' resolves to '${resolveToRealPath(path.resolve(projectRoot, '../escaped-plans'))}', which is outside the project root '${resolveToRealPath(projectRoot)}'.`,
      },
      {
        name: 'hidden directory starting with ..',
        customDir: '..plans',
        expected: path.resolve(projectRoot, '..plans'),
      },
      {
        name: 'security escape via symbolic link throws',
        customDir: 'symlink-to-outside',
        setup: () => {
          const realProjectRoot = resolveToRealPath(projectRoot);
          const spy = vi
            .spyOn(pathsModule, 'resolveToRealPath')
            .mockImplementation((targetPath: string) => {
              if (targetPath.includes('symlink-to-outside')) {
                return path.resolve('/outside/project/root');
              }
              return realProjectRoot;
            });
          return () => spy.mockRestore();
        },
        expected: '',
        expectedError: `Custom plans directory 'symlink-to-outside' resolves to '${path.resolve('/outside/project/root')}', which is outside the project root '${resolveToRealPath(projectRoot)}'.`,
      },
    ];

    testCases.forEach(({ name, customDir, expected, expectedError, setup }) => {
      it(`should handle ${name}`, async () => {
        const cleanup = setup?.();
        try {
          if (name.includes('default behavior')) {
            await storage.initialize();
          }

          storage.setCustomPlansDir(customDir);
          if (expectedError) {
            expect(() => storage.getPlansDir()).toThrow(expectedError);
          } else {
            const expectedValue =
              typeof expected === 'function' ? expected() : expected;
            expect(storage.getPlansDir()).toBe(expectedValue);
          }
        } finally {
          cleanup?.();
        }
      });
    });
  });
});
