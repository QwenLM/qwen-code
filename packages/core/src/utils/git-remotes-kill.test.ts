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

/** An exec rejection; stdout and stderr are empty unless `fields` sets them. */
function gitError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), {
    stdout: '',
    stderr: '',
    ...fields,
  });
}

const DIAG = 'fatal: unable to read config file';
const LEAK = 'global\u0000remote.leak.url\nhttps://global.example/x.git\u0000';

const killError = (): Error =>
  gitError('spawn git SIGTERM', {
    code: null,
    signal: 'SIGTERM',
    killed: true,
  });

const noMatchError = (): Error => gitError('exit 1', { code: 1 });

// A timeout kill whose child still exits 1: only the killed/signal guards
// separate it from the no-match shape.
const killedExit1Error = (): Error =>
  gitError('spawn git SIGTERM', { code: 1, signal: null, killed: true });

// A genuine git failure: only the empty-output guards separate it from the
// no-match shape.
const exit1WithStderr = (): Error =>
  gitError('exit 1', { stderr: `${DIAG}\n`, code: 1 });

// git's own no-such-remote answer (a removal retry whose section is
// already gone): exits 2 (probed on 2.50.1), stderr carries the line.
const noSuchRemoteError = (): Error =>
  gitError('exit 2', { stderr: "error: No such remote: 'x'\n", code: 2 });

// A killed read that already dumped partial config (every scope included)
// to stdout: the route forwards error text to the client, so the dump must
// not leave the module. stderr carries git's diagnostics and must SURVIVE
// the strip — the anchored classifier shapes match on it.
const killedDumpError = (): Error =>
  gitError('spawn git SIGTERM', {
    stdout: LEAK,
    stderr: DIAG,
    code: null,
    signal: 'SIGTERM',
    killed: true,
  });

const sectionRefusal = (): Error =>
  gitError('exit 128', {
    stderr: "error: Could not remove config section 'remote.dup'\n",
    code: 128,
  });

type Answer = string | Error;

/** Queues runGit answers in order: a string resolves, an Error rejects. */
function queue(...answers: Answer[]): void {
  for (const answer of answers) {
    if (answer instanceof Error) runGit.mockRejectedValueOnce(answer);
    else runGit.mockResolvedValueOnce(answer);
  }
}

// Config dumps without any remote record (NONE_ORIGIN origin-annotated).
const NONE = 'local\u0000core.x\ny\u0000';
const WT_NONE = 'worktree\u0000core.x\ny\u0000';
const NONE_ORIGIN = 'local\u0000file:.git/config\u0000core.x\ny\u0000';
const GONE_PREFLIGHT =
  'local\u0000file:.git/config\u0000remote.gone.url\nhttps://example.com/g\u0000';
const PUSH_ALIAS =
  'local\u0000url.https://example.com/.pushinsteadof\ngone\u0000';
const WORKTREE_DUP =
  'worktree\u0000file:.git/config.worktree\u0000remote.dup.url\nhttps://example.com/w.git\u0000';
const SURVIVOR_WRITE = 'config --local --add branch.feat.remote survivor';
const MERGE_READ = 'config --local --includes --get-all -z branch.feat.merge';
const REFS_READ = 'for-each-ref --format=%(refname) refs/remotes/';
const STILL_CONFIGURED = /remote still configured after removal/;

/** Snapshot: `branch` tracks `name` in worktree scope, `survivor` locally. */
const shadowed = (branch: string, name: string) =>
  `local\u0000branch.${branch}.remote\nsurvivor\u0000worktree\u0000branch.${branch}.remote\n${name}\u0000`;

const PROBES: Answer[] = [
  '.git\n', // rev-parse --git-dir
  '.git\n', // rev-parse --git-common-dir
  '/repo\n', // rev-parse --show-toplevel
];

type Start = { preflight?: string; snapshot?: string };

/** Reads before `git remote remove`: pre-flight, the probes, the snapshot. */
function removalStart({
  preflight = NONE_ORIGIN,
  snapshot = NONE,
}: Start = {}) {
  return [preflight, ...PROBES, snapshot];
}

