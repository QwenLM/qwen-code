/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GIT_ENV_RESTORED_KEYS } from './load-simple-git.js';

describe('loadSimpleGit', () => {
  afterEach(() => {
    vi.doUnmock('simple-git');
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('uses named exports and single-flights concurrent loads', async () => {
    const simpleGit = vi.fn();
    const CheckRepoActions = { IS_REPO_ROOT: 'root' };
    vi.doMock('simple-git', () => ({ CheckRepoActions, simpleGit }));
    const { loadSimpleGit } = await import('./load-simple-git.js');

    const first = loadSimpleGit();
    const second = loadSimpleGit();

    expect(second).toBe(first);
    const loaded = await first;
    expect(loaded.CheckRepoActions).toBe(CheckRepoActions);

    loaded.simpleGit('/repo');
    expect(simpleGit).toHaveBeenCalledWith('/repo', {
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
      allowEnvironment: GIT_ENV_RESTORED_KEYS,
    });
  });

  it('keeps the guard last and preserves caller options', async () => {
    const simpleGit = vi.fn();
    vi.doMock('simple-git', () => ({
      CheckRepoActions: { IS_REPO_ROOT: 'root' },
      simpleGit,
    }));
    const { loadSimpleGit } = await import('./load-simple-git.js');
    const { simpleGit: guarded } = await loadSimpleGit();

    guarded('/repo', {
      config: ['core.quotepath=false'],
      unsafe: { allowUnsafeHooksPath: true },
    });

    // Git honours the last `-c` for a key, so ours has to come after any the
    // caller supplied.
    expect(simpleGit).toHaveBeenCalledWith('/repo', {
      config: [
        'core.quotepath=false',
        'core.fsmonitor=',
        'log.showSignature=false',
      ],
      unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true },
      allowEnvironment: GIT_ENV_RESTORED_KEYS,
    });
  });

  it('guards the options-only and no-argument overloads', async () => {
    const simpleGit = vi.fn();
    vi.doMock('simple-git', () => ({
      CheckRepoActions: { IS_REPO_ROOT: 'root' },
      simpleGit,
    }));
    const { loadSimpleGit } = await import('./load-simple-git.js');
    const { simpleGit: guarded } = await loadSimpleGit();

    guarded({ baseDir: '/repo' });
    expect(simpleGit).toHaveBeenLastCalledWith({
      baseDir: '/repo',
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
      allowEnvironment: GIT_ENV_RESTORED_KEYS,
    });

    guarded();
    expect(simpleGit).toHaveBeenLastCalledWith({
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
      allowEnvironment: GIT_ENV_RESTORED_KEYS,
    });
  });

  it('unwraps a default-only CommonJS chunk', async () => {
    const simpleGit = Object.assign(vi.fn(), {
      CheckRepoActions: { IS_REPO_ROOT: 'root' },
    });
    Object.assign(simpleGit, { simpleGit });
    vi.doMock('simple-git', () => ({
      CheckRepoActions: undefined,
      simpleGit: undefined,
      default: simpleGit,
    }));
    const { loadSimpleGit } = await import('./load-simple-git.js');

    const loaded = await loadSimpleGit();
    expect(loaded.CheckRepoActions).toBe(simpleGit.CheckRepoActions);
    loaded.simpleGit('/repo');
    expect(simpleGit).toHaveBeenCalledWith('/repo', {
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
      allowEnvironment: GIT_ENV_RESTORED_KEYS,
    });
  });

  it('rejects an unexpected module shape', async () => {
    vi.doMock('simple-git', () => ({
      CheckRepoActions: undefined,
      simpleGit: undefined,
      default: {},
    }));
    const { loadSimpleGit } = await import('./load-simple-git.js');

    await expect(loadSimpleGit()).rejects.toThrow(
      'simple-git module does not match the expected API',
    );
  });

  it('lets gitEnv-restored guarded variables through the v4 env guard', async () => {
    // Unmocked: the real simple-git v4 client throws on a task env naming a
    // guarded variable the client did not opt into. gitEnv() restores these
    // operator-set variables by design, so the loader must name them.
    vi.stubEnv('GIT_SSL_CAINFO', '/tmp/ci-test-ca.pem');
    vi.stubEnv('GIT_AUTHOR_NAME', 'CI User');
    const { loadSimpleGit } = await import('./load-simple-git.js');
    const { gitEnv } = await import('./git-branches.js');
    const { simpleGit: guarded } = await loadSimpleGit();

    const git = guarded().env(gitEnv());
    expect(gitEnv()['GIT_SSL_CAINFO']).toBe('/tmp/ci-test-ca.pem');
    expect(gitEnv()['GIT_AUTHOR_NAME']).toBe('CI User');
    await expect(git.version()).resolves.toBeDefined();
  });
});
