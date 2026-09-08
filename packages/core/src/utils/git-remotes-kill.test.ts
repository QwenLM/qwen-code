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

const { fetchGitRemotes, gitRemoteAdd, gitRemoteRemove } = await import(
  './git-remotes.js'
);

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

// A killed read that already dumped partial config (every scope included)
// to stdout: the route forwards error text to the client, so the dump must
// not leave the module. stderr carries git's diagnostics and must SURVIVE
// the strip — the anchored classifier shapes match on it.
function killedDumpError(): Error {
  return Object.assign(new Error('spawn git SIGTERM'), {
    stdout: 'global\u0000remote.leak.url\nhttps://global.example/x.git\u0000',
    stderr: 'fatal: unable to read config file',
    code: null,
    signal: 'SIGTERM',
    killed: true,
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

  it('strips the config dump from a killed read before rethrowing', async () => {
    runGit
      .mockResolvedValueOnce('.git\n')
      .mockRejectedValueOnce(killedDumpError());
    const err = await fetchGitRemotes('/repo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
  });

  it('fails the add pre-flight closed on a killed scope read', async () => {
    // A killed scope read must not read as "no inherited collision", and
    // its partial all-scope dump must not reach the client.
    runGit
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockRejectedValueOnce(killedDumpError()); // scope read
    const err = await gitRemoteAdd(
      '/repo',
      'origin',
      'https://example.com/o/r.git',
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
  });

  it('fails the removal verification closed on a killed scope read', async () => {
    // remove ok → probe ok → repo-scope re-read lists nothing → the
    // all-scope verification read is killed: reject, never certify, and
    // never leak the partial dump.
    runGit
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // repo-scope read
      .mockRejectedValueOnce(killedDumpError()); // all-scope verification
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
  });
});
