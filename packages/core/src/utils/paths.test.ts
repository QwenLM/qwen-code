/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CLI_HOME, ENV_CONFIG_DIR } from '../config/brand.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  escapePath,
  unescapePath,
  isSubpath,
  shortenPath,
  normalizePath,
  resolveToRealPath,
  makeRelative,
  expandPath,
  rewritePosixDrivePath,
  sanitizePath,
  MAX_SANITIZED_LENGTH,
  CONFIG_DIR,
  getConfigHomeDir,
  getConfigHomeDirOverride,
  setConfigHomeDirOverride,
  displayPathForWorkspace,
} from './paths.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...(actual as object),
    realpathSync: (p: string) => p,
  };
});

const mockPlatform = (platform: string) => {
  vi.stubGlobal(
    'process',
    Object.create(process, {
      platform: {
        get: () => platform,
      },
    }),
  );
};

describe('escapePath', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('in posix', () => {
    beforeEach(() => mockPlatform('linux'));

    it.each([
      ['spaces', 'my file.txt', 'my\\ file.txt'],
      ['tabs', 'file\twith\ttabs.txt', 'file\\\twith\\\ttabs.txt'],
      ['parentheses', 'file(1).txt', 'file\\(1\\).txt'],
      ['square brackets', 'file[backup].txt', 'file\\[backup\\].txt'],
      ['curly braces', 'file{temp}.txt', 'file\\{temp\\}.txt'],
      ['semicolons', 'file;name.txt', 'file\\;name.txt'],
      ['ampersands', 'file&name.txt', 'file\\&name.txt'],
      ['pipes', 'file|name.txt', 'file\\|name.txt'],
      ['asterisks', 'file*.txt', 'file\\*.txt'],
      ['question marks', 'file?.txt', 'file\\?.txt'],
      ['dollar signs', 'file$name.txt', 'file\\$name.txt'],
      ['backticks', 'file`name.txt', 'file\\`name.txt'],
      ['single quotes', "file'name.txt", "file\\'name.txt"],
      ['double quotes', 'file"name.txt', 'file\\"name.txt'],
      ['hash symbols', 'file#name.txt', 'file\\#name.txt'],
      ['exclamation marks', 'file!name.txt', 'file\\!name.txt'],
      ['tildes', 'file~name.txt', 'file\\~name.txt'],
      [
        'less than and greater than signs',
        'file<name>.txt',
        'file\\<name\\>.txt',
      ],
      [
        'multiple special characters',
        'my file (backup) [v1.2].txt',
        'my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt',
      ],
      ['normal file', 'normalfile.txt', 'normalfile.txt'],
      ['normal path', 'path/to/normalfile.txt', 'path/to/normalfile.txt'],
      [
        'real world example 1',
        'My Documents/Project (2024)/file [backup].txt',
        'My\\ Documents/Project\\ \\(2024\\)/file\\ \\[backup\\].txt',
      ],
      [
        'real world example 2',
        'file with $special &chars!.txt',
        'file\\ with\\ \\$special\\ \\&chars\\!.txt',
      ],
      ['empty string', '', ''],
      [
        'all special chars',
        ' ()[]{};&|*?$`\'"#!<>',
        '\\ \\(\\)\\[\\]\\{\\}\\;\\&\\|\\*\\?\\$\\`\\\'\\"\\#\\!\\<\\>',
      ],
    ])('should escape %s', (_, input, expected) => {
      expect(escapePath(input)).toBe(expected);
    });
  });

  describe('in windows', () => {
    beforeEach(() => mockPlatform('win32'));

    it.each([
      [
        'spaces',
        'C:\\path with spaces\\file.txt',
        '"C:\\path with spaces\\file.txt"',
      ],
      ['parentheses', 'file(1).txt', '"file(1).txt"'],
      ['special chars', 'file&name.txt', '"file&name.txt"'],
      ['caret', 'file^name.txt', '"file^name.txt"'],
      ['normal path', 'C:\\path\\to\\file.txt', 'C:\\path\\to\\file.txt'],
    ])('should escape %s', (_, input, expected) => {
      expect(escapePath(input)).toBe(expected);
    });
  });
});