/** removalStart, then a successful `git remote remove`. */
const removed = (start?: Start) => [...removalStart(start), ''];

// After the removal: the listing and its all-scope verification find
// nothing and ls-remote echoes the bare name back.
const LISTED_GONE: Answer[] = [
  '.git\n', // rev-parse probe
  NONE, // listing read
  NONE, // all-scope section verify
  'origin\n', // ls-remote --get-url: name echoed = gone
];

/** A tracking-refs read (or re-verify) that finds nothing. */
const noRefs = (): Answer[] => [
  '', // for-each-ref (empty)
  '', // remote list (empty)
  noMatchError(), // fetch refspec dests (none)
];

// Tracking-refs sweep, then its re-verify (for-each-ref, git remote, fetch
// dest namespaces): every read empty.
const EMPTY_REF_SWEEPS: Answer[] = ['', '', '', '', '', ''];

/** A clean certified removal of origin up to the sibling-worktree list. */
function throughSweep(): Answer[] {
  return [
    ...removed(),
    ...LISTED_GONE,
    ...noRefs(), // tracking-refs read
    ...noRefs(), // tracking-refs re-verify
    NONE, // (worktree) sweep read
    NONE, // (worktree) sweep re-verify
  ];
}

/**
 * Removes `name` from the shadowed snapshot (feat pointed in worktree
 * scope, local survivor backup); the restore's presence reads then find
 * an include-held residue (--get-all frames values bare) and no pushremote.
 */
function shadowRemoved(name: string, preflight: string): Answer[] {
  return [
    ...removed({ preflight, snapshot: shadowed('feat', name) }),
    `${name}\u0000`, // restore remote presence read
    '', // restore pushremote presence read
  ];
}

const settle = (p: Promise<unknown>) => p.catch((e: unknown) => e);
const stdio = (err: unknown) => err as { stdout?: unknown; stderr?: unknown };

/** fetchGitRemotes after a good rev-parse probe, then `reads`. */
function listing(...reads: Answer[]) {
  queue('.git\n', ...reads);
  return fetchGitRemotes('/repo');
}

/**
 * Removes `name`: what it rejected with, and the git argument lines it
 * spawned. Sliced from this call's own start: the mock is module-level and
 * accumulates across tests, so an earlier test's spawns (its `remote
 * remove`) would otherwise satisfy index lookups.
 */
async function remove(name: string) {
  const base = runGit.mock.calls.length;
  const err = await settle(gitRemoteRemove('/repo', name));
  const spawned = runGit.mock.calls
    .slice(base)
    .map((c) => (c[1] as string[]).join(' '));
  return { err, spawned };
}

/** A killed read rethrown with its stdout stripped (and `stderr` kept). */
function expectStrippedKill(err: unknown, stderr?: string): void {
  expect(err).toMatchObject({ killed: true });
  expect(stdio(err).stdout).toBe('');
  if (stderr !== undefined) expect(stdio(err).stderr).toBe(stderr);
}

function expectStillConfigured(err: unknown): void {
  expect((err as Error | undefined)?.message).toMatch(STILL_CONFIGURED);
}

