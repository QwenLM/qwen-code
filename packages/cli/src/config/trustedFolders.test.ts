/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as osActual from 'node:os';
import {
  atomicWriteFileSync,
  FatalConfigError,
  ideContextStore,
} from '@qwen-code/qwen-code-core';
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
  type Mock,
} from 'vitest';
import * as fs from 'node:fs';
import * as commentJson from 'comment-json';
import stripJsonComments from 'strip-json-comments';
import * as path from 'node:path';
import {
  loadTrustedFolders,
  getTrustedFoldersPath,
  saveTrustedFolders,
  TrustLevel,
  isWorkspaceTrusted,
  getWorkspaceTrustStatus,
  resetTrustedFoldersForTesting,
} from './trustedFolders.js';
import type { Settings } from './settings.js';

vi.mock('proper-lockfile', () => ({
  default: { lockSync: vi.fn(() => vi.fn()) },
}));

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof osActual>();
  return {
    ...actualOs,
    homedir: vi.fn(() => '/mock/home/user'),
    platform: vi.fn(() => 'linux'),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof fs>();
  return {
    ...actualFs,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    lstatSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});
vi.mock('strip-json-comments', () => ({
  default: vi.fn((content) => content),
}));
vi.mock('comment-json', async (importOriginal) => {
  const actual = await importOriginal<typeof commentJson>();
  return {
    ...actual,
    parse: vi.fn(actual.parse),
    stringify: vi.fn(actual.stringify),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    atomicWriteFileSync: vi.fn(),
  };
});
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

