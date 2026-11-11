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
  readWorktreeBaseCommit,
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
import { resetForTest, setCwdChangedCallback } from '../utils/Shell.js';
import type { WorktreeSettings } from './worktree/contracts.js';

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

describe('WorktreeSessionService.leave', () => {
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
    vi.mocked(readWorktreeBaseCommit).mockResolvedValue('durable-base');
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

  it('does not clear an unresolved owner handoff while leaving a worktree', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = {
      ...makeActiveWorktreeSettings(worktreePath, originalCwd),
      pendingOwnerReleasePath: path.join(temporaryRoot, 'previous-worktree'),
    };
    state.worktreeSettings = settings;
    const record = vi.fn().mockResolvedValue(undefined);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'unavailable',
    );
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(/owner handoff/i);

    expect(record).not.toHaveBeenCalledWith(null);
    expect(state.worktreeSettings).toBe(settings);
  });

  it('does not finalize a worktree while an owner handoff is unresolved', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    state.worktreeSettings = {
      ...makeActiveWorktreeSettings(worktreePath, originalCwd),
      pendingOwnerReleasePath: path.join(temporaryRoot, 'previous-worktree'),
    };
    const record = vi.fn().mockResolvedValue(undefined);
    vi.mocked(releaseWorktreeOwnershipForHandoff).mockResolvedValue(
      'unavailable',
    );

    await expect(
      worktreeSessionService.finalize(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(/owner handoff/i);

    expect(record).not.toHaveBeenCalledWith(null);
  });

  it('leaves with keep by returning to the original runtime and persisting null without deleting the checkout', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi.fn().mockResolvedValue(undefined);
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'keep' },
      ),
    ).resolves.toMatchObject({ action: 'keep', worktreePath: settings.path });

    expect(cleanupWorktreeSession).not.toHaveBeenCalled();
    expect(state.worktreeSettings).toBeUndefined();
    expect(state.workingDir).toBe(originalCwd);
    expect(record).toHaveBeenCalledWith(null);
    expect(releaseWorktreeOwnership).toHaveBeenCalledWith(
      settings.path,
      'session-1',
      false,
    );
  });

  it('leaves with remove only after clean ownership validation, then persists null', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi.fn().mockResolvedValue(undefined);
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'remove', force: false },
      ),
    ).resolves.toMatchObject({ action: 'remove', worktreePath: settings.path });

    expect(countWorktreeChanges).toHaveBeenCalledWith(
      settings.path,
      'durable-base',
    );
    expect(cleanupWorktreeSession).toHaveBeenCalledWith(
      {
        worktreeSettings: settings,
        currentSessionId: 'session-1',
        force: false,
      },
      undefined,
    );
    expect(state.worktreeSettings).toBeUndefined();
    expect(record).toHaveBeenCalledWith(null);
  });

  it('fails closed for an attached worktree before writing or deleting', async () => {
    const { config, state } = createRuntimeConfig(worktreePath);
    const settings = {
      ...makeActiveWorktreeSettings(worktreePath, originalCwd),
      lifecycle: 'attached' as const,
      sessionId: undefined,
    };
    state.worktreeSettings = settings;
    const record = vi.fn();

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'remove', force: true },
      ),
    ).rejects.toThrow(/owner/i);

    expect(record).not.toHaveBeenCalled();
    expect(cleanupWorktreeSession).not.toHaveBeenCalled();
  });

  it('rolls keep runtime state back when the null state cannot be persisted', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(state.worktreeSettings).toBe(settings);
    expect(state.workingDir).toBe(worktreePath);
    expect(process.cwd()).toBe(worktreePath);
  });

  it('retains FileHistory snapshots when keep persistence fails', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    const manager = new FileHistoryManager({
      cwd: worktreePath,
      sessionId: 'session-1',
    });
    await manager.makeSnapshot('before-keep');
    state.worktreeSettings = settings;
    state.fileHistoryManager = manager;
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(manager.getSnapshots()).toMatchObject([
      { messageId: 'before-keep', cwd: worktreePath },
    ]);
  });

  it('does not notify the owning session when keep persistence fails', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const observer = vi.mocked(config.getHookSystem()!.onCwdChanged);
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: vi
            .fn()
            .mockRejectedValue(new Error('JSONL unavailable')),
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(/JSONL unavailable/);

    expect(observer).not.toHaveBeenCalled();
  });

  it('restores worktree runtime and state if removal is rejected after recording exit intent', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi.fn().mockResolvedValue(undefined);
    vi.mocked(cleanupWorktreeSession).mockResolvedValue({
      removed: false,
      reason: 'cleanup-failed',
      message: 'git refused',
    });
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'remove', force: false },
      ),
    ).rejects.toThrow(/git refused/);

    expect(state.worktreeSettings).toBe(settings);
    expect(state.workingDir).toBe(worktreePath);
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pendingExit: true }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ worktreeCwd: worktreePath }),
    );
  });

  it('preserves recoverable exit intent when removal and rollback persistence both fail', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('state recovery unavailable'));
    vi.mocked(cleanupWorktreeSession).mockResolvedValue({
      removed: false,
      reason: 'cleanup-failed',
      message: 'remove hook failed',
    });
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'remove', force: false },
      ),
    ).rejects.toThrow(/remove hook failed.*state recovery unavailable/);

    expect(state.worktreeSettings).toBe(settings);
    expect(state.workingDir).toBe(worktreePath);
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pendingExit: true }),
    );
    expect(releaseWorktreeOwnership).not.toHaveBeenCalled();
  });

  it('does not inspect Git changes when worktree runtime paths are invalid', async () => {
    const { config, state } = createRuntimeConfig(worktreePath);
    state.worktreeSettings = {
      ...makeActiveWorktreeSettings(worktreePath, originalCwd),
      worktreeCwd: originalCwd,
    };
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      worktreeSessionService.finalize(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'inspect' },
      ),
    ).resolves.toMatchObject({
      action: 'inspect',
      changedFiles: null,
      commits: null,
      owner: false,
    });

    expect(countWorktreeChanges).not.toHaveBeenCalled();
  });

  it('keeps the checkout recoverable when owner release and rollback persistence both fail', async () => {
    const { config, state } = createRuntimeConfig(worktreePath, [worktreePath]);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('state recovery unavailable'));
    vi.mocked(releaseWorktreeOwnership).mockResolvedValue(false);
    resetForTest(worktreePath);
    process.chdir(worktreePath);

    await expect(
      worktreeSessionService.leave(
        {
          config,
          sessionId: 'session-1',
          phase: 'runtime',
          recordWorktreeState: record,
        },
        { action: 'keep' },
      ),
    ).rejects.toThrow(
      /Failed to release worktree ownership.*state recovery unavailable/,
    );

    expect(state.worktreeSettings).toBe(settings);
    expect(state.workingDir).toBe(worktreePath);
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pendingExit: true }),
    );
  });

  it('keeps finalized worktree state, inspects without side effects, and clears state only after finalize remove', async () => {
    const { config, state } = createRuntimeConfig(worktreePath);
    const settings = makeActiveWorktreeSettings(worktreePath, originalCwd);
    state.worktreeSettings = settings;
    const record = vi.fn().mockResolvedValue(undefined);
    const context = {
      config,
      sessionId: 'session-1',
      phase: 'runtime' as const,
      recordWorktreeState: record,
    };

    await expect(
      worktreeSessionService.finalize(context, { action: 'inspect' }),
    ).resolves.toMatchObject({
      action: 'inspect',
      changedFiles: 0,
      commits: 0,
    });
    expect(record).not.toHaveBeenCalled();
    expect(cleanupWorktreeSession).not.toHaveBeenCalled();

    await expect(
      worktreeSessionService.finalize(context, { action: 'keep' }),
    ).resolves.toMatchObject({ action: 'keep' });
    expect(record).not.toHaveBeenCalled();

    await expect(
      worktreeSessionService.finalize(context, {
        action: 'remove',
        force: false,
      }),
    ).resolves.toMatchObject({ action: 'remove' });
    expect(record).toHaveBeenCalledWith(null);
    expect(state).toMatchObject({
      targetDir: originalCwd,
      workingDir: originalCwd,
      worktreeSettings: undefined,
    });
    expect(process.cwd()).toBe(originalCwd);
  });
});
