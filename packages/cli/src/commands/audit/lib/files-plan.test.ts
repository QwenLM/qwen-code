/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyExcludeRemedy,
  AuditRefusal,
  buildFilesPlan,
  checkLocalOnlyGuard,
  classifyAuditPath,
  collectAuditFiles,
  estimateTokens,
  LOW_SUBJECT_LINES_GATE,
  lowTierConfig,
  MAX_LINE_CHARS,
  resolveAuditRoot,
  rosterForEffort,
  SUBJECT_LINES_GATE,
  SUBJECT_TOKENS_PER_LINE,
  TEST_LINES_GATE,
  TEST_TOKENS_PER_LINE,
  tileFileGroups,
  TOKEN_CAP,
  walkAuditTree,
  type AuditCollection,
  type AuditFileEntry,
} from './files-plan.js';

let dir: string;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `audit-plan-test-$(literal)-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n'.repeat(10));
  writeFileSync(join(dir, 'src', 'a.test.ts'), 'x'.repeat(100));
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  writeFileSync(join(dir, 'logo.png'), 'not-really-a-png');
  writeFileSync(join(dir, 'module.pyc'), 'not-really-bytecode');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function collect(overrides?: Partial<AuditCollection>): AuditCollection {
  return { ...collectAuditFiles(dir), ...overrides };
}

function planFor(
  collection: AuditCollection,
  effort: 'low' | 'medium' | 'high' = 'medium',
) {
  return buildFilesPlan(dir, dir, effort, collection);
}

describe('walkAuditTree', () => {
  it('enumerates without git, including what git ls-files would ignore', () => {
    mkdirSync(join(dir, 'vendor', 'lib'), { recursive: true });
    writeFileSync(
      join(dir, 'vendor', 'lib', 'vendored.ts'),
      'export const v = 1;\n',
    );
    const { files } = walkAuditTree(dir);
    expect(files).toContain('vendor/lib/vendored.ts');
  });

  it('excludes dependency-install and tooling directories by name, anywhere', () => {
    for (const name of [
      'node_modules',
      '.git',
      'target',
      '.venv',
      '__pycache__',
      'coverage',
      '.next',
      'out',
      '.gradle',
      'obj',
      'Pods',
      '.tox',
      '.qwen',
    ]) {
      mkdirSync(join(dir, 'src', name), { recursive: true });
      writeFileSync(join(dir, 'src', name, 'x.ts'), 'const x = 1;\n');
    }
    const { files, excludedDirs } = walkAuditTree(dir);
    expect(files.every((f) => !f.endsWith('x.ts'))).toBe(true);
    expect(excludedDirs).toContain('src/node_modules');
    expect(excludedDirs).toContain('src/.git');
    expect(excludedDirs).toContain('src/.qwen');
  });

  it('excludes dist/build everywhere except under vendor/', () => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'out.js'), 'console.log(1);\n');
    mkdirSync(join(dir, 'vendor', 'pkg', 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'vendor', 'pkg', 'dist', 'index.js'),
      'module.exports = {};\n',
    );
    const { files, excludedDirs } = walkAuditTree(dir);
    expect(files).not.toContain('dist/out.js');
    expect(files).toContain('vendor/pkg/dist/index.js');
    expect(excludedDirs).toContain('dist');
  });

  it('excludes node_modules even under vendor/, and vendor/bundle', () => {
    mkdirSync(join(dir, 'vendor', 'pkg', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'pkg', 'node_modules', 'dep.js'), 'x');
    mkdirSync(join(dir, 'vendor', 'bundle'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'bundle', 'gem.rb'), 'x');
    const { files, excludedDirs } = walkAuditTree(dir);
    expect(files).not.toContain('vendor/pkg/node_modules/dep.js');
    expect(files).not.toContain('vendor/bundle/gem.rb');
    expect(excludedDirs).toContain('vendor/bundle');
  });

  it('treats an excluded name at the path root as excluding everything', () => {
    const distRoot = join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(join(distRoot, 'out.js'), 'console.log(1);\n');
    const { files, excludedDirs } = walkAuditTree(distRoot);
    expect(files).toEqual([]);
    expect(excludedDirs).toEqual(['.']);
  });

  it('records symlinks and never follows them', () => {
    symlinkSync(join(dir, 'src', 'a.ts'), join(dir, 'src', 'link.ts'));
    mkdirSync(join(dir, 'real'), { recursive: true });
    symlinkSync(join(dir, 'real'), join(dir, 'dirlink'));
    const { files, structuralUncoverable } = walkAuditTree(dir);
    expect(files).not.toContain('src/link.ts');
    expect(files).not.toContain('dirlink');
    expect(
      structuralUncoverable
        .filter((u) => u.reason === 'symlink')
        .map((u) => u.path),
    ).toEqual(expect.arrayContaining(['src/link.ts', 'dirlink']));
  });
});

describe('classifyAuditPath', () => {
  it('keeps vendor/ a subject but routes test-shaped paths under it to test', () => {
    expect(classifyAuditPath('vendor/lib/index.ts')).toBe('source');
    expect(classifyAuditPath('vendor/lib/hooks.test.ts')).toBe('test');
    expect(classifyAuditPath('vendor/lib/__tests__/x.ts')).toBe('test');
    expect(classifyAuditPath('vendor/lib/foo_test.go')).toBe('test');
    expect(classifyAuditPath('vendor/lib/test_main.py')).toBe('test');
    expect(classifyAuditPath('vendor/lib/x.snap')).toBe('generated');
  });

  it('classifies lockfiles and minified assets as generated (still subjects)', () => {
    expect(classifyAuditPath('package-lock.json')).toBe('generated');
    expect(classifyAuditPath('assets/app.min.js')).toBe('generated');
    expect(classifyAuditPath('docs/guide.md')).toBe('docs');
    expect(classifyAuditPath('README.md')).toBe('docs');
  });
});

describe('collectAuditFiles', () => {
  it('enumerates, classifies, and records binary files as uncoverable', () => {
    const c = collectAuditFiles(dir);
    const byPath = new Map(c.subjects.map((f) => [f.path, f]));
    expect(byPath.get('src/a.ts')?.kind).toBe('source');
    expect(byPath.get('src/a.ts')?.lines).toBe(10); // wc-style line count
    expect(c.testCorpus.map((f) => f.path)).toEqual(['src/a.test.ts']);
    expect(byPath.get('README.md')?.kind).toBe('docs');
    const uncoverable = new Map(c.uncoverable.map((u) => [u.path, u]));
    expect(uncoverable.get('logo.png')?.reason).toBe('non-text');
    expect(uncoverable.get('module.pyc')?.reason).toBe('non-text');
  });

  it('detects NUL-byte content as non-text even without a binary extension', () => {
    writeFileSync(join(dir, 'src', 'payload.ts'), 'const a = 1;\0\n');
    const c = collectAuditFiles(dir);
    expect(c.uncoverable.find((u) => u.path === 'src/payload.ts')?.reason).toBe(
      'non-text',
    );
  });

  it('detects an over-cap line as uncoverable with its lines counted', () => {
    writeFileSync(
      join(dir, 'src', 'bundle.ts'),
      `${'x'.repeat(MAX_LINE_CHARS + 1)}\n`,
    );
    const c = collectAuditFiles(dir);
    const entry = c.uncoverable.find((u) => u.path === 'src/bundle.ts');
    expect(entry?.reason).toBe('over-cap-lines');
    expect(entry?.lines).toBe(1);
  });

  it('surfaces reserved-prefix files as residue while keeping them subjects', () => {
    writeFileSync(join(dir, '.qwen-audit-scratch-foo.ts'), 'const s = 1;\n');
    const c = collectAuditFiles(dir);
    expect(c.residue.map((r) => r.path)).toEqual([
      '.qwen-audit-scratch-foo.ts',
    ]);
    expect(c.subjects.map((f) => f.path)).toContain(
      '.qwen-audit-scratch-foo.ts',
    );
  });

  it('detects an event/lifecycle module by call patterns', () => {
    for (const name of ['bus.ts', 'wire.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        Array.from({ length: 5 }, (_, i) => `emitter.emit('e${i}')`).join('\n'),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.detected).toBe(true);
    expect(c.eventDetection.callSites).toBeGreaterThanOrEqual(8);
    expect(c.eventDetection.files).toBe(2);
  });

  it('does not flag a module with no event surface', () => {
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.detected).toBe(false);
  });
});

describe('buildFilesPlan gates', () => {
  it('refuses an empty subject set at every tier', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      expect(() =>
        planFor(collect({ subjects: [], uncoverable: [] }), effort),
      ).toThrow(/no subject files/);
    }
  });

  it('names the exclusion when it empties the subject set', () => {
    const distRoot = join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(join(distRoot, 'out.js'), 'console.log(1);\n');
    expect(() =>
      buildFilesPlan(distRoot, distRoot, 'medium', collectAuditFiles(distRoot)),
    ).toThrow(/only excluded directories/);
  });

  it('refuses when every subject is uncoverable', () => {
    expect(() =>
      planFor(
        collect({
          subjects: [],
          uncoverable: [
            { path: 'logo.png', kind: 'source', reason: 'non-text', lines: 1 },
          ],
        }),
      ),
    ).toThrow(/only uncoverable subjects/);
  });

  it('refuses over the subject gate', () => {
    const big = collect({
      subjects: [
        {
          path: 'big.ts',
          kind: 'source',
          lines: SUBJECT_LINES_GATE + 1,
          chars: 0,
        },
      ],
    });
    expect(() => planFor(big)).toThrow(/subject lines exceeds/);
  });

  it('refuses low over its own gate and points at medium', () => {
    const big = collect({
      uncoverable: [],
      subjects: [
        {
          path: 'big.ts',
          kind: 'source',
          lines: LOW_SUBJECT_LINES_GATE + 1,
          chars: 0,
        },
      ],
    });
    expect(() => planFor(big, 'low')).toThrow(/--effort medium/);
    // The same plan is fine at medium.
    expect(planFor(big, 'medium').subjectLines).toBe(
      LOW_SUBJECT_LINES_GATE + 1,
    );
  });

  it('applies the test gate only on tiers that run Agent 5', () => {
    const c = collect({
      testCorpus: [
        {
          path: 'big.test.ts',
          kind: 'test',
          lines: TEST_LINES_GATE + 1,
          chars: 0,
        },
      ],
    });
    expect(() => planFor(c, 'medium')).toThrow(/test lines exceeds/);
    expect(() => planFor(c, 'high')).toThrow(/test lines exceeds/);
    expect(planFor(c, 'low').testLines).toBe(TEST_LINES_GATE + 1);
  });

  it('counts uncoverable files toward the gate arms', () => {
    const c = collect({
      subjects: [
        {
          path: 'a.ts',
          kind: 'source',
          lines: SUBJECT_LINES_GATE - 10,
          chars: 0,
        },
      ],
      uncoverable: [
        { path: 'b.bin', kind: 'source', reason: 'non-text', lines: 20 },
      ],
    });
    expect(() => planFor(c)).toThrow(/subject lines exceeds/);
  });
});

describe('estimate and token cap', () => {
  it('brackets both calibration modules', () => {
    // permissions: 7,638 subject / 8,640 test, measured ~32.5M
    const permissions = estimateTokens(7638, 8640);
    expect(permissions.floorTokens).toBeGreaterThanOrEqual(32_400_000);
    expect(permissions.floorTokens).toBeLessThanOrEqual(32_600_000);
    expect(permissions.topTokens).toBeLessThanOrEqual(42_400_000);
    // hooks: 8,516 subject / 16,335 test, measured ~46M
    const hooks = estimateTokens(8516, 16335);
    expect(hooks.floorTokens).toBeGreaterThanOrEqual(45_900_000);
    expect(hooks.floorTokens).toBeLessThanOrEqual(46_100_000);
    expect(hooks.topTokens).toBeLessThanOrEqual(TOKEN_CAP);
  });

  it('the precision case: rounded rates would refuse the hooks module', () => {
    const roundedTop = Math.round((8516 * 2_600 + 16335 * 1_500) * 1.3);
    expect(roundedTop).toBeGreaterThan(TOKEN_CAP);
    expect(SUBJECT_TOKENS_PER_LINE).toBe(2_607);
    expect(TEST_TOKENS_PER_LINE).toBe(1_457);
  });

  it('refuses the corner that passes both gate arms', () => {
    const corner = estimateTokens(SUBJECT_LINES_GATE, TEST_LINES_GATE);
    expect(corner.topTokens).toBeGreaterThan(TOKEN_CAP);
    const c = collect({
      uncoverable: [],
      subjects: [
        { path: 'a.ts', kind: 'source', lines: SUBJECT_LINES_GATE, chars: 0 },
      ],
      testCorpus: [
        { path: 'a.test.ts', kind: 'test', lines: TEST_LINES_GATE, chars: 0 },
      ],
    });
    expect(() => planFor(c, 'medium')).toThrow(/cap/);
  });

  it('prices no estimate at low', () => {
    expect(planFor(collect(), 'low').estimate).toBeNull();
  });
});

describe('roster and tier config', () => {
  it('medium launches the nine dimension agents; high adds 6b/6c; low none', () => {
    expect(rosterForEffort('medium')).toEqual([
      '1a',
      '1c',
      '2',
      '3a',
      '3b',
      '3c',
      '4',
      '5',
      '6a',
    ]);
    expect(rosterForEffort('high')).toEqual([
      ...rosterForEffort('medium'),
      '6b',
      '6c',
    ]);
    expect(rosterForEffort('low')).toEqual([]);
  });

  it('1c is mandatory at medium and high; 1b and invariant roles never appear', () => {
    for (const effort of ['medium', 'high'] as const) {
      expect(rosterForEffort(effort)).toContain('1c');
      expect(rosterForEffort(effort)).not.toContain('1b');
    }
  });

  it('low tier drops angle B, rebases the floor to A+C, computes the sweep flag', () => {
    expect(lowTierConfig(10).angles).toEqual(['A', 'C']);
    expect(lowTierConfig(10).angleFloorApplied).toBe(true);
    expect(lowTierConfig(10).sweep).toBe(false);
    expect(lowTierConfig(500).angles).toEqual(['A', 'C', 'D', 'E', 'F']);
    expect(lowTierConfig(500).angleFloorApplied).toBe(false);
    expect(lowTierConfig(500).sweep).toBe(true);
    expect(lowTierConfig(500).findingCap).toBe(10);
  });

  it('high carries file groups and the plan-time agent bound', () => {
    const c = collect();
    const high = planFor(c, 'high');
    expect(high.fileGroups).not.toBeNull();
    expect(high.agentBound).toBe(
      (high.roster.length + high.fileGroups!.length * 5) * 2,
    );
    expect(planFor(c, 'medium').fileGroups).toBeNull();
    expect(planFor(c, 'medium').agentBound).toBeNull();
  });
});

describe('tileFileGroups', () => {
  it('packs in path order up to the group constant; oversized files stand alone', () => {
    const entry = (path: string, lines: number): AuditFileEntry => ({
      path,
      kind: 'source',
      lines,
      chars: 0,
    });
    const groups = tileFileGroups([
      entry('a.ts', 300),
      entry('b.ts', 200),
      entry('c.ts', 500),
      entry('d.ts', 50),
    ]);
    expect(groups).toEqual([['a.ts'], ['b.ts'], ['c.ts'], ['d.ts']]);
    expect(tileFileGroups([entry('a.ts', 300), entry('b.ts', 100)])).toEqual([
      ['a.ts', 'b.ts'],
    ]);
  });
});

describe('resolveAuditRoot', () => {
  it('rejects files with a /review delegation message', () => {
    expect(() => resolveAuditRoot(join(dir, 'src', 'a.ts'))).toThrow(
      /\/review <file-path>/,
    );
  });

  it('rejects missing paths', () => {
    expect(() => resolveAuditRoot(join(dir, 'nope'))).toThrow(/does not exist/);
  });
});

describe('git-backed checks', () => {
  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  }

  function initRepo(): string {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'mod'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    return repo;
  }

  it('refuses a gitlink at or under the audited path', () => {
    const repo = initRepo();
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).trim();
    git(
      ['update-index', '--add', '--cacheinfo', `160000,${sha},mod/sub`],
      repo,
    );
    expect(() =>
      buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      ),
    ).toThrow(AuditRefusal);
    expect(() =>
      buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      ),
    ).toThrow(/submodule/);
  });

  it('guard: unprotected without ignore rules, ok with them, tracked with force-added files', () => {
    const repo = initRepo();
    const unprotected = checkLocalOnlyGuard(repo, 'x.md');
    expect(unprotected.dirs.map((d) => d.status)).toEqual([
      'unprotected',
      'unprotected',
    ]);

    writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
    const ignored = checkLocalOnlyGuard(repo, 'x.md');
    expect(ignored.dirs.map((d) => d.status)).toEqual(['ok', 'ok']);

    // A full re-include of the audits path flips it back to exposed.
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n!.qwen/audits/**\n',
    );
    const reincluded = checkLocalOnlyGuard(repo, 'x.md');
    expect(reincluded.dirs[0].status).toBe('unprotected');
    expect(reincluded.dirs[1].status).toBe('ok');

    // A force-added tracked file under the tmp dir is caught by the index probe.
    writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(repo, '.qwen', 'tmp', 'forced.json'), '{}');
    git(['add', '-f', '.qwen/tmp/forced.json'], repo);
    const tracked = checkLocalOnlyGuard(repo, 'x.md');
    expect(tracked.dirs[1].status).toBe('tracked');
    expect(tracked.dirs[1].trackedFiles).toContain('.qwen/tmp/forced.json');
  });

  it('the exclude remedy makes the probe answer ignored on re-check', () => {
    const repo = initRepo();
    expect(
      checkLocalOnlyGuard(repo, 'x.md').dirs.every(
        (d) => d.status === 'unprotected',
      ),
    ).toBe(true);
    applyExcludeRemedy(repo);
    const after = checkLocalOnlyGuard(repo, 'x.md');
    expect(after.dirs.map((d) => d.status)).toEqual(['ok', 'ok']);
    // The remedy lands in .git/info/exclude; no tracked .gitignore is created.
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(
      readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('/.qwen/audits/');
  });

  it('probes toplevel-relative when the cwd is a subdirectory', () => {
    const repo = initRepo();
    writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
    const sub = join(repo, 'pkg', 'sub');
    mkdirSync(sub, { recursive: true });
    // .qwen/ ignored at the toplevel covers the subdirectory's landing too.
    expect(checkLocalOnlyGuard(sub, 'x.md').dirs.map((d) => d.status)).toEqual([
      'ok',
      'ok',
    ]);
    // Without ignore rules the subdirectory landing is unprotected, and the
    // remedy anchors the rules at the subdirectory.
    const repo2 = join(dir, 'repo2');
    mkdirSync(join(repo2, 'pkg', 'sub'), { recursive: true });
    git(['init', '-q'], repo2);
    const sub2 = join(repo2, 'pkg', 'sub');
    expect(checkLocalOnlyGuard(sub2, 'x.md').dirs.map((d) => d.status)).toEqual(
      ['unprotected', 'unprotected'],
    );
    applyExcludeRemedy(sub2);
    expect(
      readFileSync(join(repo2, '.git', 'info', 'exclude'), 'utf8'),
    ).toContain('/pkg/sub/.qwen/audits/');
    expect(checkLocalOnlyGuard(sub2, 'x.md').dirs.map((d) => d.status)).toEqual(
      ['ok', 'ok'],
    );
  });

  it('passes vacuously outside any worktree', () => {
    const guard = checkLocalOnlyGuard(dir, 'x.md');
    expect(guard.dirs.map((d) => d.status)).toEqual([
      'no-worktree',
      'no-worktree',
    ]);
  });
});
