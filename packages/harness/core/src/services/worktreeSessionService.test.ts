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
import { FatalConfigError } from '../utils/errors.js';
import {
  cleanupCreatedWorktreeForSession,
  createWorktreeForSession,
  findProjectRootForWorktree,
  resolveExistingWorktreeForSession,
  WorktreeRepositoryNotFoundError,
} from './worktreeService.js';
import {
  recordInitialWorktreeTranscriptState,
  toAttachedForkWorktreeSession,
  toTranscriptWorktreeSession,
  worktreeSessionService,
} from './worktreeSessionService.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

vi.mock('./worktreeService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktreeService.js')>();
  return {
    ...actual,
    cleanupCreatedWorktreeForSession: vi.fn(),
    createWorktreeForSession: vi.fn(),
    cleanupWorktreeSession: vi.fn(),
    countWorktreeChanges: vi.fn(),
    findProjectRootForWorktree: vi.fn(),
    resolveExistingWorktreeForSession: vi.fn(),
  };
});

// 本组只验证映射与创建失败补偿；跨进程预占由真实 Git 集成用例覆盖。
vi.mock('./worktree/creationReservation.js', () => ({
  addWorktreeReservation: async () => {},
}));

describe('Worktree transcript state projection', () => {
  it('uses the startup base SHA and keeps worktreeCwd', () => {
    expect(
      toTranscriptWorktreeSession(
        {
          name: 'feature-x',
          path: '/workspace/demo/.qwen/worktrees/feature-x',
          worktreeCwd:
            '/workspace/demo/.qwen/worktrees/feature-x/apps/desktop',
          baseSha: 'startup-base-sha',
          originalCwd: '/workspace/demo',
          lifecycle: 'owner',
        },
        'session-wt-1',
      ),
    ).toMatchObject({
      originalHeadCommit: 'startup-base-sha',
      sessionId: 'session-wt-1',
      worktreeCwd:
        '/workspace/demo/.qwen/worktrees/feature-x/apps/desktop',
    });
  });

  it('omits a clean baseline that is unavailable', () => {
    expect(
      toTranscriptWorktreeSession(
        {
          name: 'hook-worktree',
          path: '/workspace/hook-worktree',
          worktreeCwd: '/workspace/hook-worktree/apps/desktop',
          baseSha: '',
          originalCwd: '/workspace/demo',
          lifecycle: 'owner',
          hookBased: true,
        },
        'session-wt-1',
      ),
    ).not.toHaveProperty('originalHeadCommit');
  });

  it('keeps a pending owner release marker in the transcript state', () => {
    expect(
      toTranscriptWorktreeSession(
        {
          name: 'feature-b',
          path: '/workspace/demo/.qwen/worktrees/feature-b',
          worktreeCwd:
            '/workspace/demo/.qwen/worktrees/feature-b/apps/desktop',
          baseSha: 'startup-base-sha',
          originalCwd: '/workspace/demo',
          lifecycle: 'owner',
          pendingOwnerReleasePath:
            '/workspace/demo/.qwen/worktrees/feature-a',
        },
        'session-wt-1',
      ),
    ).toMatchObject({
      pendingOwnerReleasePath:
        '/workspace/demo/.qwen/worktrees/feature-a',
    });
  });

  it('keeps worktreeCwd but downgrades a fork to attached', () => {
    expect(
      toAttachedForkWorktreeSession(
        {
          name: 'feature-x',
          path: '/workspace/demo/.qwen/worktrees/feature-x',
          worktreeCwd:
            '/workspace/demo/.qwen/worktrees/feature-x/apps/desktop',
          baseSha: 'abc123def',
          originalCwd: '/workspace/demo/apps/desktop',
          lifecycle: 'owner',
          sessionId: 'source-session',
        },
        'fork-session',
      ),
    ).toMatchObject({
      sessionId: 'fork-session',
      lifecycle: 'attached',
      worktreeCwd:
        '/workspace/demo/.qwen/worktrees/feature-x/apps/desktop',
    });
  });

  it('records explicit null for a new ordinary session', async () => {
    const recordWorktreeState = vi.fn().mockResolvedValue(undefined);

    await recordInitialWorktreeTranscriptState(
      {
        getSessionId: () => 'session-plain-1',
        getWorktreeSettings: () => undefined,
      },
      { recordWorktreeState },
    );

    expect(recordWorktreeState).toHaveBeenCalledWith(null);
  });
});

