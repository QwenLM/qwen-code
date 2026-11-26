/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyReviewTrust,
  detectReviewMandatoryEscalations,
  externalContentContainerRequested,
  forceHardwareRequested,
  isReviewContentAllowlistedPath,
  trustInputFromPlan,
} from './sandbox-trust.js';
import { buildDiffPlan } from './diff-plan.js';
import { buildPlanReport, stringifyPlanReport } from './report.js';

describe('forceHardwareRequested', () => {
  it('accepts operator env truthy values and ignores file-sourced repo values', () => {
    for (const val of ['1', 'true', 'YES', ' on ']) {
      expect(
        forceHardwareRequested(
          { QWEN_REVIEW_FORCE_HARDWARE: val },
          () => false,
        ),
      ).toBe(true);
    }
    expect(
      forceHardwareRequested({ QWEN_REVIEW_FORCE_HARDWARE: '0' }, () => false),
    ).toBe(false);
    expect(
      forceHardwareRequested(
        { QWEN_REVIEW_FORCE_HARDWARE: '1' },
        (k) => k === 'QWEN_REVIEW_FORCE_HARDWARE',
      ),
    ).toBe(false);
  });
});

describe('detectReviewMandatoryEscalations', () => {
  it('stays empty for plain source and test files', () => {
    expect(
      detectReviewMandatoryEscalations([
        { path: 'packages/cli/src/foo.ts' },
        { path: 'packages/cli/src/foo.test.ts' },
        { path: 'docs/guide.md' },
      ]),
    ).toEqual([]);
  });

  it.each([
    ['package.json', 'dependency-manifest:package.json'],
    [
      'packages/cli/package.json',
      'dependency-manifest:packages/cli/package.json',
    ],
    ['pnpm-lock.yaml', 'dependency-manifest:pnpm-lock.yaml'],
    ['.npmrc', 'dependency-manifest:.npmrc'],
    ['.pnpmfile.mjs', 'dependency-manifest:.pnpmfile.mjs'],
    ['patches/foo@1.0.0.patch', 'dependency-manifest:patches/foo@1.0.0.patch'],
    [
      'packages/managed-agent-server/pom.xml',
      'dependency-manifest:packages/managed-agent-server/pom.xml',
    ],
    ['.github/workflows/ci.yml', 'ci-or-agent-config:.github/workflows/ci.yml'],
    ['.qwen/settings.json', 'ci-or-agent-config:.qwen/settings.json'],
    ['.claude/agents/helper.md', 'ci-or-agent-config:.claude/agents/helper.md'],
    ['scripts/build.mjs', 'build-or-sandbox-tooling:scripts/build.mjs'],
    ['Dockerfile', 'build-or-sandbox-tooling:Dockerfile'],
    ['vitest.config.ts', 'build-or-sandbox-tooling:vitest.config.ts'],
    ['tools/run.sh', 'executable-extension:tools/run.sh'],
  ])('flags high-risk path %s', (path, expected) => {
    expect(detectReviewMandatoryEscalations([{ path }])).toContain(expected);
  });

  it('flags executable modes, symlinks, submodules, binaries, and renames from high-risk paths', () => {
    const reasons = detectReviewMandatoryEscalations([
      { path: 'bin/helper', mode: '100755' },
      { path: 'link/target', mode: '120000' },
      { path: 'vendor/sub', mode: '160000' },
      { path: 'assets/blob', binary: true },
      { path: 'docs/renamed.txt', renameFrom: '.github/workflows/release.yml' },
    ]);
    expect(reasons).toContain('executable-mode:bin/helper');
    expect(reasons).toContain('symlink-entry:link/target');
    expect(reasons).toContain('submodule-entry:vendor/sub');
    expect(reasons).toContain('binary-file:assets/blob');
    expect(reasons).toContain(
      'ci-or-agent-config:.github/workflows/release.yml',
    );
  });
});

