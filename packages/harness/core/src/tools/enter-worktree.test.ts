/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type {
  PreparedWorktree,
  WorktreeSettings,
} from '../services/worktree/contracts.js';
import type { WorktreeSessionContext } from '../services/worktreeSessionService.js';
import { worktreeSessionService } from '../services/worktreeSessionService.js';
import { EnterWorktreeTool } from './enter-worktree.js';

describe('EnterWorktreeTool', () => {
  let config: Config;
  let prepare: MockInstance<typeof worktreeSessionService.prepare>;
  let enter: MockInstance<typeof worktreeSessionService.enter>;
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

  const prepared: PreparedWorktree = {
    settings,
    created: true,
    preparedForSessionId: 'session-1',
  };

  beforeEach(() => {
    prepare = vi
      .spyOn(worktreeSessionService, 'prepare')
      .mockResolvedValue(prepared);
    enter = vi
      .spyOn(worktreeSessionService, 'enter')
      .mockResolvedValue(settings);
    recordWorktreeState = vi.fn().mockResolvedValue(undefined);
    config = makeFakeConfig({
      sessionId: 'session-1',
      targetDir: process.cwd(),
      cwd: '/repo/apps/desktop',
    });
    config.setTargetDir('/repo/apps/desktop');
    vi.spyOn(config, 'getWorktreeSettings').mockReturnValue(undefined);
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      recordWorktreeState,
    });
  });

  afterEach(async () => {
    await config.dispose();
    vi.restoreAllMocks();
  });

  function buildTool(): EnterWorktreeTool {
    return new EnterWorktreeTool(config);
  }

  it('refuses a second named worktree while one is active', async () => {
    vi.mocked(config.getWorktreeSettings).mockReturnValue(settings);

    const result = await buildTool()
      .build({ name: 'other' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Already in a worktree session');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects name and path together', () => {
    expect(() =>
      buildTool().build({ name: 'feature', path: '/repo/existing' }),
    ).toThrow(/at most one of name or path/i);
  });

  it('rejects an empty existing-worktree path', () => {
    expect(() => buildTool().build({ path: '   ' })).toThrow(
      /worktree path must not be empty/i,
    );
  });

  it('routes a named worktree through prepare and immediate enter', async () => {
    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      {
        kind: 'create',
        name: 'feature',
        originalCwd: '/repo/apps/desktop',
        projectRoot: '/repo/apps/desktop',
        options: expect.objectContaining({ fromCwd: '/repo/apps/desktop' }),
      },
    );
    expect(enter).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        sessionId: 'session-1',
        phase: 'runtime',
        recordWorktreeState: expect.any(Function),
      }),
      prepared,
    );
    const context = enter.mock.calls[0][0] as WorktreeSessionContext;
    await expect(context.recordWorktreeState?.(null)).resolves.toBeUndefined();
    expect(recordWorktreeState).toHaveBeenCalledWith(null);
    expect(result.llmContent).toContain('Created worktree');
    expect(result.toolUseResult).toMatchObject({
      worktreePath: settings.path,
      worktreeBranch: settings.worktreeBranch,
    });
  });

  it('uses the original project directory when switching from an active worktree', async () => {
    const active = {
      ...settings,
      name: 'old',
      path: '/repo/.qwen/worktrees/old',
      worktreeCwd: '/repo/.qwen/worktrees/old/apps/desktop',
    };
    vi.mocked(config.getWorktreeSettings).mockReturnValue(active);
    const attached = {
      ...settings,
      lifecycle: 'attached' as const,
      sessionId: undefined,
      enteredExisting: true,
    };
    prepare.mockResolvedValue({
      ...prepared,
      settings: attached,
      created: false,
    });
    enter.mockResolvedValue(attached);

    const result = await buildTool()
      .build({ path: '/repo/.qwen/worktrees/feature' })
      .execute(new AbortController().signal);

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorktreeSettings: active }),
      {
        kind: 'attach',
        path: '/repo/.qwen/worktrees/feature',
        originalCwd: '/repo/apps/desktop',
        launchRoot: '/repo/apps/desktop',
      },
    );
    expect(result.llmContent).toContain('Entered worktree');
    expect(result.llmContent).toContain('will never remove it');
    expect(result.llmContent).toContain(active.path);
  });

  it('keeps the existing resumed-worktree wording', async () => {
    prepare.mockResolvedValue({ ...prepared, created: false });

    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('resumed existing worktree');
  });

  it('keeps the hook-based wording', async () => {
    const hookSettings = { ...settings, hookBased: true };
    prepare.mockResolvedValue({ ...prepared, settings: hookSettings });
    enter.mockResolvedValue(hookSettings);

    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('hook-based');
  });

  it('reports a committed entry warning without returning a false failure', async () => {
    enter.mockResolvedValue({
      ...settings,
      entryWarning: 'Ownership recovery is still pending.',
    });

    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(
      'Warning: Ownership recovery is still pending.',
    );
  });

  it('generates a random slug when no name is provided', async () => {
    const result = await buildTool()
      .build({})
      .execute(new AbortController().signal);

    expect(prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'create',
        name: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/),
      }),
    );
    expect(result.error).toBeUndefined();
  });

  it('returns the existing error shape when prepare fails', async () => {
    prepare.mockRejectedValue(new Error('disk full'));

    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('Error creating or entering worktree');
    expect(result.llmContent).toContain('disk full');
    expect(result.error).toMatchObject({ type: 'execution_failed' });
  });

  it('does not return success when enter fails', async () => {
    enter.mockRejectedValue(new Error('transcript write failed'));

    const result = await buildTool()
      .build({ name: 'feature' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('transcript write failed');
    expect(result.llmContent).not.toContain('Created worktree at');
    expect(result.error).toMatchObject({ type: 'execution_failed' });
  });
});
