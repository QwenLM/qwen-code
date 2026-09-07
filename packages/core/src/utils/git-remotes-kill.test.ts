/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// The kill/no-match discriminator cannot be reached through real git (a
// killed read is a host-condition), so stub the exec wrapper: the probe
// succeeds and the config read rejects with the two shapes.
const runGit = vi.fn();
vi.mock('./git-branches.js', () => ({
  runGit: (...args: unknown[]) => runGit(...args),
  gitEnv: (base?: unknown) => base,
}));

const { fetchGitRemotes } = await import('./git-remotes.js');

function killError(): Error {
  return Object.assign(new Error('spawn git SIGTERM'), {
    stdout: '',
    stderr: '',
    code: null,
    signal: 'SIGTERM',
    killed: true,
  });
}

function noMatchError(): Error {
  return Object.assign(new Error('exit 1'), {
    stdout: '',
    stderr: '',
    code: 1,
  });
}

// A timeout kill whose child still exits 1: only the killed/signal guards
// separate it from the no-match shape.
function killedExit1Error(): Error {
  return Object.assign(new Error('spawn git SIGTERM'), {
    stdout: '',
    stderr: '',
    code: 1,
    signal: null,
    killed: true,
  });
}

// A genuine git failure: only the empty-output guards separate it from the
// no-match shape.
function exit1WithStderr(): Error {
  return Object.assign(new Error('exit 1'), {
    stdout: '',
    stderr: 'fatal: unable to read config file\n',
    code: 1,
  });
}

describe('fetchGitRemotes config-read failure discrimination', () => {
  it('rethrows a killed config read instead of answering an empty list', async () => {
    runGit
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockRejectedValueOnce(killError());
    await expect(fetchGitRemotes('/repo')).rejects.toMatchObject({
      killed: true,
    });
  });

  it('answers an empty list for git no-match (exit 1, no output)', async () => {
    runGit
      .mockResolvedValueOnce('.git\n')
      .mockRejectedValueOnce(noMatchError());
    await expect(fetchGitRemotes('/repo')).resolves.toEqual([]);
  });

  it('rethrows a timeout kill that exits 1 instead of reading no-match', async () => {
    runGit
      .mockResolvedValueOnce('.git\n')
      .mockRejectedValueOnce(killedExit1Error());
    await expect(fetchGitRemotes('/repo')).rejects.toMatchObject({
      killed: true,
    });
  });

  it('rethrows an exit-1 read that carries stderr', async () => {
    runGit
      .mockResolvedValueOnce('.git\n')
      .mockRejectedValueOnce(exit1WithStderr());
    await expect(fetchGitRemotes('/repo')).rejects.toMatchObject({
      code: 1,
    });
  });
});
