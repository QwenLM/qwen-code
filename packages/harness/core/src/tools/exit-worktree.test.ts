/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { WorktreeSettings } from '../services/worktree/contracts.js';
import type {
  WorktreeSessionContext,
  WorktreeSessionService,
} from '../services/worktreeSessionService.js';
import { ExitWorktreeTool } from './exitWorktree.js';

describe('ExitWorktreeTool', () => {
  let config: Config;
  let service: WorktreeSessionService;
  let leave: ReturnType<typeof vi.fn>;
  let finalize: ReturnType<typeof vi.fn>;
  let recordWorktreeState: ReturnType<typeof vi.fn>;

  const settings: WorktreeSettings = {
    name: 'feature',
    path: '/repo/.qwen/worktrees/feature',
    worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
    baseSha: 'abc123',
    lifecycle: 'owner',
    originalCwd: '/repo/apps/desktop',
    worktreeBranch: 'worktree-feature',
    originalBranch: 'main',
    originalHeadCommit: 'abc123',
    sessionId: 'session-1',
  };

  beforeEach(() => {
    leave = vi.fn().mockResolvedValue({
      action: 'keep',
      worktreePath: settings.path,
      originalCwd: settings.originalCwd,
    });
    finalize = vi.fn().mockResolvedValue({
      action: 'inspect',
      changedFiles: 0,
      commits: 0,
      owner: true,
    });
    service = {
      prepare: vi.fn(),
      enter: vi.fn(),
      restore: vi.fn(),
      leave,
      finalize,
    } as unknown as WorktreeSessionService;
    recordWorktreeState = vi.fn().mockResolvedValue(undefined);
    config = {
      getWorktreeSettings: vi.fn().mockReturnValue(settings),
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      recordWorktreeState,
    } as unknown as Config;
  });

  function buildTool(): ExitWorktreeTool {
    return new ExitWorktreeTool(config, service);
  }

  it('returns info when no worktree session is active', async () => {
    vi.mocked(config.getWorktreeSettings).mockReturnValue(undefined);

    const result = await buildTool()
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('No active worktree session');
    expect(leave).not.toHaveBeenCalled();
  });

  it('does not guess a restore directory when originalCwd is missing', async () => {
    vi.mocked(config.getWorktreeSettings).mockReturnValue({
      ...settings,
      originalCwd: undefined,
    });

    const result = await buildTool()
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('does not record the directory');
    expect(leave).not.toHaveBeenCalled();
  });

  it('refuses to remove an attached worktree', async () => {
    vi.mocked(config.getWorktreeSettings).mockReturnValue({
      ...settings,
      lifecycle: 'attached',
      sessionId: undefined,
    });

    const result = await buildTool()
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('does not own the worktree');
    expect(leave).not.toHaveBeenCalled();
  });

  it('routes keep through leave with immediate persistence', async () => {
    const result = await buildTool()
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(leave).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: expect.any(Function),
      }),
      { action: 'keep' },
    );
    const context = leave.mock.calls[0][0] as WorktreeSessionContext;
    await expect(context.recordWorktreeState?.(null)).resolves.toBeUndefined();
    expect(recordWorktreeState).toHaveBeenCalledWith(null);
    expect(result.llmContent).toContain('preserved');
    expect(result.toolUseResult).toMatchObject({
      action: 'keep',
      originalCwd: settings.originalCwd,
      worktreePath: settings.path,
    });
  });

  it('allows an attached worktree to leave with keep', async () => {
    vi.mocked(config.getWorktreeSettings).mockReturnValue({
      ...settings,
      lifecycle: 'attached',
      sessionId: undefined,
      enteredExisting: true,
    });

    const result = await buildTool()
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(leave).toHaveBeenCalledWith(expect.anything(), { action: 'keep' });
  });

  it('reports incomplete cleanup when keeping a worktree', async () => {
    leave.mockResolvedValue({
      action: 'keep',
      worktreePath: settings.path,
      originalCwd: settings.originalCwd,
      cleanup: {
        status: 'partial',
        message: 'owner metadata remains',
      },
    });

    const result = await buildTool()
      .build({ action: 'keep' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Cleanup incomplete');
    expect(result.llmContent).toContain('owner metadata remains');
    expect(result.toolUseResult).toMatchObject({
      action: 'keep',
      cleanup: { status: 'partial' },
    });
  });

  it('preserves detailed change warnings before remove', async () => {
    finalize.mockResolvedValue({
      action: 'inspect',
      changedFiles: 3,
      commits: 1,
      owner: true,
    });

    const result = await buildTool()
      .build({ action: 'remove' })
      .execute(new AbortController().signal);

    expect(finalize).toHaveBeenCalledWith(expect.anything(), {
      action: 'inspect',
    });
    expect(result.llmContent).toContain('3 uncommitted file(s)');
    expect(result.llmContent).toContain('1 unpushed commit(s)');
    expect(result.llmContent).toContain('discard_changes');
    expect(leave).not.toHaveBeenCalled();
  });

  it('fails closed when change inspection is unavailable', async () => {
    finalize.mockResolvedValue({
      action: 'inspect',
      changedFiles: null,
      commits: null,
      owner: true,
    });

    const result = await buildTool()
      .build({ action: 'remove' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Could not verify');
    expect(leave).not.toHaveBeenCalled();
  });

  it('routes confirmed remove through leave', async () => {
    leave.mockResolvedValue({
      action: 'remove',
      worktreePath: settings.path,
      originalCwd: settings.originalCwd,
    });

    const result = await buildTool()
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);

    expect(finalize).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith(expect.anything(), {
      action: 'remove',
      force: true,
    });
    expect(result.llmContent).toContain('removed worktree');
    expect(result.toolUseResult).toMatchObject({ action: 'remove' });
  });

  it('routes a clean unconfirmed remove through leave without force', async () => {
    leave.mockResolvedValue({
      action: 'remove',
      worktreePath: settings.path,
      originalCwd: settings.originalCwd,
    });

    await buildTool()
      .build({ action: 'remove' })
      .execute(new AbortController().signal);

    expect(leave).toHaveBeenCalledWith(expect.anything(), {
      action: 'remove',
      force: false,
    });
  });

  it('reports incomplete cleanup without claiming the worktree was removed', async () => {
    leave.mockResolvedValue({
      action: 'remove',
      worktreePath: settings.path,
      originalCwd: settings.originalCwd,
      cleanup: {
        status: 'partial',
        message: 'remove hook failed',
      },
    });

    const result = await buildTool()
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Cleanup incomplete');
    expect(result.llmContent).toContain(settings.path);
    expect(result.llmContent).toContain('remove hook failed');
    expect(result.llmContent).not.toContain('removed worktree');
    expect(result.toolUseResult).toMatchObject({
      action: 'remove',
      cleanup: { status: 'partial' },
    });
  });

  it('maps service failures to the existing tool error shape', async () => {
    leave.mockRejectedValue(new Error('cleanup refused'));

    const result = await buildTool()
      .build({ action: 'remove', discard_changes: true })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Failed to remove worktree');
    expect(result.llmContent).toContain('cleanup refused');
    expect(result.error).toMatchObject({ type: 'execution_failed' });
  });

  it('marks remove as destructive and keep as non-destructive', () => {
    expect(buildTool().isDestructive({ action: 'remove' })).toBe(true);
    expect(buildTool().isDestructive({ action: 'keep' })).toBe(false);
  });

  it('rejects invalid action', () => {
    expect(() =>
      buildTool().build({ action: 'invalid' as 'keep' | 'remove' }),
    ).toThrow(/must be equal to one of the allowed values|Action must be/);
  });
});
