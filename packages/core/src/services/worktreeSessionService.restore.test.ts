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

describe('WorktreeSessionService.restore', () => {
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
          : path.dirname(path.dirname(worktreePath)),
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

  it('restores a new state from worktreeCwd and verifies durable owner metadata', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockResolvedValue(undefined);
    const stateToRestore = makeTranscriptState(path.dirname(path.dirname(worktreePath)), originalCwd, {
      worktreeCwd: worktreePath,
    });

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

    expect(inspectWorktreeOwnership).toHaveBeenCalledWith(
      path.dirname(path.dirname(worktreePath)),
      'session-1',
      false,
    );
    expect(state.worktreeSettings).toMatchObject({
      worktreeCwd: worktreePath,
      lifecycle: 'owner',
    });
    expect(process.cwd()).toBe(worktreePath);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeCwd: worktreePath }),
    );
  });
  it('restores an attached worktree and settles its previous owner handoff without gaining delete authority', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockResolvedValue(undefined);
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    vi.mocked(isWorktreeOwnedBySession).mockResolvedValue(false);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'released',
    );

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
            lifecycle: 'attached',
            enteredExisting: true,
            pendingOwnerReleasePath: previousWorktreePath,
          },
        ),
      ),
    ).resolves.toMatchObject({ status: 'restored' });

    expect(state.worktreeSettings).toMatchObject({
      lifecycle: 'attached',
      enteredExisting: true,
    });
    expect(state.worktreeSettings?.sessionId).toBeUndefined();
    expect(state.worktreeSettings).not.toHaveProperty(
      'pendingOwnerReleasePath',
    );
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: 'attached' }),
    );
  });

  it('retries an attached handoff after its stable-state confirmation cannot be persisted', async () => {
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    const stateToRestore = makeTranscriptState(
      path.dirname(path.dirname(worktreePath)),
      originalCwd,
      {
        worktreeCwd: worktreePath,
        lifecycle: 'attached',
        enteredExisting: true,
        pendingOwnerReleasePath: previousWorktreePath,
      },
    );
    vi.mocked(isWorktreeOwnedBySession).mockResolvedValue(false);
    vi.mocked(releaseWorktreeOwnershipForHandoff)
      .mockResolvedValueOnce('released')
      .mockResolvedValueOnce('already-released');
    const firstRuntime = createRuntimeConfig(originalCwd);

    await expect(
      worktreeSessionService.restore(
        {
          config: firstRuntime.config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        stateToRestore,
      ),
    ).rejects.toThrow(/owner handoff/i);

    const retryRuntime = createRuntimeConfig(originalCwd);
    await expect(
      worktreeSessionService.restore(
        {
          config: retryRuntime.config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: vi.fn().mockResolvedValue(undefined),
        },
        stateToRestore,
      ),
    ).resolves.toMatchObject({ status: 'restored' });
    expect(retryRuntime.state.worktreeSettings).toMatchObject({
      lifecycle: 'attached',
    });
    expect(retryRuntime.state.worktreeSettings).not.toHaveProperty(
      'pendingOwnerReleasePath',
    );
  });

  it('rejects a path that now belongs to a different Git repository', async () => {
    const worktreeRoot = path.dirname(path.dirname(worktreePath));
    const sourceCommonDir = path.join(temporaryRoot, 'repo', '.git');
    const replacementCommonDir = path.join(temporaryRoot, 'replacement', '.git');
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) =>
      cwd === originalCwd
        ? {
            worktreeRoot: path.join(temporaryRoot, 'repo'),
            gitDir: sourceCommonDir,
            commonDir: sourceCommonDir,
            isWorktree: false,
          }
        : {
            worktreeRoot,
            gitDir: path.join(replacementCommonDir, 'worktrees', 'feature'),
            commonDir: replacementCommonDir,
            isWorktree: true,
          },
    );
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn();

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(worktreeRoot, originalCwd, {
          worktreeCwd: worktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a hook checkout whose durable origin belongs to another project', async () => {
    const worktreeRoot = path.dirname(path.dirname(worktreePath));
    vi.mocked(readWorktreeOwnerState).mockResolvedValue({
      version: 1,
      ownerSessionId: 'another-session',
      originalCwd: path.join(temporaryRoot, 'another-project'),
    });
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn();

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(worktreeRoot, originalCwd, {
          worktreeCwd: worktreePath,
          hookBased: true,
          lifecycle: 'attached',
          enteredExisting: true,
        }),
      ),
    ).resolves.toMatchObject({ status: 'failed' });

    expect(state.workingDir).toBe(originalCwd);
    expect(record).not.toHaveBeenCalled();
  });

  it('rejects a Git-managed worktree when repository identity cannot be resolved', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn();
    vi.mocked(resolveGitRepositoryLayout).mockResolvedValue(null);

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(path.dirname(path.dirname(worktreePath)), originalCwd, {
          worktreeCwd: worktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not treat an unresolved source repository itself as a nested repository', async () => {
    const sourceRoot = await fs.realpath(path.join(temporaryRoot, 'repo'));
    const worktreeRoot = path.dirname(path.dirname(worktreePath));
    vi.mocked(resolveGitRepositoryLayout).mockImplementation(async (cwd) =>
      cwd === sourceRoot
        ? null
        : {
            worktreeRoot,
            gitDir: path.join(sourceRoot, '.git', 'worktrees', 'feature'),
            commonDir: path.join(sourceRoot, '.git'),
            isWorktree: true,
          },
    );
    const { config, state } = createRuntimeConfig(sourceRoot);
    const record = vi.fn();
    const result = await worktreeSessionService.restore(
      {
        config,
        sessionId: 'session-1',
        phase: 'restore',
        recordWorktreeState: record,
      },
      makeTranscriptState(worktreeRoot, sourceRoot, {
        worktreeCwd: worktreePath,
      }),
    );
    expect(result).toMatchObject({ status: 'failed' });
    expect(state.workingDir).toBe(sourceRoot);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not downgrade to originalCwd when the persisted worktree cannot be accessed', async () => {
    const worktreeRoot = path.dirname(path.dirname(worktreePath));
    vi.mocked(fs.stat).mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn();

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(worktreeRoot, originalCwd, {
          worktreeCwd: worktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('permission denied'),
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(record).not.toHaveBeenCalled();
  });

  it('downgrades a restore owner claim to attached when durable metadata does not match', async () => {
    vi.mocked(inspectWorktreeOwnership).mockResolvedValue('not-owned');
    const { config, state } = createRuntimeConfig(originalCwd);

    await worktreeSessionService.restore(
      {
        config,
        sessionId: 'session-1',
        phase: 'restore',
        recordWorktreeState: vi.fn(),
      },
      makeTranscriptState(path.dirname(path.dirname(worktreePath)), originalCwd, {
        worktreeCwd: worktreePath,
      }),
    );

    expect(state.worktreeSettings).toMatchObject({ lifecycle: 'attached' });
    expect(state.worktreeSettings?.sessionId).toBeUndefined();
  });

  it('derives a legacy worktree cwd from the original relative project path', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const stateToRestore = makeTranscriptState(path.dirname(path.dirname(worktreePath)), originalCwd, {
      worktreeCwd: undefined,
    });

    await worktreeSessionService.restore(
      {
        config,
        sessionId: 'session-1',
        phase: 'restore',
        recordWorktreeState: vi.fn(),
      },
      stateToRestore,
    );

    expect(state.worktreeSettings?.worktreeCwd).toBe(worktreePath);
  });

  it('falls back to the worktree root when legacy relative mapping no longer exists', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const root = path.dirname(path.dirname(worktreePath));
    await fs.rm(path.join(root, 'apps'), { recursive: true, force: true });
    const stateToRestore = makeTranscriptState(root, originalCwd, {
      worktreeCwd: undefined,
    });

    await worktreeSessionService.restore(
      {
        config,
        sessionId: 'session-1',
        phase: 'restore',
        recordWorktreeState: vi.fn(),
      },
      stateToRestore,
    );

    expect(state.worktreeSettings?.worktreeCwd).toBe(root);
  });

  it('falls back to the original ordinary session when the persisted worktree is missing', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const missingWorktree = path.join(temporaryRoot, 'missing-worktree');
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(missingWorktree, originalCwd, {
          worktreeCwd: missingWorktree,
        }),
      ),
    ).resolves.toEqual({ status: 'fallback' });

    expect(state).toMatchObject({
      targetDir: originalCwd,
      workingDir: originalCwd,
      worktreeSettings: undefined,
    });
    expect(record).toHaveBeenCalledWith(null, true);
  });

  it('keeps a missing worktree transcript recoverable when its previous owner handoff is unresolved', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const missingWorktree = path.join(temporaryRoot, 'missing-worktree');
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    const record = vi.fn().mockResolvedValue(undefined);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'unavailable',
    );

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(missingWorktree, originalCwd, {
          worktreeCwd: missingWorktree,
          pendingOwnerReleasePath: previousWorktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not discard a missing worktree transcript with an invalid owner handoff', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const missingWorktree = path.join(temporaryRoot, 'missing-worktree');
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    await fs.mkdir(previousWorktreePath, { recursive: true });
    const canonicalPreviousWorktreePath = await fs.realpath(previousWorktreePath);
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
                : path.dirname(path.dirname(worktreePath)),
            gitDir: path.join(temporaryRoot, 'repo', '.git'),
            commonDir: path.join(temporaryRoot, 'repo', '.git'),
            isWorktree: cwd !== originalCwd,
          },
    );
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(missingWorktree, originalCwd, {
          worktreeCwd: missingWorktree,
          pendingOwnerReleasePath: canonicalPreviousWorktreePath,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(state.workingDir).toBe(originalCwd);
    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('falls back after a missing worktree only when its previous owner handoff is already complete', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const missingWorktree = path.join(temporaryRoot, 'missing-worktree');
    const previousWorktreePath = path.join(
      temporaryRoot,
      'previous-worktree',
    );
    const record = vi.fn().mockResolvedValue(undefined);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'already-released',
    );

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(missingWorktree, originalCwd, {
          worktreeCwd: missingWorktree,
          pendingOwnerReleasePath: previousWorktreePath,
        }),
      ),
    ).resolves.toEqual({ status: 'fallback' });

    expect(state.workingDir).toBe(originalCwd);
    expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
      previousWorktreePath,
      'session-1',
      originalCwd,
    );
    expect(record).toHaveBeenCalledWith(null, true);
  });

  it('fails without guessing when both the worktree and original cwd are missing', async () => {
    const { config } = createRuntimeConfig(originalCwd);
    const missingWorktree = path.join(temporaryRoot, 'missing-worktree');
    const missingOriginalCwd = path.join(temporaryRoot, 'missing-original');
    const record = vi.fn();

    await expect(
      worktreeSessionService.restore(
        {
          config,
          sessionId: 'session-1',
          phase: 'restore',
          recordWorktreeState: record,
        },
        makeTranscriptState(missingWorktree, missingOriginalCwd, {
          worktreeCwd: missingWorktree,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
    });

    expect(record).not.toHaveBeenCalled();
  });
});
