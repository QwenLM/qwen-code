/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ENV_WORKTREE_HANDLED,
  ENV_WORKTREE_INFO,
  makeFakeConfig,
  worktreeSessionService,
  type Config,
} from '@qwen-code/core';
import {
  applyWorktreeStartupRequest,
  resolveWorktreeStartupRequest,
} from './worktreeStartupRequest.js';

describe('worktreeStartupRequest', () => {
  const configs: Config[] = [];

  function createConfig(options: Parameters<typeof makeFakeConfig>[0] = {}) {
    const config = makeFakeConfig({ ...options, targetDir: process.cwd() });
    config.setTargetDir(options.targetDir ?? '/');
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      recordWorktreeState: vi.fn(),
    });
    configs.push(config);
    return config;
  }

  afterEach(async () => {
    await Promise.all(configs.splice(0).map((config) => config.dispose()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps an explicit request as data without changing cwd', () => {
    const chdir = vi.spyOn(process, 'chdir');
    const request = resolveWorktreeStartupRequest({
      requestedName: 'feature',
      originalCwd: '/repo/apps/desktop',
    });

    expect(request).toEqual({
      kind: 'create',
      name: 'feature',
      originalCwd: '/repo/apps/desktop',
    });
    expect(chdir).not.toHaveBeenCalled();
    chdir.mockRestore();
  });

  it('returns no request for an ordinary startup', () => {
    expect(
      resolveWorktreeStartupRequest({
        requestedName: undefined,
        originalCwd: '/repo/apps/desktop',
      }),
    ).toBeUndefined();
  });

  it.each([
    ['#42', 'pr-42', 42],
    ['https://github.com/team/repo/pull/42', 'pr-42', 42],
    ['https://gitlab.com/team/repo/-/merge_requests/42', 'pr-42', 42],
    ['42', '42', undefined],
  ])(
    'prepares CLI review reference %s with its review ref',
    async (name, slug, prNumber) => {
      const config = createConfig({ sessionId: 'review-session' });
      const enter = vi
        .spyOn(config, 'enterWorktree')
        .mockResolvedValue({} as Awaited<ReturnType<Config['enterWorktree']>>);
      await applyWorktreeStartupRequest(config, {
        kind: 'create',
        name,
        originalCwd: config.getProjectRoot(),
      });
      expect(enter).toHaveBeenCalledWith(
        expect.objectContaining({
          name: slug,
        }),
        undefined,
      );
      expect(
        enter.mock.calls[0]?.[0].kind === 'create' &&
          enter.mock.calls[0][0].options?.prNumber,
      ).toBe(prNumber);
    },
  );

  it('creates from the stable session root after resuming from another checkout', async () => {
    const launchCwd = '/repo/.qwen/worktrees/old/apps/desktop';
    const settings = {
      name: 'feature',
      path: '/repo/.qwen/worktrees/feature',
      worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
      baseSha: 'abc123',
      lifecycle: 'owner' as const,
      originalCwd: '/repo/apps/desktop',
      sessionId: 'session-1',
    };
    const prepared = {
      settings,
      created: true,
      preparedForSessionId: 'session-1',
    };
    const prepare = vi
      .spyOn(worktreeSessionService, 'prepare')
      .mockResolvedValue(prepared);
    const enter = vi
      .spyOn(worktreeSessionService, 'enter')
      .mockResolvedValue(settings);
    const config = createConfig({
      sessionId: 'session-1',
      targetDir: launchCwd,
      worktree: { baseRef: 'head' },
    });
    vi.spyOn(config, 'getSessionArtifactProjectRoot').mockReturnValue(
      '/repo/apps/desktop',
    );

    await expect(
      applyWorktreeStartupRequest(config, {
        kind: 'create',
        name: 'feature',
        originalCwd: launchCwd,
      }),
    ).resolves.toEqual({ ...settings, created: true });
    expect(
      resolveWorktreeStartupRequest({
        requestedName: undefined,
        originalCwd: settings.originalCwd,
      }),
    ).toBeUndefined();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      {
        kind: 'create',
        name: 'feature',
        originalCwd: '/repo/apps/desktop',
        projectRoot: '/repo/apps/desktop',
        options: {
          baseRef: 'head',
          fromCwd: '/repo/apps/desktop',
        },
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
  });

  it('does not replay lifecycle hooks after the service has entered a worktree', async () => {
    const settings = {
      name: 'feature',
      path: '/repo/.qwen/worktrees/feature',
      worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
      baseSha: 'abc123',
      lifecycle: 'owner' as const,
      originalCwd: '/repo/apps/desktop',
      sessionId: 'session-1',
    };
    vi.spyOn(worktreeSessionService, 'prepare').mockResolvedValue({
      settings,
      created: true,
      preparedForSessionId: 'session-1',
    });
    vi.spyOn(worktreeSessionService, 'enter').mockResolvedValue(settings);
    const hookSystem = {
      getRegistry: () => ({ getHooksForEvent: () => [] }),
      fireWorktreeCreateEvent: vi.fn().mockResolvedValue(undefined),
      fireCwdChangedEvent: vi.fn().mockResolvedValue(undefined),
    };
    const config = createConfig({
      sessionId: 'session-1',
      targetDir: '/repo/apps/desktop',
    });
    vi.spyOn(config, 'getHookSystem').mockReturnValue(
      hookSystem as unknown as ReturnType<Config['getHookSystem']>,
    );

    await applyWorktreeStartupRequest(config, {
      kind: 'create',
      name: 'feature',
      originalCwd: '/repo/apps/desktop',
    });

    expect(hookSystem.fireWorktreeCreateEvent).not.toHaveBeenCalled();
    expect(hookSystem.fireCwdChangedEvent).not.toHaveBeenCalled();
  });

  it('propagates a worktree preparation failure', async () => {
    vi.spyOn(worktreeSessionService, 'prepare').mockRejectedValue(
      new Error('prepare failed'),
    );
    const config = createConfig({
      sessionId: 'session-1',
      targetDir: '/repo/apps/desktop',
    });

    await expect(
      applyWorktreeStartupRequest(config, {
        kind: 'create',
        name: 'feature',
        originalCwd: '/repo/apps/desktop',
      }),
    ).rejects.toThrow('prepare failed');
  });

  it.each([undefined, '{invalid', '{}'])(
    'rejects unusable inherited state instead of silently dropping an explicit worktree request: %s',
    (serialized) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(ENV_WORKTREE_INFO, serialized);
      expect(() =>
        resolveWorktreeStartupRequest({
          requestedName: 'feature',
          originalCwd: '/repo',
        }),
      ).toThrow(/inherited worktree/i);
    },
  );

  it('treats inherited worktree environment as attached restore data', () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(
      ENV_WORKTREE_INFO,
      JSON.stringify({
        name: 'feature',
        path: '/repo/.qwen/worktrees/feature',
        worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
        baseSha: 'abc123',
        originalCwd: '/repo/apps/desktop',
        worktreeBranch: 'worktree-feature',
      }),
    );

    expect(
      resolveWorktreeStartupRequest({
        requestedName: 'ignored-child-request',
        originalCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
      }),
    ).toEqual({
      kind: 'restore-inherited',
      state: expect.objectContaining({
        originalCwd: '/repo/apps/desktop',
        worktreePath: '/repo/.qwen/worktrees/feature',
        worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
        lifecycle: 'attached',
      }),
    });
  });

  it('restores the project subdirectory from inherited legacy state without worktreeCwd', async () => {
    const tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'inherited-worktree-')),
    );
    const repoRoot = path.join(tempRoot, 'repo');
    const originalCwd = path.join(repoRoot, 'apps', 'desktop');
    const worktreePath = path.join(tempRoot, 'checkout');
    const expectedCwd = path.join(worktreePath, 'apps', 'desktop');
    let config: Config | undefined;
    try {
      await fs.mkdir(originalCwd, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'initial',
        ],
        { cwd: repoRoot, stdio: 'ignore' },
      );
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      await fs.mkdir(expectedCwd, { recursive: true });
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(
        ENV_WORKTREE_INFO,
        JSON.stringify({ name: 'feature', path: worktreePath, originalCwd }),
      );
      const request = resolveWorktreeStartupRequest({
        requestedName: undefined,
        originalCwd,
      });
      expect(request).toBeDefined();
      config = makeFakeConfig({
        sessionId: 'inherited-session',
        targetDir: originalCwd,
        cwd: originalCwd,
        acpMode: true,
      });
      const record = vi.fn();

      await applyWorktreeStartupRequest(config, request!, {
        record,
      });

      expect(config.getWorkingDir()).toBe(expectedCwd);
      expect(config.getSessionArtifactProjectRoot()).toBe(originalCwd);
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          worktreeCwd: expectedCwd,
          lifecycle: 'attached',
        }),
      );
    } finally {
      await config?.dispose();
      await fs.rm(tempRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('consumes inherited startup state without forwarding it to subsequent child sessions', async () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(
      ENV_WORKTREE_INFO,
      JSON.stringify({
        name: 'old',
        path: '/old-worktree',
        originalCwd: '/repo',
      }),
    );
    const request = resolveWorktreeStartupRequest({
      requestedName: undefined,
      originalCwd: '/old-worktree',
    })!;
    const config = createConfig({ sessionId: 'session-1' });
    vi.spyOn(config, 'restoreWorktree').mockResolvedValue({
      status: 'fallback',
    });
    await applyWorktreeStartupRequest(config, request);
    expect(
      resolveWorktreeStartupRequest({
        requestedName: 'new',
        originalCwd: '/repo',
      }),
    ).toEqual({
      kind: 'create',
      name: 'new',
      originalCwd: '/repo',
    });
    expect(
      resolveWorktreeStartupRequest({
        requestedName: undefined,
        originalCwd: '/repo',
      }),
    ).toBeUndefined();
  });

  it('refuses startup worktrees without persistence before invoking lifecycle side effects', async () => {
    const config = createConfig({
      sessionId: 'session-1',
      sessionPersistence: false,
    });
    const enter = vi.spyOn(config, 'enterWorktree');
    await expect(
      applyWorktreeStartupRequest(config, {
        kind: 'create',
        name: 'feature',
        originalCwd: '/repo',
      }),
    ).rejects.toThrow(/persistence/);
    expect(enter).not.toHaveBeenCalled();
  });

  it('uses immediate writer persistence when a resumed runtime applies the request', async () => {
    const settings = {
      name: 'new',
      path: '/repo/.qwen/worktrees/new',
      worktreeCwd: '/repo/.qwen/worktrees/new/apps/desktop',
      baseSha: 'abc123',
      lifecycle: 'owner' as const,
      originalCwd: '/repo/apps/desktop',
      sessionId: 'session-1',
    };
    vi.spyOn(worktreeSessionService, 'prepare').mockResolvedValue({
      settings,
      created: true,
      preparedForSessionId: 'session-1',
    });
    const enter = vi
      .spyOn(worktreeSessionService, 'enter')
      .mockResolvedValue(settings);
    const config = createConfig({
      sessionId: 'session-1',
      targetDir: '/repo/apps/desktop',
    });
    const record = vi.fn().mockResolvedValue(undefined);

    await applyWorktreeStartupRequest(
      config,
      {
        kind: 'create',
        name: 'new',
        originalCwd: '/repo/apps/desktop',
      },
      { record },
    );

    expect(enter).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'runtime',
        recordWorktreeState: expect.any(Function),
      }),
      expect.objectContaining({ settings }),
    );
    const context = enter.mock.calls[0]?.[0] as {
      recordWorktreeState: (state: null) => Promise<void>;
    };
    await context.recordWorktreeState(null);
    expect(record).toHaveBeenCalledWith(null);
  });
});