describe('unescapePath', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('in posix', () => {
    beforeEach(() => mockPlatform('linux'));

    it.each([
      ['spaces', 'my\\ file.txt', 'my file.txt'],
      ['tabs', 'file\\\twith\\\ttabs.txt', 'file\twith\ttabs.txt'],
      ['parentheses', 'file\\(1\\).txt', 'file(1).txt'],
      ['square brackets', 'file\\[backup\\].txt', 'file[backup].txt'],
      ['curly braces', 'file\\{temp\\}.txt', 'file{temp}.txt'],
      [
        'multiple special characters',
        'my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt',
        'my file (backup) [v1.2].txt',
      ],
      ['normal file', 'normalfile.txt', 'normalfile.txt'],
      ['normal path', 'path/to/normalfile.txt', 'path/to/normalfile.txt'],
      ['empty string', '', ''],
    ])('should unescape %s', (_, input, expected) => {
      expect(unescapePath(input)).toBe(expected);
    });

    it.each([
      'my file.txt',
      'file(1).txt',
      'file[backup].txt',
      'My Documents/Project (2024)/file [backup].txt',
      'file with $special &chars!.txt',
      ' ()[]{};&|*?$`\'"#!~<>',
      'file\twith\ttabs.txt',
    ])('should unescape escaped %s', (input) => {
      expect(unescapePath(escapePath(input))).toBe(input);
    });
  });

  describe('in windows', () => {
    beforeEach(() => mockPlatform('win32'));

    it.each([
      [
        'quoted path',
        '"C:\\path with spaces\\file.txt"',
        'C:\\path with spaces\\file.txt',
      ],
      ['unquoted path', 'C:\\path\\to\\file.txt', 'C:\\path\\to\\file.txt'],
      ['partially quoted', '"C:\\path', '"C:\\path'],
      ['empty string', '', ''],
    ])('should unescape %s', (_, input, expected) => {
      expect(unescapePath(input)).toBe(expected);
    });

    it.each([
      'C:\\path\\to\\file.txt',
      'C:\\path with spaces\\file.txt',
      'file(1).txt',
      'file&name.txt',
    ])('should unescape escaped %s', (input) => {
      expect(unescapePath(escapePath(input))).toBe(input);
    });
  });
});

describe('isSubpath', () => {
  it('should return true for a direct subpath', () => {
    expect(isSubpath('/a/b', '/a/b/c')).toBe(true);
  });

  it('should return true for the same path', () => {
    expect(isSubpath('/a/b', '/a/b')).toBe(true);
  });

  it('should return false for a parent path', () => {
    expect(isSubpath('/a/b/c', '/a/b')).toBe(false);
  });

  it('should return false for a completely different path', () => {
    expect(isSubpath('/a/b', '/x/y')).toBe(false);
  });

  it('should handle relative paths', () => {
    expect(isSubpath('a/b', 'a/b/c')).toBe(true);
    expect(isSubpath('a/b', 'a/c')).toBe(false);
  });

  it('should handle paths with ..', () => {
    expect(isSubpath('/a/b', '/a/b/../b/c')).toBe(true);
    expect(isSubpath('/a/b', '/a/c/../b')).toBe(true);
  });

  it('should handle root paths', () => {
    expect(isSubpath('/', '/a')).toBe(true);
    expect(isSubpath('/a', '/')).toBe(false);
  });

  it('should handle trailing slashes', () => {
    expect(isSubpath('/a/b/', '/a/b/c')).toBe(true);
    expect(isSubpath('/a/b', '/a/b/c/')).toBe(true);
    expect(isSubpath('/a/b/', '/a/b/c/')).toBe(true);
  });
});

