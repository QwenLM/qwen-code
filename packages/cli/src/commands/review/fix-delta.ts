/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review fix-delta`: what `--fix` actually changed, as a diff — the fix
// auditor's input (Step 6B).
//
// The question the audit asks is about the EDIT, not the diff under review: a
// local review's tree already carries the user's uncommitted change, and the
// fixer's hunks land on top of it, so `git diff HEAD` after the edits is the
// user's change and the fix together, indistinguishable. The edit is the
// difference between two states of the same working tree — before the first
// `edit` call and after the last — so this command records the first state and
// diffs the second against it.
//
// The record is a git tree object, written through a THROWAWAY index: read
// HEAD into it, `add -A` the working tree, `write-tree`. The user's own index
// is never written (a `--fix` review runs in their checkout, and their staging
// state is theirs), the stash stack is never touched (it is shared across
// worktrees and other sessions), and nothing is checked out or reset. The tree
// object is unreferenced garbage after the review — the same thing `git stash
// create` leaves behind — and `add -A` is what decides what counts: modified,
// deleted and untracked-unignored files, which is exactly the set a fix's test
// file lands in.
//
// The review's own side files are excluded from the diff by pathspec, not by
// hoping they are ignored: the ledger, the artifact and the snapshot itself are
// written between the two states, and a hunks file that carried them would
// hand the auditor its own bookkeeping as an edit to audit.

import type { CommandModule } from 'yargs';
import type { Dirent } from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  git,
  gitOpt,
  gitRaw,
  gitWithEnv,
  gitWithEnvRaw,
  gitWithEnvReport,
  gitWithInputRaw,
} from './lib/git.js';

/** What `--snapshot` writes and `--since` reads back. */
export interface FixSnapshot {
  /** The repository root the tree was taken in — a snapshot is not portable. */
  root: string;
  /** The tree object recording the working tree at snapshot time. */
  tree: string;
  /**
   * Paths already holding CONFIRMED invisible edits at snapshot time:
   * submodule checkouts and nested git repositories, including ones a
   * symlink reaches or an ignored directory hides. Unconfirmed states —
   * paths the probe cannot open or resolve — never enter the baseline:
   * stamped as pre-existing, they would filter a fix's real edit out of the
   * warning into a false all-clear. Dirt that predates the fix is not the
   * fix's doing: a no-op fix in such a repository must still hear the
   * all-clear, not a claim that invisible edits exist. Identities are
   * keyed on the raw path bytes (latin1-encoded) — the display decode is
   * not injective — so the `--since` comparison matches exactly the paths
   * the probe recorded.
   */
  dirtySubmodules: string[];
  /**
   * Per path the probe could ANSWER for — dirty or clean — a digest of the
   * state observed inside it at snapshot time: its uncommitted entries and
   * its identity (HEAD, branch, stash count). "Already dirty" as a bare
   * boolean filtered every later edit inside such a path into the
   * pre-existing note — a level-2 submodule holding nothing but a moved
   * inner gitlink (the everyday `submodule update --remote` shape) was
   * enough to stamp its parent, after which a fix's real edit inside it
   * was reported as dirt that was already there and the audit all-cleared
   * hunks the edit is missing from. With the digest the claim is
   * checkable: pre-existing dirt is dirt whose INSIDE is the same state it
   * was, and anything else — including a path whose digest either run
   * could not take — is disclosed as a blind spot. Clean paths carry a
   * digest too, because "clean" is not "unchanged": content committed or
   * stashed inside a nested repository leaves its status empty at both
   * moments while the superproject tree records none of it, and only the
   * identity in the digest can tell the two moments apart. Keyed on the
   * same raw-byte (latin1) identities as `dirtySubmodules`.
   */
  digests: Record<string, string>;
}

/**
 * The review's own NAME families under `.qwen/tmp` — everything the flow
 * creates between the two states: the side files (`qwen-review-{target}-*`)
 * and the worktree family (`review-pr-*`). Keyed on the names the flow
 * itself writes, never on whole directories: content a user's repository
 * tracks under `.qwen/tmp` or `.qwen/reviews` is ordinary reviewable
 * content — a finding can anchor on it and `--fix` can edit it, and a
 * directory-wide exclusion dropped exactly that edit from both capture and
 * comparison. The same holds for a TRACKED path whose name matches a
 * family: the flow writes its side files untracked, so a tracked match is
 * user content, and the capture records it after the exclusion has done
 * its work on the untracked half (see `snapshotWorkingTree`).
 */
export const FIX_DELTA_EXCLUDES = [
  '.qwen/tmp/qwen-review-*',
  '.qwen/tmp/review-pr-*',
] as const;

/**
 * The command's own side paths — the `--out` file, and in `--since` mode the
 * `--since` snapshot itself — relative to `root` when they fall inside it.
 * The name families above are keyed on what the REVIEW flow writes; but
 * `fix-delta` is a public subcommand whose `--out` takes any path with no
 * location validation, and one that resolves inside the repository outside
 * those families is captured by the next snapshot and enters the very hunks
 * the exclusion exists to keep clean. Each is excluded literally, the same
 * way the in-tree git dir is.
 */
function inRepoSidePaths(
  root: string,
  candidates: Array<string | undefined>,
): string[] {
  const rels = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const rel = relative(root, resolve(candidate));
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      continue;
    }
    rels.add(rel);
  }
  return [...rels];
}

/**
 * The git directory's path relative to `root` when it sits INSIDE the
 * worktree, otherwise null. A checkout normally cannot see its git dir — git
 * never records the conventional `.git` — but `git init --separate-git-dir`
 * and `.git` files that redirect into the tree make it ordinary capturable
 * content there: without an exclusion the snapshot trees would carry the
 * whole git dir, and the loose objects `write-tree` creates between the two
 * states would flood the hunks with object churn.
 */
function inTreeGitDir(root: string): string | null {
  const gitDir = git('-C', root, 'rev-parse', '--absolute-git-dir');
  const rel = relative(root, gitDir);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  return rel;
}

/**
 * The exclusion is lexical — a symlink planted at an excluded directory
 * redirects every side-file write through it into a physical path no
 * pathspec matches, so the capture would report the review's own
 * bookkeeping (or an attacker's content) as fix edits. The command's own
 * side paths are refused the same way: the directory check lstats only the
 * PREFIXES of the excluded directories, so a link planted at the
 * deterministic `--out` name itself would redirect the write — or, in
 * `--since` mode, the baseline read — through it. Refuse, the way
 * `releaseWorktree` refuses a redirected ancestor: the failure direction
 * stops the run, it never contaminates it. Overwriting an existing REGULAR
 * side file stays allowed — Step 6B re-runs with the same name every round.
 */
function assertNoRedirectedExcludes(
  root: string,
  sidePaths: ReadonlyArray<string | undefined>,
): void {
  const targets = new Set<string>();
  for (const chain of [join('.qwen', 'tmp'), inTreeGitDir(root) ?? '']) {
    let acc = '';
    for (const part of chain.split(sep)) {
      if (part === '') continue;
      acc = acc === '' ? part : join(acc, part);
      targets.add(acc);
    }
  }
  for (const rel of targets) {
    let link = false;
    try {
      link = lstatSync(join(root, rel)).isSymbolicLink();
    } catch {
      continue;
    }
    if (link) {
      throw new Error(
        `fix-delta: excluded directory ${rel} is a symlink; refusing to ` +
          'write side files outside the exclusion.',
      );
    }
  }
  for (const p of sidePaths) {
    if (p === undefined) continue;
    let link = false;
    try {
      link = lstatSync(resolve(p)).isSymbolicLink();
    } catch {
      continue;
    }
    if (link) {
      throw new Error(
        `fix-delta: side path ${p} is a symlink; refusing to write through ` +
          'the redirect.',
      );
    }
  }
}

/**
 * Record the working tree under `root` as a tree object and return its sha.
 * Runs through a throwaway index so the user's index is untouched.
 */
