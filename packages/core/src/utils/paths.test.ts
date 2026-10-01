/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from 'vitest';
import {
  escapePath,
  formatDisplayPath,
  resolvePath,
  validatePath,
  resolveAndValidatePath,
  unescapePath,
  isSubpath,
  shortenPath,
  tildeifyPath,
  expandHomeDir,
  getProjectHash,
  realpathNearestExisting,
  realpathNearestExistingAsync,
  _resetValidatePathCacheForTest,
} from './paths.js';
import type { Config } from '../config/config.js';

const { sep } = path;
const homeDir = os.homedir();

// One test per row: [title, ...checks], where each check is [...args,
// expected] and runs one toBe assertion, in order. The test is named by
// substituting the row title for %s in `name`.
function table<A extends unknown[]>(
  name: string,
  fn: (...args: A) => unknown,
  rows: Array<[string, ...Array<[...A, unknown]>]>,
) {
  const named = rows.map(([title, ...checks]): (typeof rows)[number] => [
    name.replace('%s', () => title),
    ...checks,
  ]);
  it.each(named)('%s', (_title, ...checks) => {
    for (const check of checks) {
      expect(fn(...(check.slice(0, -1) as A))).toBe(check[check.length - 1]);
    }
  });
}

function createConfigStub(
  targetDir: string,
  allowedDirectories: string[],
): Config {
  const resolvedTargetDir = path.resolve(targetDir);
  const resolvedDirectories = allowedDirectories.map((dir) =>
    path.resolve(dir),
  );
  const workspaceContext = {
    isPathWithinWorkspace(testPath: string) {
      const resolvedPath = path.resolve(testPath);
      return resolvedDirectories.some((dir) => {
        const relative = path.relative(dir, resolvedPath);
        return (
          relative === '' ||
          (!relative.startsWith('..') && !path.isAbsolute(relative))
        );
      });
    },
    getDirectories: () => resolvedDirectories,
  };
  return {
    getTargetDir: () => resolvedTargetDir,
    getWorkspaceContext: () => workspaceContext,
  } as unknown as Config;
}