describe('Trusted Folders Loading', () => {
  let mockFsExistsSync: Mocked<typeof fs.existsSync>;
  let mockStripJsonComments: Mocked<typeof stripJsonComments>;

  beforeEach(() => {
    resetTrustedFoldersForTesting();
    vi.resetAllMocks();
    mockFsExistsSync = vi.mocked(fs.existsSync);
    mockStripJsonComments = vi.mocked(stripJsonComments);
    vi.mocked(osActual.homedir).mockReturnValue('/mock/home/user');
    (mockStripJsonComments as unknown as Mock).mockImplementation(
      (jsonString: string) => jsonString,
    );
    (mockFsExistsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('{}');
    (fs.lstatSync as Mock).mockReturnValue({
      isSymbolicLink: () => false,
      isFile: () => true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load empty rules if no files exist', () => {
    const { rules, errors } = loadTrustedFolders();
    expect(rules).toEqual([]);
    expect(errors).toEqual([]);
  });

  describe('isPathTrusted', () => {
    function setup({ config = {} as Record<string, TrustLevel> } = {}) {
      (mockFsExistsSync as Mock).mockImplementation(
        (p) => p === getTrustedFoldersPath(),
      );
      (fs.readFileSync as Mock).mockImplementation((p) => {
        if (p === getTrustedFoldersPath()) return JSON.stringify(config);
        return '{}';
      });

      const folders = loadTrustedFolders();

      return { folders };
    }

    it('provides a method to determine if a path is trusted', () => {
      const { folders } = setup({
        config: {
          './myfolder': TrustLevel.TRUST_FOLDER,
          '/trustedparent/trustme': TrustLevel.TRUST_PARENT,
          '/user/folder': TrustLevel.TRUST_FOLDER,
          '/secret': TrustLevel.DO_NOT_TRUST,
          '/secret/publickeys': TrustLevel.TRUST_FOLDER,
        },
      });
      expect(folders.isPathTrusted('/secret')).toBe(false);
      expect(folders.isPathTrusted('/user/folder')).toBe(true);
      expect(folders.isPathTrusted('/secret/publickeys/public.pem')).toBe(true);
      expect(folders.isPathTrusted('/user/folder/harhar')).toBe(true);
      expect(folders.isPathTrusted('myfolder/somefile.jpg')).toBe(true);
      expect(folders.isPathTrusted('/trustedparent/someotherfolder')).toBe(
        true,
      );
      expect(folders.isPathTrusted('/trustedparent/trustme')).toBe(true);

      // No explicit rule covers this file
      expect(folders.isPathTrusted('/secret/bankaccounts.json')).toBe(
        undefined,
      );
      expect(folders.isPathTrusted('/secret/mine/privatekey.pem')).toBe(
        undefined,
      );
      expect(folders.isPathTrusted('/user/someotherfolder')).toBe(undefined);
    });
  });

  it('should load user rules if only user file exists', () => {
    const userPath = getTrustedFoldersPath();
    (mockFsExistsSync as Mock).mockImplementation((p) => p === userPath);
    const userContent = {
      '/user/folder': TrustLevel.TRUST_FOLDER,
    };
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return JSON.stringify(userContent);
      return '{}';
    });

    const { rules, errors } = loadTrustedFolders();
    expect(rules).toEqual([
      { path: '/user/folder', trustLevel: TrustLevel.TRUST_FOLDER },
    ]);
    expect(errors).toEqual([]);
  });

  it('should handle JSON parsing errors gracefully', () => {
    const userPath = getTrustedFoldersPath();
    (mockFsExistsSync as Mock).mockImplementation((p) => p === userPath);
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return 'invalid json';
      return '{}';
    });

    const { rules, errors } = loadTrustedFolders();
    expect(rules).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe(userPath);
    expect(errors[0].message).toContain('Unexpected token');
  });

  it('should use QWEN_CODE_TRUSTED_FOLDERS_PATH env var if set', () => {
    const customPath = '/custom/path/to/trusted_folders.json';
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = customPath;

    (mockFsExistsSync as Mock).mockImplementation((p) => p === customPath);
    const userContent = {
      '/user/folder/from/env': TrustLevel.TRUST_FOLDER,
    };
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === customPath) return JSON.stringify(userContent);
      return '{}';
    });

    const { rules, errors } = loadTrustedFolders();
    expect(rules).toEqual([
      {
        path: '/user/folder/from/env',
        trustLevel: TrustLevel.TRUST_FOLDER,
      },
    ]);
    expect(errors).toEqual([]);

    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  });

  it('setValue should update the user config and save it', () => {
    const loadedFolders = loadTrustedFolders();
    loadedFolders.setValue('/new/path', TrustLevel.TRUST_FOLDER);

    expect(loadedFolders.user.config['/new/path']).toBe(
      TrustLevel.TRUST_FOLDER,
    );
    expect(atomicWriteFileSync).toHaveBeenCalledWith(
      getTrustedFoldersPath(),
      JSON.stringify({ '/new/path': TrustLevel.TRUST_FOLDER }, null, 2),
      // noFollow:true mirrors the credential write sites' security
      // posture - a pre-placed symlink at the config path could leak
      // the trusted-folder list or leave the user's real config stale.
      {
        encoding: 'utf-8',
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      },
    );
  });

  it('setValue re-reads under the lock and preserves concurrent disk rules', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);
    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock)
      .mockReturnValueOnce('{}')
      .mockReturnValueOnce(
        JSON.stringify({ '/concurrent/path': TrustLevel.DO_NOT_TRUST }),
      );

    const loadedFolders = loadTrustedFolders();
    loadedFolders.setValue('/new/path', TrustLevel.TRUST_FOLDER);

    expect(loadedFolders.user.config).toEqual({
      '/concurrent/path': TrustLevel.DO_NOT_TRUST,
      '/new/path': TrustLevel.TRUST_FOLDER,
    });
    expect(vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1]).toContain(
      '"/concurrent/path": "DO_NOT_TRUST"',
    );
  });

  it('setValue does not mutate memory when the atomic write fails', () => {
    const loadedFolders = loadTrustedFolders();
    vi.mocked(atomicWriteFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() =>
      loadedFolders.setValue('/new/path', TrustLevel.TRUST_FOLDER),
    ).toThrow('disk full');
    expect(loadedFolders.user.config).toEqual({});
  });

  it('setValue should preserve existing comments when rewriting the trust file', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);
    const originalContent = `{
  // work repos
  "/existing/path": "TRUST_FOLDER"
}`;
    const strippedContent = JSON.stringify({
      '/existing/path': TrustLevel.TRUST_FOLDER,
    });

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (mockStripJsonComments as unknown as Mock).mockReturnValue(strippedContent);
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return originalContent;
      return '{}';
    });

    const loadedFolders = loadTrustedFolders();
    loadedFolders.setValue('/new/path', TrustLevel.TRUST_FOLDER);

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1];
    expect(writtenContent).toContain('// work repos');
    expect(writtenContent).toContain('"/existing/path": "TRUST_FOLDER"');
    expect(writtenContent).toContain('"/new/path": "TRUST_FOLDER"');
  });

  it('saveTrustedFolders should remove stale disk-only entries when syncing trusted folders', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);
    const originalContent = `{
  // keep this one
  "/keep/path": "TRUST_FOLDER"
}`;

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return originalContent;
      return '{}';
    });

    saveTrustedFolders({
      path: userPath,
      config: {
        '/new/path': TrustLevel.TRUST_FOLDER,
      },
    });

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1];
    expect(writtenContent).not.toContain('// keep this one');
    expect(writtenContent).not.toContain('"/keep/path": "TRUST_FOLDER"');
    expect(writtenContent).toContain('"/new/path": "TRUST_FOLDER"');
  });

  it('saveTrustedFolders should reject malformed input without overwriting it', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return '{ invalid jsonc';
      return '{}';
    });

    expect(() =>
      saveTrustedFolders({
        path: userPath,
        config: {
          '/new/path': TrustLevel.TRUST_FOLDER,
        },
      }),
    ).toThrow();
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('saveTrustedFolders should reject invalid preserved output', async () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);
    const originalContent = `{
  // work repos
  "/existing/path": "TRUST_FOLDER"
}`;
    const parseSpy = vi.mocked(commentJson.parse);
    const actualCommentJson =
      await vi.importActual<typeof commentJson>('comment-json');

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return originalContent;
      return '{}';
    });
    parseSpy
      .mockImplementationOnce((...args: Parameters<typeof commentJson.parse>) =>
        actualCommentJson.parse(...args),
      )
      .mockImplementationOnce(() => {
        throw new Error('invalid preserved output');
      });

    expect(() =>
      saveTrustedFolders({
        path: userPath,
        config: {
          '/new/path': TrustLevel.TRUST_FOLDER,
        },
      }),
    ).toThrow('invalid preserved output');
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it('saveTrustedFolders should reject an existing top-level array', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return '[]';
      return '{}';
    });

    expect(() =>
      saveTrustedFolders({
        path: userPath,
        config: {
          '/new/path': TrustLevel.TRUST_FOLDER,
        },
      }),
    ).toThrow('not a valid JSON object');
    expect(atomicWriteFileSync).not.toHaveBeenCalled();
  });

  it.each(['"hello"', '42', 'true', 'null'])(
    'saveTrustedFolders should reject an existing top-level primitive: %s',
    (existingContent) => {
      const userPath = getTrustedFoldersPath();
      const dirPath = path.dirname(userPath);

      (mockFsExistsSync as Mock).mockImplementation(
        (p) => p === userPath || p === dirPath,
      );
      (fs.readFileSync as Mock).mockImplementation((p) => {
        if (p === userPath) return existingContent;
        return '{}';
      });

      expect(() =>
        saveTrustedFolders({
          path: userPath,
          config: {
            '/new/path': TrustLevel.TRUST_FOLDER,
          },
        }),
      ).toThrow('not a valid JSON object');
      expect(atomicWriteFileSync).not.toHaveBeenCalled();
    },
  );
});

