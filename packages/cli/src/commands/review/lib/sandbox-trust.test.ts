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
  forceHardwareRequested,
  trustInputFromPlan,
} from './sandbox-trust.js';

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
});