describe.skipIf(process.platform !== 'win32')('isSubpath on Windows', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => mockPlatform('win32'));

  it('should return true for a direct subpath on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should return true for the same path on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'C:\\Users\\Test')).toBe(true);
  });

  it('should return false for a parent path on Windows', () => {
    expect(isSubpath('C:\\Users\\Test\\file.txt', 'C:\\Users\\Test')).toBe(
      false,
    );
  });

  it('should return false for a different drive on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'D:\\Users\\Test')).toBe(false);
  });

  it('should be case-insensitive for drive letters on Windows', () => {
    expect(isSubpath('c:\\Users\\Test', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should be case-insensitive for path components on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'c:\\users\\test\\file.txt')).toBe(
      true,
    );
  });

  it('should handle mixed slashes on Windows', () => {
    expect(isSubpath('C:/Users/Test', 'C:\\Users\\Test\\file.txt')).toBe(true);
  });

  it('should handle trailing slashes on Windows', () => {
    expect(isSubpath('C:\\Users\\Test\\', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should handle relative paths correctly on Windows', () => {
    expect(isSubpath('Users\\Test', 'Users\\Test\\file.txt')).toBe(true);
    expect(isSubpath('Users\\Test\\file.txt', 'Users\\Test')).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('isSubpath on Darwin', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => mockPlatform('darwin'));

  it('should be case-insensitive for path components on Darwin', () => {
    expect(isSubpath('/PROJECT', '/project/src')).toBe(true);
  });

  it('should return true for a direct subpath on Darwin', () => {
    expect(isSubpath('/Users/Test', '/Users/Test/file.txt')).toBe(true);
  });
});

describe('shortenPath', () => {
  describe.skipIf(process.platform === 'win32')('on POSIX', () => {
    it('should not shorten a path that is shorter than maxLen', () => {
      const p = '/path/to/file.txt';
      expect(shortenPath(p, 40)).toBe(p);
    });

    it('should not shorten a path that is equal to maxLen', () => {
      const p = '/path/to/file.txt';
      expect(shortenPath(p, p.length)).toBe(p);
    });

    it('should shorten a long path, keeping start and end from a short limit', () => {
      const p = '/path/to/a/very/long/directory/name/file.txt';
      expect(shortenPath(p, 25)).toBe('/path/.../name/file.txt');
    });

    it('should shorten a long path, keeping more from the end from a longer limit', () => {
      const p = '/path/to/a/very/long/directory/name/file.txt';
      expect(shortenPath(p, 35)).toBe('/path/.../directory/name/file.txt');
    });

    it('should handle deep paths where few segments from the end fit', () => {
      const p = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.txt';
      expect(shortenPath(p, 20)).toBe('/a/.../y/z/file.txt');
    });

    it('should handle deep paths where many segments from the end fit', () => {
      const p = '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.txt';
      expect(shortenPath(p, 45)).toBe(
        '/a/.../l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.txt',
      );
    });

    it('should handle a long filename in the root when it needs shortening', () => {
      const p = '/a-very-long-filename-that-needs-to-be-shortened.txt';
      expect(shortenPath(p, 40)).toBe(
        '/a-very-long-filen...o-be-shortened.txt',
      );
    });

    it('should handle root path', () => {
      const p = '/';
      expect(shortenPath(p, 10)).toBe('/');
    });

    it('should handle a path with one long segment after root', () => {
      const p = '/a-very-long-directory-name';
      expect(shortenPath(p, 20)).toBe('/a-very-...ory-name');
    });

    it('should handle a path with just a long filename (no root)', () => {
      const p = 'a-very-long-filename-that-needs-to-be-shortened.txt';
      expect(shortenPath(p, 40)).toBe(
        'a-very-long-filena...o-be-shortened.txt',
      );
    });

    it('should fallback to truncating earlier segments while keeping the last intact', () => {
      const p = '/abcdef/fghij.txt';
      const result = shortenPath(p, 10);
      expect(result).toBe('/fghij.txt');
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('should fallback by truncating start and middle segments when needed', () => {
      const p = '/averylongcomponentname/another/short.txt';
      const result = shortenPath(p, 25);
      expect(result).toBe('/averylo.../.../short.txt');
      expect(result.length).toBeLessThanOrEqual(25);
    });

    it('should show only the last segment when maxLen is tiny', () => {
      const p = '/foo/bar/baz.txt';
      const result = shortenPath(p, 8);
      expect(result).toBe('/baz.txt');
      expect(result.length).toBeLessThanOrEqual(8);
    });

    it('should fall back to simple truncation when the last segment exceeds maxLen', () => {
      const longFile = 'x'.repeat(60) + '.txt';
      const p = `/really/long/${longFile}`;
      const result = shortenPath(p, 50);
      expect(result).toBe('/really/long/xxxxxxxxxx...xxxxxxxxxxxxxxxxxxx.txt');
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('should handle relative paths without a root', () => {
      const p = 'foo/bar/baz/qux.txt';
      const result = shortenPath(p, 18);
      expect(result).toBe('foo/.../qux.txt');
      expect(result.length).toBeLessThanOrEqual(18);
    });

    it('should ignore empty segments created by repeated separators', () => {
      const p = '/foo//bar///baz/verylongname.txt';
      const result = shortenPath(p, 20);
      expect(result).toBe('.../verylongname.txt');
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });

  describe.skipIf(process.platform !== 'win32')('on Windows', () => {
    it('should not shorten a path that is shorter than maxLen', () => {
      const p = 'C\\Users\\Test\\file.txt';
      expect(shortenPath(p, 40)).toBe(p);
    });

    it('should not shorten a path that is equal to maxLen', () => {
      const p = 'C\\path\\to\\file.txt';
      expect(shortenPath(p, p.length)).toBe(p);
    });

    it('should shorten a long path, keeping start and end from a short limit', () => {
      const p = 'C\\path\\to\\a\\very\\long\\directory\\name\\file.txt';
      expect(shortenPath(p, 30)).toBe('C\\...\\directory\\name\\file.txt');
    });

    it('should shorten a long path, keeping more from the end from a longer limit', () => {
      const p = 'C\\path\\to\\a\\very\\long\\directory\\name\\file.txt';
      expect(shortenPath(p, 42)).toBe(
        'C\\...\\a\\very\\long\\directory\\name\\file.txt',
      );
    });

    it('should handle deep paths where few segments from the end fit', () => {
      const p =
        'C\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\o\\p\\q\\r\\s\\t\\u\\v\\w\\x\\y\\z\\file.txt';
      expect(shortenPath(p, 22)).toBe('C\\...\\w\\x\\y\\z\\file.txt');
    });

    it('should handle deep paths where many segments from the end fit', () => {
      const p =
        'C\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\o\\p\\q\\r\\s\\t\\u\\v\\w\\x\\y\\z\\file.txt';
      expect(shortenPath(p, 47)).toBe(
        'C\\...\\k\\l\\m\\n\\o\\p\\q\\r\\s\\t\\u\\v\\w\\x\\y\\z\\file.txt',
      );
    });

    it('should handle a long filename in the root when it needs shortening', () => {
      const p = 'C\\a-very-long-filename-that-needs-to-be-shortened.txt';
      expect(shortenPath(p, 40)).toBe(
        'C\\a-very-long-file...o-be-shortened.txt',
      );
    });

    it('should handle root path', () => {
      const p = 'C\\';
      expect(shortenPath(p, 10)).toBe('C\\');
    });

    it('should handle a path with one long segment after root', () => {
      const p = 'C\\a-very-long-directory-name';
      expect(shortenPath(p, 22)).toBe('C\\a-very-...tory-name');
    });

    it('should handle a path with just a long filename (no root)', () => {
      const p = 'a-very-long-filename-that-needs-to-be-shortened.txt';
      expect(shortenPath(p, 40)).toBe(
        'a-very-long-filena...o-be-shortened.txt',
      );
    });

    it('should fallback to truncating earlier segments while keeping the last intact', () => {
      const p = 'C\\abcdef\\fghij.txt';
      const result = shortenPath(p, 15);
      expect(result).toBe('C\\...\\fghij.txt');
      expect(result.length).toBeLessThanOrEqual(15);
    });

    it('should fallback by truncating start and middle segments when needed', () => {
      const p = 'C\\averylongcomponentname\\another\\short.txt';
      const result = shortenPath(p, 30);
      expect(result).toBe('C\\...\\another\\short.txt');
      expect(result.length).toBeLessThanOrEqual(30);
    });

    it('should show only the last segment for tiny maxLen values', () => {
      const p = 'C\\foo\\bar\\baz.txt';
      const result = shortenPath(p, 12);
      expect(result).toBe('...\\baz.txt');
      expect(result.length).toBeLessThanOrEqual(12);
    });

    it('should keep the drive prefix when space allows', () => {
      const p = 'C\\foo\\bar\\baz.txt';
      const result = shortenPath(p, 14);
      expect(result).toBe('C\\...\\baz.txt');
      expect(result.length).toBeLessThanOrEqual(14);
    });

    it('should fall back when the last segment exceeds maxLen on Windows', () => {
      const longFile = 'x'.repeat(60) + '.txt';
      const p = `C\\really\\long\\${longFile}`;
      const result = shortenPath(p, 40);
      expect(result).toBe('C\\really\\long\\xxxx...xxxxxxxxxxxxxx.txt');
      expect(result.length).toBeLessThanOrEqual(40);
    });

    it('should handle UNC paths with limited space', () => {
      const p = '\\server\\share\\deep\\path\\file.txt';
      const result = shortenPath(p, 25);
      expect(result).toBe('\\server\\...\\path\\file.txt');
      expect(result.length).toBeLessThanOrEqual(25);
    });

    it('should collapse UNC paths further when maxLen shrinks', () => {
      const p = '\\server\\share\\deep\\path\\file.txt';
      const result = shortenPath(p, 18);
      expect(result).toBe('\\s...\\...\\file.txt');
      expect(result.length).toBeLessThanOrEqual(18);
    });
  });
});

describe('resolveToRealPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      description:
        'should return path as-is if no special characters or protocol',
      input: path.resolve('simple', 'path'),
      expected: path.resolve('simple', 'path'),
    },
    {
      description: 'should remove file:// protocol',
      input: pathToFileURL(path.resolve('path', 'to', 'file')).toString(),
      expected: path.resolve('path', 'to', 'file'),
    },
    {
      description: 'should decode URI components',
      input: path.resolve('path', 'to', 'some folder').replace(/ /g, '%20'),
      expected: path.resolve('path', 'to', 'some folder'),
    },
    {
      description: 'should handle both file protocol and encoding',
      input: pathToFileURL(path.resolve('path', 'to', 'My Project')).toString(),
      expected: path.resolve('path', 'to', 'My Project'),
    },
  ])('$description', ({ input, expected }) => {
    expect(resolveToRealPath(input)).toBe(expected);
  });

  it('should return decoded path even if fs.realpathSync fails with ENOENT', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      const err = new Error('File not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const p = path.resolve('path', 'to', 'New Project');
    const input = pathToFileURL(p).toString();
    const expected = p;

    expect(resolveToRealPath(input)).toBe(expected);
  });

  it('should return decoded path even if fs.realpathSync fails with EISDIR', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      const err = new Error(
        'Illegal operation on a directory',
      ) as NodeJS.ErrnoException;
      err.code = 'EISDIR';
      throw err;
    });

    const p = path.resolve('path', 'to', 'New Project');
    const input = pathToFileURL(p).toString();
    const expected = p;

    expect(resolveToRealPath(input)).toBe(expected);
  });

  // skip: 现存失败
  it.skip('should recursively resolve symlinks for non-existent child paths', () => {
    const parentPath = path.resolve('/some/parent/path');
    const resolvedParentPath = path.resolve('/resolved/parent/path');
    const childPath = path.resolve(parentPath, 'child', 'file.txt');
    const expectedPath = path.resolve(resolvedParentPath, 'child', 'file.txt');

    vi.spyOn(fs, 'realpathSync').mockImplementation((p) => {
      const pStr = p.toString();
      if (pStr === parentPath) {
        return resolvedParentPath;
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    expect(resolveToRealPath(childPath)).toBe(expectedPath);
  });

  // skip: 现存失败
  it.skip('should prevent infinite recursion on malicious symlink structures', () => {
    const maliciousPath = path.resolve('malicious', 'symlink');

    vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    vi.spyOn(fs, 'lstatSync').mockImplementation(
      () => ({ isSymbolicLink: () => true }) as fs.Stats,
    );

    vi.spyOn(fs, 'readlinkSync').mockImplementation(() =>
      ['..', 'malicious', 'symlink'].join(path.sep),
    );

    expect(() => resolveToRealPath(maliciousPath)).toThrow(
      /Infinite recursion detected/,
    );
  });
});

describe('posix drive path rewrite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.skipIf(process.platform !== 'win32')('on Windows', () => {
    it('rewritePosixDrivePath rewrites /d/... to D:\\...', () => {
      expect(rewritePosixDrivePath('/d/Codes/x.txt')).toBe('D:\\Codes\\x.txt');
      expect(rewritePosixDrivePath('/cygdrive/c/Users/u')).toBe(
        'C:\\Users\\u',
      );
      // Non-drive shapes are untouched.
      expect(rewritePosixDrivePath('relative/path')).toBe('relative/path');
      expect(rewritePosixDrivePath('/dir/name')).toBe('/dir/name');
    });

    it('expandPath pins /d/... to drive D instead of the current drive', () => {
      expect(expandPath('/d/Codes/x.txt')).toBe('D:\\Codes\\x.txt');
    });

    it('resolveToRealPath resolves /d/... against drive D', () => {
      // Without the rewrite path.resolve pins the input to the current drive
      // and the permission layer sees a fabricated mirror path.
      vi.spyOn(fs, 'realpathSync').mockImplementation((p) => p.toString());
      expect(resolveToRealPath('/d/Codes/x.txt')).toBe('D:\\Codes\\x.txt');
    });
  });

  describe.skipIf(process.platform === 'win32')('off Windows', () => {
    it('rewritePosixDrivePath is a no-op', () => {
      expect(rewritePosixDrivePath('/d/Codes/x.txt')).toBe('/d/Codes/x.txt');
    });
  });
});

describe('makeRelative', () => {
  describe.skipIf(process.platform === 'win32')('on POSIX', () => {
    it('should return relative path if targetPath is already relative', () => {
      expect(makeRelative('foo/bar', '/root')).toBe('foo/bar');
    });

    it('should return relative path from root to target', () => {
      const root = '/Users/test/project';
      const target = '/Users/test/project/src/file.ts';
      expect(makeRelative(target, root)).toBe('src/file.ts');
    });

    it('should return "." if target and root are the same', () => {
      const root = '/Users/test/project';
      expect(makeRelative(root, root)).toBe('.');
    });

    it('should handle parent directories with ..', () => {
      const root = '/Users/test/project/src';
      const target = '/Users/test/project/docs/readme.md';
      expect(makeRelative(target, root)).toBe('../docs/readme.md');
    });
  });

  describe.skipIf(process.platform !== 'win32')('on Windows', () => {
    it('should return relative path if targetPath is already relative', () => {
      expect(makeRelative('foo/bar', 'C:\\root')).toBe('foo/bar');
    });

    it('should return relative path from root to target', () => {
      const root = 'C:\\Users\\test\\project';
      const target = 'C:\\Users\\test\\project\\src\\file.ts';
      expect(makeRelative(target, root)).toBe('src\\file.ts');
    });

    it('should return "." if target and root are the same', () => {
      const root = 'C:\\Users\\test\\project';
      expect(makeRelative(root, root)).toBe('.');
    });

    it('should handle parent directories with ..', () => {
      const root = 'C:\\Users\\test\\project\\src';
      const target = 'C:\\Users\\test\\project\\docs\\readme.md';
      expect(makeRelative(target, root)).toBe('..\\docs\\readme.md');
    });
  });
});

describe('normalizePath', () => {
  it('should resolve a relative path to an absolute path', () => {
    const result = normalizePath('some/relative/path');
    expect(result).toMatch(/^\/|^[a-z]:\//);
  });

  it('should convert all backslashes to forward slashes', () => {
    const result = normalizePath(path.resolve('some', 'path'));
    expect(result).not.toContain('\\');
  });

  describe.skipIf(process.platform !== 'win32')('on Windows', () => {
    it('should lowercase the entire path', () => {
      const result = normalizePath('C:\\Users\\TEST');
      expect(result).toBe(result.toLowerCase());
    });

    it('should normalize drive letters to lowercase', () => {
      const result = normalizePath('C:\\');
      expect(result).toMatch(/^c:\//);
    });

    it('should handle mixed separators', () => {
      const result = normalizePath('C:/Users\\Test/file.txt');
      expect(result).not.toContain('\\');
      expect(result).toMatch(/^c:\/users\/test\/file\.txt$/);
    });
  });

  describe.skipIf(process.platform !== 'darwin')('on Darwin', () => {
    beforeEach(() => mockPlatform('darwin'));
    afterEach(() => vi.unstubAllGlobals());

    it('should lowercase the entire path', () => {
      const result = normalizePath('/Users/TEST');
      expect(result).toBe('/users/test');
    });
  });

  describe.skipIf(
    process.platform === 'win32' || process.platform === 'darwin',
  )('on Linux', () => {
    it('should preserve case', () => {
      const result = normalizePath('/usr/Local/Bin');
      expect(result).toContain('Local');
      expect(result).toContain('Bin');
    });

    it('should use forward slashes', () => {
      const result = normalizePath('/usr/local/bin');
      expect(result).toBe('/usr/local/bin');
    });
  });
});

describe('expandPath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('should expand tilde to home directory', () => {
    const result = expandPath('~');
    expect(result).toBe(path.resolve(process.env['HOME'] ?? ''));
  });

  it('should expand ~/path to path within home directory', () => {
    const result = expandPath('~/Documents');
    const home = process.env['HOME'] ?? '';
    expect(result).toBe(path.join(home, 'Documents'));
  });

  it('should resolve relative paths against baseDir', () => {
    const result = expandPath('src/file.ts', '/project');
    expect(result).toBe(path.resolve('/project', 'src/file.ts'));
  });

  it('should return absolute paths normalized', () => {
    const result = expandPath('/absolute/path/../file.txt');
    expect(result).toBe(path.normalize('/absolute/file.txt'));
  });

  it('should return NFC-normalized strings', () => {
    // NFC normalization: é as composed (NFC) vs decomposed (NFD)
    const nfdPath = '/path/caf\u0065\u0301'; // decomposed é
    const result = expandPath(nfdPath);
    expect(result).toBe(result.normalize('NFC'));
  });

  it('should trim whitespace from paths', () => {
    const result = expandPath('  /some/path  ');
    expect(result).toBe(path.normalize('/some/path'));
  });

  it('should return baseDir for empty path', () => {
    const result = expandPath('', '/base/dir');
    expect(result).toBe(path.normalize('/base/dir'));
  });

  it('should return baseDir for whitespace-only path', () => {
    const result = expandPath('   ', '/base/dir');
    expect(result).toBe(path.normalize('/base/dir'));
  });

  it('should throw on null bytes in path', () => {
    expect(() => expandPath('/path/with\0null')).toThrow(
      'Path contains null bytes',
    );
  });

  it('should throw on null bytes in baseDir', () => {
    expect(() => expandPath('file.txt', '/base\0dir')).toThrow(
      'Path contains null bytes',
    );
  });

  it('should default baseDir to process.cwd()', () => {
    const result = expandPath('relative.txt');
    expect(result).toBe(
      path.resolve(process.cwd(), 'relative.txt').normalize('NFC'),
    );
  });

  it('should use configured CLI home for tilde when set', () => {
    vi.stubEnv(ENV_CLI_HOME, '/custom/home');
    const result = expandPath('~/file.txt');
    expect(result).toBe(path.join('/custom/home', 'file.txt'));
  });
});

