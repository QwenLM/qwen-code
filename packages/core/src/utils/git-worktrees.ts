/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { runGit, runGitCapture, streamGitRecords } from './git-branches.js';
import { openNoFollow, openSyncNoFollow } from './no-follow-open.js';
import { NO_EXEC_CONFIG } from './gitUtils.js';

export interface GitWorktreeEntry {
  /** Absolute path as git records it. */
  path: string;
  head: string;
  /** Short branch name; `null` when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Present when the worktree is locked; the reason when git recorded one. */
  locked?: string;
  /**
   * Present when git has marked the entry stale: its directory is gone, or
   * the directory outlived its gitfile. git never marks a locked one.
   */
  prunable?: string;
  /** The repository's main worktree, which git lists first and never removes. */
  isMain: boolean;
}

/**
 * What a look for a nested repository found.
 *
 * Three answers, not two, because the caller is about to delete a directory:
 * a probe that could not look has not found nothing, and collapsing the two
 * is how a repository the user was never told about goes with the removal.
 */
export type NestedRepositoryAnswer = 'present' | 'absent' | 'unknown';

/** The answer that has to win when two looks disagree. */
function weightier(
  a: NestedRepositoryAnswer,
  b: NestedRepositoryAnswer,
): NestedRepositoryAnswer {
  if (a === 'present' || b === 'present') return 'present';
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return 'absent';
}

/**
 * Open a repository-written file without following a symlink or waiting on
 * a FIFO.
 *
 * Where the platform has `O_NOFOLLOW` the kernel refuses the link, and
 * `O_NONBLOCK` keeps a FIFO from holding the daemon's thread. Windows has no
 * `O_NOFOLLOW` — or'ing it in there opens straight through a link (#8227) —
 * so it goes through the shared helper's lstat-and-verify fallback instead;
 * and a FIFO is not something a path on its filesystems can be.
 */
const NO_FOLLOW = fs.constants.O_NOFOLLOW as number | undefined;
const POINTER_OPEN_FLAGS =
  fs.constants.O_RDONLY | (NO_FOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function openPointer(file: string): Promise<fsPromises.FileHandle> {
  return NO_FOLLOW === undefined
    ? openNoFollow(file)
    : fsPromises.open(file, POINTER_OPEN_FLAGS);
}

function openPointerSync(file: string): number {
  return NO_FOLLOW === undefined
    ? openSyncNoFollow(file)
    : fs.openSync(file, POINTER_OPEN_FLAGS);
}

/** How much of a repository-written pointer file is worth reading. */
const GITDIR_POINTER_MAX_BYTES = 8192;

/**
 * `target` with every symlink resolved, or `target` if it cannot be.
 *
 * git records the back-pointer with symlinks already resolved, so comparing
 * it against a path a caller holds — `/tmp/x` where git wrote `/private/tmp/x`
 * — would answer "different worktree" about the same directory.
 *
 * Exported because the daemon compares the same pair of paths: two spellings
 * of "the same directory" have to mean the same thing on both sides of that
 * comparison, and a second copy of this is how they come to disagree.
 * Deliberately not `realpathSync.native`, which asks the platform and gets
 * the on-disk spelling back: on a case-insensitive volume that answers with
 * a case git never recorded, and the comparison fails on a worktree that
 * merely changed case.
 */
export function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * `target` as the platform spells it, or `target` if it cannot be resolved.
 *
 * Unlike {@link realpathOrSelf} this asks the filesystem for the name it
 * actually holds, which differs from the caller's on a case-insensitive
 * volume and under Unicode normalisation. Use it to decide whether two paths
 * are the same place; use {@link realpathOrSelf} to compare against a path
 * git recorded, where git's own spelling is the one that has to match.
 */
export function realpathOnDiskOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return realpathOrSelf(target);
  }
}

/**
 * The worktree `<admin>/<id>/gitdir` points at, or `null`.
 *
 * Read whole rather than by line: git writes the path verbatim, and a path
 * may contain a newline — which is why the listing asks for `-z`. Opened
 * without following a symlink and without blocking on a FIFO, because the
 * repository chooses what is there. A relative pointer is resolved against
 * the directory holding it, which is what git writes it relative to.
 */
async function readGitdirPointer(
  adminEntryDir: string,
): Promise<string | null> {
  const read = await readGitdirPointerAnswer(adminEntryDir);
  return typeof read === 'object' ? read.at : null;
}

