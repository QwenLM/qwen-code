/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogger } from '../utils/runLogger.js';

const mocks = vi.hoisted(() => ({
  createGitCommandEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  execFileNoThrow: vi.fn(),
  readGitHead: vi.fn(),
  resolveGitRepositoryLayout: vi.fn(),
}));

vi.mock('../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: mocks.execFileNoThrow,
}));
vi.mock('../utils/gitUtils.js', () => ({
  createGitCommandEnv: mocks.createGitCommandEnv,
  GitMetadataProbeTimeoutError: class GitMetadataProbeTimeoutError extends Error {},
  readGitHead: mocks.readGitHead,
  resolveGitRepositoryLayout: mocks.resolveGitRepositoryLayout,
}));

import {
  clearSystemContext,
  collectGitContext,
  getSystemContext,
  takeSystemContextPrefetch,
} from './system-context.js';

describe('system context session cache', () => {
  beforeEach(() => {
    mocks.resolveGitRepositoryLayout.mockResolvedValue(null);
    mocks.readGitHead.mockResolvedValue({
      ref: 'refs/heads/main',
      branch: 'main',
      commit: 'a'.repeat(40),
    });
    mocks.execFileNoThrow.mockImplementation(async () => ({
      stdout: '',
      stderr: '',
      code: 0,
    }));
  });

  afterEach(() => {
    clearSystemContext('session-a');
    clearSystemContext('session-b');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('reuses one promise for the same session and directory', () => {
    expect(getSystemContext('session-a', '/tmp/a')).toBe(
      getSystemContext('session-a', '/tmp/a'),
    );
  });

  it('logs the first cache hit once per session and directory', () => {
    const log = vi.spyOn(runLogger, 'log').mockImplementation(() => {});

    void getSystemContext('session-a', '/tmp/a');
    void getSystemContext('session-a', '/tmp/a');
    void getSystemContext('session-a', '/tmp/a');

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('cache_hit=false'),
    );
    expect(
      log.mock.calls.filter(([message]) =>
        String(message).includes('cache_hit=true'),
      ),
    ).toHaveLength(1);
  });

  it('isolates directories within a session', () => {
    // A startup prewarm and the turn that consumes it can disagree on the
    // working directory. Sharing an entry across directories would let the turn
    // describe a repository it is no longer in.
    expect(getSystemContext('session-a', '/tmp/a')).not.toBe(
      getSystemContext('session-a', '/tmp/b'),
    );
  });

  it('isolates concurrent sessions', () => {
    expect(getSystemContext('session-a', '/tmp/a')).not.toBe(
      getSystemContext('session-b', '/tmp/a'),
    );
  });

  it('takes a startup flight once and collects without reusing it after compaction', async () => {
    const prefetch = getSystemContext('session-a', '/tmp/a');
    expect(takeSystemContextPrefetch('session-a', '/tmp/a')).toBe(prefetch);
    expect(takeSystemContextPrefetch('session-a', '/tmp/a')).toBeUndefined();
    await prefetch;
    const refreshed = collectGitContext('/tmp/a');
    expect(refreshed).not.toBe(prefetch);
    await refreshed;
  });

  it('discards prefetch from a different directory without affecting another session', async () => {
    await getSystemContext('session-a', '/tmp/a');
    const other = getSystemContext('session-b', '/tmp/a');
    expect(takeSystemContextPrefetch('session-a', '/tmp/b')).toBeUndefined();
    expect(takeSystemContextPrefetch('session-a', '/tmp/a')).toBeUndefined();
    expect(takeSystemContextPrefetch('session-b', '/tmp/a')).toBe(other);
    await other;
  });

  it('clears every directory of the requested session', () => {
    const firstA = getSystemContext('session-a', '/tmp/a');
    const secondA = getSystemContext('session-a', '/tmp/b');
    const firstB = getSystemContext('session-b', '/tmp/a');

    clearSystemContext('session-a');

    expect(getSystemContext('session-a', '/tmp/a')).not.toBe(firstA);
    expect(getSystemContext('session-a', '/tmp/b')).not.toBe(secondA);
    expect(getSystemContext('session-b', '/tmp/a')).toBe(firstB);
  });

  it('evicts a cancelled flight so a later call can retry', async () => {
    const abortController = new AbortController();
    const cancellationReason = new Error('cancel system context collection');
    abortController.abort(cancellationReason);

    const cancelled = getSystemContext('session-a', '/tmp/a', {
      signal: abortController.signal,
    });

    await expect(cancelled).rejects.toBe(cancellationReason);

    const retry = getSystemContext('session-a', '/tmp/a');
    expect(retry).not.toBe(cancelled);
    await expect(retry).resolves.toEqual({});
  });

  it('runs required Git commands with -C instead of a child-process cwd', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mocks.resolveGitRepositoryLayout.mockResolvedValue({
      worktreeRoot: '/workspace/repo',
      gitDir: '/workspace/repo/.git',
      commonDir: '/workspace/repo/.git',
      isWorktree: false,
    });
    mocks.execFileNoThrow.mockImplementation(
      async (_file: string, args: string[]) => ({
        stdout: args.includes('symbolic-ref')
          ? 'origin/main\n'
          : args.includes('user.name')
            ? 'Qwen User\n'
            : '',
        stderr: '',
        code: 0,
      }),
    );

    await getSystemContext('session-a', '/workspace/repo');

    expect(mocks.execFileNoThrow).toHaveBeenCalledWith(
      'git',
      [
        ...internalGitArgs(),
        '-C',
        '/workspace/repo',
        '--no-optional-locks',
        'log',
        '--oneline',
        '-n',
        '5',
      ],
      expect.anything(),
    );

    expect(mocks.execFileNoThrow).toHaveBeenCalled();
    for (const [file, args, options] of mocks.execFileNoThrow.mock.calls) {
      expect(file).toBe('git');
      expect(args.slice(0, internalGitArgs().length + 2)).toEqual([
        ...internalGitArgs(),
        '-C',
        '/workspace/repo',
      ]);
      expect(options).not.toHaveProperty('cwd');
      expect(options.env).toEqual({ PATH: '/usr/bin' });
      expect(options.windowsProcessTreeCleanup).toEqual({
        source: 'system-context',
      });
    }
  });

  it('omits Git context instead of reporting clean when status fails', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mocks.resolveGitRepositoryLayout.mockResolvedValue({
      worktreeRoot: '/workspace/repo',
      gitDir: '/workspace/repo/.git',
      commonDir: '/workspace/repo/.git',
      isWorktree: false,
    });
    mocks.execFileNoThrow.mockImplementation(
      async (_file: string, args: string[]) => ({
        stdout: '',
        stderr: '',
        code: args.includes('status') ? 1 : 0,
      }),
    );

    await expect(
      getSystemContext('session-a', '/workspace/repo'),
    ).resolves.toEqual({});
  });

  it('reports clean only after a successful empty status', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mocks.resolveGitRepositoryLayout.mockResolvedValue({
      worktreeRoot: '/workspace/repo',
      gitDir: '/workspace/repo/.git',
      commonDir: '/workspace/repo/.git',
      isWorktree: false,
    });

    const context = await getSystemContext('session-a', '/workspace/repo');

    expect(context['gitStatus']).toContain('Current branch: main');
    expect(context['gitStatus']).toContain('Status:\n(clean)');
  });

  it.each([
    {
      name: 'read error',
      result: { code: 2, stdout: '', stderr: 'invalid config' },
    },
    {
      name: 'filter driver containing a newline',
      result: { code: 0, stdout: 'filter.line\nbreak.clean\0' },
    },
    { name: 'timeout', result: { code: 1, stdout: '', timedOut: true } },
    {
      name: 'malformed output',
      result: { code: 0, stdout: 'filter.test.clean' },
    },
  ])(
    'keeps metadata without status after a filter probe $name',
    async ({ result }) => {
      vi.stubEnv('NODE_ENV', 'development');
      mocks.resolveGitRepositoryLayout.mockResolvedValue({
        worktreeRoot: '/workspace/repo',
        gitDir: '/workspace/repo/.git',
        commonDir: '/workspace/repo/.git',
      });
      mocks.execFileNoThrow.mockImplementation(
        async (_file: string, args: string[]) =>
          args.includes('--list')
            ? result
            : { code: 0, stdout: '', stderr: '' },
      );
      const context = await getSystemContext('session-a', '/workspace/repo');
      expect(context['gitStatus']).toContain('Current branch: main');
      expect(context['gitStatus']).toContain(
        result.stdout.includes('\0')
          ? 'not collected: Git content filters are configured'
          : 'not collected: Git filter configuration could not be verified',
      );
      expect(context['gitStatus']).not.toContain('(clean)');
      expect(
        mocks.execFileNoThrow.mock.calls.some(([, args]) =>
          args.includes('status'),
        ),
      ).toBe(false);
    },
  );

  it('evicts a timed-out Git status flight', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mocks.resolveGitRepositoryLayout.mockResolvedValue({
      worktreeRoot: '/workspace/repo',
      gitDir: '/workspace/repo/.git',
      commonDir: '/workspace/repo/.git',
      isWorktree: false,
    });
    mocks.execFileNoThrow.mockImplementation(
      async (_file: string, args: string[]) => ({
        stdout: '',
        stderr: '',
        code: args.includes('status') ? 1 : 0,
        timedOut: args.includes('status'),
      }),
    );

    const timedOut = getSystemContext('session-a', '/workspace/repo');
    await expect(timedOut).resolves.toEqual({});
    expect(getSystemContext('session-a', '/workspace/repo')).not.toBe(timedOut);
  });
});
