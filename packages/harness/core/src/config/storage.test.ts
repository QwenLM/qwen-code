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
import type { Config } from './config.js';
import { getScopedAutoMemoryDirs } from '../memory/structured-memory-store.js';
import { loadScopedMemoryIndexes } from '../memory/memory-index.js';
import { PermissionModes } from '../permissions/manager/decision/index.js';
import { PermissionManager } from '../permissions/manager/permission-manager.js';
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

  it('shares project memory across linked worktrees and repository subdirectories', async () => {
    const dir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'project-memory-'),
    );
    const manager = new PermissionManager();
    try {
      const root = await fs.promises.realpath(dir);
      const configDir = path.join(root, 'config');
      const primary = path.join(root, 'main checkout');
      const first = path.join(root, 'worktree one');
      const second = path.join(root, 'worktree two');
      const other = path.join(root, 'unrelated checkout');
      vi.stubEnv(ENV_CONFIG_DIR, configDir);

      const head = 'ref: refs/heads/main\n';
      for (const checkout of [primary, other]) {
        const gitDir = path.join(checkout, '.git');
        await fs.promises.mkdir(path.join(gitDir, 'objects'), {
          recursive: true,
        });
        await fs.promises.mkdir(path.join(gitDir, 'refs'), { recursive: true });
        await fs.promises.writeFile(path.join(gitDir, 'HEAD'), head);
      }
      for (const checkout of [first, second]) {
        const gitDir = path.join(
          primary,
          '.git',
          'worktrees',
          path.basename(checkout),
        );
        const marker = path.join(checkout, '.git');
        await fs.promises.mkdir(gitDir, { recursive: true });
        await fs.promises.mkdir(checkout);
        await fs.promises.writeFile(marker, `gitdir: ${gitDir}\n`);
        await fs.promises.writeFile(path.join(gitDir, 'gitdir'), `${marker}\n`);
        await fs.promises.writeFile(path.join(gitDir, 'commondir'), '../..\n');
        await fs.promises.writeFile(path.join(gitDir, 'HEAD'), head);
      }
      const nested = path.join(second, 'src');
      await fs.promises.mkdir(nested);

      const mainStorage = new Storage(primary);
      const firstStorage = new Storage(first);
      const nestedStorage = new Storage(nested);
      const otherStorage = new Storage(other);
      await Promise.all(
        [mainStorage, firstStorage, nestedStorage, otherStorage].map((s) =>
          s.initialize(),
        ),
      );

      const shared = path.join(Storage.getProjectStateDir(primary), 'memory');
      expect(mainStorage.isLinkedWorktree()).toBe(false);
      expect(firstStorage.isLinkedWorktree()).toBe(true);
      expect(nestedStorage.isLinkedWorktree()).toBe(true);
      expect(otherStorage.isLinkedWorktree()).toBe(false);
      expect(mainStorage.getProjectMemoryDir()).toBe(shared);
      expect(firstStorage.getProjectMemoryDir()).toBe(shared);
      expect(nestedStorage.getProjectMemoryDir()).toBe(shared);
      expect(otherStorage.getProjectMemoryDir()).toBe(
        path.join(Storage.getProjectStateDir(other), 'memory'),
      );
      expect(firstStorage.getProjectTempDir()).not.toBe(
        mainStorage.getProjectTempDir(),
      );

      const sharedIndex = path.join(
        firstStorage.getProjectMemoryDir(),
        'MEMORY.md',
      );
      await fs.promises.mkdir(shared, { recursive: true });
      await fs.promises.writeFile(sharedIndex, 'shared notes');
      const legacy = path.join(Storage.getProjectStateDir(nested), 'memory');
      await fs.promises.mkdir(legacy, { recursive: true });
      const legacyIndex = path.join(legacy, 'MEMORY.md');
      await fs.promises.writeFile(legacyIndex, 'older checkout notes');

      const memoryConfig = {
        storage: nestedStorage,
        isAutoMemoryUserScopeEnabled: () => false,
        isAutoMemoryProjectScopeEnabled: () => true,
      } as Config;
      expect(getScopedAutoMemoryDirs(memoryConfig)).toEqual([
        { scope: 'project', dir: shared },
      ]);
      expect(
        await loadScopedMemoryIndexes(
          getScopedAutoMemoryDirs(memoryConfig, { includeLegacyIndex: true }),
        ),
      ).toEqual([
        {
          scope: 'project',
          indexPath: legacyIndex,
          content: 'older checkout notes',
          legacy: true,
        },
        { scope: 'project', indexPath: sharedIndex, content: 'shared notes' },
      ]);

      manager.initialize();
      const session = manager.createSessionPermissionManager({
        getWorkingDir: () => nested,
        getSessionId: () => 'worktree-memory',
        getProjectAutoMemoryDir: () =>
          nestedStorage.getInitializedProjectMemoryDir(),
        flagSettings: {
          initialMode: PermissionModes.Default,
          rules: { allow: {}, deny: {}, ask: {} },
          additionalDirectories: [],
        },
      });
      try {
        const read = await session.check({
          toolName: 'Read',
          input: { file_path: sharedIndex },
          toolUseId: 'read-shared-index',
        });
        expect(read.kind).toBe('allow');
        const write = await session.check({
          toolName: 'Write',
          input: { file_path: sharedIndex, content: 'updated notes' },
          toolUseId: 'write-shared-index',
        });
        expect(write.kind).toBe('allow');
        const unrelatedWrite = await session.check({
          toolName: 'Write',
          input: {
            file_path: path.join(otherStorage.getProjectMemoryDir(), 'MEMORY.md'),
            content: 'unrelated notes',
          },
          toolUseId: 'write-unrelated-index',
        });
        expect(unrelatedWrite.kind).toBe('deny');
      } finally {
        await session.dispose();
      }
    } finally {
      manager.dispose();
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
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
