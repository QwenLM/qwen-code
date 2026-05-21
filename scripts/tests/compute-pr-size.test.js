/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// compute-pr-size.cjs is CommonJS (.cjs ext because the repo root
// package.json sets "type": "module"). Vitest's ESM<->CJS interop
// surfaces its named exports as properties of the default import.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeMeaningfulSize,
  isIgnored,
  IGNORED_PATTERNS,
} from '../compute-pr-size.cjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

describe('isIgnored', () => {
  it('ignores lockfiles at root and nested', () => {
    expect(isIgnored('package-lock.json')).toBe(true);
    expect(isIgnored('sub/dir/pnpm-lock.yaml')).toBe(true);
    expect(isIgnored('yarn.lock')).toBe(true);
  });

  it('does not ignore a file that merely ends with a lockfile name', () => {
    // The `(?:^|\/)` anchor must prevent matching `my-package-lock.json`.
    expect(isIgnored('my-package-lock.json')).toBe(false);
  });

  it('ignores docs, markdown, snapshots and generated files', () => {
    expect(isIgnored('docs/intro.md')).toBe(true);
    expect(isIgnored('docs-site/x.tsx')).toBe(true);
    expect(isIgnored('packages/core/README.md')).toBe(true);
    expect(isIgnored('packages/core/__snapshots__/a.snap')).toBe(true);
    expect(isIgnored('src/schema.generated.ts')).toBe(true);
    expect(isIgnored('integration-tests/fixtures/sample.txt')).toBe(true);
  });

  it('does not ignore ordinary source files', () => {
    expect(isIgnored('packages/core/src/index.ts')).toBe(false);
    expect(isIgnored('scripts/compute-pr-size.cjs')).toBe(false);
  });
});

describe('computeMeaningfulSize', () => {
  it('sums additions+deletions of non-ignored files only', () => {
    const prJson = {
      files: [
        { path: 'src/a.ts', additions: 10, deletions: 5 },
        { path: 'package-lock.json', additions: 800, deletions: 800 },
        { path: 'docs/guide.md', additions: 50, deletions: 0 },
        { path: 'src/b.ts', additions: 3, deletions: 2 },
      ],
    };
    expect(computeMeaningfulSize(prJson)).toBe(20);
  });

  it('returns 0 for a docs-only PR (regression: PR #4356)', () => {
    const prJson = {
      files: [
        { path: 'docs/monitor.md', additions: 120, deletions: 0 },
        { path: 'docs/_nav.md', additions: 8, deletions: 0 },
      ],
    };
    expect(computeMeaningfulSize(prJson)).toBe(0);
  });

  it('treats a missing or non-array files[] as zero, not an error', () => {
    expect(computeMeaningfulSize({})).toBe(0);
    expect(computeMeaningfulSize({ files: null })).toBe(0);
    expect(computeMeaningfulSize({ files: 'oops' })).toBe(0);
  });

  it('skips malformed file entries defensively', () => {
    const prJson = {
      files: [
        null,
        { additions: 5 },
        { path: 42, additions: 5 },
        { path: 'src/c.ts', additions: 7 },
      ],
    };
    expect(computeMeaningfulSize(prJson)).toBe(7);
  });
});

describe('IGNORED_PATTERNS stays in sync with pr-gate.yml', () => {
  // The PR-size exclusion list is duplicated: once here as JS regexes,
  // once inline in .github/workflows/pr-gate.yml's github-script step.
  // Both files carry "keep in sync" comments — this test makes a silent
  // drift fail CI instead.
  it('matches the `const ignored = [...]` block in pr-gate.yml', () => {
    const yml = readFileSync(
      join(repoRoot, '.github', 'workflows', 'pr-gate.yml'),
      'utf8',
    );
    const start = yml.indexOf('const ignored = [');
    expect(start).toBeGreaterThan(-1);
    const end = yml.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    const block = yml.slice(start, end);
    const ymlSources = block
      .split('\n')
      .map((line) => line.match(/^\s*\/(.*)\/,/))
      .filter(Boolean)
      .map((m) => m[1]);
    expect(ymlSources).toEqual(IGNORED_PATTERNS.map((re) => re.source));
  });
});
