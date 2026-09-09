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

  it('fails the removal closed on a killed toplevel probe', async () => {
    // A killed --show-toplevel is not a bare-repo answer: reading the
    // origins against the wrong base would refuse every removal from a
    // subdir cwd, so the kill must surface.
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockRejectedValueOnce(killedDumpError()); // rev-parse --show-toplevel
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
  });

  it('refuses a removal over an unknown-scope upstream survivor', async () => {
    // Apple Git labels its runtime-prefix defaults file scope `unknown`:
    // the records are real and git resolves them, so the survivor fold
    // must see them — a record the fold drops would certify a dangling
    // upstream this gate exists to refuse.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope verification
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep re-verify
      .mockResolvedValueOnce('unknown\u0000branch.main.remote\norigin\u0000'); // survivor read
    await expect(gitRemoteRemove('/repo', 'origin')).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(runGit.mock.calls.length).toBe(calls + 14);
  });

  it('fails the removal verification closed on a killed scope read', async () => {
    // pointing-branches snapshot ok → remove ok → probe ok → repo-scope
    // re-read lists nothing → the all-scope verification read is killed:
    // reject, never certify, and never leak the partial dump.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockRejectedValueOnce(killedDumpError()); // all-scope verification
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    // The exact call count pins the sequencing: an added or removed read
    // must not silently retarget the kill.
    expect(runGit.mock.calls.length).toBe(calls + 9);
  });

  it('strips the dump from a killed pre-removal snapshot read', async () => {
    // The snapshot read precedes the mutation: a killed read must reject
    // stripped before `git remote remove` ever runs.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockRejectedValueOnce(killedDumpError()); // snapshot read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 5);
  });

  it('strips the dump from a killed origin pre-flight read before rm runs', async () => {
    // The include-origin pre-flight is the FIRST read of a removal: a
    // killed dump must reject stripped, and `git remote remove` must
    // never run on a blind answer.
    const calls = runGit.mock.calls.length;
    runGit.mockRejectedValueOnce(killedDumpError());
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 1);
  });

  it('strips the dump from a killed branch-key read after removal', async () => {
    // snapshot finds one pointing branch → remove ok → probe ok →
    // listing empty → all-scope verification empty → tracking-refs read
    // empty → re-verify empty → the branch-key sweep read is killed
    // mid-dump: reject stripped, never certify past the guard.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('worktree\u0000branch.feat.remote\norigin\u0000')
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope verification
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockRejectedValueOnce(killedDumpError()); // branch-key sweep read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 12);
  });

  it('strips the dump from a killed upstream-survivor read after cleanup', async () => {
    // snapshot (no branch keys) → remove ok → probe ok → listing empty →
    // all-scope verification empty → tracking-refs read empty →
    // re-verify empty → worktree sweep read → worktree re-verify → the
    // upstream-survivor read is killed mid-dump: reject stripped, never
    // certify past the guard.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope verification
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // worktree sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // worktree re-verify
      .mockRejectedValueOnce(killedDumpError()); // upstream-survivor read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 14);
  });

  it('fails the listing closed on a killed promisor badge read', async () => {
    // A promisor-carrying section costs one extra read; a KILLED badge
    // read is not a negative answer — the listing must reject rather
    // than render the remote without the badge the remove confirm
    // relies on, and the partial dump must not leave the module.
    runGit
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce(
        'local\u0000remote.origin.url\nhttps://example.com/x.git\u0000local\u0000remote.origin.promisor\ntrue\u0000',
      ) // listing dump: one promisor-carrying section
      .mockRejectedValueOnce(killedDumpError()); // the badge read
    const err = await fetchGitRemotes('/repo').catch((e: unknown) => e);
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
  });

  it('does not read exit 1 with output on stdout as a no-match', async () => {
    // The empty-stdout arm is the deciding one here: a genuine git
    // failure carrying ANY output must surface, never answer [] .
    runGit
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockRejectedValueOnce(
        Object.assign(new Error('exit 1'), {
          stdout: 'unexpected output on stdout\n',
          stderr: '',
          code: 1,
        }),
      );
    await expect(fetchGitRemotes('/repo')).rejects.toMatchObject({
      code: 1,
    });
  });

  it('strips the dump from a killed read whose stderr is empty too', async () => {
    // The real timeout-kill shape has stderr: '' — the strip must still
    // leave nothing but the error itself (no dump, no diagnostics).
    runGit
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockRejectedValueOnce(
        Object.assign(new Error('spawn git SIGTERM'), {
          stdout:
            'global\u0000remote.leak.url\nhttps://global.example/x.git\u0000',
          stderr: '',
          code: null,
          signal: 'SIGTERM',
          killed: true,
        }),
      );
    const err = await fetchGitRemotes('/repo').catch((e: unknown) => e);
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe('');
  });

  it('strips the dump from a killed tracking-refs read', async () => {
    // snapshot (no branch keys) → remove ok → probe ok → listing empty →
    // all-scope verification empty → the tracking-refs read is killed
    // mid-dump: reject stripped — "no refs" is not an answer a killed
    // read may produce.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope verification
      .mockRejectedValueOnce(killedDumpError()); // tracking-refs read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 10);
  });

  it('strips the dump from a killed tracking-refs re-verification', async () => {
    // … tracking-refs read finds ONE ref → the delete runs → the
    // re-verify read is killed mid-dump: reject stripped, never certify
    // the phantom group as cleaned.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope verification
      .mockResolvedValueOnce('refs/remotes/origin/main\n') // refs read
      .mockResolvedValueOnce('') // update-ref -d
      .mockRejectedValueOnce(killedDumpError()); // re-verify
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 12);
  });
});