/**
 * {@link readGitdirPointer}, telling "there is no pointer" apart from "there
 * is one this will not read".
 *
 * git lists a worktree only through a pointer it can read, so an entry with
 * none — missing or empty — belongs to no listed worktree. One this refuses
 * to read — a symlink, a FIFO, one past the bound, one it is not allowed to
 * open — may well be the entry git read to list the worktree being asked
 * about, and answering about that worktree then means saying so.
 */
async function readGitdirPointerAnswer(
  adminEntryDir: string,
): Promise<{ at: string } | 'missing' | 'unreadable'> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await openPointer(path.join(adminEntryDir, 'gitdir'));
    const stat = await handle.stat();
    // Whole or nothing. A pointer longer than any path git writes is not one
    // this should read a prefix of: `path.dirname` of a cut-off path names a
    // real directory that was never meant, and the caller would authorise a
    // prune against it. Answer "cannot tell" instead.
    if (!stat.isFile() || stat.size > GITDIR_POINTER_MAX_BYTES) {
      return 'unreadable';
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.toString('utf8', 0, bytesRead).replace(/\s+$/, '');
    if (!raw) return 'missing';
    // Against the real directory holding it, not the spelling the caller
    // happened to use: a relative pointer resolved against `/tmp/x` answers
    // with a path git never wrote, and the worktree it names is usually gone
    // — so nothing further can resolve it back.
    return {
      at: realpathOrSelf(
        path.dirname(path.resolve(realpathOrSelf(adminEntryDir), raw)),
      ),
    };
  } catch (err) {
    return saysNothingIsThere(err) ? 'missing' : 'unreadable';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function attribute(line: string, key: string): string | undefined {
  if (line === key) return '';
  return line.startsWith(`${key} `) ? line.slice(key.length + 1) : undefined;
}

/** Parse `git worktree list --porcelain -z` output. */
export function parseGitWorktreeList(raw: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of raw.split('\0')) {
    if (line === '') {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const worktreePath = attribute(line, 'worktree');
    if (worktreePath !== undefined) {
      current = {
        path: worktreePath,
        head: '',
        branch: null,
        detached: false,
        bare: false,
        isMain: entries.length === 0,
      };
      continue;
    }
    if (!current) continue;
    const head = attribute(line, 'HEAD');
    const branch = attribute(line, 'branch');
    const locked = attribute(line, 'locked');
    const prunable = attribute(line, 'prunable');
    if (head !== undefined) current.head = head;
    else if (branch !== undefined)
      current.branch = branch.replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (locked !== undefined) current.locked = locked;
    else if (prunable !== undefined) current.prunable = prunable;
  }
  if (current) entries.push(current);
  return entries;
}

/** List every worktree of the repository containing `cwd`, main first. */
export async function listGitWorktrees(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitWorktreeEntry[]> {
  const raw = await runGit(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'list', '--porcelain', '-z'],
    env,
  );
  return parseGitWorktreeList(raw);
}

/**
 * Remove one linked worktree, and only that one.
 *
 * Without `force` git refuses a worktree with uncommitted changes or a lock;
 * callers decide when to override. A worktree whose directory has already
 * disappeared is dropped without `force`, because git validates `<path>/.git`
 * only when the directory is there to validate — which is also why this
 * rejects, at every force level, a registration git can no longer validate:
 * a directory that outlived its gitfile (`fatal: validation failed …
 * '<path>/.git' does not exist`), a `.git` that is not a gitfile, or one
 * pointing at another repository. {@link pruneGitWorktrees} clears the first
 * of those; the rest need a hand at a terminal.
 */
export async function removeGitWorktree(
  cwd: string,
  worktreePath: string,
  options: { force?: boolean } = {},
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  // A worktree's own repository chooses `core.fsmonitor`, and git refreshes
  // the index — running it — on the status check the non-forced removal
  // makes. The shared `runGit` these go through does not scrub those keys,
  // so every git call in this file passes them itself; closing it in
  // `runGit` would cover the branch and remote helpers too.
  await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'worktree',
      'remove',
      ...(options.force ? ['--force', '--force'] : []),
      '--',
      worktreePath,
    ],
    env,
  );
}

/**
 * Whether any branch, remote-tracking branch or tag contains `commit`.
 *
 * A detached worktree is the only thing pointing at its own HEAD, so removing
 * it can be the last reference to those commits. Refs are shared across a
 * repository's worktrees, so this asks from anywhere in it.
 */
export async function commitIsReachable(
  cwd: string,
  commit: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const out = await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'for-each-ref',
      '--count=1',
      '--contains',
      commit,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    env,
  );
  return out.trim().length > 0;
}