export function snapshotWorkingTree(
  root: string,
  sidePaths: readonly string[] = [],
): string {
  // The scratch index must live OUTSIDE anything the snapshot can capture:
  // os.tmpdir() honours TMPDIR, and a hermetic sandbox pointing it inside the
  // worktree made `add -A` record the scratch directory itself into the
  // trees — the command's own temp files reported as fix edits. The git dir
  // is the usual such place, and the rare repository whose git dir sits
  // inside its worktree is covered by the git-dir exclusion in
  // `excludePathspec`, which keeps the scratch dir out of the trees with it.
  const gitDir = git('-C', root, 'rev-parse', '--absolute-git-dir');
  const scratch = mkdtempSync(join(gitDir, 'qwen-fix-delta-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    // An unborn HEAD (a repo with no commit yet) has no tree to seed from —
    // start empty, and `add -A` records everything as added.
    // Probed IN `root`, not in the process cwd: every other call here carries
    // `-C root`, and a bare `rev-parse HEAD` answers for whatever repository
    // the process happens to sit in.
    if (
      gitOpt('-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD') !== null
    ) {
      gitWithEnv(env, ['-C', root, ...probePins(root), 'read-tree', 'HEAD']);
    } else {
      gitWithEnv(env, ['-C', root, ...probePins(root), 'read-tree', '--empty']);
    }
    // `--sparse`: in a sparse-checkout repository `add` refuses to run once
    // ANY untracked file — e.g. this command's own side file — sits outside
    // the cone. Out-of-cone tracked entries drop identically from both trees,
    // so the delta is unaffected, and the flag is a no-op elsewhere.
    // `--ignore-errors`: the tolerated skip below must not stop the run from
    // recording everything else — without it the fatal aborts before the
    // throwaway index receives ANY of the other paths.
    const add = gitWithEnvReport(env, [
      '-C',
      root,
      ...probePins(root),
      'add',
      '-A',
      '--sparse',
      '--ignore-errors',
      '--',
      ...excludePathspec(root, sidePaths),
    ]);
    assertCompleteCapture(add);
    // The families are excluded above because the flow WRITES them between
    // the two states — as untracked files. A path the repository TRACKS
    // under a family name is not that: the flow never tracks its side
    // files, so a tracked match is user content by the `FIX_DELTA_EXCLUDES`
    // contract, and the glob dropped a fix's edit to it from both trees —
    // the hunks omitted a landed edit and the run printed "unchanged" over
    // it. Record the tracked half after the exclusion has removed the
    // untracked half: `-u` touches index entries only, so nothing the flow
    // wrote can ride in through it, and the set is enumerated from THIS
    // index (HEAD's tree) so that `-u` never meets a pathspec it cannot
    // match — git refuses the whole call on one, `--ignore-errors` or not.
    const tracked = trackedFamilyPaths(env, root, sidePaths);
    if (tracked.length > 0) {
      const update = gitWithEnvReport(
        env,
        [
          '-C',
          root,
          // The names are raw bytes and may hold glob characters: literal,
          // and through stdin rather than spawn args, which would coerce a
          // non-UTF-8 name to U+FFFD and update a path that does not exist.
          '--literal-pathspecs',
          ...probePins(root),
          'add',
          '-u',
          '--sparse',
          '--ignore-errors',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        Buffer.concat(tracked.flatMap((path) => [path, Buffer.from([0])])),
      );
      assertCompleteCapture(update);
    }
    return gitWithEnv(env, ['-C', root, ...probePins(root), 'write-tree']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The paths the throwaway index TRACKS under the review's name families —
 * the half of a family match that is user content, not the flow's
 * bookkeeping. Read off the throwaway index (`GIT_INDEX_FILE` in `env`),
 * never the user's: the re-inclusion updates entries of the index it is
 * given, and an entry the user's index holds but HEAD does not would send
 * `add -u` a pathspec it cannot match. The literal excludes ride along so
 * the in-tree git dir and this command's own side files stay out.
 */
function trackedFamilyPaths(
  env: Record<string, string>,
  root: string,
  sidePaths: readonly string[],
): Buffer[] {
  const specs: string[] = [];
  for (const family of FIX_DELTA_EXCLUDES) {
    specs.push(`:(glob)**/${family}`, `:(glob)**/${family}/**`);
  }
  const raw = gitWithEnvRaw(env, [
    '-C',
    root,
    ...probePins(root),
    'ls-files',
    '-z',
    '--',
    ...specs,
    ...literalExcludes(root, sidePaths),
  ]);
  return splitNul(raw).filter((path) => path.length > 0);
}

/**
 * The stderr notes `add -A` may print without failing the capture — every
 * other note fails the snapshot closed. A co-occurring failure hides behind
 * a tolerated neighbour when the match is looser than line-by-line, and an
 * unlistable directory EXITS 0 with only a warning and leaves its content
 * silently absent from the index — shapes a try/catch on the exit status
 * cannot see at all, so the capture is ruled on the child's own notes:
 *
 * - a nested git repository with ZERO commits — git refuses to add it
 *   ("does not have a commit checked out"); the repository stays invisible
 *   in both trees, the same model as submodule content, and the blind-spot
 *   probe names it. Newer gits (2.55) follow that note with a second one,
 *   "unable to index file '<path>'", for the SAME path — tolerated only in
 *   that pairing, since on its own the same words can mean a path that was
 *   skipped for any other reason;
 * - the embedded-repository notice and its `hint:` advice block — the
 *   gitlink IS recorded all the same;
 * - the `core.autocrlf` normalisation warnings — the file IS added, the
 *   warning announces the stored form.
 *
 * None of these skips a path; a note that can mean one ("could not open
 * directory" and its kin) finds no tolerance here.
 */
const TOLERATED_ADD_NOTES = [
  // `[\s\S]`, not `.`: the note embeds the raw, unquoted path, and a
  // reassembled multi-line note (below) carries the name's own newlines.
  /^error: '[\s\S]*' does not have a commit checked out$/,
  /^warning: adding embedded git repository: .*$/,
  /^hint:/,
  /^warning: in the working copy of '.*', LF will be replaced by CRLF the next time Git touches it$/,
  /^warning: in the working copy of '.*', CRLF will be replaced by LF the next time Git touches it$/,
];

const ZERO_COMMIT_NOTE_START = "error: '";
const ZERO_COMMIT_NOTE_END = "' does not have a commit checked out";
const UNABLE_TO_INDEX_START = "error: unable to index file '";
const UNABLE_TO_INDEX_END = "'";

/**
 * The zero-commit note — and the "unable to index file" note newer gits
 * pair it with — embed the raw, unquoted path: a nested repository whose
 * directory NAME contains a newline splits the note across lines, neither
 * of which matches line-by-line, and the shape the tolerance exists for
 * becomes a hard refusal. Reassemble those two notes at line boundaries
 * before matching; every other note stays strict per line. A note that
 * starts but never ends is pushed as found — unexplained, and the capture
 * fails closed on it.
 */
function reassembleZeroCommitNotes(lines: string[]): string[] {
  const shapes = [
    { start: ZERO_COMMIT_NOTE_START, end: ZERO_COMMIT_NOTE_END },
    { start: UNABLE_TO_INDEX_START, end: UNABLE_TO_INDEX_END },
  ];
  const notes: string[] = [];
  let pending: { text: string; end: string } | null = null;
  for (const line of lines) {
    if (pending === null) {
      const shape = shapes.find(
        (s) => line.startsWith(s.start) && !line.endsWith(s.end),
      );
      if (shape !== undefined) {
        pending = { text: line, end: shape.end };
        continue;
      }
      notes.push(line);
      continue;
    }
    pending.text = `${pending.text}\n${line}`;
    if (pending.text.endsWith(pending.end)) {
      notes.push(pending.text);
      pending = null;
    }
  }
  if (pending !== null) notes.push(pending.text);
  return notes;
}

/**
 * The paths the zero-commit notes name, so the paired "unable to index
 * file" note is tolerated for exactly those and no other.
 */
function zeroCommitPaths(notes: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const note of notes) {
    if (
      note.startsWith(ZERO_COMMIT_NOTE_START) &&
      note.endsWith(ZERO_COMMIT_NOTE_END)
    ) {
      paths.add(
        note.slice(
          ZERO_COMMIT_NOTE_START.length,
          note.length - ZERO_COMMIT_NOTE_END.length,
        ),
      );
    }
  }
  return paths;
}

export function assertCompleteCapture(add: {
  stderr: string;
  status: number;
  completed: boolean;
}): void {
  // Tolerance belongs to genuine exits alone: a child killed mid-`add`
  // (timeout, buffer overflow) or never spawned leaves the scratch index at
  // its seeded state, and ruling on its notes would record HEAD's tree as
  // the snapshot — a false baseline with no error.
  if (!add.completed) {
    throw new Error(
      `fix-delta: git add could not capture the whole tree (exit ${add.status}): ` +
        'the child did not exit normally, so its notes are a partial capture.',
    );
  }
  const notes = reassembleZeroCommitNotes(
    add.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  const zeroCommit = zeroCommitPaths(notes);
  const unexplained = notes.filter((line) => {
    if (TOLERATED_ADD_NOTES.some((note) => note.test(line))) return false;
    // The paired note, for a path the zero-commit note already explained.
    return !(
      line.startsWith(UNABLE_TO_INDEX_START) &&
      line.endsWith(UNABLE_TO_INDEX_END) &&
      zeroCommit.has(
        line.slice(
          UNABLE_TO_INDEX_START.length,
          line.length - UNABLE_TO_INDEX_END.length,
        ),
      )
    );
  });
  if (unexplained.length > 0 || (add.status !== 0 && notes.length === 0)) {
    throw new Error(
      `fix-delta: git add could not capture the whole tree (exit ${add.status}): ` +
        (unexplained.join(' | ') || add.stderr.trim()),
    );
  }
}

/**
 * The pathspec the CAPTURE runs under: the review's own name families
 * excluded — once as a file match and once as a deep-content match, because
 * a glob `*` does not cross `/` — and, in the rare repository whose git dir
 * sits inside its worktree, the git dir with them. `literal` there: the dir
 * name is raw path text, and the default wildcard matching reads
 * `[]`/`*`/`?` in it as a glob that drops merely matching tracked files
 * from the capture.
 *
 * At ANY depth: a review run from a subdirectory writes its side files under
 * THAT directory's `.qwen/tmp`, so the families are not root-anchored. What
 * the depth costs is paid back elsewhere rather than here: the tracked half
 * of a family match is recorded after this exclusion has run
 * (`snapshotWorkingTree`), and the probe side never lets a REPOSITORY hide
 * behind a family name (`probeExcluded`).
 */
export function excludePathspec(
  root: string,
  extraLiteral: readonly string[] = [],
): string[] {
  const specs = ['.'];
  for (const family of FIX_DELTA_EXCLUDES) {
    specs.push(`:(glob,exclude)**/${family}`, `:(glob,exclude)**/${family}/**`);
  }
  return [...specs, ...literalExcludes(root, extraLiteral)];
}

/** The literal half of both pathspecs: the in-tree git dir and the side files. */
function literalExcludes(
  root: string,
  extraLiteral: readonly string[],
): string[] {
  const specs: string[] = [];
  const gitDir = inTreeGitDir(root);
  if (gitDir !== null) {
    // `path.relative` emits the platform separator, but pathspec matching
    // is `/`-based on every platform — a git dir two or more components
    // below the root must not reach the pathspec with any other separator.
    specs.push(`:(exclude,literal)${gitDir.split(sep).join('/')}`);
  }
  for (const rel of extraLiteral) {
    specs.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
  }
  return specs;
}

/**
 * The pathspec the BLIND-SPOT PROBE and the TREE COMPARISON run under: the
 * capture's, with the review's own name FAMILIES left in.
 *
 * The families are excluded from the capture because the flow writes them
 * between the two states and a hunks file carrying them would hand the
 * auditor its own bookkeeping. Excluding them from the PROBE as well was an
 * entrance rather than symmetry: a nested repository planted at a
 * family-shaped name — `sub/.qwen/tmp/qwen-review-hide` — was hidden from
 * both trees by the capture pathspec AND kept out of the status the probe
 * reads, so an edit inside it appeared nowhere and drew no blind-spot line,
 * while the identical plant under any other name was disclosed. The probe
 * therefore SEES the families and prunes what it discovers by what it IS
 * (`probeExcluded`) — the review's own worktrees, known from git's own
 * registry — which, unlike a pathspec, can tell a planted repository from
 * the bookkeeping the family is named for.
 *
 * The comparison needs no family exclusion either: the capture has already
 * kept the flow's untracked side files out of both trees, and what the
 * trees DO hold under a family name is the tracked half — user content the
 * capture records on purpose, which an exclusion here dropped from the
 * hunks again.
 *
 * The literal excludes stay: the in-tree git dir is not blind-spot content,
 * and this command's own `--out`/`--since` files are its own writes.
 */
function literalPathspec(
  root: string,
  extraLiteral: readonly string[],
): string[] {
  return ['.', ...literalExcludes(root, extraLiteral)];
}

/**
 * The repository's COMMON git dir — where `info/attributes` and
 * `info/exclude` live for a linked worktree as much as for the main one.
 */
function commonGitDir(root: string): string | null {
  const common = gitOpt('-C', root, 'rev-parse', '--git-common-dir');
  if (common === null || common === '') return null;
  return resolve(root, common);
}

/** True when an exclude file carries a rule, not just git's template comments. */
function hasActiveExcludeRule(path: string): boolean {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => {
        const t = line.trim();
        return t !== '' && !t.startsWith('#');
      });
  } catch {
    return false;
  }
}

/**
 * Repo-local surfaces that steer what `git add -A` STORES, named for
 * disclosure.
 *
 * The capture treats the working tree as hostile content — the review has
 * already run the code under review by the time Step 6B edits it — but it
 * reads that tree through git, and git reads the repository's own
 * configuration on the way. These surfaces decide what the stored bytes
 * are, all writable as the same user the audited fixer runs as, and all
 * structurally invisible to a comparison OF the trees they shaped:
 *
 * - `filter.<name>.clean` (wired by an attributes line) replaces a path's
 *   stored content with the filter's output, so a real edit can be absent
 *   from both trees — the hunks miss it — or bytes the worktree never held
 *   can be attested as an edit that never landed. Both directions were
 *   demonstrated end to end. `filter.<name>.process` is the same surface
 *   through the long-running protocol — gitattributes(5) has it take
 *   precedence over `clean`/`smudge` whenever it is set — so a repository
 *   configured with the process key alone steers the capture identically.
 * - `.git/info/attributes` and `core.attributesFile` are where such a filter
 *   is wired without touching a tracked `.gitattributes`.
 * - `.git/info/exclude` and `core.excludesFile` drop paths from the
 *   untracked half of `add -A`, so a fix's new test file can vanish from
 *   both trees. The second names a file OUTSIDE the tree from the
 *   repository's own config, so neither the rule nor an edit to it is
 *   anything a capture could record.
 *
 * Disclosure, not refusal: every one of them is also an ordinary thing for a
 * repository to configure, and a refusal would take the audit away from
 * every user who has one. The module's direction — over-warn, never silence
 * a blind spot — is what the note serves. The sibling measurement in
 * `worktree.ts` de-steers the ONE command it can (`-c core.fsmonitor=`);
 * these surfaces have no equivalent override, so what cannot be neutralised
 * is named.
 */
function captureSteeringSurfaces(root: string): string[] {
  const surfaces: string[] = [];
  // The MERGED config — the same resolution `add` itself reads. `-z`:
  // `--get-regexp` prints `key\nvalue`, and a value may hold newlines, so
  // only the NUL boundary separates entries reliably. Exit 1 (no match)
  // arrives here as null.
  const filters = gitOpt(
    '-C',
    root,
    'config',
    '-z',
    '--get-regexp',
    '^filter\\..*\\.(clean|process)$',
  );
  for (const entry of (filters ?? '').split('\0')) {
    if (entry === '') continue;
    const key = entry.split('\n')[0];
    if (key !== undefined && key !== '') surfaces.push(key);
  }
  const attributesFile = gitOpt(
    '-C',
    root,
    'config',
    '--get',
    'core.attributesFile',
  );
  if (attributesFile !== null && attributesFile !== '') {
    surfaces.push(`core.attributesFile (${attributesFile})`);
  }
  const common = commonGitDir(root);
  if (common !== null) {
    if (existsSync(join(common, 'info', 'attributes'))) {
      surfaces.push('info/attributes');
    }
    if (hasActiveExcludeRule(join(common, 'info', 'exclude'))) {
      surfaces.push('info/exclude');
    }
  }
  // `--path` expands a leading `~`; a relative value resolves against the
  // directory `add` runs in, which is `root`. Gated on a real rule the way
  // `info/exclude` is — a pointer at a missing or comment-only file steers
  // nothing.
  const excludesFile = gitOpt(
    '-C',
    root,
    'config',
    '--get',
    '--path',
    'core.excludesFile',
  );
  if (
    excludesFile !== null &&
    excludesFile !== '' &&
    hasActiveExcludeRule(resolve(root, excludesFile))
  ) {
    surfaces.push(`core.excludesFile (${excludesFile})`);
  }
  return surfaces;
}

/**
 * The changed paths whose `diff` attribute resolves to something other than
 * `unspecified` — the surface that steers what the COMPARISON RENDERS.
 *
 * One `f.txt -diff` line (in `.git/info/attributes`, in a tracked
 * `.gitattributes`, or through `core.attributesFile`) forces a text fix's
 * hunks into opaque base85 `GIT binary patch` data: the hunks are non-empty,
 * the file is listed, nothing fails — and the auditor all-clears an edit it
 * cannot read, the exact failure the `--binary` flag above exists to
 * prevent. A `diff=<driver>` answer steers the same rendering through
 * config.
 *
 * Asked at `--since` time, never only at capture: these files are writable
 * as this user and plantable BETWEEN the two moments, so a capture-time
 * reading cannot see them. `git check-attr` answers under git's own
 * precedence and path resolution — the derivation a hand-read of one file
 * cannot match.
 */
function renderSteeringPaths(root: string, files: readonly Buffer[]): number[] {
  if (files.length === 0) return [];
  const all = files.map((_, i) => i);
  let raw: string;
  try {
    // The RAW name bytes on stdin, never the display decode: `decodePath`
    // renders a non-UTF-8 name through latin1, and re-encoding that string
    // as UTF-8 asks about a DIFFERENT path — which resolves `unspecified`
    // and answers "no steering" for exactly the path the probe could not
    // name. `-z` on both sides so a name holding a newline cannot forge a
    // record.
    raw = gitWithInputRaw(
      Buffer.concat(files.flatMap((f) => [f, Buffer.from([0])])),
      ['-C', root, ...probePins(root), 'check-attr', '--stdin', '-z', 'diff'],
    );
  } catch {
    // Unanswerable is not "clean": name every changed path rather than
    // certify a rendering the probe could not read.
    return all;
  }
  // Records are `<path> NUL <attr> NUL <value> NUL` in INPUT ORDER, one per
  // path for the one attribute asked. Read positionally, never by the
  // echoed key: the stream is decoded on the way back, so a non-UTF-8 name
  // returns as U+FFFD and would match no key at all — and a probe that
  // matched nothing would fail open the same way. The VALUES are ASCII, so
  // the decode cannot corrupt what is actually read.
  const fields = raw.split('\0');
  const steered: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const value = fields[i * 3 + 2];
    // Fewer records than paths: the rest were never answered for.
    if (value === undefined) return [...steered, ...all.slice(i)];
    if (value !== 'unspecified') steered.push(i);
  }
  return steered;
}

/**
 * The patch between two trees of this repository, review side files
 * excluded — as the RAW BYTES git printed: the hunks artifact must stay
 * git's patch, `git apply`-replayable, and a lossy string roundtrip
 * rewrites every non-UTF-8 byte of the fix to U+FFFD — data loss in the
 * command's sole output.
 */
function patchBetweenTrees(
  root: string,
  fromTree: string,
  toTree: string,
  sidePaths: readonly string[],
): Buffer {
  return gitRaw(
    '-C',
    root,
    // Pinned like every other outer spawn: `diff-tree` compares tree
    // objects, but given a pathspec it loads the index on the way — and
    // `core.fsmonitor` ran from it (measured on git 2.55, where `add` and
    // `status` themselves did not).
    ...probePins(root),
    // `-c` rides BEFORE the subcommand: it is a git-level override. The
    // hunks are the command's sole output, and under the default
    // `core.quotePath=true` their headers C-quote every non-ASCII name
    // while every other name surface in this flow prints the raw path —
    // the audit would correlate one file's edit under two different names.
    '-c',
    'core.quotePath=false',
    'diff-tree',
    '-r',
    '-p',
    '-M',
    // Without `--binary` a binary-content edit enters the hunks — the
    // command's sole output — as a bare "Binary files … differ" stub: no
    // patch data, not `git apply`-replayable, and the audit all-clears an
    // edit it could not read.
    '--binary',
    '--no-color',
    '--no-ext-diff',
    fromTree,
    toTree,
    '--',
    ...literalPathspec(root, sidePaths),
  );
}

/**
 * The files that differ between two trees, taken from git's own listing.
 * Re-parsing the rendered patch instead miscounts and mangles: with default
 * `core.quotePath` a non-ASCII path renders quoted (`"a/src/\346…"`) and
 * drops out of an anchored header regex, and a path containing a space
 * matches but yields a garbled name. `-z` prints raw NUL-separated names —
 * one per file, a rename counted once, under its new name.
 */
function filesBetweenTrees(
  root: string,
  fromTree: string,
  toTree: string,
  sidePaths: readonly string[],
): Buffer[] {
  const raw = gitRaw(
    '-C',
    root,
    ...probePins(root),
    'diff-tree',
    '-r',
    '--name-only',
    '-z',
    '-M',
    fromTree,
    toTree,
    '--',
    ...literalPathspec(root, sidePaths),
  );
  // RAW, one Buffer per name: the display decode happens at the reporting
  // edge (`decodePath`), because a non-UTF-8 name must reach the summary
  // byte-preserved rather than as U+FFFD — and because the attribute probe
  // below has to ask git about the bytes, not about their rendering.
  return splitNul(raw).filter((name) => name.length > 0);
}

/**
 * The git-level overrides every spawn that measures a working tree carries,
 * and why — the probe children INSIDE discovered repositories, and the
 * outer spawns against the audited repository itself (`read-tree`, `add`,
 * `write-tree`, `status`, `ls-files`, `check-attr`, `diff-tree`), which
 * honour that repository's `.git/config` exactly as a probe honours a
 * nested one's.
 *
 * A probe runs git INSIDE a repository discovered in the working tree — a
 * submodule, a nested repo, one an ignored directory hides — whose own
 * `.git/config` is writable by anything running as the reviewing user, the
 * audited fixer included; and the audited repository's own config is the
 * same surface one level up, since the reviewed code has run by the time
 * Step 6B edits. The same threat model the diff's sibling measurement
 * states (worktree.ts — "the tripwire is the one command that must not be
 * steerable by the tree it is measuring"): `sanitizedGitEnv` strips the
 * ENV-level redirects, but a repository's own config FILE is read by git
 * and reaches the child regardless.
 *
 * - `core.fsmonitor` runs a command on `status` AND on `ls-files -v`
 *   (daemon-git-worktree-guard.ts records the second) — the measurement
 *   would become the execution. Cleared, exactly as the worktree tripwire
 *   clears it.
 * - `core.worktree` redirects the probe at another directory: a decoy
 *   holding a pristine copy answers 'clean' while the edit sits on disk in
 *   the audited one — the "planted decoy answering clean for the wrong
 *   repository" shape `probeNestedRepoState` says it exists to prevent,
 *   reached through config instead of a mangled name (a RELATIVE
 *   `core.worktree` resolves against the git dir, so the decoy can ride
 *   inside the nested repository itself). `--work-tree` pins the audited
 *   directory and outranks it.
 *
 * `-c` and `--work-tree` both ride BEFORE the subcommand; the pinned path is
 * the UTF-8-roundtrip-validated one the caller already gated. For the outer
 * spawns the pinned path is `root` — which `assertRootHoldsCwd` has already
 * ruled is the tree this command runs in, the one place a `core.worktree`
 * plant is met by a gate rather than a pin, because the pin's own argument
 * is what the plant steers.
 */
function probePins(path: string): string[] {
  return ['--work-tree', path, '-c', 'core.fsmonitor='];
}

/**
 * The state of a nested repository's own uncommitted content, and — when it
 * could be read at all — a DIGEST of that state.
 *
 * `--ignored=matching` on top of the untracked view: a repository whose
 * only uncommitted content matches its OWN ignore rules emits nothing to a
 * plain status, and an edit inside would classify clean in both states.
 *
 * `failed` is a state of its own, not dirt: the caller decides what an
 * unanswerable probe means for the baseline and for the warning.
 *
 * The digest is what makes "already dirty" a comparable fact rather than a
 * boolean: a path recorded dirty at snapshot time and dirty now is
 * pre-existing dirt only when the state INSIDE it is the same state — see
 * the comparison in `runFixDelta`.
 */
function probeNestedRepoState(absPath: Buffer): {
  state: 'clean' | 'dirty' | 'failed';
  digest?: string;
} {
  // Spawn coerces every channel through UTF-8, so a name the bytes cannot
  // represent would reach the child mangled to U+FFFD — probing whatever
  // happens to live at THAT name (a planted decoy answering 'clean' for the
  // wrong repository) instead of failing. Refuse the coercion: the failure
  // direction over-warns, it never silences a blind spot.
  const path = absPath.toString('utf8');
  if (!Buffer.from(path, 'utf8').equals(absPath)) return { state: 'failed' };
  const inner = gitOpt(
    '-C',
    path,
    ...probePins(path),
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    // `=v2`, not the v1 short format, because the DIGEST is taken off this
    // output: v2 carries each entry's mode and its HEAD/index object hashes,
    // so a staged content change inside the repository moves the digest
    // while v1 would print the same two letters for it. What v2 still does
    // not carry is a worktree blob's hash — a fix that edits a file already
    // modified in the worktree at snapshot time leaves the digest standing,
    // and that residual is what `preExistingDirtNote`'s closing sentence is
    // for.
    '--porcelain=v2',
    // `--branch --show-stash`: the repository's IDENTITY rides the digest
    // as headers above the entries — `# branch.oid`, `# branch.head`, and
    // `# stash <n>` once a stash exists. An edit that was committed or
    // stashed inside a nested repository leaves its status empty at both
    // moments, and a superproject tree records nothing of it when the
    // repository is one an ignored directory hides; the moved HEAD or the
    // new stash entry is the only trace, and the digest is where it is
    // kept. The upstream headers (`# branch.upstream`, `# branch.ab`) are
    // dropped below: a fetch nobody edited with moves them.
    '--branch',
    '--show-stash',
    '--ignore-submodules=none',
    '--ignored=matching',
  );
  // A probe that could not honour the pins answers 'failed', never 'clean'.
  if (inner === null) return { state: 'failed' };
  const lines = inner
    .split('\n')
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('# branch.upstream') &&
        !line.startsWith('# branch.ab'),
    );
  const digest = createHash('sha256')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 32);
  // Dirt is what is NOT a header: with `--branch` the output is never
  // empty, so emptiness is no longer the clean test.
  if (lines.some((line) => !line.startsWith('# '))) {
    return { state: 'dirty', digest };
  }
  // An EMPTY status is not yet a clean answer: assume-unchanged and
  // skip-worktree bits hide an entry from status itself — git's documented
  // local-override practice — so a nested repository whose only
  // uncommitted content hides behind one answers empty while the edit is
  // on disk. Confirm the empty answer against the index's own tags; an
  // unconfirmable state is failed, never clean: the failure direction
  // over-warns, it never silences a blind spot.
  return indexBitsHideEntries(path)
    ? { state: 'failed' }
    : { state: 'clean', digest };
}

