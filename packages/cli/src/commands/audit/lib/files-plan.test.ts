/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  applyExcludeRemedy,
  auditReportSlug,
  AuditRefusal,
  buildFilesPlan,
  checkLocalOnlyGuard,
  classifyAuditPath,
  collectAuditFiles,
  ESTIMATE_HEADROOM,
  estimateTokens,
  FILE_GROUP_LINES,
  guardProbeShapes,
  LOW_ANGLE_FLOOR_LINES,
  LOW_FINDING_CAP,
  LOW_SUBJECT_LINES_GATE,
  LOW_SWEEP_FLOOR_LINES,
  lowTierConfig,
  MAX_LINE_CHARS,
  MAX_REVERSE_ROUNDS,
  nextCalendarDate,
  REPORT_SLUG_MAX_CHARS,
  resolveAuditRoot,
  rosterForEffort,
  submoduleRefusal,
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

const AUDIT_SKILL_PATH = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages/core/src/skills/bundled/audit/SKILL.md',
);

let dir: string;
let originalConfigNosystem: string | undefined;
let originalConfigGlobal: string | undefined;
let originalQwenHome: string | undefined;

beforeEach(() => {
  originalConfigNosystem = process.env['GIT_CONFIG_NOSYSTEM'];
  originalConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
  originalQwenHome = process.env['QWEN_HOME'];
  dir = join(
    tmpdir(),
    `audit-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, 'src'), { recursive: true });
  // checkLocalOnlyGuard eagerly evaluates Storage.getAuditFallbackDir
  // (mkdirSync under the real fallback root): redirect QWEN_HOME so the
  // guard tests never create directories in the host's home.
  process.env['QWEN_HOME'] = join(dir, 'qwen-home');
  // Process-level git-config hermeticity: the guard's in-process
  // check-ignore probes spawn git with the ambient process.env, so a host
  // global exclude (e.g. one ignoring .qwen/) would leak into verdicts.
  writeFileSync(join(dir, 'empty-gitconfig'), '');
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['GIT_CONFIG_GLOBAL'] = join(dir, 'empty-gitconfig');
  writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1;\n'.repeat(10));
  writeFileSync(join(dir, 'src', 'a.test.ts'), 'x'.repeat(100));
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  writeFileSync(join(dir, 'logo.png'), 'not-really-a-png');
  writeFileSync(join(dir, 'module.pyc'), 'not-really-bytecode');
});

afterEach(() => {
  if (originalConfigNosystem === undefined)
    delete process.env['GIT_CONFIG_NOSYSTEM'];
  else process.env['GIT_CONFIG_NOSYSTEM'] = originalConfigNosystem;
  if (originalConfigGlobal === undefined)
    delete process.env['GIT_CONFIG_GLOBAL'];
  else process.env['GIT_CONFIG_GLOBAL'] = originalConfigGlobal;
  if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
  else process.env['QWEN_HOME'] = originalQwenHome;
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

  it('silently skips a linked-worktree .git pointer file', () => {
    // A linked worktree's .git is a regular FILE (the gitdir pointer):
    // structural metadata, never an audit subject — its gitdir content
    // must not reach an agent prompt.
    const root = join(dir, 'wt');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const { files, excludedDirs, structuralUncoverable } = walkAuditTree(root);
    expect(files).toContain('a.ts');
    expect(files).not.toContain('.git');
    expect(excludedDirs).not.toContain('.git');
    expect(
      structuralUncoverable.find((u) => u.path === '.git'),
    ).toBeUndefined();
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
    mkdirSync(join(dir, 'config'), { recursive: true });
    // *.env-SUFFIXED names (the .env clauses anchor to basename start).
    writeFileSync(join(dir, 'config', 'prod.env'), 'API_KEY=x\n');
    mkdirSync(join(dir, 'deploy'), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'server.pem'), '-----BEGIN-----\n');
    // Modern SSH key names (ed25519 has been OpenSSH's default since 2021),
    // fail-closed including the .pub halves.
    writeFileSync(join(dir, 'deploy', 'id_ed25519'), '-----BEGIN-----\n');
    writeFileSync(join(dir, 'deploy', 'id_ed25519.pub'), 'ssh-ed25519 AAAA\n');
    writeFileSync(join(dir, 'deploy', 'id_ecdsa'), '-----BEGIN-----\n');
    writeFileSync(join(dir, 'deploy', 'id_dsa'), '-----BEGIN-----\n');
    writeFileSync(join(dir, 'id_rsa'), '-----BEGIN OPENSSH-----\n');
    writeFileSync(join(dir, 'state.tfstate'), '{}\n');
    mkdirSync(join(dir, 'infra'), { recursive: true });
    // Holds the same credentials as the .tfstate the suffix clause catches.
    writeFileSync(join(dir, 'infra', 'terraform.tfstate.backup'), '{}\n');
    writeFileSync(join(dir, '.npmrc'), '//registry/:_authToken=x\n');
    const c = collectAuditFiles(dir);
    const secrets = c.uncoverable.filter((u) => u.reason === 'secret-shaped');
    expect(secrets.map((u) => u.path).sort()).toEqual([
      '.env',
      '.env.local',
      '.npmrc',
      'config/prod.env',
      'deploy/id_dsa',
      'deploy/id_ecdsa',
      'deploy/id_ed25519',
      'deploy/id_ed25519.pub',
      'deploy/server.pem',
      'id_rsa',
      'infra/terraform.tfstate.backup',
      'state.tfstate',
    ]);
    // Names surface at the confirmation; zero lines steer the gate arms.
    expect(secrets.every((u) => u.lines === 0)).toBe(true);
    // A regular .ts file named after a secret shape is not caught.
    writeFileSync(join(dir, 'src', 'env-config.ts'), 'export const e = 1;\n');
    // The id_ clause's negative boundary: snake_case source names that
    // merely START with id_ (plausible in the legacy codebases the audit
    // exists for) stay subjects; 'identity.ts' pins the .env-clause side.
    writeFileSync(join(dir, 'src', 'id_generator.ts'), 'export const g = 1;\n');
    writeFileSync(join(dir, 'src', 'identity.ts'), 'export const i = 1;\n');
    const subjects = collectAuditFiles(dir).subjects.map((f) => f.path);
    expect(subjects).toContain('src/env-config.ts');
    expect(subjects).toContain('src/id_generator.ts');
    expect(subjects).toContain('src/identity.ts');
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
    const entry = c.uncoverable.find((u) => u.path === 'src/payload.ts');
    expect(entry?.reason).toBe('non-text');
    // Load-bearing: raw 0x0A bytes are not code lines and must not steer
    // the gate arms.
    expect(entry?.lines).toBe(0);
  });

  it('detects a NUL past the head window as non-text', () => {
    // The old scan windowed the first 8 KiB; a binary whose first NUL sits
    // after it escaped as text.
    writeFileSync(
      join(dir, 'src', 'late-nul.ts'),
      `${'a'.repeat(16 * 1024)}\0trailing`,
    );
    const c = collectAuditFiles(dir);
    const entry = c.uncoverable.find((u) => u.path === 'src/late-nul.ts');
    expect(entry?.reason).toBe('non-text');
    expect(entry?.lines).toBe(0);
  });

  it('records a file over the read cap as uncoverable (anchors could never resolve it)', () => {
    // Anchor resolution reads capped at AUDIT_READ_MAX_BYTES: a subject
    // over the cap would be a legal citation target whose anchors can
    // never resolve, so the plan excludes it up front.
    const chunk = `${'a'.repeat(100)}\n`;
    const overCap = 10 * 1024 * 1024 + chunk.length;
    writeFileSync(
      join(dir, 'src', 'huge.ts'),
      chunk.repeat(Math.ceil(overCap / chunk.length)),
    );
    const c = collectAuditFiles(dir);
    const entry = c.uncoverable.find((u) => u.path === 'src/huge.ts');
    expect(entry?.reason).toBe('over-cap-bytes');
    expect(entry?.lines).toBeGreaterThan(0);
    expect(c.subjects.map((f) => f.path)).not.toContain('src/huge.ts');
  });

  it('records an over-cap NUL binary as non-text with zero lines', () => {
    // The NUL arm runs BEFORE the size cap: an over-cap binary must not
    // steer the gate arms with its raw 0x0A count.
    const chunk = `a\0${'b'.repeat(100)}\n`;
    const overCap = 10 * 1024 * 1024 + chunk.length;
    writeFileSync(
      join(dir, 'src', 'huge-binary.ts'),
      chunk.repeat(Math.ceil(overCap / chunk.length)),
    );
    const c = collectAuditFiles(dir);
    const entry = c.uncoverable.find((u) => u.path === 'src/huge-binary.ts');
    expect(entry?.reason).toBe('non-text');
    expect(entry?.lines).toBe(0);
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

  it('counts .once() as an event call site', () => {
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

  it('counts .on() as an event call site', () => {
    // The \.on\s*\( arm of EVENT_CALL_RE needs its own positive fixture:
    // bus.on(...) registration is a common event-API idiom.
    for (const name of ['on-bus.ts', 'on-wire.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        Array.from({ length: 5 }, (_, i) => `emitter.on('e${i}', h)`).join(
          '\n',
        ),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.detected).toBe(true);
    expect(c.eventDetection.files).toBe(2);
    expect(c.eventDetection.callSites).toBe(10);
  });

  it('counts every remaining call-shape arm as an event call site', () => {
    // Each regex arm needs its own positive fixture: deleting any arm
    // ships green unless a fixture exercises it. emitValue pins the
    // CamelCase-continuation suffix.
    const arms = [
      'bus.dispatch(x)',
      'bus.publish(x)',
      'bus.subscribe(x)',
      'el.addEventListener(x)',
      'alarm.fire(x)',
      'job.trigger(x)',
      'emitter.emitValue(x)',
    ];
    for (const name of ['arm-a.ts', 'arm-b.ts']) {
      writeFileSync(join(dir, 'src', name), arms.join('\n'));
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.detected).toBe(true);
    expect(c.eventDetection.callSites).toBe(14);
    expect(c.eventDetection.files).toBe(2);
  });

  it('does not count underscore-suffixed stems as event call sites', () => {
    // The CamelCase continuation requires an UPPERCASE next char:
    // emit_value( is a plain identifier, not an event-API call.
    for (const name of ['under-a.ts', 'under-b.ts']) {
      writeFileSync(
        join(dir, 'src', name),
        Array.from({ length: 5 }, (_, i) => `emit_value(${i})`).join('\n'),
      );
    }
    const c = collectAuditFiles(dir);
    expect(c.eventDetection.callSites).toBe(0);
    expect(c.eventDetection.detected).toBe(false);
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

  it('names the test gate when both medium refusals are true', () => {
    // Both arms true at medium: the bounce message must name the refusal
    // medium actually hits FIRST — the test-line gate fires before the
    // token cap in buildFilesPlan.
    const c = collect({
      uncoverable: [],
      subjects: [{ path: 'a.ts', kind: 'source', lines: 8_000, chars: 0 }],
      testCorpus: [
        {
          path: 'a.test.ts',
          kind: 'test',
          lines: TEST_LINES_GATE + 20_000,
          chars: 0,
        },
      ],
    });
    expect(() => planFor(c, 'low')).toThrow(/test lines exceed/);
    expect(() => planFor(c, 'low')).not.toThrow(/exceeds the 60000000 cap/);
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
    // The top is EXACTLY floor × headroom: pin the constant itself, or a
    // retune of it moves every bracket without a red test.
    expect(permissions.topTokens).toBe(
      Math.round(permissions.floorTokens * ESTIMATE_HEADROOM),
    );
    // hooks: 8,516 subject / 16,335 test, measured ~46M
    const hooks = estimateTokens(8516, 16335);
    expect(hooks.floorTokens).toBeGreaterThanOrEqual(45_900_000);
    expect(hooks.floorTokens).toBeLessThanOrEqual(46_100_000);
    expect(hooks.topTokens).toBeGreaterThanOrEqual(59_500_000);
    expect(hooks.topTokens).toBeLessThanOrEqual(TOKEN_CAP);
    expect(hooks.topTokens).toBe(
      Math.round(hooks.floorTokens * ESTIMATE_HEADROOM),
    );
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

  // Symlink fixtures need POSIX symlink semantics.
  it.skipIf(process.platform === 'win32')(
    'distinguishes a symbolic link loop from a missing path',
    () => {
      // The path EXISTS: "does not exist" would send the user chasing a
      // checkout problem instead of the loop.
      symlinkSync(join(dir, 'loop-b'), join(dir, 'loop-a'));
      symlinkSync(join(dir, 'loop-a'), join(dir, 'loop-b'));
      expect(() => resolveAuditRoot(join(dir, 'loop-a'))).toThrow(
        /symbolic link loop/,
      );
    },
  );
});

describe('nextCalendarDate', () => {
  it('advances by one calendar day, not by 24 hours', () => {
    // A DST fall-back day is 25 hours long: `now + 24h` stays inside the
    // CURRENT date for the first wall-clock hour, so the true next date is
    // never probed and a re-include keyed to it escapes the guard.
    expect(nextCalendarDate(new Date(2026, 10, 1, 0, 30))).toBe('2026-11-02');
    // Month and year rollover ride on the same arithmetic.
    expect(nextCalendarDate(new Date(2026, 0, 31, 23, 59))).toBe('2026-02-01');
    expect(nextCalendarDate(new Date(2026, 11, 31, 12, 0))).toBe('2027-01-01');
  });
});

describe('auditReportSlug', () => {
  it('emits only names the guard validator accepts', () => {
    // The writer and the validator have to be one rule: a slug the guard
    // rejects costs the run its relocation credit — exit 5 at every
    // checkpoint, in a configuration the gate promises to clear.
    const accepted = (slug: string) =>
      slug.length > 0 &&
      slug.length <= REPORT_SLUG_MAX_CHARS &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) &&
      !slug.includes('..');
    for (const target of [
      'src/mod',
      '-leading-dash',
      '...',
      '/'.repeat(3) + 'x'.repeat(400),
      'a'.repeat(500),
      '.hidden/dir',
    ]) {
      expect(accepted(auditReportSlug(target))).toBe(true);
    }
  });
});

describe('the never-content-read and never-walk invariants', () => {
  it('records credential MATERIAL under an unguessed name as secret-shaped', () => {
    // A name list is an open-ended guess at what a secret is called; the
    // content-side detector is what closes the class. The measurement read
    // is local and bounded — nothing downstream ever sees this file.
    const key = join(dir, 'deploy-token.conf');
    writeFileSync(
      key,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n',
    );
    const collection = collectAuditFiles(dir);
    expect(collection.subjects.map((f) => f.path)).not.toContain(
      'deploy-token.conf',
    );
    expect(
      collection.uncoverable.find((u) => u.path === 'deploy-token.conf'),
    ).toMatchObject({ reason: 'secret-shaped', lines: 0 });
  });

  it('keeps a source file that merely QUOTES key armor as a subject', () => {
    // A secret scanner, a test fixture, or the detector's own source
    // legitimately carries the armor string mid-file. Dropping those from
    // the audit is a silent coverage loss — and this repository has
    // several, which is how the looser "anywhere in the prefix" spelling
    // was caught.
    writeFileSync(
      join(dir, 'src', 'scanner.ts'),
      [
        'export const PEM_HEADERS = [',
        "  '-----BEGIN OPENSSH PRIVATE KEY-----',",
        "  '-----BEGIN RSA PRIVATE KEY-----',",
        '];',
      ].join('\n'),
    );
    const collection = collectAuditFiles(dir);
    expect(collection.subjects.map((f) => f.path)).toContain('src/scanner.ts');
  });

  it.each([
    ['a trailing LF', '.env\n'],
    ['a trailing CR', '.env\r'],
    ['a trailing DEL', '.npmrc\x7f'],
    ['a trailing NUL', 'app.key\x00'],
  ])('records a secret-shaped name carrying %s', (_label, name) => {
    // Filesystem names are byte strings, and every name clause is
    // `$`-anchored: a trailing control character slips the lot and the file
    // becomes a content-read audit subject. The strip covers all of C0 plus
    // DEL, so each boundary spelling is pinned here rather than just the
    // newline one — the class is written with escapes precisely so a reader
    // can check that claim (literal bytes made the whole module undiffable).
    const weird = join(dir, name);
    try {
      writeFileSync(weird, 'API_KEY=x\n');
    } catch {
      return; // the platform refuses the name; nothing to guard
    }
    const collection = collectAuditFiles(dir);
    expect(collection.subjects.map((f) => f.path)).not.toContain(name);
    expect(collection.uncoverable.find((u) => u.path === name)).toMatchObject({
      reason: 'secret-shaped',
    });
  });

  it('names the newly covered credential shapes', () => {
    for (const name of [
      '.envrc',
      '.git-credentials',
      '.pgpass',
      'infra.tfvars',
    ]) {
      writeFileSync(join(dir, name), 'secret\n');
    }
    const collection = collectAuditFiles(dir);
    const secrets = collection.uncoverable
      .filter((u) => u.reason === 'secret-shaped')
      .map((u) => u.path)
      .sort();
    expect(secrets).toEqual([
      '.envrc',
      '.git-credentials',
      '.pgpass',
      'infra.tfvars',
    ]);
  });

  it('never walks a bare repository directory', () => {
    // The walk's invariant is unconditional ("git internals are never
    // subjects"), and a BARE repository is conventionally `<name>.git` —
    // same object store, same packed refs, same hooks.
    mkdirSync(join(dir, 'mirror.git', 'objects'), { recursive: true });
    writeFileSync(join(dir, 'mirror.git', 'config'), '[core]\n');
    writeFileSync(join(dir, 'mirror.git', 'HEAD'), 'ref: refs/heads/main\n');
    const collection = collectAuditFiles(dir);
    expect(
      collection.subjects.filter((f) => f.path.startsWith('mirror.git/')),
    ).toEqual([]);
    expect(collection.excludedDirs).toContain('mirror.git');
  });

  it('never walks the tool own artifact home inside the audited tree', () => {
    // QWEN_HOME is user-settable and guard-check itself hands out
    // in-worktree fallback roots: the previous run's relocated report and
    // findings must not become this run's subjects.
    // The suite already points QWEN_HOME inside the fixture tree, which is
    // exactly the shape this guards: a fallback landing under the audited
    // path.
    const home = process.env['QWEN_HOME'] as string;
    mkdirSync(join(home, 'audits', 'abc'), { recursive: true });
    writeFileSync(
      join(home, 'audits', 'abc', 'audit-findings-2a.md'),
      '### [Critical] a previous run\n',
    );
    const collection = collectAuditFiles(dir);
    expect(
      collection.subjects.filter((f) => f.path.startsWith('qwen-home/')),
    ).toEqual([]);
    expect(collection.excludedDirs).toContain('qwen-home');
  });
});

describe('git-backed checks', () => {
  function git(args: string[], cwd: string): string {
    // Mirror production gitEnv(): the repository-selection variables
    // override `-C` path resolution (ambient GIT_DIR re-homes `git init`
    // into a foreign repository; GIT_WORK_TREE without GIT_DIR is a hard
    // fatal), so the fixture establishment scrubs them too.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Isolate the helper repos from ambient config (a user/global
      // core.excludesFile or hooks.path would leak into the probes).
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'empty-gitconfig'),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    delete env['GIT_DIR'];
    delete env['GIT_WORK_TREE'];
    delete env['GIT_INDEX_FILE'];
    delete env['GIT_OBJECT_DIRECTORY'];
    delete env['GIT_COMMON_DIR'];
    return execFileSync('git', args, { cwd, encoding: 'utf8', env });
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

  it('walks a name-excluded directory when git tracks files inside it', () => {
    // The exclusion is a name heuristic; tracked content is the repo's own
    // verdict that it misfired (packages/desktop/scripts/build in this
    // repo is exactly such a directory).
    const repo = join(dir, 'repo-tracked');
    mkdirSync(join(repo, 'scripts', 'build'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts', 'build', 'common.ts'),
      'export const c = 1;\n',
    );
    writeFileSync(join(repo, 'scripts', 'main.ts'), 'export const m = 1;\n');
    git(['init', '-q'], repo);
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const { files, excludedDirs } = walkAuditTree(join(repo, 'scripts'));
    expect(files).toContain('build/common.ts');
    expect(excludedDirs).not.toContain('build');
    // Auditing the tracked build directory directly walks it too, instead
    // of refusing `empty-subjects` over a directory full of source.
    const rootWalk = walkAuditTree(join(repo, 'scripts', 'build'));
    expect(rootWalk.files).toContain('common.ts');
    expect(rootWalk.excludedDirs).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps a name-excluded directory excluded when the git probe has no answer',
    () => {
      // A no-answer probe (broken git, timeout) has established no
      // tracking: the exclusion stands, fail-closed like the module's
      // other guards — the old fail-open walked node_modules and every
      // excluded dir on exactly the runs where nothing is verified.
      const repo = join(dir, 'repo-noanswer');
      mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(
        join(repo, 'node_modules', 'dep', 'index.js'),
        'module.exports = 1;\n',
      );
      writeFileSync(join(repo, 'main.ts'), 'export const m = 1;\n');
      const shimDir = join(dir, 'git-shim-noanswer');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexit 3\n');
      chmodSync(join(shimDir, 'git'), 0o755);
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      try {
        const { files, excludedDirs } = walkAuditTree(repo);
        expect(files).toContain('main.ts');
        expect(files).not.toContain('node_modules/dep/index.js');
        expect(excludedDirs).toContain('node_modules');
      } finally {
        process.env['PATH'] = savedPath;
      }
    },
  );

  it('never walks the audit artifact dirs, even under the tracked override', () => {
    // This repository itself tracks files under .qwen/: the override
    // descends into .qwen, but the command group's own artifact dirs must
    // never become subjects (a re-audit would ingest the previous run's
    // findings and plan — self-contaminated findings).
    const repo = join(dir, 'repo-artifacts');
    mkdirSync(join(repo, '.qwen', 'skills'), { recursive: true });
    mkdirSync(join(repo, '.qwen', 'audits'), { recursive: true });
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(repo, '.qwen', 'skills', 'skill.md'), '# skill\n');
    writeFileSync(join(repo, '.qwen', 'audits', 'old-report.md'), '# old\n');
    writeFileSync(join(repo, '.qwen', 'tmp', 'plan.json'), '{}');
    git(['init', '-q'], repo);
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const { files, excludedDirs } = walkAuditTree(repo);
    expect(files).toContain('.qwen/skills/skill.md');
    expect(
      files.some(
        (f) => f.startsWith('.qwen/audits/') || f.startsWith('.qwen/tmp/'),
      ),
    ).toBe(false);
    expect(excludedDirs).toEqual(
      expect.arrayContaining(['.qwen/audits', '.qwen/tmp']),
    );
  });

  it('refuses a root inside the artifact dirs or .git', () => {
    // Auditing .qwen/tmp or .qwen/audits walks the previous run's
    // findings and plan as subjects (self-contamination); a .git child
    // walks git internals. The descent exclusion never fires for roots.
    const repo = join(dir, 'repo-root-artifacts');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    mkdirSync(join(repo, '.qwen', 'audits'), { recursive: true });
    writeFileSync(join(repo, '.qwen', 'tmp', 'plan.json'), '{}');
    writeFileSync(join(repo, '.qwen', 'audits', 'old.md'), '# old\n');
    expect(walkAuditTree(join(repo, '.qwen', 'tmp'))).toMatchObject({
      files: [],
      excludedDirs: ['.'],
    });
    expect(walkAuditTree(join(repo, '.qwen', 'audits'))).toMatchObject({
      files: [],
      excludedDirs: ['.'],
    });
    expect(walkAuditTree(join(repo, '.git', 'hooks'))).toMatchObject({
      files: [],
      excludedDirs: ['.'],
    });
  });

  it('still excludes a name-excluded directory git does not track', () => {
    const repo = join(dir, 'repo-untracked');
    mkdirSync(join(repo, 'build'), { recursive: true });
    writeFileSync(join(repo, 'build', 'app.js'), 'console.log(1);\n');
    writeFileSync(join(repo, 'main.ts'), 'export const m = 1;\n');
    git(['init', '-q'], repo);
    git(['add', 'main.ts'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const { files, excludedDirs } = walkAuditTree(repo);
    expect(files).not.toContain('build/app.js');
    expect(excludedDirs).toContain('build');
  });

  it('does not flip vendor mode from a vendor-named ancestor outside the repo', () => {
    // The checkout sits under a vendor component; the audited path is not
    // under the repo's own vendor/, so build outputs keep their exclusion.
    const outer = join(dir, 'vendor', 'acme-app');
    mkdirSync(join(outer, 'dist'), { recursive: true });
    writeFileSync(join(outer, 'dist', 'bundle.js'), 'console.log(1);\n');
    writeFileSync(join(outer, 'main.ts'), 'export const m = 1;\n');
    git(['init', '-q'], outer);
    writeFileSync(join(outer, '.gitignore'), 'dist/\n');
    git(['add', '.'], outer);
    git(['commit', '-m', 'init', '-q'], outer);
    const { files, excludedDirs } = walkAuditTree(outer);
    expect(files).toContain('main.ts');
    expect(files).not.toContain('dist/bundle.js');
    expect(excludedDirs).toContain('dist');
  });

  it('keeps the vendor rules for an in-repo vendor ancestor', () => {
    const repo = join(dir, 'repo-vendor');
    mkdirSync(join(repo, 'vendor', 'pkg', 'dist'), { recursive: true });
    writeFileSync(
      join(repo, 'vendor', 'pkg', 'dist', 'index.js'),
      'module.exports = {};\n',
    );
    git(['init', '-q'], repo);
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    expect(walkAuditTree(repo).files).toContain('vendor/pkg/dist/index.js');
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

  it('probes exactly the specialist findings shape the skill licenses', () => {
    // SKILL.md is the oracle for the names a run may write: every
    // licensed specialist shape must appear in guardProbeShapes and vice
    // versa — a shape written but never probed escapes the local-only
    // guard (the module's own 'every shape written is a shape probed'
    // invariant).
    const skill = readFileSync(AUDIT_SKILL_PATH, 'utf8');
    const licensed = [
      ...new Set(
        [...skill.matchAll(/audit-findings-specialist-[^`\s]*<ts>\.md/g)].map(
          (m) => m[0],
        ),
      ),
    ].sort();
    const probed = guardProbeShapes('x.md', '<ts>')
      .tmp.filter((s) => s.startsWith('audit-findings-specialist'))
      .sort();
    expect(licensed).toEqual(probed);
  });

  it('probes every ts-stamped artifact name the skill writes', () => {
    // The same invariant, generalized past the specialist shape: SKILL.md
    // is the oracle, so ANY `audit-*-<ts>.*` name it instructs a run to
    // write must be a name the guard asks about. A new artifact added to
    // the skill without a probe would carry verbatim module content into a
    // directory the guard just certified.
    const skill = readFileSync(AUDIT_SKILL_PATH, 'utf8');
    const written = new Set(
      [...skill.matchAll(/audit-[a-z0-9-]*<ts>\.[a-z]+/g)].map((m) => m[0]),
    );
    const shapes = guardProbeShapes('x.md', '<ts>');
    const probed = new Set([...shapes.audits, ...shapes.tmp]);
    const unprobed = [...written]
      .filter((name) => !probed.has(name))
      // The sidecar is a DIRECTORY: git applies a trailing-slash re-include
      // only to paths it knows are directories, so the probe deliberately
      // asks about the child file the capture writes inside it.
      .filter(
        (name) =>
          !(name.endsWith('.sidecar') && probed.has(`${name}/sidecar.json`)),
      )
      .sort();
    expect(unprobed).toEqual([]);
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
    // Pin the clock: the test derives the re-include month and the guard
    // stamps its probe names from separate new Date() calls, which can
    // disagree across a month boundary (a deterministic-shape flake).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
      const month = '2026-08';
      writeFileSync(
        join(repo, '.gitignore'),
        `.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/${month}-*.md\n`,
      );
      // The probe carries the pinned date, so a re-include keyed to this
      // month matches it and the directory answers exposed.
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
        'unprotected',
      );
    } finally {
      vi.useRealTimers();
    }
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

  it('a directory-form sidecar re-include leaves the audits dir unprotected', () => {
    // The sidecar is a DIRECTORY; git applies a trailing-slash re-include
    // only to paths it knows are directories, so it is invisible to a
    // file-shaped probe — the probe asks about a child file of the sidecar.
    const repo = initRepo();
    writeFileSync(
      join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/*.sidecar/\n',
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

  // Symlink fixtures need POSIX permissions semantics.
  it.skipIf(process.platform === 'win32')(
    'exposes a .qwen symlink whose target sits inside a foreign repository',
    () => {
      // "Outside THIS worktree" is not "outside version control": a
      // sibling checkout (or a dotfiles repo) commits whatever lands
      // there, so the landing is safe only when the target is
      // definitively outside EVERY worktree.
      const repo = initRepo();
      const foreign = join(dir, 'foreign-repo');
      mkdirSync(foreign, { recursive: true });
      git(['init', '-q'], foreign);
      symlinkSync(foreign, join(repo, '.qwen'));
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
        'unprotected',
      );
    },
  );

  it('scrubs GIT_CEILING_DIRECTORIES from the worktree probes', () => {
    // A ceiling at the toplevel makes `git -C <subdir> rev-parse
    // --show-toplevel` exit 128 with the stock not-a-repo fatal; without
    // the scrub the guard would read that as no-worktree and pass
    // vacuously inside a live worktree.
    const repo = initRepo();
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = repo;
    try {
      const guard = checkLocalOnlyGuard(join(repo, 'mod'), 'x.md');
      expect(guard.dirs.map((d) => d.status)).toEqual([
        'unprotected',
        'unprotected',
      ]);
    } finally {
      if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
      else process.env['GIT_CEILING_DIRECTORIES'] = saved;
    }
  });

  it('scrubs GIT_COMMON_DIR from the worktree probes', () => {
    // An unusable ambient GIT_COMMON_DIR makes rev-parse exit 128 "not a
    // git repository" inside a live worktree; without the scrub the guard
    // reads git-failed instead of probing the real landing.
    const repo = initRepo();
    const foreign = join(dir, 'foreign-common-dir');
    mkdirSync(foreign, { recursive: true });
    const saved = process.env['GIT_COMMON_DIR'];
    process.env['GIT_COMMON_DIR'] = foreign;
    try {
      const guard = checkLocalOnlyGuard(repo, 'x.md');
      expect(guard.dirs.map((d) => d.status)).toEqual([
        'unprotected',
        'unprotected',
      ]);
    } finally {
      if (saved === undefined) delete process.env['GIT_COMMON_DIR'];
      else process.env['GIT_COMMON_DIR'] = saved;
    }
  });

  it('a next-date-keyed re-include cannot escape the audits probe', () => {
    // Runs are hours-long: the report's write-time date can roll past the
    // probe instant, so the probe also carries the next calendar date.
    const repo = initRepo();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    writeFileSync(
      join(repo, '.gitignore'),
      `.qwen/*\n!.qwen/audits/\n.qwen/audits/*\n!.qwen/audits/${date}-*.md\n`,
    );
    expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
      'unprotected',
    );
  });

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

  it('lands the exclude remedy in the common dir of a linked worktree', () => {
    // --git-common-dir, not --git-dir: in a linked worktree the remedy
    // must write where git actually consults (the common dir), not the
    // per-worktree gitdir whose info/exclude git never reads.
    const repo = initRepo();
    git(['add', '.'], repo);
    git(['commit', '-m', 'init', '-q'], repo);
    const linked = join(dir, 'linked-worktree');
    git(['worktree', 'add', linked], repo);
    applyExcludeRemedy(linked);
    const commonExclude = readFileSync(
      join(repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(commonExclude).toContain('/.qwen/audits/');
    expect(commonExclude).toContain('/.qwen/tmp/');
    expect(
      checkLocalOnlyGuard(linked, 'x.md').dirs.map((d) => d.status),
    ).toEqual(['ok', 'ok']);
  });

  it('refuses the exclude remedy when a planted .git pointer re-homes it', () => {
    // A `.git` that is a regular FILE holding `gitdir: <elsewhere>` makes
    // git answer with the pointed-at repository: the rules would land in a
    // foreign repo's exclude file, and the audited tree would stay
    // unremediated. Path containment alone cannot decide this — a real
    // linked worktree has the same shape (see the test above) — so the
    // check is registration, and only the planted case fails it.
    const victim = join(dir, 'victim');
    mkdirSync(victim, { recursive: true });
    git(['init', '-q'], victim);
    const planted = join(dir, 'planted');
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, '.git'), `gitdir: ${join(victim, '.git')}\n`);
    const victimExclude = join(victim, '.git', 'info', 'exclude');
    const before = readFileSync(victimExclude, 'utf8');
    expect(() => applyExcludeRemedy(planted)).toThrow(
      /neither inside the audited worktree|registered as one of its worktrees/,
    );
    // `git init` ships an info/exclude: the proof is that it is untouched.
    expect(readFileSync(victimExclude, 'utf8')).toBe(before);
    expect(before).not.toContain('/.qwen/audits/');
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

  it('treats a 128 with a non-repo fatal as probe-failed, not no-worktree', () => {
    // Git exits 128 for fatals beyond "not a git repository" (here: a
    // corrupt config in the repository's own git dir); classifying that as
    // notRepo lets the guard pass vacuously in a live worktree.
    //
    // The corruption is deliberately REPO-LOCAL, not a GIT_CONFIG_GLOBAL
    // pin: the probes run with the whole GIT_-prefixed environment scrubbed
    // (gitEnv), so an env-based fixture would never reach git and the arm
    // would pass for the wrong reason.
    const repo = initRepo();
    writeFileSync(join(repo, '.git', 'config'), '[core\n');
    const guard = checkLocalOnlyGuard(repo, 'x.md');
    expect(guard.dirs.map((d) => d.status)).toEqual([
      'git-failed',
      'git-failed',
    ]);
    // The submodule refusal sees the same failure-without-answer.
    expect(submoduleRefusal(join(repo, 'mod'))).toContain('probe failed');
  });

  // The PATH shim stands in for a missing/hanging git binary.
  it.skipIf(process.platform === 'win32')(
    'reports git-failed and refuses the submodule check when the probe fails without an answer',
    () => {
      const repo = initRepo();
      const shimDir = join(dir, 'git-shim');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(join(shimDir, 'git'), '#!/bin/sh\nexit 3\n');
      chmodSync(join(shimDir, 'git'), 0o755);
      const savedPath = process.env['PATH'];
      process.env['PATH'] = `${shimDir}${delimiter}${savedPath ?? ''}`;
      try {
        const guard = checkLocalOnlyGuard(repo, 'x.md');
        expect(guard.dirs.map((d) => d.status)).toEqual([
          'git-failed',
          'git-failed',
        ]);
        expect(submoduleRefusal(join(repo, 'mod'))).toContain('probe failed');
      } finally {
        process.env['PATH'] = savedPath;
      }
    },
  );

  // Symlink fixtures need POSIX permissions semantics.
  it.skipIf(process.platform === 'win32')(
    'keeps probing a ..-named in-repo symlink target',
    () => {
      const repo = initRepo();
      // A legal in-repo directory whose name merely STARTS with '..' must
      // not be misread as outside the worktree (the harmful direction:
      // certified ok without any ignore probe).
      mkdirSync(join(repo, '..audit-store'), { recursive: true });
      symlinkSync(join(repo, '..audit-store'), join(repo, '.qwen'));
      expect(checkLocalOnlyGuard(repo, 'x.md').dirs[0].status).toBe(
        'unprotected',
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'probes the resolved physical path when the cwd is a subdirectory',
    () => {
      // The symlink branch rewrites probeDir to a toplevel-relative
      // physical path; the cwd-relative prefix must not be prepended
      // again (a double-prefixed probe asks about a nonexistent path and
      // the guard answers from a fatal instead of the real landing).
      const repo = join(dir, 'repo-sym-sub');
      mkdirSync(join(repo, 'sub'), { recursive: true });
      mkdirSync(join(repo, 'elsewhere'), { recursive: true });
      git(['init', '-q'], repo);
      writeFileSync(join(repo, '.gitignore'), 'sub/\n');
      symlinkSync(join(repo, 'elsewhere'), join(repo, 'sub', '.qwen'));
      const guard = checkLocalOnlyGuard(join(repo, 'sub'), 'x.md');
      // The physical landing elsewhere/ is NOT ignored — the guard must
      // expose it, not certify a phantom double-prefixed path.
      expect(guard.dirs[0].status).toBe('unprotected');
      expect(guard.dirs[1].status).toBe('unprotected');
    },
  );
});