describe('classifyReviewTrust', () => {
  it('classifies low-risk local and collaborator reviews as trusted-shared-kernel', () => {
    expect(
      classifyReviewTrust(
        { isLocal: true, changedFiles: [{ path: 'src/app.ts' }] },
        {},
        () => false,
      ),
    ).toEqual({
      prTrust: 'local-owner',
      executionClass: 'trusted-shared-kernel',
      escalationReasons: [],
    });

    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(
        classifyReviewTrust(
          {
            isLocal: false,
            isCrossRepository: false,
            authorAssociation: assoc,
            changedFiles: [{ path: 'packages/core/src/a.ts' }],
          },
          {},
          () => false,
        ),
      ).toEqual({
        prTrust: 'collaborator',
        executionClass: 'trusted-shared-kernel',
        escalationReasons: [],
      });
    }
  });

  it('escalates collaborator PRs touching high-risk paths to hardware-isolated', () => {
    const res = classifyReviewTrust(
      {
        isLocal: false,
        isCrossRepository: false,
        authorAssociation: 'COLLABORATOR',
        changedFiles: [
          { path: 'packages/cli/src/a.ts' },
          { path: 'package.json' },
        ],
      },
      {},
      () => false,
    );
    expect(res.prTrust).toBe('collaborator');
    expect(res.executionClass).toBe('hardware-isolated');
    expect(res.escalationReasons).toContain('dependency-manifest:package.json');
  });

  it('fails closed to hardware-isolated for fork PRs, external authors, missing files, and unknown trust', () => {
    const fork = classifyReviewTrust(
      {
        isLocal: false,
        isCrossRepository: true,
        authorAssociation: 'COLLABORATOR',
        changedFiles: [{ path: 'src/a.ts' }],
      },
      {},
      () => false,
    );
    expect(fork.prTrust).toBe('external');
    expect(fork.executionClass).toBe('hardware-isolated');
    expect(fork.escalationReasons).toContain('cross-repository-pr');

    const externalAuthor = classifyReviewTrust(
      {
        isLocal: false,
        isCrossRepository: false,
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
        changedFiles: [{ path: 'src/a.ts' }],
      },
      {},
      () => false,
    );
    expect(externalAuthor.prTrust).toBe('external');
    expect(externalAuthor.executionClass).toBe('hardware-isolated');

    const missingFiles = classifyReviewTrust(
      {
        isLocal: false,
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
      },
      {},
      () => false,
    );
    expect(missingFiles.executionClass).toBe('hardware-isolated');
    expect(missingFiles.escalationReasons).toContain(
      'changed-files-unavailable',
    );

    const unknown = classifyReviewTrust({}, {}, () => false);
    expect(unknown.prTrust).toBe('unknown');
    expect(unknown.executionClass).toBe('hardware-isolated');
  });

  it('honors operator QWEN_REVIEW_FORCE_HARDWARE=1 even on local-owner reviews', () => {
    const forced = classifyReviewTrust(
      { isLocal: true, changedFiles: [{ path: 'src/a.ts' }] },
      { QWEN_REVIEW_FORCE_HARDWARE: '1' },
      () => false,
    );
    expect(forced.prTrust).toBe('local-owner');
    expect(forced.executionClass).toBe('hardware-isolated');
    expect(forced.escalationReasons).toContain('operator-force-hardware');
  });
});