/**
 * True when the repository's index carries an entry the status cannot see:
 * `git ls-files -v` tags assume-unchanged entries with a lowercase letter
 * and skip-worktree ones with `S`. A probe that cannot list the tags at all
 * answers true — unanswerable is never clean.
 *
 * Takes the VALIDATED path, and carries the same de-steering pins as the
 * status above: `ls-files -v` executes `core.fsmonitor` too.
 */
function indexBitsHideEntries(path: string): boolean {
  const tags = gitOpt('-C', path, ...probePins(path), 'ls-files', '-v');
  if (tags === null) return true;
  return tags.split('\n').some((line) => {
    const tag = line.charAt(0);
    return tag === 'S' || (tag >= 'a' && tag <= 'z');
  });
}

/** Join a relative path given as raw bytes onto an absolute path. */
function joinBytes(abs: Buffer, rel: Buffer): Buffer {
  return Buffer.concat([abs, Buffer.from(sep), rel]);
}

/**
 * Join a walk-discovered RELATIVE name: always git's `/`, never the
 * platform separator, so a walk-discovered path and a git-originated one
 * (`-z` status, `ls-files`) key and report identically on every platform.
 */
function joinRel(parent: Buffer, name: Buffer): Buffer {
  return Buffer.concat([parent, Buffer.from('/'), name]);
}

