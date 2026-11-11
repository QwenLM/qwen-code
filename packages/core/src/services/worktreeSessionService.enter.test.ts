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
  cleanupCreatedWorktreeForSession,
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
import { FileHistoryManager } from '../file-history/file-history.js';
import { resolveGitRepositoryLayout } from '../utils/gitUtils.js';
import {
  currentCwdForTest,
  getOriginalCwd,
  resetForTest,
  setCwdChangedCallback,
} from '../utils/Shell.js';
import type {
  PreparedWorktree,
  WorktreeSettings,
} from './worktree/contracts.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';

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

function makePreparedWorktree(
  worktreeCwd: string,
  originalCwd: string,
  sessionId = 'session-1',
  created = true,
): PreparedWorktree {
  const worktreePath = path.dirname(path.dirname(worktreeCwd));
  return {
    settings: {
      name: 'feature',
      path: worktreePath,
      worktreeCwd,
      baseSha: 'base-sha',
      originalCwd,
      worktreeBranch: 'worktree-feature',
      originalBranch: 'main',
      enteredExisting: !created,
    },
    created,
    preparedForSessionId: sessionId,
  } as PreparedWorktree;
}

function makeActiveWorktreeSettings(
  worktreeCwd: string,
  originalCwd: string,
): WorktreeSettings {
  return {
    name: 'feature',
    path: path.dirname(path.dirname(worktreeCwd)),
    worktreeCwd,
    baseSha: 'base-sha',
    lifecycle: 'owner',
    originalCwd,
    worktreeBranch: 'worktree-feature',
    originalBranch: 'main',
    sessionId: 'session-1',
  };
}

