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

// git's own no-such-remote answer (a removal retry whose section is
// already gone): exits 128, stderr carries the line.
function noSuchRemoteError(): Error {
  return Object.assign(new Error('exit 128'), {
    stdout: '',
    stderr: "error: No such remote: 'x'\n",
    code: 128,
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep re-verify
      .mockResolvedValueOnce('') // worktree list --porcelain
      .mockResolvedValueOnce('unknown\u0000branch.main.remote\norigin\u0000'); // survivor read
    await expect(gitRemoteRemove('/repo', 'origin')).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(runGit.mock.calls.length).toBe(calls + 18);
  });

  it('fails the removal closed on a killed worktree-list read', async () => {
    // The sibling sweep's enumeration is a read like any other: a kill
    // must not certify while a sibling's config.worktree goes unread.
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep re-verify
      .mockRejectedValueOnce(killedDumpError()); // worktree list --porcelain -z
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect(runGit.mock.calls.length).toBe(calls + 17);
  });

  it('fails the removal closed on a killed sibling worktree read', async () => {
    // A live sibling in the list, then its config.worktree read dies:
    // the sweep cannot certify what it never read.
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // sweep re-verify
      .mockResolvedValueOnce('worktree /other\0\0') // one sibling
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel (lazy)
      .mockRejectedValueOnce(killedDumpError()); // sibling config read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect(runGit.mock.calls.length).toBe(calls + 19);
  });

  it('fails the converge arm closed on a killed repo-path probe', async () => {
    // The converge gate's last conjunct probes whether a bare-word name
    // resolves as a local-path upstream — a killed probe must not read
    // as "not a repo" and let the sweep run over a blind answer.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // x pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockRejectedValueOnce(noSuchRemoteError()) // git remote remove
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // scope read (empty of x)
      .mockResolvedValueOnce('x\n') // ls-remote --get-url: echo = unresolved
      .mockRejectedValueOnce(killedDumpError()); // ls-remote -- x (path leg)
    const err = await gitRemoteRemove('/repo', 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    // The kill stops the chain: no sweep spawn (for-each-ref, config
    // --unset, worktree list) ever follows the blind probe.
    expect(runGit.mock.calls.length).toBe(calls + 9);
  });

  it('refuses over an inherited record that races in after the pre-flight', async () => {
    // The certify-path union gate's section half is the backstop for a
    // survivor the pre-flight could not see (a concurrent global edit,
    // or the pre-flight's no-match fall-through): the post-removal
    // scope read grows an inherited record the pre-flight never saw.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce(
        'local\u0000file:.git/config\u0000remote.origin.url\nhttps://example.com/o/r.git\u0000',
      ) // pre-flight origin read: repository record only
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // snapshot
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('.git\n') // listing probe
      .mockResolvedValueOnce('') // listing read: the row is gone
      .mockResolvedValueOnce(
        'global\u0000remote.origin.pushurl\nhttps://global.example/p.git\u0000',
      ); // union gate scope read: the inherited record raced in
    await expect(gitRemoteRemove('/repo', 'origin')).rejects.toThrow(
      /remote still configured after removal/,
    );
    expect(runGit.mock.calls.length).toBe(calls + 9);
  });

  it('does not complete a worktree section when an inherited record shares it', async () => {
    // removeWorktreeScopeSection's `scopes.size !== 1` conjunct: a
    // worktree survivor shadowed by an inherited record must NOT be
    // completed (the per-worktree URL would be deleted with no
    // in-product recovery).
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce(
        'worktree\u0000file:.git/config.worktree\u0000remote.dup.url\nhttps://example.com/w.git\u0000',
      ) // pre-flight origin read: worktree record, editable
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('worktree\u0000core.x\ny\u0000') // snapshot
      .mockRejectedValueOnce(
        Object.assign(new Error('exit 128'), {
          stdout: '',
          stderr: "error: Could not remove config section 'remote.dup'\n",
          code: 128,
        }),
      ) // git remote remove
      .mockResolvedValueOnce(
        'worktree\u0000remote.dup.url\nhttps://example.com/w.git\u0000global\u0000remote.dup.url\nhttps://global.example/d.git\u0000',
      ); // completion scope read: worktree AND global
    const err = await gitRemoteRemove('/repo', 'dup').catch((e: unknown) => e);
    expect(String((err as { stderr?: unknown }).stderr)).toContain(
      'Could not remove config section',
    );
    // The completion's `--worktree --remove-section` never spawned.
    expect(runGit.mock.calls.length).toBe(calls + 7);
  });

  it('restores the shadowed local copy BEFORE any post-removal gate can fail', async () => {
    // The destroy shape: worktree-scope copy names the removed remote,
    // the local copy names a survivor. The listing read after rm is
    // killed — the restore must already have run (a gate failure must
    // not skip the rollback of git's own destruction).
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce(
        'local\u0000branch.feat.remote\nsurvivor\u0000worktree\u0000branch.feat.remote\norigin\u0000',
      ) // snapshot: feat pointed (worktree), local copy survives-named
      .mockResolvedValueOnce('') // git remote remove
      .mockResolvedValueOnce('') // restore: branch.feat.remote read (absent)
      .mockResolvedValueOnce('') // restore: the --add write
      .mockResolvedValueOnce('') // restore: merge read (absent)
      .mockResolvedValueOnce('') // restore: pushremote read (absent)
      .mockRejectedValueOnce(killedDumpError()); // rev-parse probe
    // Slice from this test's own start: the mock is module-level and
    // accumulates across tests, so an earlier test's `remote remove`
    // would otherwise satisfy the index lookups.
    const base = runGit.mock.calls.length;
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    const calls = runGit.mock.calls
      .slice(base)
      .map((c) => (c[1] as string[]).join(' '));
    const rmAt = calls.findIndex((c) => c === 'remote remove -- origin');
    const addAt = calls.findIndex((c) =>
      c.includes('--local --add branch.feat.remote'),
    );
    // The restore's write landed after the removal and before the final
    // (killed) gate read — no post-removal gate can skip it.
    expect(rmAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(rmAt);
    expect(addAt).toBeLessThan(calls.length - 1);
  });

  it('fails the removal closed on a killed restore read', async () => {
    // The restore runs right after rm (before every post-removal gate):
    // a killed read mid-restore must not certify the branch as handled.
    const calls = runGit.mock.calls.length;
    runGit
      .mockResolvedValueOnce('local\u0000file:.git/config\u0000core.x\ny\u0000') // origin pre-flight read
      .mockResolvedValueOnce('.git\n') // rev-parse --git-dir
      .mockResolvedValueOnce('.git\n') // rev-parse --git-common-dir
      .mockResolvedValueOnce('/repo\n') // rev-parse --show-toplevel
      .mockResolvedValueOnce('local\u0000branch.feat.remote\norigin\u0000') // snapshot: feat pointed
      .mockResolvedValueOnce('') // git remote remove
      .mockRejectedValueOnce(killedDumpError()); // restore read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect(runGit.mock.calls.length).toBe(calls + 7);
  });

  it('fails the removal closed on a killed resolver read', async () => {
    // A killed ls-remote is not a negative answer: a legacy
    // .git/remotes/<name> file could still resolve the removed name,
    // so the read must surface the kill (stripped), not certify.
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockRejectedValueOnce(killedDumpError()); // ls-remote --get-url
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect(runGit.mock.calls.length).toBe(calls + 10);
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
      .mockResolvedValueOnce('') // restore: local remote read (absent)
      .mockResolvedValueOnce('') // restore: local pushremote read (absent)
      .mockResolvedValueOnce('.git\n') // rev-parse probe
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // listing read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockRejectedValueOnce(killedDumpError()); // branch-key sweep read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 17);
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('') // tracking-refs read (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('') // tracking-refs re-verify (empty)
      .mockResolvedValueOnce('') // remote list (empty)
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // worktree sweep read
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // worktree re-verify
      .mockResolvedValueOnce('') // worktree list --porcelain
      .mockRejectedValueOnce(killedDumpError()); // upstream-survivor read
    const err = await gitRemoteRemove('/repo', 'origin').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ killed: true });
    expect((err as { stdout?: unknown }).stdout).toBe('');
    expect((err as { stderr?: unknown }).stderr).toBe(
      'fatal: unable to read config file',
    );
    expect(runGit.mock.calls.length).toBe(calls + 18);
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockRejectedValueOnce(killedDumpError()); // tracking-refs read
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
      .mockResolvedValueOnce('local\u0000core.x\ny\u0000') // all-scope section verify
      .mockResolvedValueOnce('origin\n') // ls-remote --get-url: name echoed = gone
      .mockResolvedValueOnce('refs/remotes/origin/main\n') // refs read
      .mockResolvedValueOnce('') // remote list (empty)
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
    expect(runGit.mock.calls.length).toBe(calls + 15);
  });
});
