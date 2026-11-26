/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cleanupWorktreeSession,
  countWorktreeChanges,
  findProjectRootForWorktree,
} from './worktreeService.js';
import {
  releasePersistedWorktreeSessionOwnership,
  releasePersistedWorktreeOwnerHandoff,
  worktreeSessionService,
} from './worktreeSessionService.js';
import {
  claimWorktreeOwnership,
  inspectWorktreeOwnership,
  isWorktreeOwnedBySession,
  readWorktreeOwnerState,
  releaseWorktreeOwnershipForHandoff,
  releaseWorktreeOwnership,
} from './worktree-owner-state.js';
import { createRuntimeConfig } from '../test-utils/worktreeSession.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import { resetForTest, setCwdChangedCallback } from '../utils/Shell.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

vi.mock('./worktreeService.js', async (importOriginal) => {
  const { createWorktreeServiceMock } = await import(
    '../test-utils/worktreeSession.js'
  );
  return createWorktreeServiceMock(
    await importOriginal<typeof import('./worktreeService.js')>(),
  );
});

vi.mock('./worktree-owner-state.js', async () => {
  const { createWorktreeOwnerMock } = await import(
    '../test-utils/worktreeSession.js'
  );
  return createWorktreeOwnerMock();
});

vi.mock('../utils/gitUtils.js', () => ({
  resolveGitRepositoryLayout: vi.fn(),
}));

function makeTranscriptState(
  worktreePath: string,
  originalCwd: string,
  overrides: Partial<TranscriptWorktreeSession> = {},
): TranscriptWorktreeSession {
  return {
    worktreePath,
    worktreeCwd: worktreePath,
    worktreeName: 'feature',
    originalCwd,
    worktreeBranch: 'worktree-feature',
    originalBranch: 'main',
    sessionId: 'session-1',
    lifecycle: 'owner',
    ...overrides,
  };
}