// A temp workspace containing subdir/, which is the target and only allowed
// directory of `config`.
function useWorkspace(prefix: string) {
  const ws = {
    root: '',
    config: {} as Config,
    // Creates <root>/<name> for the duration of fn.
    withFile(name: string, fn: (filePath: string) => void) {
      const filePath = path.join(ws.root, name);
      fs.writeFileSync(filePath, 'content');
      try {
        fn(filePath);
      } finally {
        fs.rmSync(filePath);
      }
    },
    // Runs fn with an extra temp dir and a config that also allows it.
    withExtraDir(dirPrefix: string, fn: (dir: string, config: Config) => void) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
      try {
        fn(dir, createConfigStub(ws.root, [ws.root, dir]));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
  beforeAll(() => {
    ws.root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(ws.root, 'subdir'));
    ws.config = createConfigStub(ws.root, [ws.root]);
  });
  afterAll(() => {
    fs.rmSync(ws.root, { recursive: true, force: true });
  });
  return ws;
}

describe('escapePath', () => {
  table('should escape %s', escapePath, [
    ['spaces', ['my file.txt', 'my\\ file.txt']],
    ['tabs', ['file\twith\ttabs.txt', 'file\\\twith\\\ttabs.txt']],
    ['parentheses', ['file(1).txt', 'file\\(1\\).txt']],
    ['square brackets', ['file[backup].txt', 'file\\[backup\\].txt']],
    ['curly braces', ['file{temp}.txt', 'file\\{temp\\}.txt']],
    ['semicolons', ['file;name.txt', 'file\\;name.txt']],
    ['ampersands', ['file&name.txt', 'file\\&name.txt']],
    ['pipes', ['file|name.txt', 'file\\|name.txt']],
    ['asterisks', ['file*.txt', 'file\\*.txt']],
    ['question marks', ['file?.txt', 'file\\?.txt']],
    ['dollar signs', ['file$name.txt', 'file\\$name.txt']],
    ['backticks', ['file`name.txt', 'file\\`name.txt']],
    ['single quotes', ["file'name.txt", "file\\'name.txt"]],
    ['double quotes', ['file"name.txt', 'file\\"name.txt']],
    ['hash symbols', ['file#name.txt', 'file\\#name.txt']],
    ['exclamation marks', ['file!name.txt', 'file\\!name.txt']],
    ['tildes', ['file~name.txt', 'file\\~name.txt']],
    [
      'less than and greater than signs',
      ['file<name>.txt', 'file\\<name\\>.txt'],
    ],
  ]);
  table('%s', escapePath, [
    [
      'should handle multiple special characters',
      [
        'my file (backup) [v1.2].txt',
        'my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt',
      ],
    ],
    [
      'should not double-escape already escaped characters',
      ['my\\ file.txt', 'my\\ file.txt'],
      ['file\\(name\\).txt', 'file\\(name\\).txt'],
    ],
    [
      'should handle escaped backslashes correctly',
      // Double backslash (escaped backslash) + space: the space is escaped.
      ['path\\\\ file.txt', 'path\\\\\\ file.txt'],
      // Triple backslash (escaped backslash + escaping backslash) + space: not
      // double-escaped.
      ['path\\\\\\ file.txt', 'path\\\\\\ file.txt'],
      // Quadruple backslash (two escaped backslashes) + space: space escaped.
      ['path\\\\\\\\ file.txt', 'path\\\\\\\\\\ file.txt'],
    ],
    [
      'should handle complex escaped backslash scenarios',
      // Escaped backslash before a special character that needs escaping.
      ['file\\\\(test).txt', 'file\\\\\\(test\\).txt'],
      // Multiple escaped backslashes.
      ['path\\\\\\\\with space.txt', 'path\\\\\\\\with\\ space.txt'],
    ],
    [
      'should handle paths without special characters',
      ['normalfile.txt', 'normalfile.txt'],
      ['path/to/normalfile.txt', 'path/to/normalfile.txt'],
    ],
    [
      'should handle complex real-world examples',
      [
        'My Documents/Project (2024)/file [backup].txt',
        'My\\ Documents/Project\\ \\(2024\\)/file\\ \\[backup\\].txt',
      ],
      [
        'file with $special &chars!.txt',
        'file\\ with\\ \\$special\\ \\&chars\\!.txt',
      ],
    ],
    ['should handle empty strings', ['', '']],
    [
      'should handle paths with only special characters',
      [
        ' ()[]{};&|*?$`\'"#!~<>,',
        '\\ \\(\\)\\[\\]\\{\\}\\;\\&\\|\\*\\?\\$\\`\\\'\\"\\#\\!\\~\\<\\>\\,',
      ],
    ],
  ]);
});

describe('unescapePath', () => {
  const isWindows = process.platform === 'win32';

  // On Windows, backslashes are path separators, not shell escape chars, so
  // unescapePath is intentionally a no-op on win32.
  it.skipIf(!isWindows)('should be a no-op on Windows', () => {
    for (const p of [
      'C:\\Users\\my file.txt',
      'C:\\(v2)\\file.txt',
      'path\\to\\file\\ name.txt',
    ]) {
      expect(unescapePath(p)).toBe(p);
    }
  });

  describe.skipIf(isWindows)('on Unix', () => {
    table('should unescape %s', unescapePath, [
      ['spaces', ['my\\ file.txt', 'my file.txt']],
      ['tabs', ['file\\\twith\\\ttabs.txt', 'file\twith\ttabs.txt']],
      ['parentheses', ['file\\(1\\).txt', 'file(1).txt']],
      ['square brackets', ['file\\[backup\\].txt', 'file[backup].txt']],
      ['curly braces', ['file\\{temp\\}.txt', 'file{temp}.txt']],
      [
        'multiple special characters',
        [
          'my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt',
          'my file (backup) [v1.2].txt',
        ],
      ],
    ]);
    table('%s', unescapePath, [
      [
        'should handle paths without escaped characters',
        ['normalfile.txt', 'normalfile.txt'],
        ['path/to/normalfile.txt', 'path/to/normalfile.txt'],
      ],
      [
        'should handle all special characters',
        [
          '\\ \\(\\)\\[\\]\\{\\}\\;\\&\\|\\*\\?\\$\\`\\\'\\"\\#\\!\\~\\<\\>',
          ' ()[]{};&|*?$`\'"#!~<>',
        ],
      ],
      ['should handle empty strings', ['', '']],
      [
        'should not affect backslashes not followed by special characters',
        ['file\\name.txt', 'file\\name.txt'],
        ['path\\to\\file.txt', 'path\\to\\file.txt'],
      ],
      [
        'should handle escaped backslashes in unescaping',
        ['path\\\\\\ file.txt', 'path\\\\ file.txt'],
        ['path\\\\\\\\\\ file.txt', 'path\\\\\\\\ file.txt'],
        ['file\\\\\\(test\\).txt', 'file\\\\(test).txt'],
      ],
    ]);

    it('should be the inverse of escapePath', () => {
      for (const testCase of [
        'my file.txt',
        'file(1).txt',
        'file[backup].txt',
        'My Documents/Project (2024)/file [backup].txt',
        'file with $special &chars!.txt',
        ' ()[]{};&|*?$`\'"#!~<>',
        'file\twith\ttabs.txt',
      ]) {
        expect(unescapePath(escapePath(testCase))).toBe(testCase);
      }
    });
  });
});

describe('isSubpath', () => {
  table('%s', isSubpath, [
    ['should return true for a direct subpath', ['/a/b', '/a/b/c', true]],
    ['should return true for the same path', ['/a/b', '/a/b', true]],
    ['should return false for a parent path', ['/a/b/c', '/a/b', false]],
    [
      'should return false for a completely different path',
      ['/a/b', '/x/y', false],
    ],
    [
      'should handle relative paths',
      ['a/b', 'a/b/c', true],
      ['a/b', 'a/c', false],
    ],
    [
      'should handle paths with ..',
      ['/a/b', '/a/b/../b/c', true],
      ['/a/b', '/a/c/../b', true],
    ],
    ['should handle root paths', ['/', '/a', true], ['/a', '/', false]],
    [
      'should handle trailing slashes',
      ['/a/b/', '/a/b/c', true],
      ['/a/b', '/a/b/c/', true],
      ['/a/b/', '/a/b/c/', true],
    ],
  ]);
});

describe('isSubpath on Windows', () => {
  const originalPlatform = process.platform;
  const setPlatform = (value: string) => {
    Object.defineProperty(process, 'platform', { value });
  };
  beforeAll(() => setPlatform('win32'));
  afterAll(() => setPlatform(originalPlatform));

  const dir = 'C:\\Users\\Test';
  const file = 'C:\\Users\\Test\\file.txt';
  table('%s on Windows', isSubpath, [
    ['should return true for a direct subpath', [dir, file, true]],
    ['should return true for the same path', [dir, dir, true]],
    ['should return false for a parent path', [file, dir, false]],
    [
      'should return false for a different drive',
      [dir, 'D:\\Users\\Test', false],
    ],
    [
      'should be case-insensitive for drive letters',
      ['c:\\Users\\Test', file, true],
    ],
    [
      'should be case-insensitive for path components',
      [dir, 'c:\\users\\test\\file.txt', true],
    ],
    ['should handle mixed slashes', ['C:/Users/Test', file, true]],
    ['should handle trailing slashes', ['C:\\Users\\Test\\', file, true]],
    [
      'should handle relative paths correctly',
      ['Users\\Test', 'Users\\Test\\file.txt', true],
      ['Users\\Test\\file.txt', 'Users\\Test', false],
    ],
  ]);
});

describe('resolvePath', () => {
  // Relative inputs resolve like path.resolve against the base (or cwd).
  it.each([
    [
      'resolves relative paths against the provided base directory',
      '/home/user/project',
      'src/main.ts',
    ],
    [
      'resolves relative paths against cwd when baseDir is undefined',
      undefined,
      'src/main.ts',
    ],
    [
      'resolves empty paths against the provided base directory',
      '/base/dir',
      '',
    ],
    [
      'uses baseDir when provided for relative paths',
      '/custom/base',
      './relative/path',
    ],
    ['handles dot paths correctly', '/base/dir', '.'],
    ['handles parent directory references', '/base/dir/subdir', '..'],
  ])('%s', (_title, base, rel) => {
    expect(resolvePath(base, rel)).toBe(
      path.resolve(base ?? process.cwd(), rel),
    );
  });

  table('%s', resolvePath, [
    [
      'returns absolute paths unchanged',
      ['/some/base', '/absolute/path/to/file.ts', '/absolute/path/to/file.ts'],
    ],
    ['expands tilde to home directory', [undefined, '~', homeDir]],
    [
      'expands tilde-prefixed paths to home directory',
      [
        undefined,
        '~/documents/file.txt',
        path.join(homeDir, 'documents/file.txt'),
      ],
    ],
    [
      'expands Windows-style tilde-prefixed paths to home directory',
      [
        '/some/base',
        '~\\documents\\file.txt',
        path.join(homeDir, 'documents', 'file.txt'),
      ],
    ],
    [
      'handles tilde expansion regardless of baseDir',
      ['/some/base', '~/file.txt', path.join(homeDir, 'file.txt')],
    ],
  ]);
});

describe('validatePath', () => {
  const ws = useWorkspace('validate-path-test-');
  const validate = (p: string, options?: { allowFiles?: boolean }) => () =>
    validatePath(ws.config, p, options);

  beforeEach(() => {
    // The module-level isDirectory cache persists across tests, and these
    // cases mutate the same absolute paths (create, remove, re-create as a
    // possibly different type), so reset it to keep stale lookups from
    // masking regressions.
    _resetValidatePathCacheForTest();
  });

  it('validates paths within workspace boundaries', () => {
    expect(validate(path.join(ws.root, 'subdir'))).not.toThrow();
  });

  it('throws when path is outside workspace boundaries', () => {
    expect(validate(path.join(os.tmpdir(), 'outside'))).toThrowError(
      /Path is not within workspace/,
    );
  });

  it('throws when path does not exist', () => {
    expect(validate(path.join(ws.root, 'nonexistent'))).toThrowError(
      /Path does not exist:/,
    );
  });

  it('throws when path is a file, not a directory (default behavior)', () => {
    ws.withFile('test-file.txt', (filePath) => {
      expect(validate(filePath)).toThrowError(/Path is not a directory/);
    });
  });

  it('allows files when allowFiles option is true', () => {
    ws.withFile('test-file.txt', (filePath) => {
      expect(validate(filePath, { allowFiles: true })).not.toThrow();
    });
  });

  it('validates paths at workspace root', () => {
    expect(validate(ws.root)).not.toThrow();
  });

  it('does not cache ENOENT — recreating the path between calls succeeds', () => {
    // Regression guard: a path missing at the first check and then created
    // must NOT be rejected on the second call. Positive stats are cached,
    // ENOENT is not, so a file the model creates with Edit is visible to the
    // next tool call.
    const ephemeralDir = path.join(ws.root, 'late-created');
    expect(validate(ephemeralDir)).toThrowError(/Path does not exist:/);
    fs.mkdirSync(ephemeralDir);
    try {
      expect(validate(ephemeralDir)).not.toThrow();
    } finally {
      fs.rmSync(ephemeralDir, { recursive: true, force: true });
    }
  });

  it('caches positive isDirectory — repeat call does not re-stat', () => {
    const spy = vi.spyOn(fs, 'statSync');
    const dir = path.join(ws.root, 'subdir');
    try {
      validatePath(ws.config, dir);
      const afterFirst = spy.mock.calls.length;
      validatePath(ws.config, dir);
      expect(spy.mock.calls.length).toBe(afterFirst);
    } finally {
      spy.mockRestore();
    }
  });

  it('validates paths in allowed directories', () => {
    ws.withExtraDir('validate-extra-', (extraDir, config) => {
      expect(() => validatePath(config, extraDir)).not.toThrow();
    });
  });
});

describe('resolveAndValidatePath', () => {
  const ws = useWorkspace('resolve-and-validate-');
  const resolveIn = (p: string) => () => resolveAndValidatePath(ws.config, p);

  it('returns the target directory when no path is provided', () => {
    expect(resolveAndValidatePath(ws.config)).toBe(ws.root);
  });

  it('resolves relative paths within the workspace', () => {
    expect(resolveAndValidatePath(ws.config, 'subdir')).toBe(
      path.join(ws.root, 'subdir'),
    );
  });

  it('allows absolute paths that are permitted by the workspace context', () => {
    ws.withExtraDir('resolve-and-validate-extra-', (extraDir, config) => {
      expect(resolveAndValidatePath(config, extraDir)).toBe(extraDir);
    });
  });

  it('expands tilde-prefixed paths using the home directory', () => {
    ws.withExtraDir('resolve-and-validate-home-', (fakeHome, config) => {
      const homeSubdir = path.join(fakeHome, 'project');
      fs.mkdirSync(homeSubdir);
      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
      try {
        expect(resolveAndValidatePath(config, '~/project')).toBe(homeSubdir);
        expect(resolveAndValidatePath(config, '~\\project')).toBe(homeSubdir);
        expect(resolveAndValidatePath(config, '~')).toBe(fakeHome);
      } finally {
        homedirSpy.mockRestore();
      }
    });
  });

  it('throws when the path resolves outside of the workspace', () => {
    expect(resolveIn('../outside')).toThrowError(
      /Path is not within workspace/,
    );
  });

  it('throws when the path does not exist', () => {
    expect(resolveIn('missing')).toThrowError(/Path does not exist:/);
  });

  it('throws when the path points to a file (default behavior)', () => {
    ws.withFile('file.txt', (filePath) => {
      expect(resolveIn('file.txt')).toThrowError(
        `Path is not a directory: ${filePath}`,
      );
    });
  });

  it('allows file paths when allowFiles option is true', () => {
    ws.withFile('file.txt', (filePath) => {
      expect(
        resolveAndValidatePath(ws.config, 'file.txt', { allowFiles: true }),
      ).toBe(filePath);
    });
  });
});

describe('tildeifyPath', () => {
  const siblingPath = `${homeDir}2${sep}project${sep}file.txt`;
  const tildeify = (p: string) => tildeifyPath(p);
  table('%s', tildeify, [
    [
      'replaces home directory with tilde',
      [
        path.join(homeDir, 'documents', 'file.txt'),
        `~${sep}documents${sep}file.txt`,
      ],
    ],
    [
      'returns path unchanged if it does not start with home directory',
      ['/var/log/app.log', '/var/log/app.log'],
    ],
    ['handles exact home directory path', [homeDir, '~']],
    [
      'does not replace paths that only share the home directory prefix',
      [siblingPath, siblingPath],
    ],
    [
      // The home dir is not replaced in the middle of a path.
      'handles paths with home directory in the middle',
      [`/mnt/backup${homeDir}/data`, `/mnt/backup${homeDir}/data`],
    ],
  ]);
});

describe('formatDisplayPath', () => {
  const root = path.resolve(sep, 'projects', 'my-app');
  const homeRoot = path.join(homeDir, 'work', 'proj');
  const outside = path.resolve(sep, 'other', 'place', 'file.txt');

  const format = (target: string, r: string) => formatDisplayPath(target, r);
  table('%s', format, [
    [
      'renders project-internal paths relative to the root',
      [path.join(root, 'src', 'index.ts'), root, path.join('src', 'index.ts')],
    ],
    ['renders the project root itself as .', [root, root, '.']],
    [
      'resolves relative input against the root before formatting',
      [path.join('src', 'app'), root, path.join('src', 'app')],
      ['.', root, '.'],
    ],
    ['keeps paths outside the project absolute', [outside, root, outside]],
    [
      'shortens the home directory to ~ for paths outside the project',
      [
        path.join(homeDir, 'elsewhere', 'file.txt'),
        root,
        `~${sep}elsewhere${sep}file.txt`,
      ],
    ],
    [
      'does not tildeify project-internal paths when the project is under home',
      [
        path.join(homeRoot, 'src', 'main.ts'),
        homeRoot,
        path.join('src', 'main.ts'),
      ],
    ],
    [
      'expands a tilde-prefixed input like other tool paths',
      [path.join('~', 'data'), root, `~${sep}data`],
    ],
  ]);

  it('compresses overlong paths with shortenPath semantics', () => {
    const target = path.join(
      root,
      'very/deeply/nested/directory/structure/file.ts',
    );
    const result = formatDisplayPath(target, root, 25);
    expect(result.length).toBeLessThanOrEqual(25);
    expect(result).toContain('...');
    expect(result).toContain('file.ts');
  });
});

const itPosix = it.skipIf(process.platform === 'win32');

// A temp root holding real/file.txt. The base itself is realpath'd so
// assertions do not trip over macOS's /var -> /private/var symlink.
function useRealRoot(prefix: string) {
  let root = '';
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real', 'file.txt'), 'x', 'utf8');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const at = (...segments: string[]) => path.join(root, ...segments);
  return {
    at,
    real: (...segments: string[]) => at('real', ...segments),
    // Creates <root>/<name> as a symlink to target and returns its path.
    link(name: string, target: string, type?: 'dir') {
      fs.symlinkSync(target, at(name), type);
      return at(name);
    },
  };
}

const absent = path.resolve(sep, 'no', 'such', 'ancestor', 'x');

describe('realpathNearestExisting', () => {
  const { at, real, link } = useRealRoot('realpath-nearest-');

  it.each([
    ['returns an existing path canonicalized', () => real('file.txt')],
    [
      'appends segments that do not exist yet to the resolved prefix',
      () => real('a', 'b.txt'),
    ],
    ['returns the lexical path when no ancestor can be resolved', () => absent],
  ])('%s', (_title, target) => {
    expect(realpathNearestExisting(target())).toBe(target());
  });

  itPosix('follows a symlink to its target', () => {
    const l = link('link-to-file', real('file.txt'));
    expect(realpathNearestExisting(l)).toBe(real('file.txt'));
  });

  itPosix('follows a dangling symlink to its non-existent target', () => {
    // fs.existsSync() follows links and reports a dangling one as missing,
    // so a naive nearest-existing walk would classify this by where the
    // link sits rather than where it points.
    const l = link('dangling', real('absent.txt'));
    expect(realpathNearestExisting(l)).toBe(real('absent.txt'));
  });

  itPosix('resolves an intermediate directory symlink', () => {
    const dirLink = link('dirlink', real(), 'dir');
    expect(realpathNearestExisting(path.join(dirLink, 'file.txt'))).toBe(
      real('file.txt'),
    );
    expect(realpathNearestExisting(path.join(dirLink, 'absent.txt'))).toBe(
      real('absent.txt'),
    );
  });

  itPosix(
    'resolves a relative symlink target against the real parent of the link',
    () => {
      const l = link(path.join('real', 'rel-link'), 'file.txt');
      expect(realpathNearestExisting(l)).toBe(real('file.txt'));
    },
  );

  itPosix(
    'gives up safely on a symlink cycle instead of looping forever',
    () => {
      const a = link('cycle-a', at('cycle-b'));
      link('cycle-b', a);
      // Bounded by SYMLOOP_MAX hops; the caller still range-checks the result.
      expect(() => realpathNearestExisting(a)).not.toThrow();
    },
  );
});

describe('realpathNearestExistingAsync', () => {
  const { real, link } = useRealRoot('realpath-nearest-async-');

  it('matches the sync variant across the canonicalization cases', async () => {
    for (const target of [real('file.txt'), real('a', 'b.txt'), absent]) {
      await expect(realpathNearestExistingAsync(target)).resolves.toBe(
        realpathNearestExisting(target),
      );
    }
  });

  itPosix('follows a dangling symlink to its non-existent target', async () => {
    const l = link('dangling-async', real('absent.txt'));
    await expect(realpathNearestExistingAsync(l)).resolves.toBe(
      real('absent.txt'),
    );
  });
});

describe('shortenPath', () => {
  const sepForRegex = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // abs('a/b') is `${sep}a${sep}b`.
  const abs = (p: string) => sep + p.split('/').join(sep);

  const shorten = (p: string, maxLen: number) => shortenPath(p, maxLen);
  table('%s', shorten, [
    [
      'returns path unchanged if it is already short enough',
      ['/short/path', 50, '/short/path'],
      ['/a/b/c.txt', 100, '/a/b/c.txt'],
    ],
    [
      'returns path unchanged if length equals maxLen',
      ['/exact/length', '/exact/length'.length, '/exact/length'],
    ],
    ['handles paths with only root', ['/', 10, '/'], ['/', 1, '/']],
  ]);

  // Each row is shortened to fit maxLen and contains every listed part.
  it.each<[string, string, number, ...string[]]>([
    [
      'shortens long paths by showing start and end with ellipsis in between',
      abs('home/user/projects/qwen-code/packages/core/src/file.ts'),
      40,
      // root + first segment, then the ellipsis; ends with file.ts
      `${sep}home${sep}...${sep}`,
      'file.ts',
    ],
    [
      // e.g. /home/.../subdir/file.txt, fitting as many end segments as possible
      'includes as many end segments as possible',
      abs('home/user/workspace/projects/subdir/file.txt'),
      35,
      '...',
      'file.txt',
    ],
    [
      'handles paths with single segment after root',
      '/verylongfilenamethatshouldbetruncated.txt',
      20,
      '...',
    ],
    ['handles paths with two segments', abs('home/file.txt'), 10, '...'],
    [
      // shortenPath works with any string, though it usually gets absolute paths.
      'handles relative-looking paths correctly',
      'very/long/relative/path/to/file.txt',
      20,
      '...',
    ],
    [
      // Falls back to simple truncation.
      'handles paths where even minimum representation is too long',
      '/verylongdirectoryname/verylongfilename.txt',
      15,
      '...',
    ],
  ])('%s', (_title, p, maxLen, ...parts) => {
    const result = shortenPath(p, maxLen);
    for (const part of parts) expect(result).toContain(part);
    expect(result.length).toBeLessThanOrEqual(maxLen);
  });

  it('shows all segments when they all fit after including ellipsis space', () => {
    // Short enough to need no ellipsis.
    const testPath = abs('a/b/c/d.txt');
    const result = shortenPath(testPath, 50);
    expect(result).toBe(testPath);
    expect(result).not.toContain('...');
  });

  it('handles very short maxLen values', () => {
    const result = shortenPath('/home/user/file.txt', 5);
    expect(result).toBe('/h...');
    expect(result.length).toBe(5);
  });

  it('preserves the root directory in shortened paths', () => {
    const result = shortenPath(abs('a/b/c/d/e.txt'), 15);
    expect(result.startsWith(sep)).toBe(true);
  });

  it('creates ellipsis only when segments are actually omitted', () => {
    const shortPath = abs('a/b/c.txt');
    expect(shortenPath(shortPath, 100)).not.toContain('...');
    expect(shortenPath(shortPath, 8)).toContain('...');
  });

  it('uses default maxLen of 80 when not specified', () => {
    expect(shortenPath('a'.repeat(100)).length).toBeLessThanOrEqual(80);
  });

  it('correctly calculates length including ellipsis', () => {
    const maxLen = 40;
    const result = shortenPath(
      abs('home/user/workspace/project/src/components/app.tsx'),
      maxLen,
    );
    expect(result.length).toBeLessThanOrEqual(maxLen);
    // With an ellipsis, the result is exactly two parts around it.
    if (result.includes('...')) {
      const parts = result.split('...');
      expect(parts.length).toBe(2);
      expect(parts[0].length + 3 + parts[1].length).toBeLessThanOrEqual(maxLen);
    }
  });

  it('maintains path separator consistency', () => {
    const result = shortenPath(abs('a/b/c/d/e/f.txt'), 20);
    // Every separator is the platform one.
    for (const s of result.match(new RegExp(`\\${sep}`, 'g')) ?? []) {
      expect(s).toBe(sep);
    }
  });

  it('example from documentation: /path/to/a/very/long/file.txt', () => {
    const testPath = abs('path/to/a/very/long/directory/file.txt');
    const result = shortenPath(testPath, 35);
    // Start and end with an ellipsis between.
    expect(result).toMatch(
      new RegExp(`^${sepForRegex}path${sepForRegex}\\.\\.\\..+file\\.txt$`),
    );
    expect(result.length).toBeLessThanOrEqual(35);
  });
});

describe('getProjectHash', () => {
  // Runs fn while os.platform() reports the given platform.
  function onPlatform(platform: NodeJS.Platform, fn: () => void) {
    const platformSpy = vi.spyOn(os, 'platform').mockReturnValue(platform);
    try {
      fn();
    } finally {
      platformSpy.mockRestore();
    }
  }

  it('should generate consistent hashes for the same path', () => {
    const hash1 = getProjectHash('/test/project');
    expect(hash1).toBe(getProjectHash('/test/project'));
    expect(hash1).toHaveLength(64); // SHA256 produces 64 hex characters
  });

  it('should generate different hashes for different paths', () => {
    expect(getProjectHash('/test/project1')).not.toBe(
      getProjectHash('/test/project2'),
    );
  });

  it('should generate case-insensitive hashes on Windows', () => {
    onPlatform('win32', () => {
      const [hash1, hash2, hash3] = [
        'c:\\users\\test\\project',
        'C:\\Users\\Test\\Project',
        'c:\\Users\\TEST\\project',
      ].map((p) => getProjectHash(p));
      // On Windows, all case variations produce the same hash.
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });
  });

  it('should generate case-sensitive hashes on non-Windows platforms', () => {
    onPlatform('linux', () => {
      expect(getProjectHash('/home/user/project')).not.toBe(
        getProjectHash('/HOME/USER/PROJECT'),
      );
    });
  });

  it('should handle Windows drive letter variations', () => {
    // Common cases where users type the drive letter in a different case.
    onPlatform('win32', () => {
      for (const [path1, path2] of [
        ['e:\\work', 'E:\\work'],
        ['e:\\work', 'E:\\WORK'],
        ['c:\\projects\\myapp', 'C:\\Projects\\MyApp'],
      ]) {
        expect(getProjectHash(path1)).toBe(getProjectHash(path2));
      }
    });
  });
});

describe('expandHomeDir', () => {
  const home = path.normalize(homeDir);
  const homeSlash = path.normalize(homeDir + sep);
  const documents = path.join(homeDir, 'documents');
  const documentsSlash = path.normalize(documents + sep);

  table('%s', expandHomeDir, [
    ['should return empty string for empty input', ['', '']],
    ['should expand ~ to home directory', ['~', home]],
    [
      'should preserve trailing separators for home directory paths',
      ['~/', homeSlash],
      ['~\\', homeSlash],
    ],
    ['should expand ~/path to home directory path', ['~/documents', documents]],
    [
      'should expand Windows-style ~\\path to home directory path',
      ['~\\documents', documents],
    ],
    [
      'should preserve trailing separators in Windows-style tilde paths',
      ['~\\documents\\', documentsSlash],
    ],
    [
      'should handle mixed separators in Windows-style tilde paths',
      ['~\\foo/bar\\baz', path.join(homeDir, 'foo', 'bar', 'baz')],
    ],
    [
      'should preserve legacy POSIX tilde path semantics',
      ['~/foo\\bar', path.normalize(path.join(homeDir, 'foo\\bar'))],
    ],
    ['should not expand ~path (no slash)', ['~documents', '~documents']],
    [
      'should expand %userprofile% (case-insensitive) to home directory',
      ['%userprofile%', home],
      ['%USERPROFILE%', home],
    ],
    [
      'should expand %userprofile%\\path to home directory path',
      ['%userprofile%\\documents', documents],
    ],
    [
      'should expand %USERPROFILE%/path with forward-slash separator',
      ['%USERPROFILE%/documents', documents],
    ],
    [
      'should preserve trailing separators for %USERPROFILE% paths',
      ['%USERPROFILE%/', homeSlash],
      ['%USERPROFILE%\\documents\\', documentsSlash],
    ],
    [
      'should preserve legacy %USERPROFILE% prefix semantics without a separator',
      ['%USERPROFILE%foo', path.normalize(`${homeDir}foo`)],
    ],
    [
      'should return regular absolute path unchanged (but normalized)',
      ['/absolute/path', path.normalize('/absolute/path')],
    ],
    [
      'should return relative path unchanged (but normalized)',
      ['relative/path', path.normalize('relative/path')],
    ],
  ]);
});
