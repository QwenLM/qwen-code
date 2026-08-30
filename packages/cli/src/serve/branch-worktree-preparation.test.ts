/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarker,
  GitWorktreeService,
  type SessionService,
} from '@qwen-code/qwen-code-core';
import {
  clearBranchWorktreeJournalDurable,
  createBranchWorktreeJournal,
  getBranchWorktreeJournalPath,
  recoverBranchWorktreePreparations,
  isBranchWorktreeCreationSupported,
  resolveBranchWorktreeBaseCheckout,
  updateBranchWorktreeJournal,
} from './branch-worktree-preparation.js';

const targetSessionId = '11111111-1111-4111-8111-111111111111';
const stalePid = 2_147_483_647;
let root: string;
let chatsDir: string;
let sidecarPath: string;
let journalPath: string;
let baseCommit: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-branch-journal-'));
  chatsDir = path.join(root, 'chats');
  sidecarPath = path.join(chatsDir, `${targetSessionId}.worktree.json`);
  journalPath = getBranchWorktreeJournalPath(sidecarPath, targetSessionId);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Qwen Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'qwen@example.invalid'], {
    cwd: root,
  });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'initial'], {
    cwd: root,
  });
  baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function fakeSessionService(sessionExists: boolean): SessionService {
  return {
    getWorktreeSessionPath: (sessionId: string) =>
      path.join(chatsDir, `${sessionId}.worktree.json`),
    sessionExistsInAnyState: vi.fn().mockResolvedValue(sessionExists),
  } as unknown as SessionService;
}

async function markJournalStale(
  journal: Awaited<ReturnType<typeof createBranchWorktreeJournal>>,
) {
  await fs.writeFile(
    journalPath,
    `${JSON.stringify({
      ...journal,
      pid: stalePid,
      createdAt: '2000-01-01T00:00:00.000Z',
    })}\n`,
    'utf8',
  );
}

async function recoverStalePreparation(
  sessionService: SessionService,
  options: {
    isWorktreeOccupied?: (worktreePath: string) => boolean;
    warn?: (message: string, fields?: Record<string, unknown>) => void;
  } = {},
) {
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === stalePid) {
      throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
    }
    return true;
  });
  try {
    await recoverBranchWorktreePreparations({
      workspaceCwd: root,
      sessionService,
      ...options,
    });
  } finally {
    kill.mockRestore();
  }
}