describe('trustInputFromPlan', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('extracts PR trust fields and file list from a fetch-pr plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-trust-'));
    dirs.push(dir);
    const plan = join(dir, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        prNumber: '123',
        isCrossRepository: false,
        authorAssociation: 'COLLABORATOR',
        files: [
          { path: 'packages/cli/src/a.ts', binary: false },
          { path: 'docs/b.md', renameFrom: 'scripts/old.mjs', binary: false },
        ],
      }),
    );
    expect(trustInputFromPlan(plan)).toEqual({
      isLocal: false,
      isCrossRepository: false,
      authorAssociation: 'COLLABORATOR',
      changedFiles: [
        { path: 'packages/cli/src/a.ts', binary: false },
        { path: 'docs/b.md', renameFrom: 'scripts/old.mjs', binary: false },
      ],
    });
  });

  it('treats a local plan without prNumber as local-owner and fails closed on unreadable plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-trust-'));
    dirs.push(dir);
    const localPlan = join(dir, 'local.json');
    writeFileSync(
      localPlan,
      JSON.stringify({ files: [{ path: 'src/index.ts' }] }),
    );
    expect(trustInputFromPlan(localPlan)).toEqual({
      isLocal: true,
      changedFiles: [{ path: 'src/index.ts' }],
    });
    expect(trustInputFromPlan(join(dir, 'missing.json'))).toEqual({
      isLocal: false,
    });
  });

  it('fails closed on incremental or partial PR plans while keeping demoted full-range collaborator plans trusted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-trust-inc-'));
    dirs.push(dir);

    const incPlan = join(dir, 'incremental.json');
    writeFileSync(
      incPlan,
      JSON.stringify({
        prNumber: '18226',
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
        diffStat: { files: 2 },
        incremental: { effective: true, since: 'abc123' },
        files: [{ path: 'packages/cli/src/a.ts', binary: false }],
      }),
    );
    const incTrust = classifyReviewTrust(
      trustInputFromPlan(incPlan),
      {},
      () => false,
    );
    expect(incTrust.prTrust).toBe('collaborator');
    expect(incTrust.executionClass).toBe('hardware-isolated');
    expect(incTrust.escalationReasons).toContain('changed-files-incomplete');

    const countMismatchPlan = join(dir, 'mismatch.json');
    writeFileSync(
      countMismatchPlan,
      JSON.stringify({
        prNumber: '18226',
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
        diffStat: { files: 2 },
        files: [{ path: 'packages/cli/src/a.ts', binary: false }],
      }),
    );
    expect(
      classifyReviewTrust(
        trustInputFromPlan(countMismatchPlan),
        {},
        () => false,
      ).escalationReasons,
    ).toContain('changed-files-incomplete');

    const demotedFullPlan = join(dir, 'demoted-full.json');
    writeFileSync(
      demotedFullPlan,
      JSON.stringify({
        prNumber: '18226',
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
        diffStat: { files: 1 },
        incremental: { effective: false, reason: 'nothing-to-narrow' },
        files: [{ path: 'packages/cli/src/a.ts', binary: false }],
      }),
    );
    expect(
      classifyReviewTrust(trustInputFromPlan(demotedFullPlan), {}, () => false),
    ).toEqual({
      prTrust: 'collaborator',
      executionClass: 'trusted-shared-kernel',
      escalationReasons: [],
    });
  });

  it('propagates 100755, 120000, and 160000 git modes from unified diffs through buildPlanReport into trustInputFromPlan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-trust-mode-'));
    dirs.push(dir);
    const diff = [
      'diff --git a/src/link.ts b/src/link.ts',
      'new file mode 120000',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/link.ts',
      '@@ -0,0 +1 @@',
      '+/etc/passwd',
      'diff --git a/src/tool b/src/tool',
      'index 1111111..2222222 100755',
      '--- a/src/tool',
      '+++ b/src/tool',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/vendor/sub b/vendor/sub',
      'index 1111111..2222222 160000',
      '--- a/vendor/sub',
      '+++ b/vendor/sub',
      '@@ -1 +1 @@',
      '-Subproject commit 1111111',
      '+Subproject commit 2222222',
      'diff --git a/src/plain.ts b/src/plain.ts',
      'index 1111111..2222222 100644',
      '--- a/src/plain.ts',
      '+++ b/src/plain.ts',
      '@@ -1 +1,2 @@',
      ' const x = 1;',
      '+new file mode 100755',
    ].join('\n');

    const report = buildPlanReport(
      buildDiffPlan(diff, 400),
      () => 10,
      {},
      diff,
    );
    const byPath = new Map(report.files.map((f) => [f.path, f]));
    expect(byPath.get('src/link.ts')?.mode).toBe('120000');
    expect(byPath.get('src/tool')?.mode).toBe('100755');
    expect(byPath.get('vendor/sub')?.mode).toBe('160000');
    expect(byPath.get('src/plain.ts')?.mode).toBeUndefined();

    const planFile = join(dir, 'mode-plan.json');
    writeFileSync(
      planFile,
      stringifyPlanReport({
        prNumber: '77',
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
        diffStat: { files: 4 },
        ...report,
      } as Parameters<typeof stringifyPlanReport>[0]),
    );
    const classified = classifyReviewTrust(
      trustInputFromPlan(planFile),
      {},
      () => false,
    );
    expect(classified.executionClass).toBe('hardware-isolated');
    expect(classified.escalationReasons).toEqual(
      expect.arrayContaining([
        'symlink-entry:src/link.ts',
        'executable-mode:src/tool',
        'submodule-entry:vendor/sub',
      ]),
    );
  });

  it('fails closed on adversarial plan shapes, numeric prNumber, traversal, and config files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-trust-adv-'));
    dirs.push(dir);

    for (const [name, payload] of [
      ['array.json', []],
      ['empty.json', {}],
      [
        'numeric-pr.json',
        {
          prNumber: 123,
          isCrossRepository: true,
          files: [{ path: 'src/a.ts' }],
        },
      ],
      [
        'no-prnum-fork.json',
        { isCrossRepository: true, files: [{ path: 'src/a.ts' }] },
      ],
      [
        'malformed-entry.json',
        { files: [{ path: 'src/a.ts' }, { bogus: true }] },
      ],
    ] as const) {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(payload));
      const res = classifyReviewTrust(trustInputFromPlan(p), {}, () => false);
      expect(res.executionClass).toBe('hardware-isolated');
    }

    const extraReasons = detectReviewMandatoryEscalations([
      { path: '.gitmodules' },
      { path: '.gitattributes' },
      { path: '.eslintrc.cjs' },
      { path: 'jest.config.ts' },
      { path: 'packages/sdk-typescript/scripts/build.js' },
      { path: 'packages/node-repl/build.mjs' },
      { path: '././scripts//deploy.js' },
      { path: 'src/../scripts/evil.js' },
    ]);
    expect(extraReasons).toEqual(
      expect.arrayContaining([
        'ci-or-agent-config:.gitmodules',
        'ci-or-agent-config:.gitattributes',
        'build-or-sandbox-tooling:.eslintrc.cjs',
        'build-or-sandbox-tooling:jest.config.ts',
        'build-or-sandbox-tooling:packages/sdk-typescript/scripts/build.js',
        'build-or-sandbox-tooling:packages/node-repl/build.mjs',
        'build-or-sandbox-tooling:scripts/deploy.js',
        'suspicious-path-traversal:src/../scripts/evil.js',
      ]),
    );
  });
});

