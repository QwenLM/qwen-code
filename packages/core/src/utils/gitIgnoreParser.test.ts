/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitIgnoreParser } from './gitIgnoreParser.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('GitIgnoreParser', () => {
  let parser: GitIgnoreParser;
  let projectRoot: string;

  async function createTestFile(filePath: string, content = '') {
    const fullPath = path.join(projectRoot, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  const ignored = (filePath: string) => parser.isIgnored(filePath);

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-test-'));
    parser = new GitIgnoreParser(projectRoot);
    // Every suite below runs inside a git repository.
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('Basic ignore behaviors', () => {
    it('should not ignore files when no .gitignore exists', async () => {
      expect(ignored('file.txt')).toBe(false);
    });

    it('should ignore files based on a root .gitignore', async () => {
      const gitignoreContent = `
# Comment
node_modules/
*.log
/dist
.env
`;
      await createTestFile('.gitignore', gitignoreContent);

      expect(ignored(path.join('node_modules', 'some-lib'))).toBe(true);
      expect(ignored(path.join('src', 'app.log'))).toBe(true);
      expect(ignored(path.join('dist', 'index.js'))).toBe(true);
      expect(ignored('.env')).toBe(true);
      expect(ignored('src/index.js')).toBe(false);
    });

    it('should handle git exclude file', async () => {
      await createTestFile(
        path.join('.git', 'info', 'exclude'),
        'temp/\n*.tmp',
      );

      expect(ignored(path.join('temp', 'file.txt'))).toBe(true);
      expect(ignored(path.join('src', 'file.tmp'))).toBe(true);
      expect(ignored('src/file.js')).toBe(false);
    });
  });

  describe('isIgnored path handling', () => {
    beforeEach(async () => {
      const gitignoreContent = `
node_modules/
*.log
/dist
/.env
src/*.tmp
!src/important.tmp
`;
      await createTestFile('.gitignore', gitignoreContent);
    });

    it('should always ignore .git directory', () => {
      expect(ignored('.git')).toBe(true);
      expect(ignored(path.join('.git', 'config'))).toBe(true);
      expect(ignored(path.join(projectRoot, '.git', 'HEAD'))).toBe(true);
    });

    it('should ignore files matching patterns', () => {
      expect(ignored(path.join('node_modules', 'package', 'index.js'))).toBe(
        true,
      );
      expect(ignored('app.log')).toBe(true);
      expect(ignored(path.join('logs', 'app.log'))).toBe(true);
      expect(ignored(path.join('dist', 'bundle.js'))).toBe(true);
      expect(ignored('.env')).toBe(true);
      expect(ignored(path.join('config', '.env'))).toBe(false); // .env is anchored to root
    });

    it('should ignore files with path-specific patterns', () => {
      expect(ignored(path.join('src', 'temp.tmp'))).toBe(true);
      expect(ignored(path.join('other', 'temp.tmp'))).toBe(false);
    });

    it('should handle negation patterns', () => {
      expect(ignored(path.join('src', 'important.tmp'))).toBe(false);
    });

    it('should not ignore files that do not match patterns', () => {
      expect(ignored(path.join('src', 'index.ts'))).toBe(false);
      expect(ignored('README.md')).toBe(false);
    });

    it('should handle absolute paths correctly', () => {
      const absolutePath = path.join(projectRoot, 'node_modules', 'lib');
      expect(ignored(absolutePath)).toBe(true);
    });

    it('should handle paths outside project root by not ignoring them', () => {
      const outsidePath = path.resolve(projectRoot, '..', 'other', 'file.txt');
      expect(ignored(outsidePath)).toBe(false);
    });

    it('should still evaluate files whose names start with two dots', async () => {
      await createTestFile('.gitignore', '..secret.log');

      expect(ignored('..secret.log')).toBe(true);
    });

    it('should handle relative paths correctly', () => {
      expect(ignored(path.join('node_modules', 'some-package'))).toBe(true);
      expect(ignored(path.join('..', 'some', 'other', 'file.txt'))).toBe(false);
    });

    it('should normalize path separators on Windows', () => {
      expect(ignored(path.join('node_modules', 'package'))).toBe(true);
      expect(ignored(path.join('src', 'temp.tmp'))).toBe(true);
    });

    it.each([
      ['should handle root path "/" without throwing error', '/'],
      [
        'should handle absolute-like paths without throwing error',
        '/some/path',
      ],
      ['should handle paths that start with forward slash', '/node_modules'],
      [
        'should handle backslash-prefixed files without crashing',
        '\\backslash-file-test.txt',
      ],
      [
        'should handle files with absolute-like names',
        '/backslash-file-test.txt',
      ],
    ])('%s', (_title, filePath) => {
      expect(() => ignored(filePath)).not.toThrow();
      expect(ignored(filePath)).toBe(false);
    });
  });

  describe('nested .gitignore files', () => {
    beforeEach(async () => {
      await createTestFile('.gitignore', 'root-ignored.txt');
      await createTestFile('a/.gitignore', '/b\nc');
      await createTestFile('a/d/.gitignore', 'e.txt\nf/g');
    });

    it('should handle nested .gitignore files correctly', async () => {
      // From root .gitignore
      expect(ignored('root-ignored.txt')).toBe(true);
      expect(ignored('a/root-ignored.txt')).toBe(true);

      // From a/.gitignore: /b
      expect(ignored('a/b')).toBe(true);
      expect(ignored('b')).toBe(false);
      expect(ignored('a/x/b')).toBe(false);

      // From a/.gitignore: c
      expect(ignored('a/c')).toBe(true);
      expect(ignored('a/x/y/c')).toBe(true);
      expect(ignored('c')).toBe(false);

      // From a/d/.gitignore: e.txt
      expect(ignored('a/d/e.txt')).toBe(true);
      expect(ignored('a/d/x/e.txt')).toBe(true);
      expect(ignored('a/e.txt')).toBe(false);

      // From a/d/.gitignore: f/g
      expect(ignored('a/d/f/g')).toBe(true);
      expect(ignored('a/f/g')).toBe(false);
    });
  });

  // In gitignore syntax `/` is always the separator and `\` is an escape
  // character, so a pattern's backslashes are content, not path separators.
  // Every expectation here was read off `git check-ignore` in a real
  // repository.
  describe('backslash escapes in patterns', () => {
    it('honours an escaped space', async () => {
      await createTestFile('.gitignore', 'foo\\ bar.txt\n');

      expect(ignored('foo bar.txt')).toBe(true);
    });

    it('honours an escaped leading hash', async () => {
      // `\#hash.txt` escapes the comment marker. Rewriting the backslash to
      // `/` turned it into `/#hash.txt`, which additionally anchored the
      // pattern to the repository root — so the rule both stopped matching
      // and changed scope.
      await createTestFile('.gitignore', '\\#hash.txt\n');

      expect(ignored('#hash.txt')).toBe(true);
      expect(ignored('sub/#hash.txt')).toBe(true);
    });

    it('honours escaped glob metacharacters', async () => {
      await createTestFile('.gitignore', 'a\\[b\\].txt\nlit\\*.txt\n');

      expect(ignored('a[b].txt')).toBe(true);
      expect(ignored('lit*.txt')).toBe(true);
      // The escape must still suppress the wildcard.
      expect(ignored('litX.txt')).toBe(false);
    });

    it('honours an escape inside a nested .gitignore', async () => {
      // The nested path is where the prefix is assembled, so it is the case
      // that would break if the pattern were passed through a path function.
      await createTestFile('.gitignore', '');
      await createTestFile('a/b/.gitignore', 'foo\\ bar.txt\n');

      expect(ignored('a/b/foo bar.txt')).toBe(true);
      expect(ignored('a/b/x/foo bar.txt')).toBe(true);
    });

    it('still expands nested patterns the documented way', async () => {
      // The guard against over-correcting: the three rules in the comment
      // above the prefix assembly must survive it unchanged.
      await createTestFile('.gitignore', '');
      await createTestFile('a/b/.gitignore', 'c\nd/e\n/f\n');

      // `c` -> /a/b/**/c
      expect(ignored('a/b/c')).toBe(true);
      expect(ignored('a/b/x/c')).toBe(true);
      // `d/e` -> /a/b/d/e
      expect(ignored('a/b/d/e')).toBe(true);
      expect(ignored('a/b/x/d/e')).toBe(false);
      // `/f` -> /a/b/f
      expect(ignored('a/b/f')).toBe(true);
      expect(ignored('a/b/x/f')).toBe(false);
    });
  });

  // A trailing `/` means "directories only"; it is not a separator that
  // anchors the pattern. Every expectation here was read off `git
  // check-ignore` in a real repository. This needs its own setup because the
  // suite above ignores `a/b` outright, which would stop `a/b/.gitignore`
  // from being consulted at all.
  describe('directory-only patterns in a nested .gitignore', () => {
    beforeEach(async () => {
      await createTestFile('.gitignore', '');
    });

    it('applies below the nested ignore file, not only beside it', async () => {
      // git expands `foo/` in `a/b/.gitignore` to `/a/b/**/foo/`.
      await createTestFile('a/b/.gitignore', 'foo/');

      expect(ignored('a/b/foo/f')).toBe(true);
      expect(ignored('a/b/x/foo/f')).toBe(true);
      expect(ignored('a/b/x/y/foo/f')).toBe(true);
      // Still scoped to the ignore file's own directory.
      expect(ignored('a/foo/f')).toBe(false);
    });

    it('still matches directories only', async () => {
      await createTestFile('a/b/.gitignore', 'foo/');

      // `foo` here is a file, not a directory, so git leaves it alone. The
      // `**/` prefix must not cost the trailing slash its meaning.
      expect(ignored('a/b/x/foo')).toBe(false);
    });

    it('leaves an anchored directory-only pattern anchored', async () => {
      // The guard against over-correcting: `/foo/` has a leading slash, so it
      // matches `a/b/foo/` alone and must not gain the `**/` prefix.
      await createTestFile('a/b/.gitignore', '/foo/');

      expect(ignored('a/b/foo/f')).toBe(true);
      expect(ignored('a/b/x/foo/f')).toBe(false);
    });

    it('leaves a mid-path directory-only pattern anchored', async () => {
      // `c/d/` has a real interior separator, so the trailing slash is not
      // the only slash and the pattern stays anchored.
      await createTestFile('a/b/.gitignore', 'c/d/');

      expect(ignored('a/b/c/d/f')).toBe(true);
      expect(ignored('a/b/x/c/d/f')).toBe(false);
    });
  });

  describe('precedence rules', () => {
    it('should prioritize nested .gitignore over root .gitignore', async () => {
      await createTestFile('.gitignore', '*.log');
      await createTestFile('a/b/.gitignore', '!special.log');

      expect(ignored('a/b/any.log')).toBe(true);
      expect(ignored('a/b/special.log')).toBe(false);
    });

    it('should prioritize .gitignore over .git/info/exclude', async () => {
      await createTestFile(path.join('.git', 'info', 'exclude'), '*.log');
      await createTestFile('.gitignore', '!important.log');

      expect(ignored('some.log')).toBe(true);
      expect(ignored('important.log')).toBe(false);
      expect(ignored(path.join('subdir', 'some.log'))).toBe(true);
      expect(ignored(path.join('subdir', 'important.log'))).toBe(false);
    });
  });

  // Every expectation below was read off `git check-ignore` in a real
  // repository rather than off the documentation.
  describe('pattern whitespace', () => {
    it('keeps leading whitespace as part of the pattern', async () => {
      await createTestFile('.gitignore', ' leading.txt\n');

      // Both directions matter. `trim()` did not merely fail to ignore the
      // right file, it ignored the wrong one instead, so an assertion on the
      // first line alone would also pass for the broken implementation.
      expect(ignored(' leading.txt')).toBe(true);
      expect(ignored('leading.txt')).toBe(false);
    });

    it('still drops unescaped trailing whitespace', async () => {
      await createTestFile('.gitignore', 'trail.txt   \n');

      expect(ignored('trail.txt')).toBe(true);
    });

    it('still skips blank and whitespace-only lines', async () => {
      await createTestFile('.gitignore', '\n   \n\t\nkept.txt\n');

      expect(ignored('kept.txt')).toBe(true);
      // A whitespace-only line must not survive as a pattern of its own.
      expect(ignored('other.txt')).toBe(false);
    });

    it('treats an indented # as a pattern rather than a comment', async () => {
      // git honours `#` as a comment only as the first character of the line.
      // Trimming first hid that: `  #hash.txt` was discarded as a comment.
      await createTestFile('.gitignore', '  #hash.txt\n# real comment\n');

      expect(ignored('  #hash.txt')).toBe(true);
      expect(ignored('real comment')).toBe(false);
    });

    it('reads patterns from a CRLF .gitignore', async () => {
      await createTestFile('.gitignore', 'crlf.txt\r\nsecond.txt\r\n');

      expect(ignored('crlf.txt')).toBe(true);
      expect(ignored('second.txt')).toBe(true);
    });
  });
});
