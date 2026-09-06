/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real git, real cwd. `classifyRunTarget` pins the artifact names the parent
// polls for, and the child derives ITS names by canonicalising the path
// against the repo root — so the property that matters is that every
// spelling of one file produces one pin. `run.test.ts` cannot cover it: it
// mocks `child_process`, so the git-backed canonicalisation there falls back
// to the token as typed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRunTarget } from './run.js';
import { repoRelativeOf } from './lib/paths.js';
import { safeTarget } from '../../utils/paths.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

let repo: string;
let cwd: string;
let iso: ReturnType<typeof isolateHostGitConfig>;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'run-classify-')));
  cwd = process.cwd();
  process.chdir(repo);
  iso = isolateHostGitConfig();
  execFileSync('git', ['init', '-q', '--template=', '.'], { cwd: repo });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'pkg/deep'), { recursive: true });
});

afterEach(() => {
  process.chdir(cwd);
  iso.dispose();
  rmSync(repo, { recursive: true, force: true });
});

describe('classifyRunTarget — canonical file pins', () => {
  it('every spelling of one file yields one pin', () => {
    const canonical = classifyRunTarget('src/foo.ts');
    expect(canonical).toEqual({ kind: 'file', base: 'src_foo.ts' });
    for (const spelling of [
      './src/foo.ts',
      'src/../src/foo.ts',
      join(repo, 'src/foo.ts'),
      `src//foo.ts`,
    ]) {
      expect(classifyRunTarget(spelling)).toEqual(canonical);
    }
  });

  it('a path typed from a SUBDIRECTORY pins the same name as from the root', () => {
    const fromRoot = classifyRunTarget('pkg/deep/x.ts');
    process.chdir(join(repo, 'pkg'));
    expect(classifyRunTarget('deep/x.ts')).toEqual(fromRoot);
    expect(classifyRunTarget('./deep/x.ts')).toEqual(fromRoot);
  });

  it('a symlinked prefix pins the same name — on disk and not yet on disk', () => {
    // macOS's `/tmp` is a symlink to `/private/tmp`, so a path typed under it
    // relativises against a `--show-toplevel` root that shares no prefix with
    // it: the pin used to fall back to the whole typed path flattened while
    // the child, which canonicalises, wrote `src_foo.ts`. The poll then never
    // matched and the run reported "no composed verdict was produced" over a
    // review that had already run.
    const link = join(
      realpathSync(mkdtempSync(join(tmpdir(), 'rc-link-'))),
      'l',
    );
    symlinkSync(repo, link);
    try {
      writeFileSync(join(repo, 'src/foo.ts'), 'export const a = 1;\n');
      expect(classifyRunTarget(join(link, 'src/foo.ts'))).toEqual({
        kind: 'file',
        base: 'src_foo.ts',
      });
      // And a file the review is about to CREATE — `realpathSync` throws on
      // the leaf, so the canonicalisation has to resolve the ancestor that
      // exists. Reviewing a brand-new untracked file is a supported target.
      expect(classifyRunTarget(join(link, 'src/not-yet.ts'))).toEqual({
        kind: 'file',
        base: 'src_not-yet.ts',
      });
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('a root-level ..foo.ts is inside the repo, not an escape', () => {
    // `rel.startsWith('..')` reads a perfectly ordinary filename as a walk out
    // of the repository. What escapes is `..` itself or a FIRST SEGMENT of
    // `..`.
    writeFileSync(join(repo, '..foo.ts'), 'export const a = 1;\n');
    expect(classifyRunTarget(join(repo, '..foo.ts'))).toEqual({
      kind: 'file',
      base: 'foo.ts',
    });
  });

  it('a path outside the repo keeps its typed spelling rather than a .. walk', () => {
    const outside = classifyRunTarget(join(tmpdir(), 'elsewhere.ts'));
    expect(outside.kind).toBe('file');
    expect((outside as { base: string }).base).not.toContain('..');
  });
});

describe('classifyRunTarget — parent pin and child derivation agree for a backslash name', () => {
  it.skipIf(process.platform === 'win32')(
    'a file literally named `notes\\` yields one pin on both sides',
    () => {
      // On POSIX a backslash is an ordinary filename character. The child
      // (`capture-local --file`) derives its artifact stem through
      // `repoRelativeOf` → `safeTarget` and never strips trailing
      // backslashes; the parent pin must spell the file the same way or the
      // poll never matches. (On Windows a backslash IS a separator and
      // `resolve` normalizes it away — this shape is POSIX-only.)
      writeFileSync(join(repo, 'notes\\'), 'export const a = 1;\n');
      const classified = classifyRunTarget('notes\\');
      expect(classified).toEqual({
        kind: 'file',
        base: safeTarget(repoRelativeOf(repo, 'notes\\').rel),
      });
    },
  );
});