describe('WorktreeSessionService.prepare', () => {
  let temporaryRoot: string;
  let checkoutRoot: string;
  let worktreePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-prepare-'));
    checkoutRoot = path.join(temporaryRoot, 'repo');
    worktreePath = path.join(temporaryRoot, 'worktree');
    await fs.mkdir(path.join(checkoutRoot, 'apps', 'desktop'), {
      recursive: true,
    });
    await fs.mkdir(path.join(worktreePath, 'apps', 'desktop'), {
      recursive: true,
    });
    vi.mocked(findProjectRootForWorktree).mockResolvedValue(checkoutRoot);
    vi.mocked(createWorktreeForSession).mockResolvedValue({
      worktreePath,
      worktreeName: 'feature',
      originalHeadCommit: 'base-sha',
      created: false,
    });
    vi.mocked(resolveExistingWorktreeForSession).mockResolvedValue({
      worktreePath,
      worktreeName: 'feature',
      originalHeadCommit: 'base-sha',
      enteredExisting: true,
      created: false,
    });
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates from the checkout root and uses the worktree root as worktreeCwd', async () => {
    const prepared = await worktreeSessionService.prepare(
      { sessionId: 'session-1' },
      {
        kind: 'create',
        name: 'feature',
        originalCwd: checkoutRoot,
        projectRoot: checkoutRoot,
      },
    );

    expect(prepared.settings.worktreeCwd).toBe(await fs.realpath(worktreePath));
  });

  it('uses the canonical checkout root for creation and maps a project subdirectory', async () => {
    const originalCwd = path.join(checkoutRoot, 'apps', 'desktop');

    const prepared = await worktreeSessionService.prepare(
      { sessionId: 'session-1' },
      {
        kind: 'create',
        name: 'feature',
        originalCwd,
        projectRoot: originalCwd,
      },
    );

    expect(createWorktreeForSession).toHaveBeenCalledWith(
      'feature',
      await fs.realpath(checkoutRoot),
      undefined,
      undefined,
      originalCwd,
    );
    expect(prepared.settings.worktreeCwd).toBe(
      await fs.realpath(path.join(worktreePath, 'apps', 'desktop')),
    );
    expect(prepared.settings.path).toBe(await fs.realpath(worktreePath));
  });

  it('falls back to the requested project directory for non-Git hook creation', async () => {
    vi.mocked(findProjectRootForWorktree).mockResolvedValue(undefined);
    const actual = await vi.importActual<typeof import('./worktreeService.js')>(
      './worktreeService.js',
    );
    vi.mocked(createWorktreeForSession).mockImplementationOnce(
      actual.createWorktreeForSession,
    );
    const createHookAdapter = {
      hasWorktreeCreateHook: () => true,
      executeWorktreeCreateHook: async () => ({ worktreePath }),
    };

    const prepared = await worktreeSessionService.prepare(
      { sessionId: 'session-hook', createHookAdapter },
      {
        kind: 'create',
        name: 'feature',
        originalCwd: checkoutRoot,
        projectRoot: checkoutRoot,
      },
    );

    expect(prepared.created).toBe(true);
    expect(prepared.settings).toMatchObject({
      hookBased: true,
      worktreeCwd: await fs.realpath(worktreePath),
      originalCwd: checkoutRoot,
    });
  });

  it('rejects non-Git creation when no WorktreeCreate hook is configured', async () => {
    vi.mocked(findProjectRootForWorktree).mockResolvedValue(undefined);

    const preparation = worktreeSessionService.prepare(
      { sessionId: 'session-no-git' },
      {
        kind: 'create',
        name: 'feature',
        originalCwd: checkoutRoot,
        projectRoot: checkoutRoot,
      },
    );

    await expect(preparation).rejects.toBeInstanceOf(
      WorktreeRepositoryNotFoundError,
    );
    await expect(preparation).rejects.toBeInstanceOf(FatalConfigError);
  });

  it('rejects an original cwd outside the source checkout', async () => {
    await expect(
      worktreeSessionService.prepare(
        { sessionId: 'session-1' },
        {
          kind: 'create',
          name: 'feature',
          originalCwd: temporaryRoot,
          projectRoot: checkoutRoot,
        },
      ),
    ).rejects.toThrow(/outside the source checkout/);
  });

  it('rejects a corresponding path that resolves outside the worktree', async () => {
    const outsideDirectory = path.join(temporaryRoot, 'outside');
    await fs.mkdir(path.join(outsideDirectory, 'desktop'), { recursive: true });
    await fs.rm(path.join(worktreePath, 'apps'), {
      recursive: true,
      force: true,
    });
    await fs.symlink(outsideDirectory, path.join(worktreePath, 'apps'));

    await expect(
      worktreeSessionService.prepare(
        { sessionId: 'session-1' },
        {
          kind: 'create',
          name: 'feature',
          originalCwd: path.join(checkoutRoot, 'apps', 'desktop'),
          projectRoot: checkoutRoot,
        },
      ),
    ).rejects.toThrow(/resolves outside the worktree/);
  });

  it('rejects a missing corresponding project directory', async () => {
    await fs.rm(path.join(worktreePath, 'apps'), {
      recursive: true,
      force: true,
    });

    await expect(
      worktreeSessionService.prepare(
        { sessionId: 'session-1' },
        {
          kind: 'create',
          name: 'feature',
          originalCwd: path.join(checkoutRoot, 'apps', 'desktop'),
          projectRoot: checkoutRoot,
        },
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('compensates a newly created worktree when its mapped project directory is missing', async () => {
    vi.mocked(createWorktreeForSession).mockResolvedValue({
      worktreePath,
      worktreeName: 'feature',
      originalHeadCommit: 'base-sha',
      created: true,
    });
    await fs.rm(path.join(worktreePath, 'apps'), {
      recursive: true,
      force: true,
    });

    await expect(
      worktreeSessionService.prepare(
        { sessionId: 'session-1' },
        {
          kind: 'create',
          name: 'feature',
          originalCwd: path.join(checkoutRoot, 'apps', 'desktop'),
          projectRoot: checkoutRoot,
        },
      ),
    ).rejects.toThrow(/does not exist/);

    expect(cleanupCreatedWorktreeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: await fs.realpath(worktreePath),
      }),
      await fs.realpath(checkoutRoot),
      undefined,
    );
  });

  it('preserves the source context and never claims creation when attaching', async () => {
    const activeWorktreeSettings = {
      name: 'current',
      path: path.join(temporaryRoot, 'current-worktree'),
      worktreeCwd: path.join(temporaryRoot, 'current-worktree'),
      baseSha: 'base-sha',
    };

    const prepared = await worktreeSessionService.prepare(
      { sessionId: 'session-attach', activeWorktreeSettings },
      {
        kind: 'attach',
        path: worktreePath,
        originalCwd: checkoutRoot,
        launchRoot: checkoutRoot,
      },
    );

    expect(resolveExistingWorktreeForSession).toHaveBeenCalledWith(
      'session-attach',
      worktreePath,
      checkoutRoot,
      activeWorktreeSettings,
      checkoutRoot,
    );
    expect(prepared.created).toBe(false);
    expect(prepared.settings).toMatchObject({
      originalCwd: checkoutRoot,
      worktreeCwd: await fs.realpath(worktreePath),
      enteredExisting: true,
    });
  });
});