/**
 * Whether this worktree's checkout holds a repository of its own.
 *
 * A submodule checked out inside a worktree keeps its own repository — under
 * the worktree's admin directory once git has absorbed it, inside its own
 * working directory before that — and a forced removal deletes it with
 * everything else, including commits the superproject's branch still names.
 *
 * Asked the way git asks it: the index names gitlinks, and a gitlink whose
 * path holds a repository is what `git worktree remove` refuses on. Not
 * `git submodule status`, which answers from `.gitmodules` rather than the
 * index — it says nothing about a gitlink with no mapping, and exits 128 on
 * one, which would take every properly mapped submodule beside it down with
 * the error.
 */
export async function worktreeHoldsSubmodules(
  worktreePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<NestedRepositoryAnswer> {
  let answer: NestedRepositoryAnswer = 'absent';
  // Streamed, not buffered: the index is as large as the repository, and a
  // buffered read of a monorepo's index fails. Records stay bytes until a
  // path is taken out of one, because git writes paths as the bytes they are
  // and a decoded-then-split stream loses the ones that are not UTF-8.
  await streamGitRecords(
    worktreePath,
    [...NO_EXEC_CONFIG, 'ls-files', '--stage', '-z'],
    (record) => {
      // `<mode> <sha> <stage>\t<path>`; gitlinks are mode 160000.
      if (!record.subarray(0, GITLINK_MODE.length).equals(GITLINK_MODE)) {
        return false;
      }
      const tab = record.indexOf(0x09);
      if (tab === -1) return false;
      const bytes = record.subarray(tab + 1);
      const name = bytes.toString('utf8');
      // A path that does not survive decoding names some other directory,
      // so what is at its real path cannot be looked at — and a look that
      // could not happen is not a look that found nothing.
      answer = Buffer.from(name, 'utf8').equals(bytes)
        ? weightier(
            answer,
            pathHoldsRepository(path.resolve(worktreePath, name)),
          )
        : weightier(answer, 'unknown');
      return answer === 'present';
    },
    env,
  );
  return answer;
}

/** `ls-files --stage` begins a gitlink's record with its mode. */
const GITLINK_MODE = Buffer.from('160000 ');

/**
 * The registrations `git worktree prune` would drop, by admin-directory name.
 *
 * `git worktree list` is not the same set: a registration whose `gitdir` file
 * is missing or empty is absent from the listing, cannot be locked, and is
 * dropped by prune all the same — taking the HEAD and reflog that may be the
 * last anchor for commits no ref contains. This asks git what it would do
 * rather than inferring it from what it shows.
 */
export async function dryRunGitWorktreePrune(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Array<{ id: string | null; worktreePath: string | null }>> {
  // `-v` reports on stderr, so reading stdout alone would answer "nothing".
  const { stdout, stderr } = await runGitCapture(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'prune', '-n', '-v'],
    env,
  );
  const report = `${stdout}\n${stderr}`;
  const named: Array<string | null> = report
    .split('\n')
    .map((line) => /^Removing worktrees\/(.+): /.exec(line.trim())?.[1])
    .filter((id): id is string => id !== undefined);
  // git announces one registration per line and writes the admin directory's
  // name into it verbatim — and that name belongs to the repository, which
  // may put a newline in it. A line parser then loses the announcement
  // entirely. Count the announcements instead of trusting the lines, and
  // stand in for every one that could not be read: a registration nobody can
  // name is still a registration prune would take, and the caller has to see
  // it to refuse rather than be told the coast is clear.
  const announcements = report.split('Removing worktrees/').length - 1;
  while (named.length < announcements) named.push(null);
  if (named.length === 0) return [];
  // Anything in that directory which is not a directory is a stray file —
  // a `.DS_Store`, a half-written temporary — and prune names it too. It
  // holds no registration and no commits, so counting it would fail a
  // removal for a reason that has nothing to do with any worktree.
  const commonDir = (
    await runGit(cwd, [...NO_EXEC_CONFIG, 'rev-parse', '--git-common-dir'], env)
  ).trim();
  const admin = path.resolve(cwd, commonDir, 'worktrees');
  const entries: Array<{ id: string | null; worktreePath: string | null }> = [];
  for (const id of named) {
    if (id === null) {
      entries.push({ id: null, worktreePath: null });
      continue;
    }
    const entryPath = path.join(admin, id);
    if (isSymlink(entryPath)) {
      // An admin entry that is a link is not one git made, and prune
      // follows a link to a directory and empties whatever it names — which
      // can be anywhere on disk. So it is counted and never attributed: a
      // pointer inside it naming the worktree being removed must not be
      // able to authorise that. That holds for a link that leads nowhere or
      // to a file too: what it leads to is only known now, and the prune
      // runs later — a directory made at its target in between is what it
      // would empty. Refusing costs a removal the user can retry once the
      // link is gone; the alternative costs whatever directory it names.
      entries.push({ id, worktreePath: null });
      continue;
    }
    let dir;
    try {
      dir = fs.statSync(entryPath);
    } catch {
      // Anything that cannot be looked at stays a registration.
      entries.push({ id, worktreePath: null });
      continue;
    }
    if (!dir.isDirectory()) continue;
    // An entry with nothing in it holds no back-pointer, no HEAD and no
    // reflog, so it is litter in the same sense a stray file is. One that has
    // lost only its `gitdir` still holds the commits this exists to protect.
    try {
      if (fs.readdirSync(path.join(admin, id)).length === 0) continue;
    } catch {
      // Unreadable: treated as a registration, which fails closed.
    }
    // The admin side records the worktree it belongs to, and keeps doing so
    // after the worktree's own gitfile is gone — which is the whole shape
    // this fallback exists for. A caller can therefore tell whether the one
    // entry prune would drop is the one it asked about, rather than trusting
    // that a count of one means the right one.
    entries.push({
      id,
      worktreePath: await readGitdirPointer(path.join(admin, id)),
    });
  }
  return entries;
}

/** Whether the error says nothing is there, rather than that we cannot look. */
function saysNothingIsThere(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What stat says about `target`, with "cannot look" kept apart from "no". */
function lookAt(target: string): fs.Stats | 'absent' | 'unknown' {
  try {
    return fs.statSync(target);
  } catch (err) {
    return saysNothingIsThere(err) ? 'absent' : 'unknown';
  }
}

/** Whether `<admin>/<id>/modules` holds a repository, not merely exists. */
function adminEntryHoldsModules(adminEntryDir: string): NestedRepositoryAnswer {
  const modules = path.join(adminEntryDir, 'modules');
  const entry = lookAt(modules);
  if (typeof entry === 'string') return entry;
  if (!entry.isDirectory()) return 'absent';
  try {
    // git refuses a removal on the directory's mere existence, but an empty
    // one holds nothing to lose, and warning about it would name a loss that
    // cannot happen.
    return fs.readdirSync(modules).length > 0 ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** Whether `<at>` holds a repository of its own, rather than any `.git`. */
function pathHoldsRepository(at: string): NestedRepositoryAnswer {
  const dot = lookAt(path.join(at, '.git'));
  if (typeof dot === 'string') return dot;
  if (dot.isDirectory()) {
    // An empty `.git` directory, or a directory of unrelated files, is not
    // a repository — and calling it one puts a sentence about a loss in
    // front of git's own, more exact, refusal.
    const head = lookAt(path.join(at, '.git', 'HEAD'));
    return typeof head === 'string' ? head : 'present';
  }
  return gitfileAnswer(at);
}

/**
 * Whether the admin side of this worktree holds a submodule's own repository.
 *
 * Removing a registration takes `<admin>/<id>/` with it, and a submodule
 * checked out in that worktree keeps its own repository under
 * `<admin>/<id>/modules/<name>`. `git submodule status` needs a checkout to
 * answer, so for the shapes that have none this reads the admin side
 * instead — and those are the shapes that need it most: git refuses to
 * remove a worktree whose `<admin>/<id>/modules` exists only while the
 * checkout is still there, and deletes the admin directory without a word
 * once it is gone.
 *
 * Which admin entry belongs to this worktree is decided by the back-pointer
 * and nothing else. The worktree's own gitfile names an entry too, and
 * reading it would be one stat rather than one read per registration — but
 * it names whatever it was last written with, and a directory renamed by
 * hand rather than with `git worktree move` leaves one worktree's gitfile
 * naming another's entry. The scan costs a read per registration on a
 * repository with many; the answer decides whether a repository is deleted
 * without being mentioned, so it is the back-pointer that answers.
 */
export async function worktreeAdminHoldsModules(
  cwd: string,
  worktreePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<NestedRepositoryAnswer> {
  const commonDir = (
    await runGit(cwd, [...NO_EXEC_CONFIG, 'rev-parse', '--git-common-dir'], env)
  ).trim();
  const admin = realpathOrSelf(path.resolve(cwd, commonDir, 'worktrees'));
  const wanted = realpathOrSelf(worktreePath);
  let ids: string[];
  try {
    ids = fs.readdirSync(admin);
  } catch (err) {
    return saysNothingIsThere(err) ? 'absent' : 'unknown';
  }
  let answer: NestedRepositoryAnswer = 'absent';
  const found: string[] = [];
  let doubt = false;
  for (const id of ids) {
    const back = await readGitdirPointerAnswer(path.join(admin, id));
    // No pointer at all: git cannot have listed this worktree through it.
    if (back === 'missing') continue;
    if (back === 'unreadable') {
      // git may have read this pointer where this will not, so it may be
      // the entry being asked about — and if it holds a repository, that is
      // one this cannot rule out. Held until the scan is over, and set
      // aside only if the worktree's own gitfile names an entry that was
      // read: that is the entry git validates and acts on. Without that —
      // no checkout left, or two entries naming the same path — git picks
      // by directory order, and the unreadable one may be its pick.
      if (adminEntryHoldsModules(path.join(admin, id)) !== 'absent') {
        doubt = true;
      }
      continue;
    }
    if (back.at !== wanted) continue;
    found.push(realpathOrSelf(path.join(admin, id)));
    // Any of them may be the one holding it: a first match without `modules`
    // answering for the rest would miss the repository behind it.
    answer = weightier(answer, adminEntryHoldsModules(path.join(admin, id)));
    if (answer === 'present') return answer;
  }
  if (!doubt) return answer;
  const own = gitfileTarget(worktreePath);
  return own !== null && found.includes(own)
    ? answer
    : weightier(answer, 'unknown');
}

/**
 * The admin entry `<worktree>/.git` names, or `null` when there is no
 * gitfile this will read. Opened like every pointer here: without following
 * a link or waiting on a FIFO, and never past the bound.
 */
function gitfileTarget(worktreePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openPointerSync(path.join(worktreePath, '.git'));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > GITDIR_POINTER_MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const raw = buffer.toString('utf8', 0, read).replace(/\s+$/, '');
    if (!raw.startsWith('gitdir: ')) return null;
    return realpathOrSelf(
      path.resolve(realpathOrSelf(worktreePath), raw.slice('gitdir: '.length)),
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Whether `<at>/.git`, a file, is a gitfile naming a repository.
 *
 * Bounded, symlink-free and non-blocking for the same reason the
 * back-pointer is: the checkout is somewhere a repository can write, and
 * this runs on the daemon's own thread. A FIFO left here would otherwise
 * hold that thread — and so every workspace and every session — until
 * somebody wrote to it.
 */
function gitfileAnswer(at: string): NestedRepositoryAnswer {
  let fd: number | undefined;
  try {
    fd = openPointerSync(path.join(at, '.git'));
    const stat = fs.fstatSync(fd);
    // A FIFO, a socket: not a repository, and nothing that holds one.
    if (!stat.isFile()) return 'absent';
    if (stat.size > GITDIR_POINTER_MAX_BYTES) return 'unknown';
    const buffer = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, read).startsWith('gitdir: ')
      ? 'present'
      : 'absent';
  } catch (err) {
    return saysNothingIsThere(err) ? 'absent' : 'unknown';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already gone.
      }
    }
  }
}

/** Take git's own lock on a worktree, which prune then skips. */
export async function lockGitWorktree(
  cwd: string,
  worktreePath: string,
  reason: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(
    cwd,
    [
      ...NO_EXEC_CONFIG,
      'worktree',
      'lock',
      '--reason',
      reason,
      '--',
      worktreePath,
    ],
    env,
  );
}

/** Release {@link lockGitWorktree}. */
export async function unlockGitWorktree(
  cwd: string,
  worktreePath: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(
    cwd,
    [...NO_EXEC_CONFIG, 'worktree', 'unlock', '--', worktreePath],
    env,
  );
}

/**
 * Drop every registration git has already marked prunable.
 *
 * Repository-wide by nature: git offers no per-path form, so this is the last
 * resort for the registrations {@link removeGitWorktree} cannot clear and git
 * has marked prunable. It deletes no files — a directory that outlived its
 * gitfile keeps its contents — and it skips locked worktrees, which git never
 * marks prunable anyway.
 */
export async function pruneGitWorktrees(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await runGit(cwd, [...NO_EXEC_CONFIG, 'worktree', 'prune'], env);
}