const DOT_GIT = Buffer.from('.git');

/** The `ls-files -s` mode of a gitlink, plus the space after it. */
const GITLINK_MODE_PREFIX = Buffer.from('160000 ');

/** The `ls-files -s` mode of a symlink, plus the space after it. */
const SYMLINK_MODE_PREFIX = Buffer.from('120000 ');

/**
 * Decode a raw path for reporting: UTF-8 when the bytes ARE UTF-8 (the
 * everyday case), latin1 otherwise — a byte-preserving reading, so a name
 * the decode cannot represent still reaches the disclosure line instead of
 * mangling to U+FFFD and failing every filesystem check under it.
 */
function decodePath(raw: Buffer): string {
  const utf8 = raw.toString('utf8');
  const decoded = Buffer.from(utf8, 'utf8').equals(raw)
    ? utf8
    : raw.toString('latin1');
  // Reporting and baseline identity compare names of two origins — git's
  // `-z` output and the filesystem walk — so render in git's `/`
  // separator. On win32 a backslash cannot be a filename byte; on POSIX it
  // can, and stays.
  return sep === '\\' ? decoded.split('\\').join('/') : decoded;
}

/** Split a `-z` buffer on NUL bytes without a lossy string roundtrip. */
function splitNul(raw: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (;;) {
    const idx = raw.indexOf(0, start);
    if (idx === -1) {
      parts.push(raw.subarray(start));
      return parts;
    }
    parts.push(raw.subarray(start, idx));
    start = idx + 1;
  }
}

/**
 * The path of a kind-1/2/u status entry: everything after the entry's fixed
 * ASCII field count, taken from the raw entry bytes — modes, hashes, flags
 * and scores are ASCII, so the Nth space byte is exact even when the path
 * itself is not valid UTF-8.
 */
function pathAfterSpaces(entry: Buffer, spaces: number): Buffer {
  let off = 0;
  for (let n = 0; n < spaces; n++) {
    const idx = entry.indexOf(0x20, off);
    if (idx === -1) return entry.subarray(entry.length);
    off = idx + 1;
  }
  return entry.subarray(off);
}

/**
 * The number of directory entries the ignored-directory walk visits before
 * declaring the directory unresolvable. A repository can ignore an
 * arbitrarily deep tree (`node_modules` is the everyday case), and the walk
 * is the only discovery for nested repos hiding inside one, so it has to
 * start; equally, it must not enumerate a whole package store on every
 * snapshot. Past the budget the caller names the directory itself — the
 * failure direction over-warns, it never silences a blind spot.
 */
export const IGNORED_WALK_BUDGET = 100_000;

/**
 * What every discovery route needs to rule a discovered path in or out of
 * the probe, computed once per probe.
 */
interface ExclusionContext {
  /** The audited repository's root, as the command derived it. */
  root: string;
  /** The in-tree git dir relative to `root`, when the git dir sits inside. */
  gitDirRel: string | null;
  /**
   * The audited repository's COMMON git dir, resolved: its linked worktrees
   * are registered under `<common>/worktrees/`, and that registry — not a
   * name — is what tells the flow's own review worktree from a repository
   * planted under the same name.
   */
  commonDir: string | null;
}