describe('external content-allowlist downgrade (operator opt-in)', () => {
  const OPT_IN = { QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER: '1' };
  const noFileSource = () => false;
  const externalDocs = (
    files: Array<{
      path: string;
      mode?: string;
      renameFrom?: string;
      binary?: boolean;
    }>,
  ) => ({
    isCrossRepository: true,
    authorAssociation: 'NONE',
    changedFiles: files,
  });

  it('reads the opt-in from operator env only, never from repo file-sourced env', () => {
    for (const val of ['1', 'true', 'YES', ' on ']) {
      expect(
        externalContentContainerRequested(
          { QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER: val },
          noFileSource,
        ),
      ).toBe(true);
    }
    expect(
      externalContentContainerRequested(
        { QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER: '0' },
        noFileSource,
      ),
    ).toBe(false);
    expect(
      externalContentContainerRequested(
        { QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER: '1' },
        (k) => k === 'QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER',
      ),
    ).toBe(false);
  });

  it('allowlists only docs Markdown and the four root prose files', () => {
    for (const p of [
      'docs/guide.md',
      'docs/design/a.zh-CN.md',
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'LICENSE.md',
    ]) {
      expect(isReviewContentAllowlistedPath(p)).toBe(true);
    }
    for (const p of [
      'src/a.ts',
      'docs/guide.json',
      'docs/guide.yaml',
      'docs/img.png',
      'docs/../package.json',
      'packages/cli/README.md',
      'readme.md.bak',
      '',
    ]) {
      expect(isReviewContentAllowlistedPath(p)).toBe(false);
    }
  });

  it('keeps external PRs hardware-isolated when the opt-in is off', () => {
    const res = classifyReviewTrust(
      externalDocs([{ path: 'docs/guide.md' }]),
      {},
      noFileSource,
    );
    expect(res.executionClass).toBe('hardware-isolated');
    expect(res.escalationReasons).toContain('cross-repository-pr');
    expect(res.downgradeReasons).toBeUndefined();
  });

  it('downgrades a complete docs-only external diff to shared-kernel with disclosure', () => {
    const res = classifyReviewTrust(
      externalDocs([{ path: 'docs/guide.md' }, { path: 'README.md' }]),
      OPT_IN,
      noFileSource,
    );
    expect(res.prTrust).toBe('external');
    expect(res.executionClass).toBe('trusted-shared-kernel');
    expect(res.escalationReasons).toEqual([]);
    expect(res.downgradeReasons).toEqual(['external-content-allowlist']);
  });

  it('ignores a repo file-sourced opt-in', () => {
    const res = classifyReviewTrust(
      externalDocs([{ path: 'docs/guide.md' }]),
      OPT_IN,
      (k) => k === 'QWEN_REVIEW_ALLOW_EXTERNAL_CONTENT_CONTAINER',
    );
    expect(res.executionClass).toBe('hardware-isolated');
    expect(res.downgradeReasons).toBeUndefined();
  });

  it.each([
    [
      'mixed executable content',
      [{ path: 'docs/guide.md' }, { path: 'scripts/x.js' }],
    ],
    ['dependency manifest', [{ path: 'package.json' }]],
    ['non-allowlisted markdown', [{ path: 'packages/cli/README.md' }]],
    ['data format in docs', [{ path: 'docs/config.json' }]],
    ['executable mode', [{ path: 'docs/guide.md', mode: '100755' }]],
    ['symlink mode', [{ path: 'docs/guide.md', mode: '120000' }]],
    ['submodule mode', [{ path: 'docs/guide.md', mode: '160000' }]],
    ['binary flag', [{ path: 'docs/guide.md', binary: true }]],
    ['rename', [{ path: 'docs/guide.md', renameFrom: 'scripts/x.js' }]],
    [
      'docs-to-docs rename',
      [{ path: 'docs/new.md', renameFrom: 'docs/old.md' }],
    ],
    ['traversal', [{ path: 'docs/../package.json' }]],
    ['scripts segment inside docs', [{ path: 'docs/scripts/x.md' }]],
  ])('still escalates for %s', (_name, files) => {
    const res = classifyReviewTrust(
      externalDocs(
        files as Array<{
          path: string;
          mode?: string;
          renameFrom?: string;
          binary?: boolean;
        }>,
      ),
      OPT_IN,
      noFileSource,
    );
    expect(res.executionClass).toBe('hardware-isolated');
    expect(res.downgradeReasons).toBeUndefined();
  });

  it('still escalates for an incomplete file list or missing list', () => {
    const partial = classifyReviewTrust(
      { ...externalDocs([{ path: 'docs/guide.md' }]), partialFileList: true },
      OPT_IN,
      noFileSource,
    );
    expect(partial.executionClass).toBe('hardware-isolated');
    expect(partial.downgradeReasons).toBeUndefined();
    const missing = classifyReviewTrust(
      { isCrossRepository: true, authorAssociation: 'NONE' },
      OPT_IN,
      noFileSource,
    );
    expect(missing.executionClass).toBe('hardware-isolated');
    expect(missing.downgradeReasons).toBeUndefined();
  });

  it('operator force-hardware overrides the downgrade', () => {
    const res = classifyReviewTrust(
      externalDocs([{ path: 'docs/guide.md' }]),
      { ...OPT_IN, QWEN_REVIEW_FORCE_HARDWARE: '1' },
      noFileSource,
    );
    expect(res.executionClass).toBe('hardware-isolated');
    expect(res.escalationReasons).toContain('operator-force-hardware');
    expect(res.downgradeReasons).toBeUndefined();
  });

  it('does not change collaborator or local classification', () => {
    const collab = classifyReviewTrust(
      {
        isCrossRepository: false,
        authorAssociation: 'MEMBER',
        changedFiles: [{ path: 'docs/guide.md' }],
      },
      OPT_IN,
      noFileSource,
    );
    expect(collab.executionClass).toBe('trusted-shared-kernel');
    expect(collab.downgradeReasons).toBeUndefined();
    const local = classifyReviewTrust(
      { isLocal: true, changedFiles: [{ path: 'docs/guide.md' }] },
      OPT_IN,
      noFileSource,
    );
    expect(local.executionClass).toBe('trusted-shared-kernel');
    expect(local.downgradeReasons).toBeUndefined();
  });
});
