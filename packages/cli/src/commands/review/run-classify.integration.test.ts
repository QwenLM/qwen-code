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
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRunTarget } from './run.js';
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

  it('a path outside the repo keeps its typed spelling rather than a .. walk', () => {
    const outside = classifyRunTarget(join(tmpdir(), 'elsewhere.ts'));
    expect(outside.kind).toBe('file');
    expect((outside as { base: string }).base).not.toContain('..');
  });
});
