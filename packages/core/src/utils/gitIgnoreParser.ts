/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { isPathWithinRoot } from './workspaceContext.js';

export interface GitIgnoreFilter {
  isIgnored(filePath: string): boolean;
}

export class GitIgnoreParser implements GitIgnoreFilter {
  private projectRoot: string;
  private cache: Map<string, string[]> = new Map();
  private globalPatterns: string[] | undefined;
  // Compiled ignore matcher memoized per directory chain — see getIgnorerForDir.
  private ignorerCache: Map<string, ReturnType<typeof ignore>> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private loadPatternsForFile(patternsFilePath: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(patternsFilePath, 'utf-8');
    } catch (_error) {
      return [];
    }

    const isExcludeFile = patternsFilePath.endsWith(
      path.join('.git', 'info', 'exclude'),
    );

    const relativeBaseDir = isExcludeFile
      ? '.'
      : path.dirname(path.relative(this.projectRoot, patternsFilePath));

    // Git strips a trailing CR, so that CRLF files work, and nothing else.
    // Leading whitespace is part of the pattern, and trailing whitespace is
    // stripped only when it is not backslash-escaped — both rules the `ignore`
    // library already applies to the raw pattern text. `trim()` overrode them
    // and inverted the match: a pattern ` leading.txt` stopped matching
    // ` leading.txt` and started matching `leading.txt` instead. A comment is
    // likewise a line whose FIRST character is `#`, so `  #foo` is a pattern to
    // git rather than a comment, and testing the untrimmed line reproduces that.
    return content
      .split('\n')
      .map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p))
      .filter((p) => p.trim() !== '' && !p.startsWith('#'))
      .map((p) => {
        const isNegative = p.startsWith('!');
        if (isNegative) {
          p = p.substring(1);
        }

        const isAnchoredInFile = p.startsWith('/');
        if (isAnchoredInFile) {
          p = p.substring(1);
        }

        // An empty pattern can result from a negated pattern like `!`,
        // which we can ignore.
        if (p === '') {
          return '';
        }

        let newPattern = p;
        if (relativeBaseDir && relativeBaseDir !== '.') {
          // Only in nested .gitignore files, the patterns need to be modified according to:
          // - If `a/b/.gitignore` defines `/c` then it needs to be changed to `/a/b/c`
          // - If `a/b/.gitignore` defines `c` then it needs to be changed to `/a/b/**/c`
          // - If `a/b/.gitignore` defines `c/d` then it needs to be changed to `/a/b/c/d`

          // A trailing `/` is not a separator for this test — it only means
          // "directories only". Git anchors a pattern when a `/` appears at
          // the start or in the middle, so `foo/` in `a/b/.gitignore` means
          // `/a/b/**/foo/` and still matches `a/b/x/foo/`, while `c/d` stays
          // anchored as `/a/b/c/d`. Counting the trailing slash made every
          // directory-only rule in a nested ignore file stop applying below
          // its own directory.
          const withoutDirSuffix = p.endsWith('/') ? p.slice(0, -1) : p;
          // The prefix is assembled by hand rather than with path.join so the
          // pattern text is never passed through a platform path function.
          // `relativeBaseDir` comes from path.relative and is the only piece
          // that can hold a platform separator, so it is the only piece that
          // is normalised.
          const baseDir = relativeBaseDir.replace(/\\/g, '/');
          // If no slash and not anchored in file, it matches files in any
          // subdirectory.
          const anyDepth =
            !isAnchoredInFile && !withoutDirSuffix.includes('/') ? '**/' : '';
          newPattern = `/${baseDir}/${anyDepth}${p}`;
        }

        // Anchor the pattern if originally anchored
        if (isAnchoredInFile && !newPattern.startsWith('/')) {
          newPattern = '/' + newPattern;
        }

        if (isNegative) {
          newPattern = '!' + newPattern;
        }

        // No blanket backslash rewrite here. In gitignore syntax `/` is always
        // the separator and `\` is an escape character, so rewriting every
        // backslash to `/` corrupted the pattern instead of normalising it:
        // `foo\ bar.txt` became `foo/ bar.txt`, `\#hash.txt` became
        // `/#hash.txt` (a comment escape turned into a root anchor) and
        // `a\[b\].txt` became `a/[b/].txt`. Windows separators can only enter
        // through `relativeBaseDir`, which is normalised at its source above.
        return newPattern;
      })
      .filter((p) => p !== '');
  }

  isIgnored(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    try {
      const isDir = filePath.endsWith('/');
      const resolved = path.resolve(this.projectRoot, filePath);
      const relativePath = path.relative(this.projectRoot, resolved);

      if (
        relativePath === '' ||
        !isPathWithinRoot(resolved, this.projectRoot)
      ) {
        return false;
      }

      // Even in windows, Ignore expects forward slashes.
      let normalizedPath = relativePath.replace(/\\/g, '/');
      // Preserve trailing '/' so directory-only patterns (e.g. `node_modules/`)
      // are matched correctly by the ignore library.
      if (isDir && !normalizedPath.endsWith('/')) {
        normalizedPath += '/';
      }

      if (normalizedPath.startsWith('/') || normalizedPath === '') {
        return false;
      }

      // The applicable rules depend only on the containing directory chain,
      // so the compiled matcher is built once per directory and reused for
      // every entry in it. Previously a fresh ignore() instance (with full
      // pattern recompilation) was constructed on every call — costly when
      // glob queries thousands of entries during traversal pruning.
      const ig = this.getIgnorerForDir(path.dirname(resolved));
      return ig.ignores(normalizedPath);
    } catch (_error) {
      return false;
    }
  }

  /**
   * Builds (and memoizes) the compiled ignore matcher for a directory: the
   * union of `.git`, `.git/info/exclude`, and every `.gitignore` from the
   * project root down to `leafDir`. Honors git's rule that once an ancestor
   * directory is itself ignored, deeper `.gitignore` files are not consulted.
   */
  private getIgnorerForDir(leafDir: string): ReturnType<typeof ignore> {
    const cached = this.ignorerCache.get(leafDir);
    if (cached) {
      return cached;
    }

    const ig = ignore();

    // Always ignore .git directory
    ig.add('.git');

    // Load global patterns from .git/info/exclude on first use
    if (this.globalPatterns === undefined) {
      const excludeFile = path.join(
        this.projectRoot,
        '.git',
        'info',
        'exclude',
      );
      this.globalPatterns = fs.existsSync(excludeFile)
        ? this.loadPatternsForFile(excludeFile)
        : [];
    }
    ig.add(this.globalPatterns);

    // Collect the directory chain root..leafDir.
    const dirsToVisit = [this.projectRoot];
    if (leafDir !== this.projectRoot) {
      const relativeLeaf = path.relative(this.projectRoot, leafDir);
      // Guard against a leafDir outside the project root.
      if (!relativeLeaf.startsWith('..') && !path.isAbsolute(relativeLeaf)) {
        let currentAbsDir = this.projectRoot;
        for (const part of relativeLeaf.split(path.sep)) {
          currentAbsDir = path.join(currentAbsDir, part);
          dirsToVisit.push(currentAbsDir);
        }
      }
    }

    for (const dir of dirsToVisit) {
      const relativeDir = path.relative(this.projectRoot, dir);
      if (relativeDir) {
        // Append trailing '/' so directory-only patterns (e.g. `logs/`) match.
        const normalizedRelativeDir = relativeDir.replace(/\\/g, '/') + '/';
        if (ig.ignores(normalizedRelativeDir)) {
          // This directory is ignored by an ancestor's .gitignore.
          // According to git behavior, we don't need to process this
          // directory's .gitignore, as nothing inside it can be un-ignored.
          break;
        }
      }

      if (this.cache.has(dir)) {
        const patterns = this.cache.get(dir);
        if (patterns) {
          ig.add(patterns);
        }
      } else {
        const gitignorePath = path.join(dir, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
          const patterns = this.loadPatternsForFile(gitignorePath);
          this.cache.set(dir, patterns);
          ig.add(patterns);
        } else {
          this.cache.set(dir, []); // Cache miss
        }
      }
    }

    this.ignorerCache.set(leafDir, ig);
    return ig;
  }
}