function exclusionContext(root: string): ExclusionContext {
  const common = commonGitDir(root);
  let commonDir: string | null = null;
  if (common !== null) {
    try {
      commonDir = realpathSync(common);
    } catch {
      commonDir = common;
    }
  }
  return { root, gitDirRel: inTreeGitDir(root), commonDir };
}

/** The worktree family (`review-pr-*`), split for the segment match below. */
const WORKTREE_FAMILY = (() => {
  const family =
    FIX_DELTA_EXCLUDES.find((f) => f.endsWith('/review-pr-*')) ??
    FIX_DELTA_EXCLUDES[1];
  const segments = family.split('/');
  const last = segments[segments.length - 1];
  return {
    lead: segments.slice(0, -1),
    prefix: last.endsWith('*') ? last.slice(0, -1) : last,
  };
})();

/** True when `rel` carries the worktree family's name at any depth. */
function inWorktreeFamily(rel: Buffer): boolean {
  // `decodePath` renders both discovery routes — git's `-z` status (`/` on
  // every platform) and the walk (`sep`) — in git's separator, so the
  // comparison is separator-agnostic on every platform. The family name is
  // pure ASCII, so the decode cannot collide it with a differently-encoded
  // neighbour the way an arbitrary git-dir name can.
  const segments = decodePath(rel).split('/');
  const { lead, prefix } = WORKTREE_FAMILY;
  for (let i = 0; i + lead.length < segments.length; i++) {
    let matched = true;
    for (let j = 0; j < lead.length; j++) {
      if (segments[i + j] !== lead[j]) {
        matched = false;
        break;
      }
    }
    if (matched && segments[i + lead.length].startsWith(prefix)) return true;
  }
  return false;
}

/** True when `rel` is the in-tree git dir or anything under it. */
function underInTreeGitDir(rel: Buffer, gitDirRel: string | null): boolean {
  // The comparison is on BYTES, never on the display decode: `decodePath`
  // is not injective (UTF-8 `C3 A9` and the single invalid byte `E9` both
  // render 'é'), so a decoded comparison lets a planted `.git-<0xE9>`
  // directory answer for an in-tree git dir named `.git-é` and drop out of
  // capture, comparison and probe alike. `sep` -> `/` first: `inTreeGitDir`
  // builds its name with `path.relative`, while both discovery routes
  // (git's `-z` listings and the walk's `joinRel`) key on git's separator.
  if (gitDirRel === null) return false;
  const gitDir = Buffer.from(gitDirRel.split(sep).join('/'));
  return (
    rel.equals(gitDir) ||
    (rel.length > gitDir.length &&
      rel.subarray(0, gitDir.length).equals(gitDir) &&
      rel[gitDir.length] === 0x2f) /* / */
  );
}

/**
 * True when the repository at `abs` is a LINKED WORKTREE of the audited
 * repository: its `.git` is a gitfile pointing into the audited common
 * dir's `worktrees/` registry. That is what the flow's own review worktrees
 * are (`git worktree add` under `.qwen/tmp/review-pr-*`), and what a
 * repository planted under that name is not — a `git init` there carries a
 * `.git` DIRECTORY, and a gitfile into any other registry is somebody
 * else's worktree. Anything that cannot be read as such — no `.git`, a
 * directory, an unparseable or unresolvable pointer, a name the string
 * decode cannot carry — answers false, and the path is probed: the failure
 * direction over-warns, it never silences a blind spot.
 */
function isRegisteredWorktreeOf(
  abs: Buffer,
  commonDir: string | null,
): boolean {
  if (commonDir === null) return false;
  let gitfile: string;
  try {
    const dotGit = joinBytes(abs, DOT_GIT);
    if (!lstatSync(dotGit).isFile()) return false;
    gitfile = readFileSync(dotGit, 'utf8');
  } catch {
    return false;
  }
  const match = /^gitdir:\s*(.+?)\s*$/.exec(gitfile.split('\n')[0] ?? '');
  if (match === null) return false;
  let target: string;
  try {
    // A relative pointer resolves against the worktree that holds it.
    target = realpathSync(resolve(abs.toString('utf8'), match[1]));
  } catch {
    return false;
  }
  return target.startsWith(join(commonDir, 'worktrees') + sep);
}

/**
 * The exclusion applied to what the probe DISCOVERS. The capture excludes
 * the review's name families by pathspec, but a collapsed ignored
 * directory hides its children from any pathspec — without this check the
 * walk re-discovers the review's own worktrees (in any repository ignoring
 * `.qwen`) and probes them as blind-spot dirt, the very thing the
 * exclusion exists to remove.
 *
 * Two things are excluded, and a NAME alone is neither of them:
 *
 * - the in-tree git dir, in the rare repository whose git dir sits inside
 *   its worktree — not blind-spot content, and byte-compared;
 * - a review worktree: a repository under the worktree family name
 *   (`.qwen/tmp/review-pr-*`, at any depth) whose `.git` is a gitfile into
 *   the audited repository's own `worktrees/` registry.
 *
 * Everything else the families name is walked or probed like any other
 * path. Pruning by name was an entrance three times over: a repository
 * planted at a side-file family name (`qwen-review-hide`) or one level
 * under it (`qwen-review-hide/inner`) was hidden from both trees by the
 * capture pathspec AND from every probe route by the prune, and a
 * `git init` planted at a worktree family name was pruned the same way —
 * each an edit that appeared in no hunks and drew no blind-spot line while
 * the identical plant under any other name was disclosed. The side-file
 * family holds files, which the probe never asks about, so walking it
 * costs a directory listing and finds nothing; and git's own registry,
 * unlike a name, cannot be claimed by a plant.
 */
function probeExcluded(
  abs: Buffer,
  rel: Buffer,
  ctx: ExclusionContext,
): boolean {
  if (underInTreeGitDir(rel, ctx.gitDirRel)) return true;
  return inWorktreeFamily(rel) && isRegisteredWorktreeOf(abs, ctx.commonDir);
}

/**
 * The exclusion keys on the DISCOVERED name; a symlink's own name need not
 * be family-shaped for its TARGET to be a review worktree or the in-tree
 * git dir. Resolve the target and apply the same exclusion to it — a link
 * reaching excluded content is excluded content. A target that does not
 * resolve, or resolves outside the repository, has no root-relative name
 * to match and is left to the probe.
 */
function linkTargetExcluded(abs: Buffer, ctx: ExclusionContext): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(abs);
  } catch {
    return false;
  }
  const rel = relative(ctx.root, resolved);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return false;
  }
  return probeExcluded(
    Buffer.from(resolved),
    Buffer.from(rel.split(sep).join('/')),
    ctx,
  );
}

/**
 * The nested repositories inside a collapsed ignored directory, found by
 * walking it: status never enumerates under an ignored path and `add -A`
 * records nothing there, so an edit inside such a repository is invisible
 * to both the probe's entry list and the tree comparison. Discoveries the
 * capture itself excludes are pruned; a directory the walk cannot open
 * rides `unreadable` — disclosed at comparison time, never skipped. The
 * budget bounds a symlink loop inside an ignored directory as much as
 * size.
 */
function reposUnder(
  dirAbs: Buffer,
  dirRel: Buffer,
  ctx: ExclusionContext,
): {
  repos: Array<{ abs: Buffer; rel: Buffer }>;
  unreadable: Buffer[];
  exhausted: boolean;
} {
  const repos: Array<{ abs: Buffer; rel: Buffer }> = [];
  const unreadable: Buffer[] = [];
  let left = IGNORED_WALK_BUDGET;
  const queue: Array<{ abs: Buffer; rel: Buffer }> = [
    { abs: dirAbs, rel: dirRel },
  ];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    let entries: Array<Dirent<Buffer>>;
    try {
      entries = readdirSync(cur.abs, {
        encoding: 'buffer',
        withFileTypes: true,
      });
    } catch {
      // A directory the walk cannot open is disclosed, never skipped: a
      // repository under it is undiscoverable, and the failure direction
      // over-warns, it never silences a blind spot.
      unreadable.push(cur.rel);
      continue;
    }
    for (const e of entries) {
      if (left-- === 0) {
        return { repos, unreadable, exhausted: true };
      }
      const name = e.name;
      const childAbs = joinBytes(cur.abs, name);
      const childRel = joinRel(cur.rel, name);
      if (!e.isDirectory() && !e.isFile() && !e.isSymbolicLink()) {
        // DT_UNKNOWN — a filesystem that does not hand back d_type (NFS
        // without it, sshfs/FUSE): every predicate answers false, and
        // skipping the unclassifiable child degenerated the walk to
        // 'fully walked, nothing inside', indistinguishable from empty.
        // It rides `unreadable` instead: the failure direction
        // over-warns, it never silences a blind spot.
        unreadable.push(childRel);
        continue;
      }
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(childAbs).isDirectory();
        } catch {
          continue;
        }
        // The exclusion keys on the link's own NAME; its target is
        // checked separately, or a link planted at a non-family name
        // reaches the review's own worktrees past the exclusion.
        if (isDir && linkTargetExcluded(childAbs, ctx)) continue;
      }
      if (!isDir) continue;
      if (probeExcluded(childAbs, childRel, ctx)) continue;
      if (existsSync(joinBytes(childAbs, DOT_GIT))) {
        repos.push({ abs: childAbs, rel: childRel });
      } else {
        queue.push({ abs: childAbs, rel: childRel });
      }
    }
  }
  return { repos, unreadable, exhausted: false };
}

/** What the blind-spot probe accumulates as it walks the discovery routes. */
interface ProbeState {
  dirty: Set<string>;
  unresolved: Set<string>;
  seen: Set<string>;
  /** Identity key -> digest of the state observed inside that path. */
  digests: Record<string, string>;
}

function probeNestedRepo(abs: Buffer, rel: Buffer, state: ProbeState): void {
  // Identity keys on the RAW BYTES — latin1 is a byte<->char bijection —
  // never on the display decode: decodePath is not injective (UTF-8
  // `C3 A9` and the single invalid byte `E9` both render 'é'), and a
  // colliding `seen` mark let a clean repository's probe swallow its
  // dirty sibling's. Display names are re-derived from the key at
  // reporting time; the key itself is what the sets and the persisted
  // baseline compare.
  const key = rel.toString('latin1');
  if (state.seen.has(key)) return;
  state.seen.add(key);
  const result = probeNestedRepoState(abs);
  if (result.digest !== undefined) state.digests[key] = result.digest;
  if (result.state === 'dirty') state.dirty.add(key);
  else if (result.state === 'failed') state.unresolved.add(key);
}

