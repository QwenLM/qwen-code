/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitWorktreeService,
  writeWorktreeSessionMarker,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { writeWorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import {
  makeRetainedSession,
  makeRetentionRepo,
  type RetentionTestRuntime,
} from '../../test-utils/worktree-session-retention-fixtures.js';
import { createWorkspaceRegistry } from '../workspace-registry.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
import { resolveSessionManagedGitCwd } from '../workspace-route-runtime.js';
import {
  createBranchWorktreeJournal,
  getBranchWorktreeJournalPath,
  isBranchWorktreeCreationSupported,
  recoverBranchWorktreePreparations,
  updateBranchWorktreeJournal,
} from '../branch-worktree-preparation.js';
import { SessionArchiveCoordinator } from './session-archive.js';
import { sweepWorktreeRetentionOnce } from './worktree-retention.js';
import { restoreWorktreeFromSessionSnapshot } from './session-worktree-restore.js';
import {
  executeWorktreeCleanup,
  preclassifyWorktreeCleanup,
  verifyWorktreeCleanupOwnership,
  worktreeAllowedRoots,
} from './worktree-orphan-cleanup.js';

function configureWorkspaceWorktreeSettings(
  target: RetentionTestRuntime,
  worktree: Record<string, unknown>,
): void {
  const dir = path.join(target.repo, '.qwen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ worktree }),
  );
}

describe('daemon worktree lifecycle with custom worktree.root', () => {
  let root: string;
  let coordinator: SessionArchiveCoordinator;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-custom-root-daemon-')),
    );
    coordinator = new SessionArchiveCoordinator();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sweeps retention snapshots and restores a retained checkout under custom worktree.root', async () => {
    const base = makeRetentionRepo(root, 'primary');
    const customRoot = '.worktrees';
    configureWorkspaceWorktreeSettings(base, {
      root: customRoot,
      maxRetained: 1,
    });
    const target: RetentionTestRuntime = {
      ...base,
      git: new GitWorktreeService(base.repo, { worktreeRoot: customRoot }),
    };

    const evicted = await makeRetainedSession(target, {
      slug: 'older-custom',
      dirty: true,
      activity: '2026-01-01T00:00:00.000Z',
    });
    const kept = await makeRetainedSession(target, {
      slug: 'newer-custom',
      activity: '2026-01-02T00:00:00.000Z',
    });

    expect(evicted.worktreePath).toBe(
      path.join(base.repo, '.worktrees', 'older-custom'),
    );
    expect(kept.worktreePath).toBe(
      path.join(base.repo, '.worktrees', 'newer-custom'),
    );

    const registry = createWorkspaceRegistry([target.runtime]);
    const report = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      sweepWorktreeRetentionOnce(target.runtime, registry, coordinator),
    );
    expect(report.issues).toEqual([]);
    expect(report.removed).toEqual([evicted.id]);
    expect(fs.existsSync(evicted.worktreePath)).toBe(false);
    expect(fs.existsSync(kept.worktreePath)).toBe(true);

    const restored = await runWithWorkspaceRuntimeStorage(target.runtime, () =>
      restoreWorktreeFromSessionSnapshot({
        runtime: target.runtime,
        sessionId: evicted.id,
        archiveCoordinator: coordinator,
      }),
    );
    expect(restored.reconstructed).toBe(true);
    expect(fs.existsSync(evicted.worktreePath)).toBe(true);
    expect(
      fs.readFileSync(path.join(evicted.worktreePath, 'tracked.txt'), 'utf8'),
    ).toBe('dirty-older-custom\n');
  });

  it('fails closed on retention sweep and orphan cleanup when worktree.root is invalid', async () => {
    const base = makeRetentionRepo(root, 'primary');
    const target: RetentionTestRuntime = {
      ...base,
      git: new GitWorktreeService(base.repo, { worktreeRoot: '.worktrees' }),
    };
    const s1 = await makeRetainedSession(target, {
      slug: 'first-wt',
      activity: '2026-01-01T00:00:00.000Z',
    });
    const s2 = await makeRetainedSession(target, {
      slug: 'second-wt',
      activity: '2026-01-02T00:00:00.000Z',
    });

    configureWorkspaceWorktreeSettings(base, {
      root: '../escape',
      maxRetained: 1,
    });
    const registry = createWorkspaceRegistry([target.runtime]);
    await expect(
      runWithWorkspaceRuntimeStorage(target.runtime, () =>
        sweepWorktreeRetentionOnce(target.runtime, registry, coordinator),
      ),
    ).rejects.toThrow(/\.\.|worktree\.root/);

    expect(fs.existsSync(s1.worktreePath)).toBe(true);
    expect(fs.existsSync(s2.worktreePath)).toBe(true);

    // Orphan cleanup also preserves when worktreeRoot is invalid.
    const plan = await preclassifyWorktreeCleanup(
      target.service,
      s1.id,
      target.repo,
      { quiet: true, worktreeRoot: '../escape' },
    );
    expect(plan).toBeUndefined();
    expect(fs.existsSync(s1.worktreePath)).toBe(true);
  });

  it('executes ownership-verified orphan cleanup under custom worktree.root', async () => {
    const base = makeRetentionRepo(root, 'primary');
    const customRoot = 'tmp/wts';
    configureWorkspaceWorktreeSettings(base, { root: customRoot });
    const target: RetentionTestRuntime = {
      ...base,
      git: new GitWorktreeService(base.repo, { worktreeRoot: customRoot }),
    };
    const created = await makeRetainedSession(target, {
      slug: 'orphan-custom',
      activity: '2026-01-01T00:00:00.000Z',
    });

    const plan = await preclassifyWorktreeCleanup(
      target.service,
      created.id,
      target.repo,
      { worktreeRoot: customRoot },
    );
    expect(plan).toBeDefined();
    expect(plan?.worktreeRoot).toBe(customRoot);

    const ownership = await verifyWorktreeCleanupOwnership(plan!, () => false);
    expect(ownership).toEqual({ ok: true });

    const outcome = await executeWorktreeCleanup(plan!);
    expect(outcome.removed).toBe(true);
    expect(fs.existsSync(created.worktreePath)).toBe(false);
  });

  it('checks every custom root prefix in isBranchWorktreeCreationSupported and rejects symlinked prefixes', async () => {
    const base = makeRetentionRepo(root, 'primary');
    const baseCheckout = {
      repoTop: base.repo,
      checkoutCwd: base.repo,
      headCommit: base.head,
      branch: 'main',
    };

    expect(
      await isBranchWorktreeCreationSupported(baseCheckout, 'tmp/wts'),
    ).toBe(true);

    const external = path.join(root, 'external-dir');
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(external, path.join(base.repo, 'tmp'));

    expect(
      await isBranchWorktreeCreationSupported(baseCheckout, 'tmp/wts'),
    ).toBe(false);
  });

  it('recovers an interrupted branch-preparation journal even after worktree.root changes (R1-8)', async () => {
    const base = makeRetentionRepo(root, 'primary');
    const serviceRootA = new GitWorktreeService(base.repo, {
      worktreeRoot: '.wt-a',
    });
    const slug = 'interrupted-branch';
    const created = await serviceRootA.createUserWorktree(slug, base.head, {
      detached: true,
    });
    expect(created.success).toBe(true);
    const targetSessionId = crypto.randomUUID();
    await writeWorktreeSessionMarker(created.worktree!.path, targetSessionId);
    const sidecarPath = base.service.getWorktreeSessionPath(targetSessionId);
    const journalPath = getBranchWorktreeJournalPath(
      sidecarPath,
      targetSessionId,
    );
    const journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug,
      worktreePath: created.worktree!.path,
      worktreeRoot: '.wt-a',
      worktreeBranch: '',
      repoTop: base.repo,
      baseCommit: base.head,
      sidecarPath,
    });
    // Mark as dead process (pid 999999999) past marker creation so recovery reaps it.
    const deadJournal = {
      ...(await updateBranchWorktreeJournal(
        journalPath,
        journal,
        'marker-created',
      )),
      pid: 999_999_999,
      createdAt: '2020-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(journalPath, `${JSON.stringify(deadJournal)}\n`);

    // Recover after worktree.root was changed to `.wt-b`.
    await recoverBranchWorktreePreparations({
      workspaceCwd: base.repo,
      sessionService: base.service,
      worktreeRoot: '.wt-b',
    });

    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(created.worktree!.path)).toBe(false);
  });

  it('enforces custom-root containment in worktreeAllowedRoots and resolveSessionManagedGitCwd (R1-16)', async () => {
    const base = makeRetentionRepo(root, 'primary');
    configureWorkspaceWorktreeSettings(base, { root: '.worktrees' });
    const wtService = new GitWorktreeService(base.repo, {
      worktreeRoot: '.worktrees',
    });
    const created = await wtService.createUserWorktree(
      'route-git-wt',
      base.head,
      {
        detached: true,
      },
    );
    expect(created.success).toBe(true);
    const sessionId = crypto.randomUUID();
    await writeWorktreeSessionMarker(created.worktree!.path, sessionId);
    await writeWorktreeSession(base.service.getWorktreeSessionPath(sessionId), {
      slug: 'route-git-wt',
      worktreePath: created.worktree!.path,
      worktreeBranch: '',
      originalCwd: base.repo,
      originalBranch: 'main',
      originalHeadCommit: base.head,
      workspaceCwd: base.repo,
    });

    // Allowed roots includes `<repo>/.worktrees` when valid.
    const allowed = await worktreeAllowedRoots(
      base.repo,
      base.repo,
      '.worktrees',
    );
    expect(allowed).toContain(path.join(base.repo, '.worktrees'));

    // resolveSessionManagedGitCwd admits the custom-root worktree checkout when
    // the owning session's live execution snapshot matches.
    const realWtPath = fs.realpathSync(created.worktree!.path);
    const runtimeWithSnapshot = {
      ...base.runtime,
      bridge: {
        ...base.runtime.bridge,
        getSessionExecutionSnapshot: (id: string) => {
          if (id !== sessionId) throw new Error('unknown');
          return {
            sessionId,
            workspaceCwd: base.repo,
            effectiveCwd: realWtPath,
            worktree: {
              slug: 'route-git-wt',
              path: realWtPath,
              branch: '',
            },
          };
        },
      },
    } as unknown as typeof base.runtime;
    const resolved = await resolveSessionManagedGitCwd(
      {
        query: { cwd: created.worktree!.path, sessionId },
      } as unknown as Request,
      runtimeWithSnapshot,
    );
    expect(resolved).toBe(realWtPath);

    // When `.worktrees` is replaced with an escaping symlink, both refuse it.
    const outside = path.join(root, 'outside-escape');
    fs.mkdirSync(outside, { recursive: true });
    await wtService.removeUserWorktree('route-git-wt', {
      forceDeleteBranch: true,
    });
    fs.rmSync(path.join(base.repo, '.worktrees'), {
      recursive: true,
      force: true,
    });
    fs.symlinkSync(outside, path.join(base.repo, '.worktrees'));

    expect(
      await worktreeAllowedRoots(base.repo, base.repo, '.worktrees'),
    ).toEqual([]);
    expect(
      await resolveSessionManagedGitCwd(
        { query: { cwd: outside, sessionId } } as unknown as Request,
        runtimeWithSnapshot,
      ),
    ).toBeNull();
  });
});
