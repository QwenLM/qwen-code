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

  async function setupGitRepo() {
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
  }

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitignore-test-'));
    parser = new GitIgnoreParser(projectRoot);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('Basic ignore behaviors', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('should not ignore files when no .gitignore exists', async () => {
      expect(parser.isIgnored('file.txt')).toBe(false);
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

      expect(parser.isIgnored(path.join('node_modules', 'some-lib'))).toBe(
        true,
      );
      expect(parser.isIgnored(path.join('src', 'app.log'))).toBe(true);
      expect(parser.isIgnored(path.join('dist', 'index.js'))).toBe(true);
      expect(parser.isIgnored('.env')).toBe(true);
      expect(parser.isIgnored('src/index.js')).toBe(false);
    });

    it('should handle git exclude file', async () => {
      await createTestFile(
        path.join('.git', 'info', 'exclude'),
        'temp/\n*.tmp',
      );

      expect(parser.isIgnored(path.join('temp', 'file.txt'))).toBe(true);
      expect(parser.isIgnored(path.join('src', 'file.tmp'))).toBe(true);
      expect(parser.isIgnored('src/file.js')).toBe(false);
    });
  });

  describe('isIgnored path handling', () => {
    beforeEach(async () => {
      await setupGitRepo();
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
      expect(parser.isIgnored('.git')).toBe(true);
      expect(parser.isIgnored(path.join('.git', 'config'))).toBe(true);
      expect(parser.isIgnored(path.join(projectRoot, '.git', 'HEAD'))).toBe(
        true,
      );
    });

    it('should ignore files matching patterns', () => {
      expect(
        parser.isIgnored(path.join('node_modules', 'package', 'index.js')),
      ).toBe(true);
      expect(parser.isIgnored('app.log')).toBe(true);
      expect(parser.isIgnored(path.join('logs', 'app.log'))).toBe(true);
      expect(parser.isIgnored(path.join('dist', 'bundle.js'))).toBe(true);
      expect(parser.isIgnored('.env')).toBe(true);
      expect(parser.isIgnored(path.join('config', '.env'))).toBe(false); // .env is anchored to root
    });

    it('should ignore files with path-specific patterns', () => {
      expect(parser.isIgnored(path.join('src', 'temp.tmp'))).toBe(true);
      expect(parser.isIgnored(path.join('other', 'temp.tmp'))).toBe(false);
    });

    it('should handle negation patterns', () => {
      expect(parser.isIgnored(path.join('src', 'important.tmp'))).toBe(false);
    });

    it('should not ignore files that do not match patterns', () => {
      expect(parser.isIgnored(path.join('src', 'index.ts'))).toBe(false);
      expect(parser.isIgnored('README.md')).toBe(false);
    });

    it('should handle absolute paths correctly', () => {
      const absolutePath = path.join(projectRoot, 'node_modules', 'lib');
      expect(parser.isIgnored(absolutePath)).toBe(true);
    });

    it('should handle paths outside project root by not ignoring them', () => {
      const outsidePath = path.resolve(projectRoot, '..', 'other', 'file.txt');
      expect(parser.isIgnored(outsidePath)).toBe(false);
    });

    it('should still evaluate files whose names start with two dots', async () => {
      await createTestFile('.gitignore', '..secret.log');

      expect(parser.isIgnored('..secret.log')).toBe(true);
    });

    it('should handle relative paths correctly', () => {
      expect(parser.isIgnored(path.join('node_modules', 'some-package'))).toBe(
        true,
      );
      expect(
        parser.isIgnored(path.join('..', 'some', 'other', 'file.txt')),
      ).toBe(false);
    });

    it('should normalize path separators on Windows', () => {
      expect(parser.isIgnored(path.join('node_modules', 'package'))).toBe(true);
      expect(parser.isIgnored(path.join('src', 'temp.tmp'))).toBe(true);
    });

    it('should handle root path "/" without throwing error', () => {
      expect(() => parser.isIgnored('/')).not.toThrow();
      expect(parser.isIgnored('/')).toBe(false);
    });

    it('should handle absolute-like paths without throwing error', () => {
      expect(() => parser.isIgnored('/some/path')).not.toThrow();
      expect(parser.isIgnored('/some/path')).toBe(false);
    });

    it('should handle paths that start with forward slash', () => {
      expect(() => parser.isIgnored('/node_modules')).not.toThrow();
      expect(parser.isIgnored('/node_modules')).toBe(false);
    });

    it('should handle backslash-prefixed files without crashing', () => {
      expect(() => parser.isIgnored('\\backslash-file-test.txt')).not.toThrow();
      expect(parser.isIgnored('\\backslash-file-test.txt')).toBe(false);
    });

    it('should handle files with absolute-like names', () => {
      expect(() => parser.isIgnored('/backslash-file-test.txt')).not.toThrow();
      expect(parser.isIgnored('/backslash-file-test.txt')).toBe(false);
    });
  });

  describe('nested .gitignore files', () => {
    beforeEach(async () => {
      await setupGitRepo();
      // Root .gitignore
      await createTestFile('.gitignore', 'root-ignored.txt');
      // Nested .gitignore 1
      await createTestFile('a/.gitignore', '/b\nc');
      // Nested .gitignore 2
      await createTestFile('a/d/.gitignore', 'e.txt\nf/g');
    });

    it('should handle nested .gitignore files correctly', async () => {
      // From root .gitignore
      expect(parser.isIgnored('root-ignored.txt')).toBe(true);
      expect(parser.isIgnored('a/root-ignored.txt')).toBe(true);

      // From a/.gitignore: /b
      expect(parser.isIgnored('a/b')).toBe(true);
      expect(parser.isIgnored('b')).toBe(false);
      expect(parser.isIgnored('a/x/b')).toBe(false);

      // From a/.gitignore: c
      expect(parser.isIgnored('a/c')).toBe(true);
      expect(parser.isIgnored('a/x/y/c')).toBe(true);
      expect(parser.isIgnored('c')).toBe(false);

      // From a/d/.gitignore: e.txt
      expect(parser.isIgnored('a/d/e.txt')).toBe(true);
      expect(parser.isIgnored('a/d/x/e.txt')).toBe(true);
      expect(parser.isIgnored('a/e.txt')).toBe(false);

      // From a/d/.gitignore: f/g
      expect(parser.isIgnored('a/d/f/g')).toBe(true);
      expect(parser.isIgnored('a/f/g')).toBe(false);
    });
  });

  // In gitignore syntax `/` is always the separator and `\` is an escape
  // character, so a pattern's backslashes are content, not path separators.
  // Every expectation here was read off `git check-ignore` in a real
  // repository.
  describe('backslash escapes in patterns', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('honours an escaped space', async () => {
      await createTestFile('.gitignore', 'foo\\ bar.txt\n');

      expect(parser.isIgnored('foo bar.txt')).toBe(true);
    });

    it('honours an escaped leading hash', async () => {
      // `\#hash.txt` escapes the comment marker. Rewriting the backslash to
      // `/` turned it into `/#hash.txt`, which additionally anchored the
      // pattern to the repository root — so the rule both stopped matching
      // and changed scope.
      await createTestFile('.gitignore', '\\#hash.txt\n');

      expect(parser.isIgnored('#hash.txt')).toBe(true);
      expect(parser.isIgnored('sub/#hash.txt')).toBe(true);
    });

    it('honours escaped glob metacharacters', async () => {
      await createTestFile('.gitignore', 'a\\[b\\].txt\nlit\\*.txt\n');

      expect(parser.isIgnored('a[b].txt')).toBe(true);
      expect(parser.isIgnored('lit*.txt')).toBe(true);
      // The escape must still suppress the wildcard.
      expect(parser.isIgnored('litX.txt')).toBe(false);
    });

    it('honours an escape inside a nested .gitignore', async () => {
      // The nested path is where the prefix is assembled, so it is the case
      // that would break if the pattern were passed through a path function.
      await createTestFile('.gitignore', '');
      await createTestFile('a/b/.gitignore', 'foo\\ bar.txt\n');

      expect(parser.isIgnored('a/b/foo bar.txt')).toBe(true);
      expect(parser.isIgnored('a/b/x/foo bar.txt')).toBe(true);
    });

    it('still expands nested patterns the documented way', async () => {
      // The guard against over-correcting: the three rules in the comment
      // above the prefix assembly must survive it unchanged.
      await createTestFile('.gitignore', '');
      await createTestFile('a/b/.gitignore', 'c\nd/e\n/f\n');

      // `c` -> /a/b/**/c
      expect(parser.isIgnored('a/b/c')).toBe(true);
      expect(parser.isIgnored('a/b/x/c')).toBe(true);
      // `d/e` -> /a/b/d/e
      expect(parser.isIgnored('a/b/d/e')).toBe(true);
      expect(parser.isIgnored('a/b/x/d/e')).toBe(false);
      // `/f` -> /a/b/f
      expect(parser.isIgnored('a/b/f')).toBe(true);
      expect(parser.isIgnored('a/b/x/f')).toBe(false);
    });
  });

  // A trailing `/` means "directories only"; it is not a separator that
  // anchors the pattern. Every expectation here was read off `git
  // check-ignore` in a real repository. This needs its own setup because the
  // suite above ignores `a/b` outright, which would stop `a/b/.gitignore`
  // from being consulted at all.
  describe('directory-only patterns in a nested .gitignore', () => {
    beforeEach(async () => {
      await setupGitRepo();
      await createTestFile('.gitignore', '');
    });

    it('applies below the nested ignore file, not only beside it', async () => {
      // git expands `foo/` in `a/b/.gitignore` to `/a/b/**/foo/`.
      await createTestFile('a/b/.gitignore', 'foo/');

      expect(parser.isIgnored('a/b/foo/f')).toBe(true);
      expect(parser.isIgnored('a/b/x/foo/f')).toBe(true);
      expect(parser.isIgnored('a/b/x/y/foo/f')).toBe(true);
      // Still scoped to the ignore file's own directory.
      expect(parser.isIgnored('a/foo/f')).toBe(false);
    });

    it('still matches directories only', async () => {
      await createTestFile('a/b/.gitignore', 'foo/');

      // `foo` here is a file, not a directory, so git leaves it alone. The
      // `**/` prefix must not cost the trailing slash its meaning.
      expect(parser.isIgnored('a/b/x/foo')).toBe(false);
    });

    it('leaves an anchored directory-only pattern anchored', async () => {
      // The guard against over-correcting: `/foo/` has a leading slash, so it
      // matches `a/b/foo/` alone and must not gain the `**/` prefix.
      await createTestFile('a/b/.gitignore', '/foo/');

      expect(parser.isIgnored('a/b/foo/f')).toBe(true);
      expect(parser.isIgnored('a/b/x/foo/f')).toBe(false);
    });

    it('leaves a mid-path directory-only pattern anchored', async () => {
      // `c/d/` has a real interior separator, so the trailing slash is not
      // the only slash and the pattern stays anchored.
      await createTestFile('a/b/.gitignore', 'c/d/');

      expect(parser.isIgnored('a/b/c/d/f')).toBe(true);
      expect(parser.isIgnored('a/b/x/c/d/f')).toBe(false);
    });
  });

  describe('precedence rules', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('should prioritize nested .gitignore over root .gitignore', async () => {
      await createTestFile('.gitignore', '*.log');
      await createTestFile('a/b/.gitignore', '!special.log');

      expect(parser.isIgnored('a/b/any.log')).toBe(true);
      expect(parser.isIgnored('a/b/special.log')).toBe(false);
    });

    it('should prioritize .gitignore over .git/info/exclude', async () => {
      // Exclude all .log files
      await createTestFile(path.join('.git', 'info', 'exclude'), '*.log');
      // But make an exception in the root .gitignore
      await createTestFile('.gitignore', '!important.log');

      expect(parser.isIgnored('some.log')).toBe(true);
      expect(parser.isIgnored('important.log')).toBe(false);
      expect(parser.isIgnored(path.join('subdir', 'some.log'))).toBe(true);
      expect(parser.isIgnored(path.join('subdir', 'important.log'))).toBe(
        false,
      );
    });
  });

  // Every expectation below was read off `git check-ignore` in a real
  // repository rather than off the documentation.
  describe('pattern whitespace', () => {
    beforeEach(async () => {
      await setupGitRepo();
    });

    it('keeps leading whitespace as part of the pattern', async () => {
      await createTestFile('.gitignore', ' leading.txt\n');

      // Both directions matter. `trim()` did not merely fail to ignore the
      // right file, it ignored the wrong one instead, so an assertion on the
      // first line alone would also pass for the broken implementation.
      expect(parser.isIgnored(' leading.txt')).toBe(true);
      expect(parser.isIgnored('leading.txt')).toBe(false);
    });

    it('still drops unescaped trailing whitespace', async () => {
      await createTestFile('.gitignore', 'trail.txt   \n');

      expect(parser.isIgnored('trail.txt')).toBe(true);
    });

    it('still skips blank and whitespace-only lines', async () => {
      await createTestFile('.gitignore', '\n   \n\t\nkept.txt\n');

      expect(parser.isIgnored('kept.txt')).toBe(true);
      // A whitespace-only line must not survive as a pattern of its own.
      expect(parser.isIgnored('other.txt')).toBe(false);
    });

    it('treats an indented # as a pattern rather than a comment', async () => {
      // git honours `#` as a comment only as the first character of the line.
      // Trimming first hid that: `  #hash.txt` was discarded as a comment.
      await createTestFile('.gitignore', '  #hash.txt\n# real comment\n');

      expect(parser.isIgnored('  #hash.txt')).toBe(true);
      expect(parser.isIgnored('real comment')).toBe(false);
    });

    it('reads patterns from a CRLF .gitignore', async () => {
      await createTestFile('.gitignore', 'crlf.txt\r\nsecond.txt\r\n');

      expect(parser.isIgnored('crlf.txt')).toBe(true);
      expect(parser.isIgnored('second.txt')).toBe(true);
    });
  });
});