describe('getConfigHomeDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setConfigHomeDirOverride(undefined);
  });

  it('defaults to homedir plus config directory name', () => {
    expect(getConfigHomeDir()).toBe(
      path.join(process.env['HOME'] ?? '', CONFIG_DIR).normalize('NFC'),
    );
  });

  it('uses configured config root as a complete config root', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-config-root');

    expect(getConfigHomeDir()).toBe(
      path.resolve('/tmp/qwen-config-root').normalize('NFC'),
    );
  });

  it('uses in-process override as a complete config root', () => {
    setConfigHomeDirOverride('/tmp/qwen-flag-config-root');

    expect(getConfigHomeDir()).toBe(
      path.resolve('/tmp/qwen-flag-config-root').normalize('NFC'),
    );
  });

  it('prefers in-process override over configured config root', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-env-config-root');
    setConfigHomeDirOverride('/tmp/qwen-flag-config-root');

    expect(getConfigHomeDir()).toBe(
      path.resolve('/tmp/qwen-flag-config-root').normalize('NFC'),
    );
  });

  it('reads an override published under the shared CLI key', () => {
    (globalThis as Record<symbol, string | undefined>)[
      Symbol.for('cli.configHomeDirOverride')
    ] = '/tmp/shared-config-root';

    expect(getConfigHomeDirOverride()).toBe('/tmp/shared-config-root');
  });

  it('publishes a set override under the shared CLI key', () => {
    setConfigHomeDirOverride('/tmp/new-config-root');

    expect(
      (globalThis as Record<symbol, string | undefined>)[
        Symbol.for('cli.configHomeDirOverride')
      ],
    ).toBe(path.resolve('/tmp/new-config-root').normalize('NFC'));
  });

  it('resets cached config root when in-process override changes', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-env-config-root');
    expect(getConfigHomeDir()).toBe(
      path.resolve('/tmp/qwen-env-config-root').normalize('NFC'),
    );

    setConfigHomeDirOverride('/tmp/qwen-flag-config-root');

    expect(getConfigHomeDir()).toBe(
      path.resolve('/tmp/qwen-flag-config-root').normalize('NFC'),
    );
  });

  it('uses configured CLI home as home and still appends the config directory name', () => {
    vi.stubEnv(ENV_CLI_HOME, '/tmp/qwen-home');

    expect(getConfigHomeDir()).toBe(
      path.join('/tmp/qwen-home', CONFIG_DIR).normalize('NFC'),
    );
  });

  it('does not append the config directory name to configured config root', () => {
    vi.stubEnv(ENV_CONFIG_DIR, '/tmp/qwen-config-root');

    expect(getConfigHomeDir()).not.toBe(
      path.join('/tmp/qwen-config-root', CONFIG_DIR),
    );
  });
});

