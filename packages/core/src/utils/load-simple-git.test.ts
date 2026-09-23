/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('loadSimpleGit', () => {
  afterEach(() => {
    vi.doUnmock('simple-git');
    vi.resetModules();
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
    });

    guarded();
    expect(simpleGit).toHaveBeenLastCalledWith({
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
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
});
