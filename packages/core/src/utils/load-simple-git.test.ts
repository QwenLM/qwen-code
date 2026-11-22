/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_ENV_RESTORED_KEYS,
  LOADER_ALLOWED_ENVIRONMENT_KEYS,
} from './load-simple-git.js';

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
      allowEnvironment: LOADER_ALLOWED_ENVIRONMENT_KEYS,
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
      allowEnvironment: LOADER_ALLOWED_ENVIRONMENT_KEYS,
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
      allowEnvironment: LOADER_ALLOWED_ENVIRONMENT_KEYS,
    });

    guarded();
    expect(simpleGit).toHaveBeenLastCalledWith({
      config: ['core.fsmonitor=', 'log.showSignature=false'],
      unsafe: { allowUnsafeFsMonitor: true },
      allowEnvironment: LOADER_ALLOWED_ENVIRONMENT_KEYS,
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
      allowEnvironment: LOADER_ALLOWED_ENVIRONMENT_KEYS,
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

  it('keeps the ambient transport variables for clients that never set .env()', async () => {
    // Unmocked: v4's guard deletes every guarded key the client did not name,
    // not only the ones a task env sets. The extension git client returns
    // before `.env()` on the default policy, so an operator's SSH identity has
    // to survive in the child or an SSH-sourced install fails `publickey`.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-env-shim-'));
    const shim = path.join(
      dir,
      process.platform === 'win32' ? 'shim.cmd' : 'shim',
    );
    const dump = path.join(dir, 'env.txt');
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s' "$GIT_SSH_COMMAND" > '${dump}'\nexit 1\n`,
    );
    fs.chmodSync(shim, 0o755);
    try {
      vi.stubEnv('GIT_SSH_COMMAND', 'ssh -i /tmp/operator-key');
      const { loadSimpleGit } = await import('./load-simple-git.js');
      const { simpleGit: guarded } = await loadSimpleGit();

      const git = guarded({ binary: shim });
      // The shim exits non-zero on purpose; what matters is the environment
      // its child received, not how simple-git reports the failure.
      await git.raw(['version']).catch(() => undefined);
      expect(fs.readFileSync(dump, 'utf8')).toBe('ssh -i /tmp/operator-key');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allowlists every guarded key gitEnv() restores', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'CI User');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ci@example.com');
    vi.stubEnv('GIT_AUTHOR_DATE', '2026-01-01T00:00:00Z');
    vi.stubEnv('GIT_COMMITTER_NAME', 'CI User');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ci@example.com');
    vi.stubEnv('GIT_COMMITTER_DATE', '2026-01-01T00:00:00Z');
    vi.stubEnv('GIT_SSL_CAINFO', '/tmp/ci-test-ca.pem');
    vi.stubEnv('GIT_SSL_CAPATH', '/tmp/ci-test-ca');
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'https:ssh');
    const { gitEnv } = await import('./git-branches.js');

    const restored = Object.keys(gitEnv()).filter((key) =>
      key.startsWith('GIT_'),
    );
    expect(restored.sort()).toEqual([...GIT_ENV_RESTORED_KEYS].sort());
  });
});