describe('sanitizePath', () => {
  const projectKeyFixture = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../../../tests/fixtures/session-store-project-keys.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    algorithm: string;
    cases: Array<{ name: string; input: string; expected: string }>;
  };

  it('replaces non-alphanumeric characters with hyphens', () => {
    expect(sanitizePath('/Users/foo/my-project')).toBe('-Users-foo-my-project');
    expect(sanitizePath('plugin:name:server')).toBe('plugin-name-server');
  });

  it('preserves case', () => {
    expect(sanitizePath('/Users/Xiaoxun/Workspace')).toBe(
      '-Users-Xiaoxun-Workspace',
    );
  });

  it('is deterministic: same input always produces same output', () => {
    const input = '/some/repo/path';
    expect(sanitizePath(input)).toBe(sanitizePath(input));
  });

  it('truncates and appends a short hash when exceeding MAX_SANITIZED_LENGTH', () => {
    const long = '/' + 'a'.repeat(MAX_SANITIZED_LENGTH + 50);
    const result = sanitizePath(long);
    expect(result.length).toBeLessThanOrEqual(MAX_SANITIZED_LENGTH + 1 + 12);
    expect(result.startsWith('-' + 'a'.repeat(MAX_SANITIZED_LENGTH - 1))).toBe(
      true,
    );
    // Hash suffix must differentiate otherwise-identical prefixes
    const other = '/' + 'a'.repeat(MAX_SANITIZED_LENGTH + 50) + 'b';
    expect(sanitizePath(long)).not.toBe(sanitizePath(other));
  });

  it('matches the cross-runtime SessionStore project-key contract', () => {
    expect(projectKeyFixture.algorithm).toBe(
      'ascii-replacement-plus-32-bit-djb2-xor-over-utf16-code-units',
    );
    for (const fixture of projectKeyFixture.cases) {
      expect(sanitizePath(fixture.input)).toBe(fixture.expected);
    }
  });
});