describe('fetchGitRemotes config-read failure discrimination', () => {
  it('rethrows a killed config read instead of answering an empty list', async () => {
    await expect(listing(killError())).rejects.toMatchObject({ killed: true });
  });

  it('answers an empty list for git no-match (exit 1, no output)', async () => {
    await expect(listing(noMatchError())).resolves.toEqual([]);
  });

  it('rethrows a timeout kill that exits 1 instead of reading no-match', async () => {
    await expect(listing(killedExit1Error())).rejects.toMatchObject({
      killed: true,
    });
  });

  it('rethrows an exit-1 read that carries stderr', async () => {
    await expect(listing(exit1WithStderr())).rejects.toMatchObject({ code: 1 });
  });

  it('strips the config dump from a killed read before rethrowing', async () => {
    const err = await settle(listing(killedDumpError()));
    expect(err).toBeInstanceOf(Error);
    expect(stdio(err).stdout).toBe('');
    expect(stdio(err).stderr).toBe(DIAG);
  });

  it('fails the add pre-flight closed on a killed scope read', async () => {
    // A killed scope read must not read as "no inherited collision", and
    // its partial all-scope dump must not reach the client.
    queue('.git\n', killedDumpError()); // rev-parse probe, scope read
    const add = gitRemoteAdd('/repo', 'origin', 'https://example.com/o/r.git');
    expectStrippedKill(await settle(add), DIAG);
  });

  it('fails the removal closed on a killed toplevel probe', async () => {
    // A killed --show-toplevel is not a bare-repo answer: reading the
    // origins against the wrong base would refuse every removal from a
    // subdir cwd, so the kill must surface.
    // Origin pre-flight, --git-dir and --git-common-dir, then the kill.
    queue(NONE_ORIGIN, ...PROBES.slice(0, 2), killedDumpError());
    expectStrippedKill((await remove('origin')).err);
  });

  it('refuses a removal over an unknown-scope upstream survivor', async () => {
    // Apple Git labels its runtime-prefix defaults file scope `unknown`:
    // the records are real and git resolves them, so the survivor fold
    // must see them — a record the fold drops would certify a dangling
    // upstream this gate exists to refuse.
    queue(
      ...throughSweep(),
      '', // worktree list --porcelain
      'unknown\u0000branch.main.remote\norigin\u0000', // survivor read
    );
    const { err, spawned } = await remove('origin');
    expectStillConfigured(err);
    expect(spawned).toHaveLength(20);
  });

  it('fails the removal closed on a killed worktree-list read', async () => {
    // The sibling sweep's enumeration is a read like any other: a kill
    // must not certify while a sibling's config.worktree goes unread.
    queue(...throughSweep(), killedDumpError()); // worktree list --porcelain -z
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err);
    expect(spawned).toHaveLength(19);
  });

  it('fails the removal closed on a killed sibling worktree read', async () => {
    // A live sibling in the list, then its config.worktree read dies:
    // the sweep cannot certify what it never read.
    queue(
      ...throughSweep(),
      'worktree /other\0\0', // one sibling
      '/repo\n', // rev-parse --show-toplevel (lazy)
      '/repo/.git\n', // sibling common-dir probe (at /other)
      '.git\n', // own common-dir probe (lazy, at cwd)
      killedDumpError(), // sibling config read
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err);
    expect(spawned).toHaveLength(23);
    // Pin WHERE the kill landed: the sibling's config.worktree read, not
    // one of the ownership probes — otherwise the test passes while
    // testing a different spawn.
    expect(spawned.at(-1)).toBe('config --worktree --list -z');
  });

  it('fails the converge arm closed on a killed repo-path probe', async () => {
    // The converge gate's last conjunct probes whether a bare-word name
    // resolves as a local-path upstream — a killed probe must not read
    // as "not a repo" and let the sweep run over a blind answer.
    queue(
      ...removalStart(), // x pre-flight read, probes, snapshot
      noSuchRemoteError(), // git remote remove
      NONE, // scope read (empty of x)
      'x\n', // ls-remote --get-url: echo = unresolved
      killedDumpError(), // ls-remote -- x (path leg)
    );
    const { err, spawned } = await remove('x');
    expectStrippedKill(err);
    // The kill stops the chain: no sweep spawn (for-each-ref, config
    // --unset, worktree list) ever follows the blind probe.
    expect(spawned).toHaveLength(9);
  });

  it('rethrows a killed restore read on the error path instead of answering the 404', async () => {
    // The error-path restore runs BEFORE the converge classification:
    // with a non-empty local backup its presence read spawns, and a
    // killed read there masks git's original No-such-remote (the
    // client's stale-row convergence key) with the kill — fail-closed:
    // a rollback that cannot run must not surface as a plain 404.
    queue(
      // x pre-flight read; snapshot: main effectively tracks x, local copy
      // names survivor
      ...removalStart({ preflight: NONE, snapshot: shadowed('main', 'x') }),
      noSuchRemoteError(), // git remote remove
      killError(), // restore presence read
    );
    const { err, spawned } = await remove('x');
    expect(err).toMatchObject({ killed: true });
    expect(spawned).toHaveLength(7);
    // The 7th spawn must be the error-path RESTORE's presence read, not
    // the converge gate's scope read (on a module without the
    // error-path restore the kill lands there instead and this
    // assertion is what separates the two).
    expect(spawned[6]).toBe(
      'config --local --includes --get-all -z branch.main.remote',
    );
  });

  it('refuses when the worktree-section completion spawn itself is killed', async () => {
    // removeWorktreeScopeSection's catch swallows the completion
    // failure into `false`: the removal must then surface git's own
    // refusal (409), never certify a half-completed removal.
    queue(
      // pre-flight origin read: worktree record, editable
      ...removalStart({ preflight: WORKTREE_DUP, snapshot: WT_NONE }),
      sectionRefusal(), // git remote remove
      'worktree\u0000remote.dup.url\nhttps://example.com/w.git\u0000', // completion scope read: worktree only
      killedDumpError(), // the --worktree --remove-section completion
    );
    const { err, spawned } = await remove('dup');
    expect(String(stdio(err).stderr)).toContain(
      'Could not remove config section',
    );
    expect(stdio(err).stdout).toBe('');
    expect(spawned).toHaveLength(8);
  });

  it('refuses over an inherited record that races in after the pre-flight', async () => {
    // The certify-path union gate's section half is the backstop for a
    // survivor the pre-flight could not see (a concurrent global edit,
    // or the pre-flight's no-match fall-through): the post-removal
    // scope read grows an inherited record the pre-flight never saw.
    queue(
      ...removed({
        preflight:
          'local\u0000file:.git/config\u0000remote.origin.url\nhttps://example.com/o/r.git\u0000',
      }), // pre-flight origin read: repository record only
      '.git\n', // listing probe
      '', // listing read: the row is gone
      'global\u0000remote.origin.pushurl\nhttps://global.example/p.git\u0000', // union gate scope read: the inherited record raced in
    );
    const { err, spawned } = await remove('origin');
    expectStillConfigured(err);
    expect(spawned).toHaveLength(9);
  });

  it('does not complete a worktree section when an inherited record shares it', async () => {
    // removeWorktreeScopeSection's `scopes.size !== 1` conjunct: a worktree
    // survivor shadowed by an inherited record must NOT be completed (the
    // per-worktree URL would be deleted with no in-product recovery).
    queue(
      // pre-flight origin read: worktree record, editable
      ...removalStart({ preflight: WORKTREE_DUP, snapshot: WT_NONE }),
      sectionRefusal(), // git remote remove
      'worktree\u0000remote.dup.url\nhttps://example.com/w.git\u0000global\u0000remote.dup.url\nhttps://global.example/d.git\u0000', // completion scope read: worktree AND global
    );
    const { err, spawned } = await remove('dup');
    expect(String(stdio(err).stderr)).toContain(
      'Could not remove config section',
    );
    // The completion's `--worktree --remove-section` never spawned.
    expect(spawned).toHaveLength(7);
  });

  it('restores the shadowed local copy BEFORE any post-removal gate can fail', async () => {
    // The destroy shape: worktree-scope copy names the removed remote,
    // the local copy names a survivor. The listing read after rm is
    // killed — the restore must already have run (a gate failure must
    // not skip the rollback of git's own destruction).
    queue(
      ...removed({ snapshot: shadowed('feat', 'origin') }),
      '', // restore: branch.feat.remote read (absent)
      '', // restore: pushremote read (absent)
      '', // restore: the --add write
      '', // restore: merge read (absent)
      killedDumpError(), // rev-parse probe
    );
    const { err, spawned } = await remove('origin');
    expect(err).toMatchObject({ killed: true });
    const rmAt = spawned.indexOf('remote remove -- origin');
    const addAt = spawned.findIndex((c) =>
      c.includes('--local --add branch.feat.remote'),
    );
    // The restore's write landed after the removal and before the final
    // (killed) gate read — no post-removal gate can skip it.
    expect(rmAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(rmAt);
    expect(addAt).toBeLessThan(spawned.length - 1);
  });

  it('never puts a scp-like removed name on the network via the discount gate', async () => {
    // The discount gate's path leg probes `ls-remote -- <name>`; a scp-like
    // NAME (colon before the first slash) is a network transport git resolves
    // with no config record, so the gate must answer it on the string test (no
    // discount) and never spawn the probe — the include-held residue then
    // refuses through the swept-resolving re-verify, exactly as the bare-word
    // twin does. The name needs more than one character before the colon: on
    // win32 a single-character prefix (`h:p`) IS a drive path — git's
    // has_dos_drive_prefix takes any non-NUL char plus a colon — so the gate
    // must probe it as a local transport, and the assertion below would read
    // that probe as a leak.
    queue(
      ...shadowRemoved(
        'host:path',
        'local\u0000file:.git/config\u0000remote.host:path.url\nhttps://example.com/h\u0000',
      ),
      NONE, // gate scope read (no section)
      'host:path\n', // fixed: the merge read; a mutant without the sectionless skip spends this on the gate resolver echo and then spawns the path probe
      '.git\n', // listing probe
      '', // listing read: the row is gone
      '', // union gate scope read
      'host:path\n', // union gate resolver echo
      ...EMPTY_REF_SWEEPS,
      'local\u0000branch.feat.remote\nhost:path\u0000', // sweep dump
      '', // the fixed-value unset
      'local\u0000branch.feat.remote\nhost:path\u0000', // swept-resolving re-verify: the residue stands
    );
    const { err, spawned } = await remove('host:path');
    expectStillConfigured(err);
    // Drain discipline: a mutant that spends extra spawns here would
    // otherwise leak its unconsumed queue into the next witness.
    runGit.mockReset();
    expect(spawned).not.toContain('ls-remote -- host:path');
  });

  it('refuses the removal when a pushInsteadOf alias raced into the union gate dump', async () => {
    // The fetch-side resolver is blind to push aliases (git has no
    // push-side resolver probe), so the union gate reads them from the
    // same all-scope dump the section half uses — zero extra spawns.
    // The pre-flight owns the steady-state shape; this is the backstop
    // for an alias racing in after the pre-flight read.
    queue(
      ...removed({ preflight: GONE_PREFLIGHT }), // pre-flight: no alias yet
      '.git\n', // listing probe
      '', // listing read: the row is gone
      PUSH_ALIAS, // union gate dump: a push alias raced in, keeping `gone` push-live
      // Mutant path only (the alias conjunct dropped): the removal
      // continues into the resolver, the sweep and the surviving-keys
      // reads instead of refusing.
      'gone\n', // union gate resolver echo
      ...EMPTY_REF_SWEEPS,
      '', // sweep dump
      '', // swept-resolving read
      '', // sibling worktree list
      '', // surviving-keys dump
    );
    const { err, spawned } = await remove('gone');
    expectStillConfigured(err);
    runGit.mockReset();
    expect(spawned).toContain('config --list --show-scope -z');
    expect(spawned).not.toContain(REFS_READ);
  });

  it('swallows a killed gate probe into no-discount and lets a later gate surface the kill', async () => {
    // The discount gate's probe legs answer no-discount on ANY failure
    // (a kill included) instead of aborting the rollback loop: the kill
    // must still surface — the union gate re-runs the same resolver
    // read and rethrows it there — and the swallowed kill must not have
    // discounted the residue (no survivor write-back lands).
    queue(
      ...shadowRemoved('gone', GONE_PREFLIGHT),
      NONE, // gate scope read: the section is gone
      killError(), // gate resolver probe: killed -> no-discount inside the gate
      '', // restore merge read
      '.git\n', // listing probe
      '', // listing read: the row is gone
      '', // union gate scope read
      killError(), // union gate resolver probe: the kill surfaces here
    );
    const { err, spawned } = await remove('gone');
    expect(err).toMatchObject({ killed: true });
    runGit.mockReset();
    expect(spawned).not.toContain(SURVIVOR_WRITE);
    // The rollback loop ran past the swallowed kill (a gate that
    // rethrew it would have aborted before the merge arm).
    expect(spawned).toContain(MERGE_READ);
  });

  it('does not discount a push-side-live residue when the gate dump carries a pushInsteadOf alias', async () => {
    // Same push-alias leg inside the discount gate: with the section
    // gone, a `url.*.pushInsteadOf` prefix keeping the bare name
    // resolving push-side makes the include-held residue a LIVE push
    // upstream — the write-back must not shadow it under the refusal.
    queue(
      ...shadowRemoved('gone', GONE_PREFLIGHT), // pre-flight: no alias yet
      PUSH_ALIAS, // gate dump: no section, but a push alias raced in — push-live
      '', // restore merge read
      '.git\n', // listing probe
      '', // listing read: the row is gone
      PUSH_ALIAS, // union gate dump: same alias — refuses here
      // Mutant path only (the gate's alias conjunct dropped): the gate
      // runs the resolver + path probes and discounts the residue.
      'gone\n', // gate resolver echo
      gitError('exit 128', {
        stderr: "fatal: 'gone' does not appear to be a git repository",
        code: 128,
      }), // gate path probe: no such repo
    );
    const { err, spawned } = await remove('gone');
    expectStillConfigured(err);
    runGit.mockReset();
    expect(spawned).not.toContain(SURVIVOR_WRITE);
  });

  it('rethrows a killed gate scope read before any destructive cleanup', async () => {
    // The discount gate's SCOPE leg sits outside its try on purpose: a
    // killed config read there aborts the whole removal BEFORE the
    // destructive certified-removal cleanup, while a killed PROBE leg
    // answers no-discount inside the gate (witnessed beside this one).
    // Moving the scope leg into the try would swallow the kill and run
    // the merge arm, the listing, the union gate and — with a non-empty
    // downstream queue — the tracking-ref sweep and upstream-key unset
    // on a host condition the pristine code treats as stop-everything.
    queue(
      ...shadowRemoved('gone', GONE_PREFLIGHT),
      killError(), // gate SCOPE read: killed -> rethrow, stop everything
    );
    const { err, spawned } = await remove('gone');
    expect(err).toMatchObject({ killed: true });
    runGit.mockReset();
    // Neither the rollback loop nor any destructive cleanup ran past
    // the killed scope read.
    expect(spawned).not.toContain(MERGE_READ);
    expect(spawned).not.toContain(REFS_READ);
  });

  it('fails the removal closed on a killed restore read', async () => {
    // The restore runs right after rm (before every post-removal gate):
    // a killed read mid-restore must not certify the branch as handled.
    queue(
      ...removed({ snapshot: 'local\u0000branch.feat.remote\norigin\u0000' }), // snapshot: feat pointed
      killedDumpError(), // restore read
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err);
    expect(spawned).toHaveLength(7);
  });

  it('fails the removal closed on a killed resolver read', async () => {
    // A killed ls-remote is not a negative answer: a legacy
    // .git/remotes/<name> file could still resolve the removed name,
    // so the read must surface the kill (stripped), not certify.
    queue(
      ...removed(),
      '.git\n', // rev-parse probe
      NONE, // listing read
      NONE, // all-scope section verify
      killedDumpError(), // ls-remote --get-url
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err);
    expect(spawned).toHaveLength(10);
  });

  it('fails the removal verification closed on a killed scope read', async () => {
    // pointing-branches snapshot ok → remove ok → probe ok → repo-scope
    // re-read lists nothing → the all-scope verification read is killed:
    // reject, never certify, and never leak the partial dump.
    queue(
      ...removed(),
      '.git\n', // rev-parse probe
      NONE, // listing read
      killedDumpError(), // all-scope verification
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    // The exact call count pins the sequencing: an added or removed read
    // must not silently retarget the kill.
    expect(spawned).toHaveLength(9);
  });

  it('strips the dump from a killed pre-removal snapshot read', async () => {
    // The snapshot read precedes the mutation: a killed read must reject
    // stripped before `git remote remove` ever runs.
    queue(NONE_ORIGIN, ...PROBES, killedDumpError()); // snapshot read
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(5);
  });

  it('strips the dump from a killed origin pre-flight read before rm runs', async () => {
    // The include-origin pre-flight is the FIRST read of a removal: a
    // killed dump must reject stripped, and `git remote remove` must
    // never run on a blind answer.
    queue(killedDumpError());
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(1);
  });

  it('strips the dump from a killed branch-key read after removal', async () => {
    // snapshot finds one pointing branch → remove ok → probe ok →
    // listing empty → all-scope verification empty → tracking-refs read
    // empty → re-verify empty → the branch-key sweep read is killed
    // mid-dump: reject stripped, never certify past the guard.
    queue(
      ...removed({
        snapshot: 'worktree\u0000branch.feat.remote\norigin\u0000',
      }),
      '', // restore: local remote read (absent)
      '', // restore: local pushremote read (absent)
      ...LISTED_GONE,
      ...noRefs(), // tracking-refs read
      ...noRefs(), // tracking-refs re-verify
      killedDumpError(), // branch-key sweep read
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(19);
  });

  it('strips the dump from a killed upstream-survivor read after cleanup', async () => {
    // snapshot (no branch keys) → remove ok → probe ok → listing empty →
    // all-scope verification empty → tracking-refs read empty → re-verify empty
    // → worktree sweep read → worktree re-verify → the upstream-survivor read
    // is killed mid-dump: reject stripped, never certify past the guard.
    queue(
      ...throughSweep(),
      '', // worktree list --porcelain
      killedDumpError(), // upstream-survivor read
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(20);
  });

  it('fails the listing closed on a killed promisor badge read', async () => {
    // A promisor-carrying section costs one extra read; a KILLED badge
    // read is not a negative answer — the listing must reject rather
    // than render the remote without the badge the remove confirm
    // relies on, and the partial dump must not leave the module.
    const read = listing(
      'local\u0000remote.origin.url\nhttps://example.com/x.git\u0000local\u0000remote.origin.promisor\ntrue\u0000', // listing dump: one promisor-carrying section
      killedDumpError(), // the badge read
    );
    expectStrippedKill(await settle(read), DIAG);
  });

  it('does not read exit 1 with output on stdout as a no-match', async () => {
    // The empty-stdout arm is the deciding one here: a genuine git
    // failure carrying ANY output must surface, never answer [] .
    const exit1 = gitError('exit 1', {
      stdout: 'unexpected output on stdout\n',
      code: 1,
    });
    await expect(listing(exit1)).rejects.toMatchObject({ code: 1 });
  });

  it('strips the dump from a killed read whose stderr is empty too', async () => {
    // The real timeout-kill shape has stderr: '' — the strip must still
    // leave nothing but the error itself (no dump, no diagnostics).
    const kill = gitError('spawn git SIGTERM', {
      stdout: LEAK,
      code: null,
      signal: 'SIGTERM',
      killed: true,
    });
    expectStrippedKill(await settle(listing(kill)), '');
  });

  it('strips the dump from a killed tracking-refs read', async () => {
    // snapshot (no branch keys) → remove ok → probe ok → listing empty →
    // all-scope verification empty → the tracking-refs read is killed mid-dump:
    // reject stripped — "no refs" is not an answer a killed read may produce.
    queue(
      ...removed(),
      ...LISTED_GONE,
      killedDumpError(), // tracking-refs read
      '', // remote list (spawned alongside the killed for-each-ref)
      '', // fetch refspec dests (spawned alongside the killed for-each-ref)
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(13);
  });

  it('strips the dump from a killed tracking-refs re-verification', async () => {
    // … tracking-refs read finds ONE ref → the delete runs → the
    // re-verify read is killed mid-dump: reject stripped, never certify
    // the phantom group as cleaned.
    queue(
      ...removed(),
      ...LISTED_GONE,
      'refs/remotes/origin/main\n', // refs read
      '', // remote list (empty)
      noMatchError(), // fetch refspec dests (none)
      '', // update-ref -d
      killedDumpError(), // re-verify for-each-ref
      '', // remote list (spawned alongside the killed for-each-ref)
      '', // fetch refspec dests (spawned alongside the killed for-each-ref)
    );
    const { err, spawned } = await remove('origin');
    expectStrippedKill(err, DIAG);
    expect(spawned).toHaveLength(17);
  });
});
