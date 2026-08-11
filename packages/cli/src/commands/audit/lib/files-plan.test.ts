/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
  FILE_GROUP_LINES,
  LOW_ANGLE_FLOOR_LINES,
  LOW_FINDING_CAP,
  LOW_SUBJECT_LINES_GATE,
  LOW_SWEEP_FLOOR_LINES,
  lowTierConfig,
  MAX_LINE_CHARS,
  MAX_REVERSE_ROUNDS,
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
    `audit-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      'venv',
      'env',
      'virtualenv',
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
    mkdirSync(join(dir, 'build'), { recursive: true });
    writeFileSync(join(dir, 'build', 'app.js'), 'console.log(2);\n');
    mkdirSync(join(dir, 'vendor', 'pkg', 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'vendor', 'pkg', 'dist', 'index.js'),
      'module.exports = {};\n',
    );
    mkdirSync(join(dir, 'vendor', 'pkg', 'build'), { recursive: true });
    writeFileSync(
      join(dir, 'vendor', 'pkg', 'build', 'app.js'),
      'module.exports = {};\n',
    );
    mkdirSync(join(dir, 'bundle'), { recursive: true });
    writeFileSync(join(dir, 'bundle', 'app.js'), 'console.log(3);\n');
    const { files, excludedDirs } = walkAuditTree(dir);
    expect(files).not.toContain('dist/out.js');
    expect(files).not.toContain('build/app.js');
    expect(files).toContain('vendor/pkg/dist/index.js');
    expect(files).toContain('vendor/pkg/build/app.js');
    expect(excludedDirs).toContain('dist');
    expect(excludedDirs).toContain('build');
    // bundle/ is third-party output in BOTH positions (Bundler under
    // vendor, JS bundlers at the top level).
    expect(files).not.toContain('bundle/app.js');
    expect(excludedDirs).toContain('bundle');
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

  it('applies the vendor rules when the audited path itself is named vendor', () => {
    const vendorRoot = join(dir, 'vendor');
    mkdirSync(join(vendorRoot, 'bundle'), { recursive: true });
    writeFileSync(join(vendorRoot, 'bundle', 'gem.rb'), 'x');
    mkdirSync(join(vendorRoot, 'dist'), { recursive: true });
    writeFileSync(join(vendorRoot, 'dist', 'index.js'), 'module.exports = {};');
    const { files, excludedDirs } = walkAuditTree(vendorRoot);
    // Vendored build output is a subject; the dependency-install dir is not.
    expect(files).toContain('dist/index.js');
    expect(files).not.toContain('bundle/gem.rb');
    expect(excludedDirs).toContain('bundle');
  });

  it('applies the vendor rules to a root under a vendor-named ancestor', () => {
    // Start-point independence: a walk that DESCENDS into vendor/ keeps
    // vendor/acme/dist as a subject, so starting AT vendor/acme must too.
    const root = join(dir, 'vendor', 'acme');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'out.js'), 'console.log(1);\n');
    const { files } = walkAuditTree(root);
    expect(files).toContain('dist/out.js');
  });

  it('keeps the verdicts start-point-independent for vendor roots', () => {
    // vendor/bundle: a Bundler install — excluded whether the walk descends
    // into vendor/ or starts at the install dir.
    const bundleRoot = join(dir, 'vendor', 'bundle');
    mkdirSync(bundleRoot, { recursive: true });
    writeFileSync(join(bundleRoot, 'gem.rb'), 'x');
    const bundleWalk = walkAuditTree(bundleRoot);
    expect(bundleWalk.files).toEqual([]);
    expect(bundleWalk.excludedDirs).toEqual(['.']);
    // vendor/pkg/dist: shipped package output — kept either way.
    const distRoot = join(dir, 'vendor', 'pkg', 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(join(distRoot, 'index.js'), 'module.exports = {};');
    expect(walkAuditTree(distRoot).files).toContain('index.js');
  });

  it('treats an excluded name at the path root as excluding everything', () => {
    const distRoot = join(dir, 'dist');
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(join(distRoot, 'out.js'), 'console.log(1);\n');
    const { files, excludedDirs } = walkAuditTree(distRoot);
    expect(files).toEqual([]);
    expect(excludedDirs).toEqual(['.']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records an unreadable directory and keeps enumerating',
    () => {
      mkdirSync(join(dir, 'locked'), { recursive: true });
      writeFileSync(join(dir, 'locked', 'x.ts'), 'const x = 1;\n');
      writeFileSync(join(dir, 'after.ts'), 'const after = 1;\n');
      chmodSync(join(dir, 'locked'), 0o000);
      try {
        const { files, structuralUncoverable } = walkAuditTree(dir);
        expect(files).toContain('after.ts');
        expect(structuralUncoverable).toContainEqual({
          path: 'locked',
          reason: 'unreadable',
        });
      } finally {
        chmodSync(join(dir, 'locked'), 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records an unsearchable directory child and keeps enumerating',
    () => {
      // Mode 0400: readdir succeeds (read bit), lstat on a child fails
      // (search bit) — the entry records as uncoverable instead of
      // aborting the enumeration.
      const opaque = join(dir, 'opaque');
      mkdirSync(opaque, { recursive: true });
      writeFileSync(join(opaque, 'x.ts'), 'const x = 1;\n');
      writeFileSync(join(dir, 'after2.ts'), 'const after = 1;\n');
      chmodSync(opaque, 0o400);
      try {
        const { files, structuralUncoverable } = walkAuditTree(dir);
        expect(files).toContain('after2.ts');
        expect(files).not.toContain('opaque/x.ts');
        expect(
          structuralUncoverable
            .filter((u) => u.reason === 'unreadable')
            .map((u) => u.path),
        ).toContain('opaque/x.ts');
      } finally {
        chmodSync(opaque, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'records FIFOs as non-regular and never opens them',
    () => {
      execFileSync('mkfifo', [join(dir, 'pipe')]);
      const { files, structuralUncoverable } = walkAuditTree(dir);
      expect(files).not.toContain('pipe');
      expect(structuralUncoverable).toContainEqual({
        path: 'pipe',
        reason: 'non-regular',
      });
    },
  );

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
    // A generated snapshot under a test directory is generated, not a test.
    expect(classifyAuditPath('__tests__/x.snap')).toBe('generated');
    expect(classifyAuditPath('__snapshots__/foo.snap')).toBe('generated');
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

  it('records secret-shaped files by name and never content-reads them', () => {
    writeFileSync(join(dir, '.env'), 'API_KEY=secret\n');
    writeFileSync(join(dir, '.env.local'), 'TOKEN=x\n');
    mkdirSync(join(dir, 'deploy'), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'server.pem'), '-----BEGIN-----\n');
    writeFileSync(join(dir, 'id_rsa'), '-----BEGIN OPENSSH-----\n');
    writeFileSync(join(dir, 'state.tfstate'), '{}\n');
    writeFileSync(join(dir, '.npmrc'), '//registry/:_authToken=x\n');
    const c = collectAuditFiles(dir);
    const secrets = c.uncoverable.filter((u) => u.reason === 'secret-shaped');
    expect(secrets.map((u) => u.path).sort()).toEqual([
      '.env',
      '.env.local',
      '.npmrc',
      'deploy/server.pem',
      'id_rsa',
      'state.tfstate',
    ]);
    // Names surface at the confirmation; zero lines steer the gate arms.
    expect(secrets.every((u) => u.lines === 0)).toBe(true);
    // A regular .ts file named after a secret shape is not caught.
    writeFileSync(join(dir, 'src', 'env-config.ts'), 'export const e = 1;\n');
    expect(collectAuditFiles(dir).subjects.map((f) => f.path)).toContain(
      'src/env-config.ts',
    );
  });

  it('keeps generated files subjects at collection level', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const c = collectAuditFiles(dir);
    expect(c.subjects).toContainEqual(
      expect.objectContaining({ path: 'package-lock.json', kind: 'generated' }),
    );
  });

  it('keeps a line at exactly the cap a subject', () => {
    writeFileSync(
      join(dir, 'src', 'exact.ts'),
      `${'x'.repeat(MAX_LINE_CHARS)}\n`,
    );
    const c = collectAuditFiles(dir);
    expect(c.subjects.map((f) => f.path)).toContain('src/exact.ts');
  });

  it('detects NUL-byte content as non-text even without a binary extension', () => {
    writeFileSync(join(dir, 'src', 'payload.ts'), 'const a = 1;\0\n');
    const c = collectAuditFiles(dir);
    expect(c.uncoverable.find((u) => u.path === 'src/payload.ts')?.reason).toBe(
      'non-text',
    );
  });

  it('detects a NUL past the head window as non-text', () => {
    // The old scan windowed the first 8 KiB; a binary whose first NUL sits
    // after it escaped as text.
    writeFileSync(
      join(dir, 'src', 'late-nul.ts'),
      `${'a'.repeat(16 * 1024)}\0trailing`,
    );
    const c = collectAuditFiles(dir);
    expect(
      c.uncoverable.find((u) => u.path === 'src/late-nul.ts')?.reason,
    ).toBe('non-text');
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

  it('requires event calls spread over more than one file', () => {
    writeFileSync(
      join(dir, 'src', 'solo-bus.ts'),
      Array.from({ length: 10 }, (_, i) => `emitter.emit('e${i}')`).join('\n'),
    );
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.callSites).toBeGreaterThanOrEqual(8);
    expect(c.eventDetection.files).toBe(1);
    expect(c.eventDetection.detected).toBe(false);
  });

  it('counts event calls in subjects only, not the test corpus', () => {
    writeFileSync(
      join(dir, 'src', 'bus.test.ts'),
      Array.from({ length: 10 }, (_, i) => `emitter.emit('e${i}')`).join('\n'),
    );
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.callSites).toBe(0);
    expect(c.eventDetection.detected).toBe(false);
  });

  it('does not count event keywords inside comments or strings', () => {
    for (const name of ['commented.ts', 'quoted.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        [
          Array.from({ length: 5 }, (_, i) => `// emit('e${i}')`).join('\n'),
          Array.from(
            { length: 3 },
            (_, i) => `const s${i} = 'dispatch(x)';`,
          ).join('\n'),
          '/* subscribe(handlers) */',
        ].join('\n'),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.callSites).toBe(0);
    expect(c.eventDetection.detected).toBe(false);
  });

  it('counts .once() alongside .on() as an event call site', () => {
    for (const name of ['once-bus.ts', 'once-wire.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        Array.from({ length: 5 }, (_, i) => `emitter.once('e${i}', h)`).join(
          '\n',
        ),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.detected).toBe(true);
    expect(c.eventDetection.files).toBe(2);
  });

  it('does not count past-tense and stem-prefix calls as event call sites', () => {
    for (const name of ['past.ts', 'tense.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        Array.from(
          { length: 5 },
          (_, i) => `fired(${i}); emitted(${i}); triggered(${i});`,
        ).join('\n'),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.callSites).toBe(0);
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

  it('blames test routing, not exclusions, when only tests remain', () => {
    const pkg = join(dir, 'pkg');
    mkdirSync(join(pkg, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(pkg, 'node_modules', 'dep', 'index.js'), 'x');
    mkdirSync(join(pkg, '__tests__'), { recursive: true });
    writeFileSync(join(pkg, '__tests__', 'foo.test.ts'), 'test();');
    expect(() =>
      buildFilesPlan(pkg, pkg, 'medium', collectAuditFiles(pkg)),
    ).toThrow(/Tests route out of the subject set/);
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

  it('names the path when the low-gate remedy would bounce into the test gate', () => {
    // 2,500 subject lines: over low's gate, subject-legal at medium — but
    // 20,000 test lines trip medium's test gate, so '--effort medium' would
    // refuse again.
    const c = collect({
      uncoverable: [],
      subjects: [
        {
          path: 'a.ts',
          kind: 'source',
          lines: LOW_SUBJECT_LINES_GATE + 500,
          chars: 0,
        },
      ],
      testCorpus: [
        {
          path: 'a.test.ts',
          kind: 'test',
          lines: TEST_LINES_GATE + 2_000,
          chars: 0,
        },
      ],
    });
    expect(() => planFor(c, 'low')).toThrow(/narrow the path/);
    expect(() => planFor(c, 'low')).toThrow(/test lines exceed/);
  });

  it('names the path, not a dead-end tier change, when medium would hit the cap', () => {
    // 8,000 subject + 18,000 test lines: gate-legal, but the medium
    // estimate tops over the cap — "--effort medium" would refuse again.
    const c = collect({
      uncoverable: [],
      subjects: [{ path: 'a.ts', kind: 'source', lines: 8_000, chars: 0 }],
      testCorpus: [
        { path: 'a.test.ts', kind: 'test', lines: 18_000, chars: 0 },
      ],
    });
    expect(() => planFor(c, 'low')).toThrow(/narrow the path/);
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

  it('counts uncoverable test files toward the test gate', () => {
    const c = collect({
      subjects: [{ path: 'a.ts', kind: 'source', lines: 10, chars: 0 }],
      testCorpus: [],
      uncoverable: [
        {
          path: 'big.bin',
          kind: 'test',
          reason: 'non-text',
          lines: TEST_LINES_GATE + 1,
        },
      ],
    });
    expect(() => planFor(c, 'medium')).toThrow(/test lines exceeds/);
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
    expect(permissions.topTokens).toBeGreaterThanOrEqual(42_000_000);
    expect(permissions.topTokens).toBeLessThanOrEqual(42_400_000);
    // hooks: 8,516 subject / 16,335 test, measured ~46M
    const hooks = estimateTokens(8516, 16335);
    expect(hooks.floorTokens).toBeGreaterThanOrEqual(45_900_000);
    expect(hooks.floorTokens).toBeLessThanOrEqual(46_100_000);
    expect(hooks.topTokens).toBeGreaterThanOrEqual(59_500_000);
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
    expect(lowTierConfig(500).findingCap).toBe(LOW_FINDING_CAP);
  });

  it('the angle and sweep floors flip exactly at their constants', () => {
    expect(lowTierConfig(LOW_ANGLE_FLOOR_LINES - 1).angleFloorApplied).toBe(
      true,
    );
    expect(lowTierConfig(LOW_ANGLE_FLOOR_LINES).angleFloorApplied).toBe(false);
    expect(lowTierConfig(LOW_ANGLE_FLOOR_LINES).angles).toEqual([
      'A',
      'C',
      'D',
      'E',
      'F',
    ]);
    expect(lowTierConfig(LOW_SWEEP_FLOOR_LINES - 1).sweep).toBe(false);
    expect(lowTierConfig(LOW_SWEEP_FLOOR_LINES).sweep).toBe(true);
  });

  it('high carries file groups and the plan-time agent bound', () => {
    const c = collect();
    const high = planFor(c, 'high');
    expect(high.fileGroups).not.toBeNull();
    expect(high.agentBound).toBe(
      (high.roster.length + high.fileGroups!.length * MAX_REVERSE_ROUNDS) * 2,
    );
    expect(planFor(c, 'medium').fileGroups).toBeNull();
    expect(planFor(c, 'medium').agentBound).toBeNull();
  });
  it('keys the low tier on walked lines, not gate-arm totals', () => {
    // A small walked module padded by an over-cap uncoverable text file:
    // the gate arm counts the padding, the low tier must not.
    const c = collect({
      subjects: [{ path: 'a.ts', kind: 'source', lines: 10, chars: 0 }],
      uncoverable: [
        {
          path: 'gen.txt',
          kind: 'source',
          reason: 'over-cap-lines',
          lines: LOW_ANGLE_FLOOR_LINES + 100,
        },
      ],
    });
    const low = planFor(c, 'low');
    expect(low.lowTier?.angleFloorApplied).toBe(true);
    expect(low.lowTier?.angles).toEqual(['A', 'C']);
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
    // 400 is FILE_GROUP_LINES — express the fixture against it so the
    // expected groups cannot survive a constant move with the wrong shape.
    const groups = tileFileGroups([
      entry('a.ts', FILE_GROUP_LINES - 100),
      entry('b.ts', FILE_GROUP_LINES / 2),
      entry('c.ts', FILE_GROUP_LINES + 100),
      entry('d.ts', FILE_GROUP_LINES / 8),
    ]);
    expect(groups).toEqual([['a.ts'], ['b.ts'], ['c.ts'], ['d.ts']]);
    expect(
      tileFileGroups([
        entry('a.ts', FILE_GROUP_LINES - 100),
        entry('b.ts', FILE_GROUP_LINES / 4),
      ]),
    ).toEqual([['a.ts', 'b.ts']]);
  });
});

describe('resolveAuditRoot', () => {
  it('rejects an empty target instead of auditing the cwd', () => {
    expect(() => resolveAuditRoot('')).toThrow(/no directory path/);
    expect(() => resolveAuditRoot('   ')).toThrow(/no directory path/);
  });

  it('resolves a symlinked target to its real path', () => {
    const real = join(dir, 'real-root');
    mkdirSync(real, { recursive: true });
    const link = join(dir, 'link-root');
    symlinkSync(real, link);
    expect(resolveAuditRoot(link)).toBe(realpathSync(real));
  });

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
        // Isolate the helper repos from ambient config (a user/global
        // core.excludesFile or hooks.path would leak into the probes).
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(dir, 'empty-gitconfig'),
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
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    git(['init', '-q'], repo);
    writeFileSync(join(repo, 'mod', 'a.ts'), 'const a = 1;\n');
    return repo;
  }

  it('enumerates gitignored vendored code inside a real repository', () => {
    const repo = join(dir, 'repo-gi');
    mkdirSync(join(repo, 'vendor', 'lib'), { recursive: true });
    git(['init', '-q'], repo);
    writeFileSync(join(repo, '.gitignore'), 'vendor/\n');
    writeFileSync(
      join(repo, 'vendor', 'lib', 'vendored.ts'),
      'export const v = 1;\n',
    );
    // The FS walk — not `git ls-files` — is what covers exactly this target.
    expect(walkAuditTree(repo).files).toContain('vendor/lib/vendored.ts');
  });

  it('refuses a toplevel audit with a gitlink underneath', () => {
    const repo = initRepo();
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).trim();
    git(
      ['update-index', '--add', '--cacheinfo', `160000,${sha},mod/sub`],
      repo,
    );
    expect(() =>
      buildFilesPlan(repo, repo, 'medium', collectAuditFiles(repo)),
    ).toThrow(/submodule/);
  });

  it('refuses auditing inside a gitlink ancestor path', () => {
    const repo = initRepo();
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).trim();
    git(
      ['update-index', '--add', '--cacheinfo', `160000,${sha},mod/sub`],
      repo,
    );
    mkdirSync(join(repo, 'mod', 'sub', 'inner'), { recursive: true });
    writeFileSync(join(repo, 'mod', 'sub', 'inner', 'i.ts'), 'const i = 1;\n');
    const inner = join(repo, 'mod', 'sub', 'inner');
    expect(() =>
      buildFilesPlan(inner, inner, 'medium', collectAuditFiles(inner)),
    ).toThrow(/submodule/);
  });

  it('refuses inside a checked-out submodule (superproject arm)', () => {
    const sub = join(dir, 'subrepo');
    mkdirSync(sub, { recursive: true });
    git(['init', '-q'], sub);
    writeFileSync(join(sub, 's.ts'), 'const s = 1;\n');
    git(['add', '.'], sub);
    git(['commit', '-m', 'sub', '-q'], sub);

    const superProject = join(dir, 'super');
    mkdirSync(superProject, { recursive: true });
    git(['init', '-q'], superProject);
    writeFileSync(join(superProject, 'm.ts'), 'const m = 1;\n');
    git(['add', '.'], superProject);
    git(['commit', '-m', 'super', '-q'], superProject);
    git(
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'vendored'],
      superProject,
    );

    const vendored = join(superProject, 'vendored');
    expect(() =>
      buildFilesPlan(vendored, vendored, 'medium', collectAuditFiles(vendored)),
    ).toThrow(/submodule/);
  });

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

  it('refuses a gitlink with a non-ASCII path (ls-files -z keeps it verbatim)', () => {
    const repo = initRepo();
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).trim();
    git(
      ['update-index', '--add', '--cacheinfo', `160000,${sha},mod/vendör`],
      repo,
    );
    expect(() =>
      buildFilesPlan(
        join(repo, 'mod'),
        join(repo, 'mod'),
        'medium',
        collectAuditFiles(join(repo, 'mod')),
      ),
    ).toThrow(/submodule/);
  });

  it('does not refuse a clean path next to a tab-named gitlink', () => {
    const repo = initRepo();
    mkdirSync(join(repo, 'mod', 'a'), { recursive: true });
    writeFileSync(join(repo, 'mod', 'a', 'x.ts'), 'const x = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const sha = git(['rev-parse', 'HEAD'], repo).trim();
    git(
      ['update-index', '--add', '--cacheinfo', `160000,${sha},mod/a\tb`],
      repo,
    );
    const target = join(repo, 'mod', 'a');
    // The gitlink is 'mod/a\tb', not 'mod/a' — auditing mod/a is clean.
    const plan = buildFilesPlan(
      target,
      target,
      'medium',
      collectAuditFiles(target),
    );
    expect(plan.subjectFiles.map((f) => f.path)).toContain('x.ts');
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

  it('catches a name-selective re-include of the dated report shape', () => {
    const repo = initRepo();
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/[0-9]*.md\n',
    );
    const guard = checkLocalOnlyGuard(repo, 'x.md');
    expect(guard.dirs[0].status).toBe('unprotected');
    expect(guard.dirs[1].status).toBe('ok');
  });

  it('a re-include exposing one tmp shape leaves the dir unprotected', () => {
    const repo = initRepo();
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/tmp/\n.qwen/tmp/*\n!.qwen/tmp/audit-plan-*.json\n',
    );
    const guard = checkLocalOnlyGuard(repo, 'x.md');
    expect(guard.dirs[1].status).toBe('unprotected');
    // The representative names the exposed shape: the re-include makes the
    // plan files committable while the other shapes stay ignored.
    expect(guard.dirs[1].representative).toContain('audit-plan-');
  });

  it('a date-keyed re-include cannot escape the audits probe', () => {
    const repo = initRepo();
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    writeFileSync(
      join(repo, '.gitignore'),
      `.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/${month}-*.md\n`,
    );
    // The probe carries the CURRENT date, so a re-include keyed to this
    // month matches it and the directory answers exposed.
    expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
      'unprotected',
    );
  });

  it('a sidecar-selective re-include leaves the audits dir unprotected', () => {
    const repo = initRepo();
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/*.sidecar\n',
    );
    expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
      'unprotected',
    );
  });

  // ':' is a reserved Win32 filename character, so the ':weird' fixture
  // directory cannot be created on Windows.
  it.skipIf(process.platform === 'win32')(
    'the tracked probe takes a literal pathspec under a colon-leading prefix',
    () => {
      const repo = join(dir, 'repo-colon');
      mkdirSync(join(repo, ':weird', '.qwen', 'tmp'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, '.gitignore'), '.qwen/\n');
      writeFileSync(join(repo, ':weird', '.qwen', 'tmp', 'forced.json'), '{}');
      git(['add', '-f', '--', ':(literal):weird/.qwen/tmp/forced.json'], repo);
      const guard = checkLocalOnlyGuard(join(repo, ':weird'), 'x.md');
      expect(guard.dirs[1].status).toBe('tracked');
    },
  );

  // Symlink fixtures need POSIX permissions semantics.
  it.skipIf(process.platform === 'win32')(
    'answers for a symlinked .qwen through its physical target',
    () => {
      const repo = initRepo();
      // Target outside the worktree: artifacts physically land where git
      // can never commit them — no probe fatal, no forced fallback.
      const outside = join(dir, 'outside-audit-store');
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(repo, '.qwen'));
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe('ok');
      rmSync(join(repo, '.qwen'), { force: true });

      // Target inside the worktree and gitignored: the probe follows the
      // link to the physical path (check-ignore fatals through the link).
      const inside = join(repo, '.audit-store');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(repo, '.gitignore'), '.audit-store/\n');
      symlinkSync(inside, join(repo, '.qwen'));
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe('ok');
      rmSync(join(repo, '.qwen'), { force: true });

      // Dangling link: artifacts cannot land here at all — expose it so the
      // fallback landing engages.
      symlinkSync(join(repo, 'nowhere'), join(repo, '.qwen'));
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
        'unprotected',
      );
    },
  );

  it('the exclude remedy refuses a prefix carrying gitignore pattern syntax', () => {
    const repo = initRepo();
    const magic = join(repo, 'a[1]');
    mkdirSync(magic, { recursive: true });
    expect(() => applyExcludeRemedy(magic)).toThrow(/pattern syntax/);
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

  it('appends root-anchored rules even when a subdirectory rule exists', () => {
    const repo = initRepo();
    const sub = join(repo, 'pkg', 'sub');
    mkdirSync(sub, { recursive: true });
    applyExcludeRemedy(sub);
    applyExcludeRemedy(repo);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/pkg/sub/.qwen/audits/');
    expect(exclude.split('\n')).toContain('/.qwen/audits/');
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