/**
 * A path named by a status entry or by the index that may be a symlink
 * reaching a repository: the link itself is what `add -A` records, so an
 * edit through it into that repository is invisible the same way a
 * gitlink's interior is. The exclusion checks key on the link's own name
 * AND on the resolved target, and only a directory that carries a git dir
 * is probed — the class this model names.
 */
function probeLinkedRepo(
  rootBuf: Buffer,
  rel: Buffer,
  ctx: ExclusionContext,
  state: ProbeState,
): void {
  const abs = joinBytes(rootBuf, rel);
  let isLink = false;
  try {
    isLink = lstatSync(abs).isSymbolicLink();
  } catch {
    return;
  }
  if (!isLink) return;
  if (probeExcluded(abs, rel, ctx)) return;
  try {
    if (!statSync(abs).isDirectory()) return;
  } catch {
    return;
  }
  if (linkTargetExcluded(abs, ctx)) return;
  if (existsSync(joinBytes(abs, DOT_GIT))) {
    probeNestedRepo(abs, rel, state);
    return;
  }
  // The link reaches a directory that is not ITSELF a repository — and a
  // silent return here was an entrance: `add -A` records the link, never
  // what is behind it, so a repository one or more levels down the target
  // is exactly as invisible as one the link points straight at, and it was
  // neither probed nor disclosed. Walk it the way a collapsed ignored
  // directory is walked; the shared budget bounds a link loop as much as
  // size, and what the walk cannot classify rides `unresolved`.
  const found = reposUnder(abs, rel, ctx);
  for (const r of found.repos) probeNestedRepo(r.abs, r.rel, state);
  for (const u of found.unreadable) state.unresolved.add(u.toString('latin1'));
  if (found.exhausted) state.unresolved.add(rel.toString('latin1'));
}

/**
 * Paths holding edits a superproject tree cannot record: submodule checkouts
 * and nested git repositories. Either enters the tree as its gitlink alone —
 * an edit inside that is not committed there moves no gitlink, so both
 * snapshots stay byte-identical while the fix is on disk. Porcelain-v2 names
 * them across several entry classes, and the triggers are checkout states a
 * fix can land on top of without creating, so the probe parses them all:
 *
 * - `1` entries carry a 4-char sub token — `S` plus a new-commits flag, a
 *   modified-content flag and an untracked-content flag, `.` where none
 *   (probed shapes: `SC..`, `S.M.`, `SCMU`, `S..U`) — and the last two flags
 *   are the invisible content. A new-commits flag alone is visible (the
 *   gitlink moved) and is not reported. The mode fields are NOT pinned: the
 *   interim `submodule add` state prints a 000000 HEAD slot, a staged
 *   deletion prints `160000 000000 000000`.
 * - `2` entries — a staged gitlink rename: the score is space-separated, the
 *   new path ends the record, and the original path follows as its own NUL
 *   element — consumed for EVERY kind-`2` entry, even a skipped one, so it
 *   is never parsed as an entry itself.
 * - `u` entries — an unmerged gitlink: four mode fields, three hashes, the
 *   path last.
 * - `?` entries — under `showUntrackedFiles=all` only a nested git
 *   repository survives unexpanded as `? <dir>/`, and `add -A` records its
 *   gitlink all the same. The same collapsed line names a staged-deleted
 *   gitlink, whose `1 D. S...` twin carries no dirt flags for git to
 *   compute. A slashLESS `?` entry is probed too when it is a symlink: the
 *   link itself is what `add -A` records, so an edit through it into the
 *   repository it reaches is invisible the same way.
 * - `!` entries — `--ignored=matching` collapses an ignored directory to
 *   `! <dir>/`, and neither status nor `add -A` ever looks inside one, so
 *   nested repositories hidden there are discovered by walking the
 *   directory. A `?`/`!` entry carries NO dirt flag of its own, so every
 *   candidate is probed inside and only a repository with uncommitted
 *   content counts — stamping a clean one dirty would print a false
 *   pre-existing note on a no-op run, and would filter a fix's real
 *   interior edit out of the baseline into a false all-clear.
 *
 * Discovery never rests on the status alone: the probe also scans the
 * index's own mode-160000 gitlinks and mode-120000 symlinks
 * (`ls-files -s`), because assume-unchanged / skip-worktree bits can keep
 * a dirty submodule out of the status ENTRIES altogether and an unchanged
 * tracked link emits no entry of its own — entrances that silence the
 * blind spot the model exists to name.
 *
 * The status runs with `-z` and is parsed as raw bytes: entries are
 * NUL-terminated and paths unquoted, and the rendered form C-quotes any name
 * that needs it (a non-ASCII name under default `core.quotePath`, a tab, a
 * quote or a backslash) — or cannot represent it at all when the bytes are
 * not valid UTF-8. A quoted or mangled path neither ends in '/' nor
 * resolves, so the repository would be skipped silently while invisible
 * edits land inside it.
 *
 * Identity throughout is keyed on the raw path bytes (the latin1
 * byte<->char bijection), never on the display decode, which is not
 * injective — one repository's answer must never stand for another's.
 *
 * The answer is split instead of folded: `dirty` is CONFIRMED uncommitted
 * content — the only state that may enter the snapshot baseline — and
 * `unresolved` is every path the probe could not answer: an inner status
 * that cannot run, an ignored directory the walk cannot open, one too
 * large to walk inside its budget. A comparison discloses both — the
 * failure direction over-warns, it never silences a blind spot — while a
 * baseline records `dirty` alone: an unconfirmed state stamped
 * pre-existing would filter a fix's real edit out of the warning into a
 * false all-clear.
 */
function probeBlindSpotState(
  root: string,
  sidePaths: readonly string[] = [],
): {
  dirty: string[];
  unresolved: string[];
  digests: Record<string, string>;
} {
  // `--no-optional-locks`: plain `status` opportunistically rewrites the
  // user's index to refresh its stat cache — a write this command promises
  // never to make. `-c status.showUntrackedFiles=all`: the untracked-content
  // flag is computed by a status run INSIDE each submodule reading the user's
  // config; with `showUntrackedFiles=no` there, a submodule whose only
  // invisible edit is untracked content emits no entry at all, and only a
  // `-c` override (not `--untracked-files`) propagates to that inner run.
  // The exclusion pathspec: capture and the tree comparisons apply it, so the
  // probe must too — otherwise the review's own worktrees and side files
  // under `.qwen/tmp` would be classified as blind-spot submodule dirt.
  const raw = gitRaw(
    '-C',
    root,
    ...probePins(root),
    '-c',
    'status.showUntrackedFiles=all',
    '--no-optional-locks',
    'status',
    '--porcelain=v2',
    '--ignore-submodules=none',
    '--ignored=matching',
    '-z',
    '--',
    ...literalPathspec(root, sidePaths),
  );
  const rootBuf = Buffer.from(root);
  const ctx = exclusionContext(root);
  const dirty = new Set<string>();
  const unresolved = new Set<string>();
  const seen = new Set<string>();
  const digests: Record<string, string> = {};
  const state: ProbeState = { dirty, unresolved, seen, digests };
  const entries = splitNul(raw);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 2) continue;
    const head = entry[0];
    if (head === 0x3f /* ? */ || head === 0x21 /* ! */) {
      const rel = entry.subarray(2);
      if (rel[rel.length - 1] === 0x2f /* / */) {
        const dirRel = rel.subarray(0, rel.length - 1);
        const dirAbs = joinBytes(rootBuf, dirRel);
        if (probeExcluded(dirAbs, dirRel, ctx)) continue;
        if (head === 0x21 && !existsSync(joinBytes(dirAbs, DOT_GIT))) {
          // Collapsed ignored directory that is not itself a repository:
          // the only way in is to walk it.
          const found = reposUnder(dirAbs, dirRel, ctx);
          for (const r of found.repos) {
            probeNestedRepo(r.abs, r.rel, state);
          }
          for (const u of found.unreadable) {
            unresolved.add(u.toString('latin1'));
          }
          if (found.exhausted) {
            unresolved.add(dirRel.toString('latin1'));
          }
        } else {
          probeNestedRepo(dirAbs, dirRel, state);
        }
        continue;
      }
      // Slashless: a plain file, or a symlink that may reach a repository.
      probeLinkedRepo(rootBuf, rel, ctx, state);
      continue;
    }
    const fields = entry.toString('utf8').split(' ');
    const kind = fields[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    // A rename's original path rides the next NUL element — consumed even
    // when the entry is skipped below, so it is never parsed as an entry
    // itself (a name like `u x` would re-enter the stream and die on a
    // missing field).
    if (kind === '2') i++;
    const sub = fields[2];
    if (sub.length !== 4 || !sub.startsWith('S')) continue;
    // Modified-content or untracked-content flag: the invisible content.
    if (sub[2] === '.' && sub[3] === '.') continue;
    const relBytes = pathAfterSpaces(
      entry,
      kind === '1' ? 8 : kind === '2' ? 9 : 10,
    );
    // The probe's pathspec keeps the families in (see `literalPathspec`),
    // so every discovery route prunes for itself — this one included: a
    // review worktree that a repository happens to TRACK is still the
    // review's own bookkeeping.
    if (probeExcluded(joinBytes(rootBuf, relBytes), relBytes, ctx)) {
      continue;
    }
    const key = relBytes.toString('latin1');
    dirty.add(key);
    seen.add(key);
    // The outer flags CONFIRM the dirt; the state INSIDE is what the
    // comparison needs. Without it, "already dirty at snapshot time" is a
    // bare boolean, and every later edit inside such a path is filtered
    // into the pre-existing note — the entrance a level-2 submodule
    // reached by holding nothing but a moved inner gitlink at snapshot
    // time. A probe that cannot answer leaves no digest, and the
    // comparison over-warns on the missing one.
    const inner = probeNestedRepoState(joinBytes(rootBuf, relBytes));
    if (inner.digest !== undefined) digests[key] = inner.digest;
  }
  // Status entries are not the whole of discovery: assume-unchanged /
  // skip-worktree bits on an interior file hide the dirt from the inner
  // status AND from this outer v2 status alike — the submodule emits no
  // entry, the probe above never runs, and the command prints the bare
  // all-clear while the edit is on disk. Every mode-160000 gitlink and
  // mode-120000 symlink the index records is a candidate blind spot
  // regardless of what status says about it — an unchanged tracked link
  // emits no entry of its own; `seen` keeps a status-discovered one from
  // a second probe.
  const indexEntries = gitRaw(
    '-C',
    root,
    ...probePins(root),
    'ls-files',
    '-s',
    '-z',
  );
  for (const entry of splitNul(indexEntries)) {
    const gitlink = entry.subarray(0, 7).equals(GITLINK_MODE_PREFIX);
    if (!gitlink && !entry.subarray(0, 7).equals(SYMLINK_MODE_PREFIX)) {
      continue;
    }
    // `<mode> <hash> <stage>\t<path>`: modes, hashes and the stage are
    // ASCII, so the first tab byte ends the fields exactly.
    const tab = entry.indexOf(0x09);
    if (tab === -1) continue;
    const rel = entry.subarray(tab + 1);
    const abs = joinBytes(rootBuf, rel);
    if (probeExcluded(abs, rel, ctx)) continue;
    if (!gitlink) {
      probeLinkedRepo(rootBuf, rel, ctx, state);
      continue;
    }
    // A gitlink whose checkout does not exist (a fresh clone that never
    // ran `submodule update --init`) holds no content an edit could hide
    // in; probing it answered 'failed' and over-warned on every run. A
    // checkout that EXISTS without its git dir is a dead gitlink: `add -A`
    // still records only the gitlink and no status entry names it, so an
    // edit inside would leave no record in this model — disclose it as
    // unresolved rather than skip it. The inner probe alone cannot answer
    // the state: with the git dir gone, `git -C <checkout> status` walks
    // UP into this repository and reports the superproject, not the
    // checkout.
    if (!existsSync(abs)) continue;
    if (!existsSync(joinBytes(abs, DOT_GIT))) {
      unresolved.add(rel.toString('latin1'));
      continue;
    }
    probeNestedRepo(abs, rel, state);
  }
  return { dirty: [...dirty], unresolved: [...unresolved], digests };
}

