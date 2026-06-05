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
  resetTrustedFoldersForTesting,
} from './trustedFolders.js';
import type { Settings } from './settings.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

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

  it('saveTrustedFolders should preserve disk-only entries when updating a different path', () => {
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
    expect(writtenContent).toContain('// keep this one');
    expect(writtenContent).toContain('"/keep/path": "TRUST_FOLDER"');
    expect(writtenContent).toContain('"/new/path": "TRUST_FOLDER"');
  });

  it('saveTrustedFolders should fall back to a clean rewrite when preserving comments fails during parse', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return '{ invalid jsonc';
      return '{}';
    });

    saveTrustedFolders({
      path: userPath,
      config: {
        '/new/path': TrustLevel.TRUST_FOLDER,
      },
    });

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1]).toBe(
      `{\n  "/new/path": "TRUST_FOLDER"\n}`,
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Falling back to clean rewrite for trusted folders',
      ),
    );
  });

  it('saveTrustedFolders should fall back to a clean rewrite when preserved output validation fails', async () => {
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

    saveTrustedFolders({
      path: userPath,
      config: {
        '/new/path': TrustLevel.TRUST_FOLDER,
      },
    });

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1]).toBe(
      `{\n  "/new/path": "TRUST_FOLDER"\n}`,
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('invalid preserved output'),
    );
  });

  it('saveTrustedFolders should fall back to a clean rewrite when the existing file is a top-level array', () => {
    const userPath = getTrustedFoldersPath();
    const dirPath = path.dirname(userPath);

    (mockFsExistsSync as Mock).mockImplementation(
      (p) => p === userPath || p === dirPath,
    );
    (fs.readFileSync as Mock).mockImplementation((p) => {
      if (p === userPath) return '[]';
      return '{}';
    });

    saveTrustedFolders({
      path: userPath,
      config: {
        '/new/path': TrustLevel.TRUST_FOLDER,
      },
    });

    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1]).toBe(
      `{\n  "/new/path": "TRUST_FOLDER"\n}`,
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('trusted folders file is not a JSON object'),
    );
  });

  it.each(['"hello"', '42', 'true', 'null'])(
    'saveTrustedFolders should fall back to a clean rewrite when the existing file is a top-level primitive: %s',
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

      saveTrustedFolders({
        path: userPath,
        config: {
          '/new/path': TrustLevel.TRUST_FOLDER,
        },
      });

      expect(atomicWriteFileSync).toHaveBeenCalledTimes(1);
      expect(vi.mocked(atomicWriteFileSync).mock.calls[0]?.[1]).toBe(
        `{\n  "/new/path": "TRUST_FOLDER"\n}`,
      );
      expect(writeStderrLine).toHaveBeenCalledWith(
        expect.stringContaining('trusted folders file is not a JSON object'),
      );
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