describe('WorktreeSessionService ownership settlement', () => {
  let temporaryRoot: string;
  let originalCwd: string;
  let worktreePath: string;
  let processCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    processCwd = process.cwd();
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-session-'));
    originalCwd = path.join(temporaryRoot, 'repo', 'apps', 'desktop');
    worktreePath = path.join(temporaryRoot, 'worktree', 'apps', 'desktop');
    await fs.mkdir(originalCwd, { recursive: true });
    await fs.mkdir(worktreePath, { recursive: true });
    originalCwd = await fs.realpath(originalCwd);
    worktreePath = await fs.realpath(worktreePath);
    resetForTest(originalCwd);
    process.chdir(originalCwd);
    vi.mocked(claimWorktreeOwnership).mockResolvedValue('owned');
    vi.mocked(inspectWorktreeOwnership).mockResolvedValue('owned-by-session');
    vi.mocked(isWorktreeOwnedBySession).mockResolvedValue(true);
    vi.mocked(readWorktreeOwnerState).mockResolvedValue(null);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue('released');
    vi.mocked(releaseWorktreeOwnership).mockResolvedValue(true);
    vi.mocked(cleanupWorktreeSession).mockResolvedValue({ removed: true });
    vi.mocked(countWorktreeChanges).mockResolvedValue({
      changedFiles: 0,
      commits: 0,
    });
    vi.mocked(findProjectRootForWorktree).mockResolvedValue(
      path.join(temporaryRoot, 'repo'),
    );
    const sourceCommonDir = path.join(temporaryRoot, 'repo', '.git');
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) => ({
      worktreeRoot:
        cwd === originalCwd
          ? path.join(temporaryRoot, 'repo')
          : cwd.startsWith(path.dirname(path.dirname(worktreePath)))
            ? path.dirname(path.dirname(worktreePath))
            : cwd,
      gitDir: sourceCommonDir,
      commonDir: sourceCommonDir,
      isWorktree: cwd !== originalCwd,
    }));
  });

  afterEach(async () => {
    setCwdChangedCallback(null);
    resetForTest(processCwd);
    if (process.cwd() !== processCwd) {
      process.chdir(processCwd);
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('releases a validated persisted handoff before its transcript can be deleted', async () => {
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    await fs.mkdir(previousWorktreePath, { recursive: true });
    const canonicalPreviousWorktreePath = await fs.realpath(
      previousWorktreePath,
    );

    await expect(
      releasePersistedWorktreeOwnerHandoff(
        makeTranscriptState(
          path.dirname(path.dirname(worktreePath)),
          originalCwd,
          { pendingOwnerReleasePath: canonicalPreviousWorktreePath },
        ),
        'session-1',
      ),
    ).resolves.toBeUndefined();

    expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
      canonicalPreviousWorktreePath,
      'session-1',
      originalCwd,
    );
  });

  it('releases the current durable owner before its transcript can be deleted', async () => {
    const currentWorktreePath = path.dirname(path.dirname(worktreePath));

    await expect(
      releasePersistedWorktreeSessionOwnership(
        makeTranscriptState(currentWorktreePath, originalCwd, {
          lifecycle: 'owner',
        }),
        'session-1',
      ),
    ).resolves.toBeUndefined();

    expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
      currentWorktreePath,
      'session-1',
      undefined,
      false,
    );
  });

  it('keeps the current owner when a pending handoff cannot be settled', async () => {
    const currentWorktreePath = path.dirname(path.dirname(worktreePath));
    const previousWorktreePath = path.join(temporaryRoot, 'previous-worktree');
    await fs.mkdir(previousWorktreePath, { recursive: true });
    const canonicalPreviousWorktreePath = await fs.realpath(previousWorktreePath);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockImplementation(
      async (candidatePath) => {
        if (candidatePath === canonicalPreviousWorktreePath) {
          return 'unavailable';
        }
        return 'released';
      },
    );

    await expect(
      releasePersistedWorktreeSessionOwnership(
        makeTranscriptState(currentWorktreePath, originalCwd, {
          lifecycle: 'owner',
          pendingOwnerReleasePath: canonicalPreviousWorktreePath,
        }),
        'session-1',
      ),
    ).rejects.toThrow('Cannot complete the pending worktree owner handoff');

    expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledExactlyOnceWith(
      canonicalPreviousWorktreePath,
      'session-1',
      originalCwd,
    );
  });

  it('rejects a deletion handoff that targets its current worktree', async () => {
    const currentWorktreePath = path.dirname(path.dirname(worktreePath));

    await expect(
      releasePersistedWorktreeOwnerHandoff(
        makeTranscriptState(currentWorktreePath, originalCwd, {
          pendingOwnerReleasePath: currentWorktreePath,
        }),
        'session-1',
      ),
    ).rejects.toThrow('cannot target the current worktree');

    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
  });

  it('requires same-repository identity for a handoff from a hook worktree', async () => {
    const currentWorktreePath = path.dirname(path.dirname(worktreePath));
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    await fs.mkdir(previousWorktreePath, { recursive: true });
    const canonicalPreviousWorktreePath = await fs.realpath(
      previousWorktreePath,
    );
    const sourceCommonDir = path.join(temporaryRoot, 'repo', '.git');
    const unrelatedCommonDir = path.join(temporaryRoot, 'other-repo', '.git');
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) =>
      cwd === canonicalPreviousWorktreePath
        ? {
            worktreeRoot: canonicalPreviousWorktreePath,
            gitDir: path.join(unrelatedCommonDir, 'worktrees', 'feature'),
            commonDir: unrelatedCommonDir,
            isWorktree: true,
          }
        : {
            worktreeRoot:
              cwd === originalCwd
                ? path.join(temporaryRoot, 'repo')
                : currentWorktreePath,
            gitDir: sourceCommonDir,
            commonDir: sourceCommonDir,
            isWorktree: cwd !== originalCwd,
          },
    );

    await expect(
      releasePersistedWorktreeOwnerHandoff(
        makeTranscriptState(currentWorktreePath, originalCwd, {
          hookBased: true,
          pendingOwnerReleasePath: canonicalPreviousWorktreePath,
        }),
        'session-1',
      ),
    ).rejects.toThrow('different Git repository');

    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
  });

  it.each(['released', 'already-released'] as const)(
    'completes a persisted owner handoff during resume when the previous owner is %s',
    async (handoffOutcome) => {
      const { config, state } = createRuntimeConfig(originalCwd);
      const record = vi.fn().mockResolvedValue(undefined);
      const previousWorktreePath = path.join(
        temporaryRoot,
        'previous-worktree',
      );
      const stateToRestore = makeTranscriptState(
        path.dirname(path.dirname(worktreePath)),
        originalCwd,
        {
          worktreeCwd: worktreePath,
          pendingOwnerReleasePath: previousWorktreePath,
        },
      );
      vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
        handoffOutcome,
      );

      await expect(
        worktreeSessionService.restore(
          {
            config,
            sessionId: 'session-1',
            phase: 'restore',
            recordWorktreeState: record,
          },
          stateToRestore,
        ),
      ).resolves.toMatchObject({ status: 'restored' });

      expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
        previousWorktreePath,
        'session-1',
        originalCwd,
      );
      expect(state.worktreeSettings).not.toHaveProperty(
        'pendingOwnerReleasePath',
      );
      expect(record).toHaveBeenLastCalledWith(
        expect.not.objectContaining({
          pendingOwnerReleasePath: expect.any(String),
        }),
      );
    },
  );

  it('rejects a persisted handoff that points back to the current worktree', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockResolvedValue(undefined);
    const currentWorktreePath = path.dirname(path.dirname(worktreePath));

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(currentWorktreePath, originalCwd, {
          worktreeCwd: worktreePath,
          pendingOwnerReleasePath: currentWorktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a persisted handoff targeting a linked worktree from another repository', async () => {
    const unrelatedWorktreePath = path.join(
      temporaryRoot,
      'other-worktree',
    );
    await fs.mkdir(unrelatedWorktreePath, { recursive: true });
    const unrelatedWorktree = await fs.realpath(unrelatedWorktreePath);
    const unrelatedCommonDir = path.join(temporaryRoot, 'other-repo', '.git');
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) =>
      cwd === unrelatedWorktree
        ? {
            worktreeRoot: unrelatedWorktree,
            gitDir: path.join(unrelatedCommonDir, 'worktrees', 'feature'),
            commonDir: unrelatedCommonDir,
            isWorktree: true,
          }
        : {
            worktreeRoot:
              cwd === originalCwd
                ? path.join(temporaryRoot, 'repo')
                : path.dirname(path.dirname(worktreePath)),
            gitDir: path.join(temporaryRoot, 'repo', '.git'),
            commonDir: path.join(temporaryRoot, 'repo', '.git'),
            isWorktree: cwd !== originalCwd,
          },
    );
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(
          path.dirname(path.dirname(worktreePath)),
          originalCwd,
          {
            worktreeCwd: worktreePath,
            pendingOwnerReleasePath: unrelatedWorktree,
          },
        ),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

});