describe('branch worktree preparation journal', () => {
  it('clears idempotently when the parent directory is absent', async () => {
    await expect(
      clearBranchWorktreeJournalDurable(journalPath),
    ).resolves.not.toThrow();
  });

  it('is exclusive and durably advances phases', async () => {
    const journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-a',
      worktreePath: path.join(root, '.qwen', 'worktrees', 'branch-a'),
      worktreeBranch: 'worktree-branch-a',
      repoTop: root,
      baseCommit,
      sidecarPath,
    });

    await expect(
      createBranchWorktreeJournal({
        journalPath,
        targetSessionId,
        slug: 'branch-a',
        worktreePath: journal.worktreePath,
        worktreeBranch: journal.worktreeBranch,
        repoTop: root,
        baseCommit: journal.baseCommit,
        sidecarPath,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    const dispatched = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'mutation-dispatched',
    );
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')).phase).toBe(
      'mutation-dispatched',
    );
    expect(dispatched.ownerToken).toBe(journal.ownerToken);
  });

  it('rejects a hard-linked journal before advancing its phase', async () => {
    const journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-linked',
      worktreePath: path.join(root, '.qwen', 'worktrees', 'branch-linked'),
      worktreeBranch: 'worktree-branch-linked',
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    await fs.link(journalPath, `${journalPath}.alias`);

    await expect(
      updateBranchWorktreeJournal(journalPath, journal, 'cleanup-intent'),
    ).rejects.toThrow('must be a regular file');
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')).phase).toBe(
      'planned',
    );
  });

  it('preserves an oversized recovery journal without reading it fully', async () => {
    await fs.mkdir(chatsDir, { recursive: true });
    await fs.writeFile(journalPath, 'x'.repeat(64 * 1024 + 1), 'utf8');
    const warn = vi.fn();

    await recoverBranchWorktreePreparations({
      workspaceCwd: root,
      sessionService: fakeSessionService(false),
      warn,
    });

    await expect(fs.stat(journalPath)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      'invalid branch worktree recovery journal preserved',
      expect.objectContaining({ journalPath }),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a symlinked recovery journal without following it',
    async () => {
      const journal = await createBranchWorktreeJournal({
        journalPath,
        targetSessionId,
        slug: 'branch-symlink',
        worktreePath: path.join(root, '.qwen', 'worktrees', 'branch-symlink'),
        worktreeBranch: 'worktree-branch-symlink',
        repoTop: root,
        baseCommit,
        sidecarPath,
      });
      await markJournalStale(journal);
      const target = `${journalPath}.target`;
      await fs.rename(journalPath, target);
      await fs.symlink(target, journalPath);
      const warn = vi.fn();

      await recoverBranchWorktreePreparations({
        workspaceCwd: root,
        sessionService: fakeSessionService(false),
        warn,
      });

      expect((await fs.lstat(journalPath)).isSymbolicLink()).toBe(true);
      await expect(fs.stat(target)).resolves.toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        'invalid branch worktree recovery journal preserved',
        expect.objectContaining({ journalPath }),
      );
    },
  );

  it('preserves an unknown dispatched outcome until the transcript appears', async () => {
    const journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-a',
      worktreePath: path.join(root, '.qwen', 'worktrees', 'branch-a'),
      worktreeBranch: 'worktree-branch-a',
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'mutation-dispatched',
    );
    const warn = vi.fn();

    await recoverBranchWorktreePreparations({
      workspaceCwd: root,
      sessionService: fakeSessionService(false),
      warn,
    });
    await expect(fs.stat(journalPath)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('outcome remains unknown'),
      { targetSessionId },
    );

    await recoverBranchWorktreePreparations({
      workspaceCwd: root,
      sessionService: fakeSessionService(true),
    });
    await expect(fs.stat(journalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes a stale prepared worktree whose identity is unchanged', async () => {
    const service = new GitWorktreeService(root);
    const created = await service.createUserWorktree(
      'branch-clean',
      baseCommit,
    );
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    let journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-clean',
      worktreePath: created.worktree.path,
      worktreeBranch: created.worktree.branch,
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'worktree-created',
    );
    await createWorktreeSessionMarker(created.worktree.path, targetSessionId);
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'marker-created',
    );
    await fs.writeFile(sidecarPath, '{}\n', 'utf8');
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'sidecar-ready',
    );
    await markJournalStale(journal);

    const warn = vi.fn();
    await recoverStalePreparation(fakeSessionService(false), {
      isWorktreeOccupied: (candidate) => candidate === created.worktree!.path,
      warn,
    });
    await expect(fs.stat(created.worktree.path)).resolves.toBeDefined();
    await expect(fs.stat(journalPath)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      'branch worktree is still occupied by a live session',
      { targetSessionId },
    );

    await recoverStalePreparation(fakeSessionService(false));

    await expect(fs.stat(created.worktree.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      service.getPreparedUserWorktreeBranchTip('branch-clean'),
    ).resolves.toBeNull();
    await expect(fs.stat(sidecarPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(journalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves resources when a sidecar was not created by the journal owner', async () => {
    const service = new GitWorktreeService(root);
    const created = await service.createUserWorktree(
      'branch-sidecar-conflict',
      baseCommit,
    );
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    let journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-sidecar-conflict',
      worktreePath: created.worktree.path,
      worktreeBranch: created.worktree.branch,
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'worktree-created',
    );
    await createWorktreeSessionMarker(created.worktree.path, targetSessionId);
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'marker-created',
    );
    await fs.writeFile(sidecarPath, 'pre-existing sidecar\n', 'utf8');
    await markJournalStale(journal);
    const warn = vi.fn();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === stalePid) {
        throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
      }
      return true;
    });
    try {
      await recoverBranchWorktreePreparations({
        workspaceCwd: root,
        sessionService: fakeSessionService(false),
        warn,
      });
    } finally {
      kill.mockRestore();
    }

    await expect(fs.stat(created.worktree.path)).resolves.toBeDefined();
    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toBe(
      'pre-existing sidecar\n',
    );
    await expect(fs.stat(journalPath)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      'branch worktree recovery sidecar ownership is unknown',
      { targetSessionId },
    );
  });

  it('finishes safe branch deletion after a worktree-removed checkpoint', async () => {
    const service = new GitWorktreeService(root);
    const created = await service.createUserWorktree(
      'branch-crash',
      baseCommit,
    );
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    let journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-crash',
      worktreePath: created.worktree.path,
      worktreeBranch: created.worktree.branch,
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'worktree-created',
    );
    await createWorktreeSessionMarker(created.worktree.path, targetSessionId);
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'marker-created',
    );
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'cleanup-intent',
    );
    const removed = await service.removePreparedUserWorktree(
      'branch-crash',
      targetSessionId,
      baseCommit,
      async () => {
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          'worktree-removed',
        );
        throw new Error('simulated crash');
      },
    );
    expect(removed.success).toBe(false);
    await markJournalStale(journal);

    await recoverStalePreparation(fakeSessionService(false));

    await expect(
      service.getPreparedUserWorktreeBranchTip('branch-crash'),
    ).resolves.toBeNull();
    await expect(fs.stat(journalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves a sidecar that appears during terminal recovery', async () => {
    const service = new GitWorktreeService(root);
    const created = await service.createUserWorktree(
      'branch-late-sidecar',
      baseCommit,
    );
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    let journal = await createBranchWorktreeJournal({
      journalPath,
      targetSessionId,
      slug: 'branch-late-sidecar',
      worktreePath: created.worktree.path,
      worktreeBranch: created.worktree.branch,
      repoTop: root,
      baseCommit,
      sidecarPath,
    });
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'worktree-created',
    );
    journal = await updateBranchWorktreeJournal(
      journalPath,
      journal,
      'cleanup-intent',
    );
    await service.removePreparedUserWorktree(
      'branch-late-sidecar',
      null,
      baseCommit,
      async () => {
        journal = await updateBranchWorktreeJournal(
          journalPath,
          journal,
          'worktree-removed',
        );
        throw new Error('simulated crash');
      },
    );
    await markJournalStale(journal);
    const finalize =
      GitWorktreeService.prototype.finalizePreparedUserWorktreeBranch;
    const finalizeSpy = vi
      .spyOn(GitWorktreeService.prototype, 'finalizePreparedUserWorktreeBranch')
      .mockImplementation(async function (
        this: GitWorktreeService,
        slug,
        expectedBaseCommit,
      ) {
        await fs.writeFile(sidecarPath, 'late sidecar\n', 'utf8');
        return await finalize.call(this, slug, expectedBaseCommit);
      });
    try {
      await recoverStalePreparation(fakeSessionService(false));
    } finally {
      finalizeSpy.mockRestore();
    }

    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toBe(
      'late sidecar\n',
    );
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')).phase).toBe(
      'branch-deleted',
    );
  });
});