describe('isWorkspaceTrusted', () => {
  let mockCwd: string;
  const mockRules: Record<string, TrustLevel> = {};
  const mockSettings: Settings = {
    security: {
      folderTrust: {
        enabled: true,
      },
    },
  };

  beforeEach(() => {
    resetTrustedFoldersForTesting();
    vi.spyOn(process, 'cwd').mockImplementation(() => mockCwd);
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === getTrustedFoldersPath()) {
        return JSON.stringify(mockRules);
      }
      return '{}';
    });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === getTrustedFoldersPath(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear the object
    Object.keys(mockRules).forEach((key) => delete mockRules[key]);
  });

  it('should throw a fatal error if the config is malformed', () => {
    mockCwd = '/home/user/projectA';
    // This mock needs to be specific to this test to override the one in beforeEach
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === getTrustedFoldersPath()) {
        return '{"foo": "bar",}'; // Malformed JSON with trailing comma
      }
      return '{}';
    });
    expect(() => isWorkspaceTrusted(mockSettings)).toThrow(FatalConfigError);
    expect(() => isWorkspaceTrusted(mockSettings)).toThrow(
      /Please fix the configuration file/,
    );
  });

  it('should throw a fatal error if the config is not a JSON object', () => {
    mockCwd = '/home/user/projectA';
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === getTrustedFoldersPath()) {
        return 'null';
      }
      return '{}';
    });
    expect(() => isWorkspaceTrusted(mockSettings)).toThrow(FatalConfigError);
    expect(() => isWorkspaceTrusted(mockSettings)).toThrow(
      /not a valid JSON object/,
    );
  });

  it('should return true for a directly trusted folder', () => {
    mockCwd = '/home/user/projectA';
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should return true for a child of a trusted folder', () => {
    mockCwd = '/home/user/projectA/src';
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should return true for a child of a trusted parent folder', () => {
    mockCwd = '/home/user/projectB';
    mockRules['/home/user/projectB/somefile.txt'] = TrustLevel.TRUST_PARENT;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should return false for a directly untrusted folder', () => {
    mockCwd = '/home/user/untrusted';
    mockRules['/home/user/untrusted'] = TrustLevel.DO_NOT_TRUST;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: false,
      source: 'file',
    });
  });

  it('should return undefined for a child of an untrusted folder', () => {
    mockCwd = '/home/user/untrusted/src';
    mockRules['/home/user/untrusted'] = TrustLevel.DO_NOT_TRUST;
    expect(isWorkspaceTrusted(mockSettings).isTrusted).toBeUndefined();
  });

  it('should return undefined when no rules match', () => {
    mockCwd = '/home/user/other';
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;
    mockRules['/home/user/untrusted'] = TrustLevel.DO_NOT_TRUST;
    expect(isWorkspaceTrusted(mockSettings).isTrusted).toBeUndefined();
  });

  it('should prioritize trust over distrust', () => {
    mockCwd = '/home/user/projectA/untrusted';
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;
    mockRules['/home/user/projectA/untrusted'] = TrustLevel.DO_NOT_TRUST;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should handle path normalization', () => {
    mockCwd = '/home/user/projectA';
    mockRules[`/home/user/../user/${path.basename('/home/user/projectA')}`] =
      TrustLevel.TRUST_FOLDER;
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should match distrust rules through canonical symlink paths', () => {
    mockCwd = '/real/project';
    mockRules['/link/project'] = TrustLevel.DO_NOT_TRUST;
    vi.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      const value = String(p);
      if (value === '/link/project' || value === '/real/project') {
        return '/real/project';
      }
      return value;
    });

    expect(
      isWorkspaceTrusted(mockSettings, undefined, '/real/project'),
    ).toEqual({
      isTrusted: false,
      source: 'file',
    });
  });
});