/** The blind-spot warning, phrased for an empty or an under-reporting hunks file. */
function submoduleBlindSpot(dirty: string[], hunksEmpty: boolean): string {
  const one = dirty.length === 1;
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${dirty.join(', ')} ` +
    `${one ? 'holds' : 'hold'} uncommitted edits this command cannot see — ` +
    'a snapshot records only the superproject tree, and a submodule enters ' +
    'it as its gitlink alone, so edits inside a submodule are outside this ' +
    'model until they are committed there. ' +
    (hunksEmpty
      ? 'The hunks file stays empty; the audit cannot see the edit.'
      : 'The hunks file does not show them; the audit cannot see those edits.')
  );
}

/**
 * Blind-spot paths the probe could not ANSWER at all — an unreadable
 * directory, a repository the inner status cannot run in, an ignored tree
 * past the walk budget. Phrased so the silence is read as disclosure, not
 * oversight: an edit inside would leave no record in this model.
 */
function unresolvedBlindSpot(paths: string[], hunksEmpty: boolean): string {
  const one = paths.length === 1;
  return (
    `fix-delta: ${paths.join(', ')} ${one ? 'holds' : 'hold'} state this ` +
    `command cannot see — the probe could not resolve ${one ? 'it' : 'them'} ` +
    '(a directory it cannot open, a repository it cannot run in, or an ' +
    'ignored tree past the walk budget), so an edit inside would leave no ' +
    'record in this model. ' +
    (hunksEmpty
      ? 'The hunks file stays empty; the audit cannot see the edit.'
      : 'The hunks file does not show them; the audit cannot see those edits.')
  );
}

/**
 * The capture-steering disclosure. Phrased so the reader knows the hunks
 * are the STORED bytes, not necessarily the worktree's.
 */
function captureSteeringNote(surfaces: string[]): string {
  return (
    `fix-delta: this repository configures ${surfaces.join(', ')} — ` +
    'repo-local surfaces that decide what `git add -A` stores for a path, ' +
    'and that a comparison of the trees they shaped cannot see. A clean ' +
    'filter can keep a real edit out of both trees, or attest bytes the ' +
    'worktree never held; an exclude rule can drop a new file from the ' +
    'capture entirely. Treat the hunks as the stored delta, not as proof ' +
    'of what is on disk.'
  );
}

/** The rendering-steering disclosure, named per path. */
function renderSteeringNote(paths: string[]): string {
  const one = paths.length === 1;
  return (
    `fix-delta: the \`diff\` attribute of ${paths.join(', ')} ` +
    `${one ? 'is' : 'are'} set by this repository (a \`.gitattributes\` ` +
    'rule, `.git/info/attributes`, or `core.attributesFile`), which steers ' +
    `how the hunks above render ${one ? 'it' : 'them'} — \`-diff\` turns a ` +
    'text edit into an opaque binary patch, and a `diff=<driver>` does the ' +
    'same through config. The audit cannot read what it cannot decode: ' +
    'check the hunks for a `GIT binary patch` section before trusting an ' +
    'all-clear over these paths.'
  );
}