describe('WorktreeSessionService.enter', () => {
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

  it('claims the fresh owner, installs complete settings, switches to worktreeCwd, and persists before succeeding', async () => {
    const { config, state } = createRuntimeConfig(originalCwd, [
      originalCwd,
      path.join(temporaryRoot, 'shared'),
    ]);
    const record = vi.fn().mockResolvedValue(undefined);

    const settings = await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: record,
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(claimWorktreeOwnership).toHaveBeenCalledWith(
      path.dirname(path.dirname(worktreePath)),
      'session-1',
      undefined,
      'test-claim',
    );
    expect(settings).toMatchObject({
      path: path.dirname(path.dirname(worktreePath)),
      worktreeCwd: worktreePath,
      lifecycle: 'owner',
      sessionId: 'session-1',
    });
    expect(state).toMatchObject({
      targetDir: worktreePath,
      workingDir: worktreePath,
      worktreeSettings: settings,
    });
    expect(state.workspaceDirectories).toEqual([
      worktreePath,
      path.join(temporaryRoot, 'shared'),
    ]);
    expect(currentCwdForTest()).toBe(worktreePath);
    expect(getOriginalCwd()).toBe(worktreePath);
    expect(process.cwd()).toBe(worktreePath);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.dirname(path.dirname(worktreePath)),
        worktreeCwd: worktreePath,
        lifecycle: 'owner',
      }),
    );
  });

  it.each(['settled', 'owner-unavailable', 'confirmation-failed'] as const)(
    'preserves a pending exit until its owner and confirmation are settled before another enter: %s',
    async (outcome) => {
      const { config, state } = createRuntimeConfig(originalCwd);
      const pendingExit: TranscriptWorktreeSession = {
        sessionId: 'session-1',
        originalCwd,
        worktreePath: path.join(temporaryRoot, 'previous-worktree'),
        worktreeName: 'previous',
        lifecycle: 'owner',
        pendingExit: true,
      };
      await fs.mkdir(pendingExit.worktreePath);
      const sessionPath = config.getActiveSessionTranscriptPath();
      const appendState = async (
        worktreeSession: TranscriptWorktreeSession | null,
      ) => {
        await fs.appendFile(
          sessionPath,
          JSON.stringify({
            type: 'worktree-state',
            sessionId: 'session-1',
            worktreeSession,
          }) + '\n',
        );
      };
      await appendState(pendingExit);
      const record = vi.fn(
        async (worktreeSession: TranscriptWorktreeSession | null) => {
          if (worktreeSession === null && outcome === 'confirmation-failed') {
            throw new Error('Exit confirmation unavailable');
          }
          await appendState(worktreeSession);
        },
      );
      vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
        outcome === 'owner-unavailable' ? 'unavailable' : 'released',
      );

      const enter = worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        makePreparedWorktree(worktreePath, originalCwd),
      );
      if (outcome === 'settled') {
        await expect(enter).resolves.toMatchObject({
          worktreeCwd: worktreePath,
        });
        expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
          pendingExit.worktreePath,
          'session-1',
          originalCwd,
          false,
        );
        expect(record).toHaveBeenNthCalledWith(1, null, true);
      } else {
        await expect(enter).rejects.toThrow(/unavailable/i);
        const index = await config
          .getTranscriptStore()
          .repository()
          .loadIndex(sessionPath);
        expect(index?.metadata.worktreeSessions.get('session-1')).toEqual(
          pendingExit,
        );
        expect(state.worktreeSettings).toBeUndefined();
        expect(state.workingDir).toBe(originalCwd);
        expect(claimWorktreeOwnership).not.toHaveBeenCalled();
        expect(cleanupCreatedWorktreeForSession).toHaveBeenCalled();
      }
    },
  );

  it.each(['owned-by-another-session', 'unavailable'] as const)(
    'does not enter or compensate a checkout after an unsafe owner claim: %s',
    async (ownership) => {
      const { config, state } = createRuntimeConfig(originalCwd);
      vi.mocked(claimWorktreeOwnership).mockResolvedValue(ownership);
      const record = vi.fn();
      await expect(
        worktreeSessionService.enter(
          {
            config,
            sessionId: 'session-1',
            phase: 'runtime',
            recordWorktreeState: record,
          },
          makePreparedWorktree(worktreePath, originalCwd),
        ),
      ).rejects.toThrow(/ownership|owned by another/i);
      expect(state.workingDir).toBe(originalCwd);
      expect(record).toHaveBeenLastCalledWith(null);
      expect(cleanupCreatedWorktreeForSession).not.toHaveBeenCalled();
    },
  );

  it('preserves the original runtime and snapshots when process chdir fails', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const manager = new FileHistoryManager({
      cwd: originalCwd,
      sessionId: 'session-1',
    });
    await manager.makeSnapshot('before-entry');
    state.fileHistoryManager = manager;
    const chdir = vi.spyOn(process, 'chdir');
    chdir.mockImplementationOnce(() => {
      throw new Error('chdir failed');
    });
    const record = vi.fn();
    try {
      await expect(
        worktreeSessionService.enter(
          {
            config,
            sessionId: 'session-1',
            phase: 'runtime',
            recordWorktreeState: record,
          },
          makePreparedWorktree(worktreePath, originalCwd),
        ),
      ).rejects.toThrow(/chdir failed/);
      expect(state.workingDir).toBe(originalCwd);
      expect(state.worktreeSettings).toBeUndefined();
      expect(process.cwd()).toBe(originalCwd);
      expect(manager.getSnapshots()).toMatchObject([
        { messageId: 'before-entry', cwd: originalCwd },
      ]);
      expect(record).not.toHaveBeenCalled();
    } finally {
      chdir.mockRestore();
    }
  });

  it('notifies the owning session when entering a worktree', async () => {
    const { config } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockResolvedValue(undefined);
    const observer = vi.mocked(config.getHookSystem()!.onCwdChanged);

    await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: record,
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(observer).toHaveBeenCalledExactlyOnceWith(
      originalCwd,
      worktreePath,
    );
  });

  it('refreshes runtime-root-bound services after entering a worktree', async () => {
    const { config } = createRuntimeConfig(originalCwd);

    await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: vi.fn().mockResolvedValue(undefined),
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(config.refreshRuntimeWorkspaceServices).toHaveBeenCalledOnce();
  });

  it('removes a previous worktree and its nested workspace directories when entering another worktree', async () => {
    const previousWorktreeCwd = path.join(
      temporaryRoot,
      'previous-worktree',
      'apps',
      'desktop',
    );
    const previousNestedDirectory = path.join(previousWorktreeCwd, 'packages');
    const externalDirectory = path.join(temporaryRoot, 'shared');
    await fs.mkdir(previousNestedDirectory, { recursive: true });
    await fs.mkdir(externalDirectory, { recursive: true });
    const previousSettings = makeActiveWorktreeSettings(
      await fs.realpath(previousWorktreeCwd),
      originalCwd,
    );
    const canonicalPreviousNestedDirectory = await fs.realpath(
      previousNestedDirectory,
    );
    const canonicalExternalDirectory = await fs.realpath(externalDirectory);
    const { config, state } = createRuntimeConfig(previousSettings.worktreeCwd, [
      previousSettings.worktreeCwd,
      canonicalPreviousNestedDirectory,
      canonicalExternalDirectory,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousSettings.worktreeCwd);
    process.chdir(previousSettings.worktreeCwd);

    await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: vi.fn().mockResolvedValue(undefined),
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(state.workspaceDirectories).toEqual([
      worktreePath,
      canonicalExternalDirectory,
    ]);
  });

  it('rejects a prepared worktree from another session before changing runtime state', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-2',
          phase: 'runtime',
          recordWorktreeState: vi.fn(),
        },
        makePreparedWorktree(worktreePath, originalCwd, 'session-1'),
      ),
    ).rejects.toThrow(/different session/i);

    expect(claimWorktreeOwnership).not.toHaveBeenCalled();
    expect(state.workingDir).toBe(originalCwd);
    expect(process.cwd()).toBe(originalCwd);
  });

  it('rolls runtime state back without claiming ownership when immediate persistence fails', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const record = vi.fn().mockRejectedValue(new Error('JSONL unavailable'));

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(state).toMatchObject({
      targetDir: originalCwd,
      workingDir: originalCwd,
      worktreeSettings: undefined,
      workspaceDirectories: [originalCwd],
    });
    expect(currentCwdForTest()).toBe(originalCwd);
    expect(getOriginalCwd()).toBe(originalCwd);
    expect(process.cwd()).toBe(originalCwd);
    expect(claimWorktreeOwnership).not.toHaveBeenCalled();
    expect(releaseWorktreeOwnership).not.toHaveBeenCalled();
    expect(cleanupCreatedWorktreeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.dirname(path.dirname(worktreePath)),
      }),
      originalCwd,
      undefined,
    );
  });

  it('retains FileHistory snapshots when entry persistence fails', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const manager = new FileHistoryManager({
      cwd: originalCwd,
      sessionId: 'session-1',
    });
    await manager.makeSnapshot('before-entry');
    state.fileHistoryManager = manager;

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(manager.getSnapshots()).toMatchObject([
      { messageId: 'before-entry', cwd: originalCwd },
    ]);
  });

  it('reports partial success when ownership and rollback persistence both fail', async () => {
    const { config, state } = createRuntimeConfig(originalCwd);
    const observer = vi.mocked(config.getHookSystem()!.onCwdChanged);
    let persisted: TranscriptWorktreeSession | null = null;
    vi.mocked(claimWorktreeOwnership).mockResolvedValue('unavailable');
    const record = vi.fn(async (next: TranscriptWorktreeSession | null) => {
      if (!next) throw new Error('Rollback write unavailable');
      persisted = next;
    });
    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).resolves.toMatchObject({
      path: path.dirname(path.dirname(worktreePath)),
      entryWarning: expect.stringMatching(/checkout retained/i),
    });

    expect(persisted).toMatchObject({ worktreeCwd: worktreePath });
    expect(state.workingDir).toBe(worktreePath);
    expect(observer).toHaveBeenCalledWith(originalCwd, worktreePath);
    expect(releaseWorktreeOwnership).not.toHaveBeenCalled();
    expect(cleanupCreatedWorktreeForSession).not.toHaveBeenCalled();
  });

  it('does not notify the owning session when entry persistence fails', async () => {
    const { config } = createRuntimeConfig(originalCwd);
    const observer = vi.mocked(config.getHookSystem()!.onCwdChanged);

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(observer).not.toHaveBeenCalled();
  });

  it('writes the new worktree state with a pending previous owner before releasing it', async () => {
    const previousWorktreeDirectory = path.join(
      temporaryRoot,
      'previous-worktree',
      'apps',
      'desktop',
    );
    await fs.mkdir(previousWorktreeDirectory, { recursive: true });
    const previousWorktreeCwd = await fs.realpath(previousWorktreeDirectory);
    const previousSettings = makeActiveWorktreeSettings(
      previousWorktreeCwd,
      originalCwd,
    );
    const { config, state } = createRuntimeConfig(previousWorktreeCwd, [
      previousWorktreeCwd,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousWorktreeCwd);
    process.chdir(previousWorktreeCwd);
    const previousWorktreePath = previousSettings.path;
    const nextWorktreePath = path.dirname(path.dirname(worktreePath));
    const record = vi.fn().mockResolvedValue(undefined);

    const settings = await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: record,
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        worktreePath: nextWorktreePath,
        pendingOwnerReleasePath: previousWorktreePath,
      }),
    );
    expect(releaseWorktreeOwnershipForHandoff).toHaveBeenCalledWith(
      previousWorktreePath,
      'session-1',
      originalCwd,
    );
    expect(
      record.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(releaseWorktreeOwnershipForHandoff).mock
        .invocationCallOrder[0]!,
    );
    expect(record).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        pendingOwnerReleasePath: expect.any(String),
      }),
    );
    expect(settings).not.toHaveProperty('pendingOwnerReleasePath');
  });

  it('retains a durable handoff marker when the previous owner cannot be released', async () => {
    const previousWorktreeDirectory = path.join(
      temporaryRoot,
      'previous-worktree',
      'apps',
      'desktop',
    );
    await fs.mkdir(previousWorktreeDirectory, { recursive: true });
    const previousWorktreeCwd = await fs.realpath(previousWorktreeDirectory);
    const previousSettings = makeActiveWorktreeSettings(
      previousWorktreeCwd,
      originalCwd,
    );
    const { config, state } = createRuntimeConfig(previousWorktreeCwd, [
      previousWorktreeCwd,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousWorktreeCwd);
    process.chdir(previousWorktreeCwd);
    const previousWorktreePath = previousSettings.path;
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'unavailable',
    );
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).resolves.toMatchObject({
      pendingOwnerReleasePath: previousWorktreePath,
    });

    expect(state.worktreeSettings).toMatchObject({
      pendingOwnerReleasePath: previousWorktreePath,
    });
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pendingOwnerReleasePath: previousWorktreePath,
      }),
    );
  });

  it('keeps an existing destination worktree attached while persisting its previous owner handoff', async () => {
    const previousWorktreeDirectory = path.join(
      temporaryRoot,
      'previous-worktree',
      'apps',
      'desktop',
    );
    await fs.mkdir(previousWorktreeDirectory, { recursive: true });
    const previousWorktreeCwd = await fs.realpath(previousWorktreeDirectory);
    const previousSettings = makeActiveWorktreeSettings(
      previousWorktreeCwd,
      originalCwd,
    );
    const { config, state } = createRuntimeConfig(previousWorktreeCwd, [
      previousWorktreeCwd,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousWorktreeCwd);
    process.chdir(previousWorktreeCwd);
    vi.mocked(inspectWorktreeOwnership).mockImplementation(async (candidate) =>
      candidate === previousSettings.path ? 'owned-by-session' : 'not-owned',
    );
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'unavailable',
    );
    const record = vi.fn().mockResolvedValue(undefined);

    const settings = await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: record,
      },
      makePreparedWorktree(worktreePath, originalCwd, 'session-1', false),
    );

    expect(settings).toMatchObject({
      lifecycle: 'attached',
      pendingOwnerReleasePath: previousSettings.path,
    });
    expect(settings.sessionId).toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: 'attached',
        pendingOwnerReleasePath: previousSettings.path,
      }),
    );
  });

  it.each(['owner', 'attached'] as const)(
    'preserves an unresolved handoff when switching again from %s',
    async (lifecycle) => {
      const previousCwd = path.join(temporaryRoot, 'previous', 'apps', 'desktop');
      await fs.mkdir(previousCwd, { recursive: true });
      const { config, state } = createRuntimeConfig(previousCwd);
      const previous = {
        ...makeActiveWorktreeSettings(previousCwd, originalCwd),
        lifecycle,
        pendingOwnerReleasePath: path.join(temporaryRoot, 'older-worktree'),
      };
      state.worktreeSettings = previous;
      const record = vi.fn().mockResolvedValue(undefined);
      vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
        'unavailable',
      );
      await expect(
        worktreeSessionService.enter(
          {
            config,
            sessionId: 'session-1',
            phase: 'runtime',
            recordWorktreeState: record,
          },
          makePreparedWorktree(worktreePath, originalCwd),
        ),
      ).rejects.toThrow(/pending.*handoff/i);
      expect(state.worktreeSettings).toEqual(previous);
      expect(record).not.toHaveBeenCalled();
      expect(cleanupCreatedWorktreeForSession).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: path.dirname(path.dirname(worktreePath)),
        }),
        originalCwd,
        undefined,
      );
    },
  );

  it('settles the earlier handoff before committing another switch', async () => {
    const previousCwd = path.join(temporaryRoot, 'previous', 'apps', 'desktop');
    await fs.mkdir(previousCwd, { recursive: true });
    const { config, state } = createRuntimeConfig(previousCwd);
    const pendingPath = path.join(temporaryRoot, 'older');
    state.worktreeSettings = {
      ...makeActiveWorktreeSettings(previousCwd, originalCwd),
      pendingOwnerReleasePath: pendingPath,
    };
    const record = vi.fn().mockResolvedValue(undefined);
    await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: record,
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );
    expect(
      vi.mocked(releaseWorktreeOwnershipForHandoff).mock.calls.map(
        ([releasedPath]) => releasedPath,
      ),
    ).toEqual([pendingPath, path.dirname(path.dirname(previousCwd))]);
    expect(state.worktreeSettings).not.toHaveProperty(
      'pendingOwnerReleasePath',
    );
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreePath: state.worktreeSettings!.path }),
    );
  });

  it('allows switching away from a legacy hook checkout without inventing ownership', async () => {
    const previousWorktreeDirectory = path.join(
      temporaryRoot,
      'hook-worktree',
      'apps',
      'desktop',
    );
    await fs.mkdir(previousWorktreeDirectory, { recursive: true });
    const previousWorktreeCwd = await fs.realpath(previousWorktreeDirectory);
    const previousSettings: WorktreeSettings = {
      ...makeActiveWorktreeSettings(previousWorktreeCwd, originalCwd),
      hookBased: true,
    };
    const { config, state } = createRuntimeConfig(previousWorktreeCwd, [
      previousWorktreeCwd,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousWorktreeCwd);
    process.chdir(previousWorktreeCwd);
    vi.mocked(inspectWorktreeOwnership).mockResolvedValueOnce('not-owned');

    const settings = await worktreeSessionService.enter(
      {
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: vi.fn().mockResolvedValue(undefined),
      },
      makePreparedWorktree(worktreePath, originalCwd),
    );

    expect(settings.path).toBe(path.dirname(path.dirname(worktreePath)));
    expect(settings.pendingOwnerReleasePath).toBeUndefined();
    expect(releaseWorktreeOwnershipForHandoff).not.toHaveBeenCalled();
  });

  it('refuses a switch before claiming the destination when previous ownership cannot be verified', async () => {
    const previousWorktreeDirectory = path.join(
      temporaryRoot,
      'previous-worktree',
      'apps',
      'desktop',
    );
    await fs.mkdir(previousWorktreeDirectory, { recursive: true });
    const previousWorktreeCwd = await fs.realpath(previousWorktreeDirectory);
    const previousSettings = makeActiveWorktreeSettings(
      previousWorktreeCwd,
      originalCwd,
    );
    const { config, state } = createRuntimeConfig(previousWorktreeCwd, [
      previousWorktreeCwd,
    ]);
    state.worktreeSettings = previousSettings;
    resetForTest(previousWorktreeCwd);
    process.chdir(previousWorktreeCwd);
    vi.mocked(inspectWorktreeOwnership).mockResolvedValue('unavailable');
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.enter(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        makePreparedWorktree(worktreePath, originalCwd),
      ),
    ).rejects.toThrow(/verify previous worktree ownership/i);

    expect(claimWorktreeOwnership).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(state.worktreeSettings).toBe(previousSettings);
    expect(state.workingDir).toBe(previousWorktreeCwd);
  });
});