describe('getWorkspaceTrustStatus', () => {
  const mockRules: Record<string, TrustLevel> = {};
  const mockSettings: Settings = {
    security: {
      folderTrust: {
        enabled: true,
      },
    },
  };

  beforeEach(() => {
    resetTrustedFoldersForTesting();
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (p === getTrustedFoldersPath()) {
        return JSON.stringify(mockRules);
      }
      return '{}';
    });
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === getTrustedFoldersPath(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.keys(mockRules).forEach((key) => delete mockRules[key]);
  });

  it('uses explicit workspace path instead of process cwd', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user/other');
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;

    expect(
      getWorkspaceTrustStatus(mockSettings, '/home/user/projectA'),
    ).toMatchObject({
      workspaceCwd: '/home/user/projectA',
      folderTrustEnabled: true,
      effective: { state: 'trusted', source: 'file' },
      explicitTrustLevel: TrustLevel.TRUST_FOLDER,
    });
  });

  it('reports trust levels inherited from matching parent rules', () => {
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;
    mockRules['/home/user/projectB/child'] = TrustLevel.TRUST_PARENT;

    expect(
      getWorkspaceTrustStatus(mockSettings, '/home/user/projectA/subdir'),
    ).toMatchObject({
      effective: { state: 'trusted', source: 'file' },
      explicitTrustLevel: TrustLevel.TRUST_FOLDER,
    });
    expect(
      getWorkspaceTrustStatus(mockSettings, '/home/user/projectB/sibling'),
    ).toMatchObject({
      effective: { state: 'trusted', source: 'file' },
      explicitTrustLevel: TrustLevel.TRUST_PARENT,
    });
  });

  it('reports disabled folder trust as trusted disabled source', () => {
    expect(
      getWorkspaceTrustStatus(
        { security: { folderTrust: { enabled: false } } },
        '/home/user/projectA',
      ),
    ).toEqual({
      v: 1,
      workspaceCwd: '/home/user/projectA',
      folderTrustEnabled: false,
      effective: { state: 'trusted', source: 'disabled' },
      explicitTrustLevel: null,
      requiresDaemonRestartForChanges: true,
    });
  });

  it('distinguishes unknown from explicit do not trust', () => {
    mockRules['/home/user/untrusted'] = TrustLevel.DO_NOT_TRUST;

    expect(
      getWorkspaceTrustStatus(mockSettings, '/home/user/untrusted'),
    ).toMatchObject({
      effective: { state: 'untrusted', source: 'file' },
      explicitTrustLevel: TrustLevel.DO_NOT_TRUST,
    });
    expect(
      getWorkspaceTrustStatus(mockSettings, '/home/user/unknown'),
    ).toMatchObject({
      effective: { state: 'unknown', source: 'none' },
      explicitTrustLevel: null,
    });
  });

  it('does not mutate the cached config when a preview override is passed', () => {
    mockRules['/home/user/projectA'] = TrustLevel.TRUST_FOLDER;

    // Prime the module cache from disk, then snapshot the loaded config.
    const before = { ...loadTrustedFolders().user.config };

    // A read-only "preview" check with a tentative override config that adds a
    // folder not present on disk.
    const overrideConfig = {
      ...before,
      '/home/user/preview': TrustLevel.DO_NOT_TRUST,
    };
    getWorkspaceTrustStatus(mockSettings, '/home/user/preview', overrideConfig);

    // The cached config must be unchanged — the tentative preview must not leak
    // into subsequent reads.
    expect(loadTrustedFolders().user.config).toEqual(before);
    expect(
      loadTrustedFolders().user.config['/home/user/preview'],
    ).toBeUndefined();
  });
});