describe('resolveBranchWorktreeBaseCheckout', () => {
  it('accepts a detached HEAD in the source session managed worktree', async () => {
    const sourceSessionId = '22222222-2222-4222-8222-222222222222';
    const service = new GitWorktreeService(root);
    const created = await service.createUserWorktree('source', baseCommit);
    if (!created.success || !created.worktree) {
      throw new Error(created.error ?? 'worktree creation failed');
    }
    await createWorktreeSessionMarker(created.worktree.path, sourceSessionId);
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(
      sidecarPath,
      `${JSON.stringify({
        slug: 'source',
        worktreePath: created.worktree.path,
        worktreeBranch: created.worktree.branch,
        originalCwd: root,
        originalBranch: 'main',
        originalHeadCommit: baseCommit,
      })}\n`,
      'utf8',
    );
    execFileSync('git', ['checkout', '--detach', '-q'], {
      cwd: created.worktree.path,
    });

    const resolved = await resolveBranchWorktreeBaseCheckout({
      workspaceCwd: root,
      sessionId: sourceSessionId,
      snapshot: {
        workspaceCwd: root,
        effectiveCwd: created.worktree.path,
        worktree: {
          slug: 'source',
          path: created.worktree.path,
          branch: created.worktree.branch,
        },
      },
      sidecarPath,
    });
    expect(resolved).toMatchObject({
      repoTop: await fs.realpath(root),
      checkoutCwd: await fs.realpath(created.worktree.path),
      headCommit: baseCommit,
      branch: 'HEAD',
    });

    const decoy = await fs.mkdtemp(path.join(os.tmpdir(), 'git-env-decoy-'));
    execFileSync('git', ['init', '-q'], { cwd: decoy });
    const previousGitDir = process.env['GIT_DIR'];
    const previousGitWorkTree = process.env['GIT_WORK_TREE'];
    process.env['GIT_DIR'] = path.join(decoy, '.git');
    process.env['GIT_WORK_TREE'] = decoy;

    try {
      await expect(isBranchWorktreeCreationSupported(resolved!)).resolves.toBe(
        true,
      );
    } finally {
      if (previousGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previousGitDir;
      if (previousGitWorkTree === undefined) {
        delete process.env['GIT_WORK_TREE'];
      } else {
        process.env['GIT_WORK_TREE'] = previousGitWorkTree;
      }
      await fs.rm(decoy, { recursive: true, force: true });
    }
  });
});

describe('isBranchWorktreeCreationSupported', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects symlinked worktree metadata directories',
    async () => {
      const outside = path.join(root, 'outside-qwen');
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(root, '.qwen'));

      await expect(
        isBranchWorktreeCreationSupported({
          repoTop: root,
          checkoutCwd: root,
          headCommit: baseCommit,
          branch: 'main',
        }),
      ).resolves.toBe(false);
    },
  );

  it('rejects a HEAD that tracks the ownership marker path', async () => {
    await fs.writeFile(path.join(root, '.qwen-session'), 'tracked\n');
    execFileSync('git', ['add', '.qwen-session'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'track marker'], { cwd: root });
    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();

    await expect(
      isBranchWorktreeCreationSupported({
        repoTop: root,
        checkoutCwd: root,
        headCommit,
        branch: 'main',
      }),
    ).resolves.toBe(false);
  });
});