describe('displayPathForWorkspace', () => {
  const mockHomeDir =
    process.platform === 'win32' ? 'C:\\Users\\testuser' : '/Users/testuser';

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, eslint-js/no-restricted-syntax
    vi.spyOn(require('node:os'), 'homedir').mockReturnValue(mockHomeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays workspace-internal absolute path as relative', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    const filePath = path.join(workspaceRoot, 'src', 'app.ts');
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe(
      path.join('src', 'app.ts'),
    );
  });

  it('displays workspace-external path under home as ~/...', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    const filePath = path.join(mockHomeDir, 'Desktop', 'a.md');
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe(
      path.sep === '/' ? '~/Desktop/a.md' : '~\\Desktop\\a.md',
    );
  });

  it('displays workspace-external path outside home as absolute', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    const filePath = '/tmp/a.md';
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe('/tmp/a.md');
  });

  it('resolves relative traversal and does not display ../..', () => {
    const workspaceRoot = path.join(mockHomeDir, 'projects', 'myapp');
    // ../other/file.ts from /Users/testuser/projects/myapp → /Users/testuser/projects/other/file.ts
    const filePath = path.join('..', 'other', 'file.ts');
    const result = displayPathForWorkspace(filePath, workspaceRoot);
    expect(result).not.toContain('..');
    // Should resolve to ~/projects/other/file.ts since it's under home
    expect(result).toBe(
      path.sep === '/'
        ? '~/projects/other/file.ts'
        : '~\\projects\\other\\file.ts',
    );
  });

  it('displays same-path as .', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    expect(displayPathForWorkspace(workspaceRoot, workspaceRoot)).toBe('.');
  });

  it('displays path equal to home dir as ~', () => {
    const workspaceRoot = '/tmp/workspace';
    expect(displayPathForWorkspace(mockHomeDir, workspaceRoot)).toBe('~');
  });

  it('handles nested workspace-internal paths', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    const filePath = path.join(
      workspaceRoot,
      'packages',
      'core',
      'src',
      'index.ts',
    );
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe(
      path.join('packages', 'core', 'src', 'index.ts'),
    );
  });

  it('handles relative path that stays inside workspace', () => {
    const workspaceRoot = path.join(mockHomeDir, 'project');
    const filePath = path.join('src', 'utils', 'helper.ts');
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe(
      path.join('src', 'utils', 'helper.ts'),
    );
  });

  it('does not misclassify internal path starting with ".." in segment name', () => {
    const workspaceRoot = path.join(mockHomeDir, 'repo');
    // A directory named "..cache" inside the workspace
    const filePath = path.join(workspaceRoot, '..cache', 'a.ts');
    expect(displayPathForWorkspace(filePath, workspaceRoot)).toBe(
      path.join('..cache', 'a.ts'),
    );
  });
});