describe('isWorkspaceTrusted with IDE override', () => {
  afterEach(() => {
    vi.clearAllMocks();
    ideContextStore.clear();
    resetTrustedFoldersForTesting();
  });

  const mockSettings: Settings = {
    security: {
      folderTrust: {
        enabled: true,
      },
    },
  };

  it('should return true when ideTrust is true, ignoring config', () => {
    ideContextStore.set({ workspaceState: { isTrusted: true } });
    // Even if config says don't trust, ideTrust should win.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ [process.cwd()]: TrustLevel.DO_NOT_TRUST }),
    );
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'ide',
    });
  });

  it('should return false when ideTrust is false, ignoring config', () => {
    ideContextStore.set({ workspaceState: { isTrusted: false } });
    // Even if config says trust, ideTrust should win.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ [process.cwd()]: TrustLevel.TRUST_FOLDER }),
    );
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: false,
      source: 'ide',
    });
  });

  it('should fall back to config when ideTrust is undefined', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ [process.cwd()]: TrustLevel.TRUST_FOLDER }),
    );
    expect(isWorkspaceTrusted(mockSettings)).toEqual({
      isTrusted: true,
      source: 'file',
    });
  });

  it('should always return true if folderTrust setting is disabled', () => {
    const settings: Settings = {
      security: {
        folderTrust: {
          enabled: false,
        },
      },
    };
    ideContextStore.set({ workspaceState: { isTrusted: false } });
    expect(isWorkspaceTrusted(settings)).toEqual({
      isTrusted: true,
      source: undefined,
    });
  });

  it('should not apply IDE trust to an explicit different workspace', () => {
    ideContextStore.set({ workspaceState: { isTrusted: true } });
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user/current');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === getTrustedFoldersPath(),
    );
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ '/home/user/other': TrustLevel.DO_NOT_TRUST }),
    );

    expect(
      isWorkspaceTrusted(mockSettings, undefined, '/home/user/other'),
    ).toEqual({
      isTrusted: false,
      source: 'file',
    });
  });
});

describe('Trusted Folders Caching', () => {
  beforeEach(() => {
    resetTrustedFoldersForTesting();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should cache the loaded folders object', () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');

    // First call should read the file
    loadTrustedFolders();
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Second call should use the cache
    loadTrustedFolders();
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Resetting should clear the cache
    resetTrustedFoldersForTesting();

    // Third call should read the file again
    loadTrustedFolders();
    expect(readSpy).toHaveBeenCalledTimes(2);
  });
});