/** Pre-existing submodule dirt, named so the silence is not read as oversight. */
function preExistingDirtNote(dirty: string[]): string {
  const one = dirty.length === 1;
  const them = one ? 'it' : 'them';
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${dirty.join(', ')} ` +
    'already held uncommitted content at snapshot time — pre-existing dirt, ' +
    `not reported as a blind spot because nothing newly dirtied ${them}. ` +
    `Edits inside ${them} since remain invisible to this command.`
  );
}

/**
 * Clean at both moments, and not the same inside: the repository's HEAD or
 * stash moved between the two states. A commit or a stash made inside a
 * nested repository is exactly as invisible to the superproject tree as an
 * uncommitted edit — a tracked gitlink moves, an untracked or ignored one
 * leaves no trace at all — and the status the probe reads is empty on both
 * sides of it.
 */
function movedInsideNote(paths: string[]): string {
  const one = paths.length === 1;
  return (
    `fix-delta: ${paths.join(', ')} ${one ? 'has' : 'have'} had content ` +
    `committed or stashed inside ${one ? 'it' : 'them'} since the snapshot ` +
    `— the interior is clean at both moments, but ${one ? 'its' : 'their'} ` +
    'HEAD or stash moved, and the superproject trees recorded nothing of ' +
    'it. An edit committed inside a nested repository is as invisible to ' +
    'this command as an uncommitted one; the hunks do not show it.'
  );
}

/** Snapshot-time dirt that vanished: content changed between the two states. */
function cleanedSubmoduleNote(cleaned: string[]): string {
  const one = cleaned.length === 1;
  return (
    `fix-delta: ${one ? 'submodule' : 'submodules'} ${cleaned.join(', ')} ` +
    'held uncommitted content at snapshot time that is gone now — content ' +
    `inside ${one ? 'it' : 'them'} changed between the two states, ` +
    'invisible to this command.'
  );
}

/**
 * Identity byte keys back to display names for the notes above: latin1
 * re-yields the exact bytes, and `decodePath` renders them the same way
 * it rendered them at discovery time.
 */
function displayNames(keys: string[]): string[] {
  return keys.map((key) => decodePath(Buffer.from(key, 'latin1')));
}

/**
 * The root git reports must CONTAIN the directory this command runs in.
 *
 * Discovery walks UP from the process cwd to find the git dir, so the
 * working tree it belongs to holds the cwd in every honest layout — a
 * plain checkout, a linked worktree, a submodule checkout (whose own
 * `core.worktree` names exactly that checkout). What breaks the
 * containment is a repo-local `core.worktree` pointing elsewhere — git's
 * own documentation calls the shape "most likely a misconfiguration" —
 * and that is a plant the audited repository's writable `.git/config`
 * makes available to code that has already run by Step 6B: it redirects
 * `--show-toplevel` itself, so every later spawn, `--work-tree` pin
 * included, would measure the decoy consistently, the root-identity check
 * at `--since` would pass because both moments agree, and a bare all-clear
 * would certify a tree nobody read. The gate belongs at derivation: the
 * pin's own argument is what the plant steers, so a pin cannot close it.
 * Refusal, not repair — this command cannot know which of the two
 * directories the fix was applied in, and the flow discloses a refusal
 * as `Fix audit: not run`.
 */
function assertRootHoldsCwd(root: string): void {
  const cwd = realpathSync(process.cwd());
  const top = realpathSync(root);
  const rel = relative(top, cwd);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `fix-delta: git reports ${root} as the working tree, but this command ` +
        `runs in ${cwd}, which is not inside it — a repo-local ` +
        '`core.worktree` (or an equivalent redirect) points every git ' +
        'command at another directory, and a capture taken there would ' +
        'certify a tree the fix was never applied in. Unset it ' +
        '(`git config --unset core.worktree`) and re-run.',
    );
  }
}

export interface FixDeltaArgs {
  snapshot: boolean;
  since?: string;
  out: string;
}

export function runFixDelta(args: FixDeltaArgs): void {
  if (args.snapshot === Boolean(args.since)) {
    throw new Error(
      'fix-delta: pass exactly one of --snapshot (record the tree before the ' +
        'first edit) or --since <snapshot.json> (diff the tree now against it).',
    );
  }
  const root = git('rev-parse', '--show-toplevel');
  assertRootHoldsCwd(root);
  assertNoRedirectedExcludes(root, [args.out, args.since]);
  // The command's own `--out` (and, in `--since` mode, the `--since` file
  // itself) are side files of THIS run exactly like the review's families:
  // captured by the next snapshot and entering the hunks as bookkeeping
  // whenever they resolve inside the repository outside those families.
  const sidePaths = inRepoSidePaths(root, [args.out, args.since]);
  mkdirSync(dirname(resolve(args.out)), { recursive: true });

  if (args.snapshot) {
    // Read BEFORE the capture: the surfaces below shape what it stores, and
    // the disclosure is only useful ahead of the bytes it qualifies.
    const steering = captureSteeringSurfaces(root);
    if (steering.length > 0) writeStderrLine(captureSteeringNote(steering));
    const tree = snapshotWorkingTree(root, sidePaths);
    const probe = probeBlindSpotState(root, sidePaths);
    const snapshot: FixSnapshot = {
      root,
      tree,
      // The baseline holds only CONFIRMED dirt: unresolved states are
      // disclosed at `--since` time, never recorded as pre-existing —
      // unconfirmed dirt cannot be blamed on "already there", or a fix's
      // real edit inside would filter into a false all-clear.
      dirtySubmodules: probe.dirty,
      // …and a digest for every path the probe could ANSWER for, clean or
      // dirty: the dirty ones so that "pre-existing" is a checkable claim,
      // the clean ones so that content committed or stashed inside a clean
      // repository — which moves no status entry — is still seen to have
      // moved. An absent one makes the comparison over-warn, which is the
      // direction this module fails in.
      digests: probe.digests,
    };
    writeFileSync(resolve(args.out), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeStderrLine(`fix-delta: snapshot ${tree.slice(0, 12)} of ${root}`);
    return;
  }

  let snapshot: FixSnapshot;
  try {
    const raw = JSON.parse(readFileSync(args.since as string, 'utf8')) as {
      root?: unknown;
      tree?: unknown;
      dirtySubmodules?: unknown;
      digests?: unknown;
    };
    if (
      typeof raw.root !== 'string' ||
      !/^[0-9a-f]{40,64}$/.test(String(raw.tree))
    ) {
      throw new Error('not a fix-delta snapshot ({root, tree})');
    }
    snapshot = {
      root: raw.root,
      tree: raw.tree as string,
      dirtySubmodules: Array.isArray(raw.dirtySubmodules)
        ? raw.dirtySubmodules.filter((p): p is string => typeof p === 'string')
        : [],
      // A record this run did not write — an older snapshot, a hand-edited
      // file — leaves every baseline path digest-less, and the comparison
      // below then reports all of them as blind spots. That is the
      // over-warning direction on purpose: silently restoring the boolean
      // model would restore the hole it closes.
      digests:
        typeof raw.digests === 'object' && raw.digests !== null
          ? Object.fromEntries(
              Object.entries(raw.digests as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, v as string]),
            )
          : {},
    };
  } catch (err) {
    throw new Error(
      `fix-delta: cannot read the snapshot ${args.since}: ${(err as Error).message}. ` +
        'Pass the file `fix-delta --snapshot --out <file>` wrote before the edits.',
    );
  }
  if (resolve(snapshot.root) !== resolve(root)) {
    throw new Error(
      `fix-delta: the snapshot was taken in ${snapshot.root}, but this is ${root}. ` +
        'A snapshot diffs only against the tree it recorded.',
    );
  }
  if (
    gitOpt('-C', root, 'cat-file', '-e', `${snapshot.tree}^{tree}`) === null
  ) {
    throw new Error(
      `fix-delta: the snapshot tree ${snapshot.tree.slice(0, 12)} is not in this ` +
        'repository. Take the snapshot in the same checkout the edits are applied in.',
    );
  }

  // Re-read at `--since` time too, never only at capture: every one of
  // these files is writable as this user and plantable BETWEEN the two
  // moments, and this run takes its own `add -A` capture below.
  const steering = captureSteeringSurfaces(root);
  if (steering.length > 0) writeStderrLine(captureSteeringNote(steering));
  const now = snapshotWorkingTree(root, sidePaths);
  const diff =
    now === snapshot.tree
      ? Buffer.alloc(0)
      : patchBetweenTrees(root, snapshot.tree, now, sidePaths);
  writeFileSync(resolve(args.out), diff);
  // Edits inside a submodule never move its gitlink, so the tree comparison
  // is blind to them whether or not the superproject diff is empty — probe
  // in both cases. Dirt recorded at snapshot time is not the fix's doing;
  // only NEW dirt names a blind spot, and an unresolved path over-warns at
  // EVERY comparison: the baseline never recorded one, and silence over a
  // path the probe cannot answer is a false all-clear.
  const probe = probeBlindSpotState(root, sidePaths);
  const dirtyNow = probe.dirty;
  const unresolvedNow = probe.unresolved;
  // "Already dirty" is not the question; "the same dirt" is. A path in the
  // baseline whose interior state DIFFERS from the one recorded there was
  // changed between the two moments — invisible to both trees, and exactly
  // the edit the audit must be told about — so it is fresh dirt, not
  // pre-existing. A digest missing on either side answers "cannot tell",
  // which routes the same way: the failure direction over-warns, it never
  // silences a blind spot.
  const sameDirtAsBaseline = (p: string): boolean => {
    const before = snapshot.digests[p];
    const now = probe.digests[p];
    return before !== undefined && now !== undefined && before === now;
  };
  const freshDirt = dirtyNow.filter(
    (p) => !snapshot.dirtySubmodules.includes(p) || !sameDirtAsBaseline(p),
  );
  const preExisting = dirtyNow.filter(
    (p) => snapshot.dirtySubmodules.includes(p) && sameDirtAsBaseline(p),
  );
  // The third transition the baseline can see: dirt at snapshot time that is
  // GONE now necessarily changed on disk between the two states — a clean
  // submodule emits no status entry and the gitlink never moved, so without
  // this the all-clear claim would be provably false. A path the probe can
  // no longer ANSWER is not gone — it rides the unresolved disclosure.
  const cleaned = snapshot.dirtySubmodules.filter(
    (p) => !dirtyNow.includes(p) && !unresolvedNow.includes(p),
  );
  const files =
    diff.length === 0
      ? []
      : filesBetweenTrees(root, snapshot.tree, now, sidePaths);
  // The fourth transition: clean at both moments, and NOT the same inside.
  // "Clean" is a statement about uncommitted content; the digest also
  // carries the repository's identity, and a HEAD or stash that moved
  // between the moments is content that went in without a status entry to
  // show for it. A tracked submodule's move IS in the hunks — its gitlink
  // changed, and the comparison lists the path — so it is not a blind
  // spot here (a moved gitlink is the everyday `submodule update` shape,
  // and reporting it would be a note every such run prints). What is
  // disclosed is a move the trees recorded NOTHING of: a repository an
  // ignored directory hides, or one the walk reached through a link —
  // the only trace an edit committed there leaves anywhere. A path either
  // moment could not answer for is not compared here: it rides the
  // unresolved disclosure.
  const recorded = new Set(files.map((name) => name.toString('latin1')));
  const movedInside = Object.keys(snapshot.digests).filter(
    (p) =>
      !snapshot.dirtySubmodules.includes(p) &&
      !dirtyNow.includes(p) &&
      !unresolvedNow.includes(p) &&
      !recorded.has(p) &&
      probe.digests[p] !== undefined &&
      probe.digests[p] !== snapshot.digests[p],
  );
  if (diff.length === 0) {
    if (preExisting.length > 0) {
      writeStderrLine(preExistingDirtNote(displayNames(preExisting)));
    }
    if (freshDirt.length > 0) {
      writeStderrLine(submoduleBlindSpot(displayNames(freshDirt), true));
    }
    if (unresolvedNow.length > 0) {
      writeStderrLine(unresolvedBlindSpot(displayNames(unresolvedNow), true));
    }
    if (cleaned.length > 0) {
      writeStderrLine(cleanedSubmoduleNote(displayNames(cleaned)));
    }
    if (movedInside.length > 0) {
      writeStderrLine(movedInsideNote(displayNames(movedInside)));
    }
    if (
      freshDirt.length === 0 &&
      cleaned.length === 0 &&
      unresolvedNow.length === 0 &&
      movedInside.length === 0
    ) {
      writeStderrLine(
        'fix-delta: the tree is unchanged since the snapshot — no edit was ' +
          'applied to the content `git add -A` captures (edits inside ' +
          'gitignored paths are outside this model), or the snapshot was ' +
          'taken after the edits.',
      );
    }
    return;
  }
  const steeredRendering = renderSteeringPaths(root, files);
  if (steeredRendering.length > 0) {
    writeStderrLine(
      renderSteeringNote(steeredRendering.map((i) => decodePath(files[i]))),
    );
  }
  const names = files.map((name) => decodePath(name));
  const shown = names.slice(0, 8).join(', ');
  writeStderrLine(
    `fix-delta: ${names.length} file(s) changed since the snapshot — ${shown}` +
      (names.length > 8 ? `, and ${names.length - 8} more` : ''),
  );
  if (preExisting.length > 0) {
    writeStderrLine(preExistingDirtNote(displayNames(preExisting)));
  }
  if (freshDirt.length > 0) {
    writeStderrLine(submoduleBlindSpot(displayNames(freshDirt), false));
  }
  if (unresolvedNow.length > 0) {
    writeStderrLine(unresolvedBlindSpot(displayNames(unresolvedNow), false));
  }
  if (cleaned.length > 0) {
    writeStderrLine(cleanedSubmoduleNote(displayNames(cleaned)));
  }
  if (movedInside.length > 0) {
    writeStderrLine(movedInsideNote(displayNames(movedInside)));
  }
}

export const fixDeltaCommand: CommandModule = {
  command: 'fix-delta',
  describe:
    'Record the working tree before `--fix` edits it (--snapshot), then diff ' +
    'the tree against that record after the edits (--since): the hunks the fix ' +
    'applied, and nothing else, for the Step 6B fix audit. Never writes the ' +
    "user's index or the stash.",
  builder: (yargs) =>
    yargs
      .option('snapshot', {
        type: 'boolean',
        describe: 'Record the working tree now, as a tree object, into --out',
      })
      .option('since', {
        type: 'string',
        describe:
          'A snapshot file from --snapshot; writes the diff from it to the ' +
          'tree now into --out (review side files under .qwen/ excluded)',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Where to write the snapshot (JSON) or the diff',
      }),
  handler: (argv) => {
    runFixDelta({
      snapshot: argv['snapshot'] === true,
      since: argv['since'] as string | undefined,
      out: argv['out'] as string,
    });
  },
};
