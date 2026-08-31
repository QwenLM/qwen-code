/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Disposable sibling worktrees, and the steps their users need.
//
// `test-efficacy` runs its mutants in one; `base-tree` builds the merge-base in
// another; `scratch-tree` hands a third to each Step 4 verifier. All three add a
// tree beside the review worktree, all must survive a leftover from a crashed
// run, and all need the sweep's stderr to explain a subsequent `add` failure —
// so the step lives here rather than three times.
//
// The residue probe below is the same subject seen from the other side: the
// reason those trees exist is that the SHARED review worktree must stay exactly
// as the PR left it while other agents read it.

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { inertPath } from './paths.js';
import { readWorkspacePackages } from './workspaces.js';

export type SweepResult = ReturnType<typeof spawnSync>;

/**
 * The git environment variables that redirect repository discovery, which
 * this pipeline must never inherit.
 *
 * An exported GIT_DIR overrides discovery for EVERY identity check at once —
 * both sides of every comparison see the same override, so no check can
 * detect it, and even the head sha is read from the wrong repository. These
 * variables mean a human deliberately redirected their own shell; this
 * command's trees are chosen by the paths its callers pass, and a measurement
 * or reset that lands where the environment points instead is aimed at
 * someone else's work.
 */
const GIT_ENV_REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

/**
 * The environment's other half: variables that inject CONFIG rather than
 * redirect discovery.
 *
 * Dropping the discovery redirects and keeping these would be a gate on the
 * front door with the window open — `GIT_CONFIG_COUNT` plus
 * `GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` sets any config key for the run
 * (`core.fsmonitor` and the `filter.*` pair are command execution), and
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_PARAMETERS` do the same
 * by other routes. The numbered keys are removed by scanning the environment,
 * because the count that names them is itself the thing being removed.
 */
const GIT_ENV_CONFIG = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
];

/**
 * The third half: variables git EXECUTES rather than reads.
 *
 * The two lists above close redirection and config injection and leave the
 * most direct route open — `GIT_SSH_COMMAND` and `GIT_EXTERNAL_DIFF` are a
 * command, `GIT_EXEC_PATH` moves git's own subcommand and remote-helper lookup
 * to a directory of the setter's choosing, `GIT_TEMPLATE_DIR` plants hooks that
 * run at the next `init`, and the askpass/proxy/editor trio are exec'd
 * conditionally. This is not a new judgement call: `config/shared-env-keys.ts`
 * already blocks exactly this family for session subprocesses, with the
 * rationale written out there, and a review's git calls run as the same user
 * with the same inheritance. `XDG_CONFIG_HOME` rides along because git merges
 * `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`, which is the same config
 * injection without naming a git variable at all.
 *
 * The setter does not have to be an attacker for this to matter: a reviewer's
 * shell profile exporting `GIT_EXEC_PATH` for an unrelated reason silently
 * changes which `git-remote-https` every fetch in this pipeline runs.
 */
const GIT_ENV_EXEC = [
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_EXTERNAL_DIFF',
  'XDG_CONFIG_HOME',
];

/**
 * The first symlink at or above `dir`, or null when every component is real.
 *
 * The walk STOPS at `stopAt` — the checkout — and does not climb through it.
 * Components above the repository are the user's own filesystem layout, not
 * anything a probe can plant: `/var` is a symlink on every macOS box, so a
 * walk to `/` refuses every sweep there while reporting that it found a
 * redirect. What this looks for is a link inside the tree the pipeline owns,
 * which is where a probe can put one.
 */
export function redirectedAncestor(
  dir: string,
  stopAt: string = process.cwd(),
): string | null {
  try {
    // Canonical on BOTH sides of the stop test, and only there: `process.cwd()`
    // reports the resolved path while a caller's string may not (`/var` vs
    // `/private/var` on macOS is the everyday case), so a literal comparison
    // never matches and the walk climbs past the checkout into exactly the
    // system links this is not about. The symlink test above it stays lstat —
    // canonicalising THAT would resolve away the thing being looked for.
    // Where the stop is no ancestor of the walk's path neither stop test
    // fires and the walk lstats every component up to the filesystem root.
    const stop = resolve(stopAt);
    let stopReal = stop;
    try {
      stopReal = realpathSync(stopAt);
    } catch {
      // Unresolvable: the literal comparison below is the whole stop test.
    }
    for (let cur = resolve(dir); ; cur = dirname(cur)) {
      if (lstatSync(cur).isSymbolicLink()) return cur;
      if (cur === stop) return null;
      try {
        if (realpathSync(cur) === stopReal) return null;
      } catch {
        // A component that does not resolve is not the checkout; keep walking.
      }
      // `dir` was not under `stopAt` at all: nothing this owns is above it.
      if (dirname(cur) === cur) return null;
    }
  } catch {
    // A path that does not resolve has nothing above it to redirect through;
    // the caller's own absent-path handling answers that case.
    return null;
  }
}

/** Git invocations must resolve the tree they are given, not the caller shell's redirects. */
export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Case-INSENSITIVE, because Windows env lookup is: `git_dir` and `Git_Dir`
  // reach the child exactly as `GIT_DIR` does, while an exact-case delete on a
  // plain object removes neither. `config/shared-env-keys.ts` — the file this
  // list is modelled on — folds case for this reason, and diverging from the
  // model was an oversight rather than a decision.
  const drop = new Set(
    [...GIT_ENV_REDIRECTS, ...GIT_ENV_CONFIG, ...GIT_ENV_EXEC].map((k) =>
      k.toLowerCase(),
    ),
  );
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (drop.has(lower) || /^git_config_(key|value)_\d+$/.test(lower)) {
      delete env[key];
    }
  }
  // `refs/replace` redirects OBJECT lookup: one `git replace <sha> <evil>` in
  // the common dir — a directory nothing in this pipeline wipes — and every
  // later `worktree add --detach <sha>` and `checkout --detach <sha>` in this
  // pipeline materialises the attacker's tree while `rev-parse <sha>` still
  // answers the original, because rev-parse resolves the ref and the checkout
  // resolves the object. Nothing here wants a replacement object, and the
  // reader the pipeline points at `git show HEAD:` does not either.
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  return env;
}

/**
 * Free a disposable worktree's path: unregister it, then remove what is left.
 *
 * `git worktree remove --force` only clears a tree git still tracks. A directory
 * left at the path after metadata loss or a partial cleanup is reported "not a
 * working tree" and left in place — and a *non-empty* one then makes
 * `git worktree add` fail `already exists`, wedging every later run until
 * someone clears it by hand. So the unregister is followed by a plain remove of
 * whatever dir remains. `rmSync` unlinks a symlink rather than following it, so
 * a tampered leftover cannot redirect the delete outside `tree`.
 *
 * This is `releaseWorktree`'s two-step, and deliberately NOT a call to it:
 * `releaseWorktree` runs git from the process cwd, which need not be this
 * worktree's repo, and it discards the sweep's stderr — which is usually the
 * only thing that explains a subsequent `add` failure. Every caller here needs
 * `cwd` and that stderr.
 *
 * Best-effort by design: a clean path is the normal case, so the unregister does
 * not throw on a non-zero status. `rmSync` still can (`force` suppresses ENOENT
 * but not EPERM/EBUSY) — callers decide what that means.
 */
export function discardWorktree(
  cwd: string,
  tree: string,
): SweepResult | undefined {
  // A symlink at the tree path must never reach `git worktree remove`: git
  // resolves it and force-removes whichever registered worktree it points at
  // — a victim this path never owned, measured live. A symlink is never a
  // worktree; unlinking it — all the `rmSync` below does to it — is the whole
  // job here.
  let symlink = false;
  try {
    symlink = lstatSync(tree).isSymbolicLink();
  } catch {
    // Absent: nothing for the guard, and the rmSync below is a no-op.
  }
  // Read BEFORE anything is removed: the tree's own `.git` file names the admin
  // directory that belongs to it (`gitdir: <common>/worktrees/<id>`). That
  // pointer is the only trustworthy link between a path and its registration —
  // the `gitdir` files on the other side are writable by anything running as
  // the user, so scanning THEM and matching on content lets a rewritten one
  // aim this cleanup at a live sibling's registration.
  const ownAdminDir = adminDirOf(tree);
  let sweep: SweepResult | undefined;
  if (!symlink) {
    sweep = spawnSync('git', ['worktree', 'remove', '--force', tree], {
      cwd,
      encoding: 'utf8',
      env: sanitizedGitEnv(),
    });
    if (sweep.status !== 0) {
      // A LOCKED admin entry is the one leftover neither `remove --force` nor
      // `prune` can clear, and probe code has a shell inside these trees: one
      // `touch` in the admin dir the tree's own gitfile names is enough. Every
      // later `worktree add` at that path then fatals "missing but locked", for
      // every disposable tree of that review, until a human intervenes.
      // `unlock` + the second `--force` is what git documents for exactly this.
      spawnSync('git', ['worktree', 'unlock', tree], {
        cwd,
        encoding: 'utf8',
        env: sanitizedGitEnv(),
      });
      sweep = spawnSync(
        'git',
        ['worktree', 'remove', '--force', '--force', tree],
        { cwd, encoding: 'utf8', env: sanitizedGitEnv() },
      );
    }
  }
  rmSync(tree, { recursive: true, force: true });
  // And clear the ADMIN entry the two steps above can leave behind — but only
  // THIS path's. A tree whose `.git` gitfile is broken makes `worktree remove`
  // fail; `rmSync` then takes the directory, and `.git/worktrees/<name>`
  // survives, so the next `worktree add` here refuses "missing but already
  // registered". A repo-wide `git worktree prune` clears that and much more: it
  // deregisters ANY entry whose directory is momentarily absent — another
  // shard's `worktree add` mid-flight (this pipeline runs discards and adds
  // concurrently against one common dir), or the user's own worktree on a
  // volume that happens to be unmounted. So the entry is found by its own
  // `gitdir` file and removed alone.
  dropWorktreeRegistration(cwd, tree, ownAdminDir);
  return sweep;
}

/** The residue probe's answer: what to name, and how much it left unnamed. */
export interface WorktreeResidue {
  /** The dirty paths, capped — every one of them safe to interpolate. */
  paths: string[];
  /**
   * How many the tree actually holds. `total > paths.length` means the cap bit,
   * and both renderers say so: a capped list presented as the complete one is a
   * verifier restoring twelve paths and leaving the thirteenth in the tree the
   * next round reads.
   */
  total: number;
  /**
   * Why the check could not run, when it could not. An empty list means "clean"
   * ONLY when this is absent: a `git status` that died — ENOBUFS on a tree so
   * dirty its output passed the buffer, a repository git refused to read — used
   * to be indistinguishable from a pristine tree, and the overload case is
   * exactly the one where the answer matters. Both renderers say "could not be
   * measured" instead of "clean" when this is set.
   */
  unmeasured?: string;
}

/**
 * Remove the admin entry that names `tree`, and nothing else.
 *
 * `<common>/worktrees/<id>/gitdir` holds the path of the `.git` FILE inside the
 * working tree, so the entry for a given path is identifiable without asking
 * git to sweep. Best-effort throughout: a leftover admin entry costs the next
 * `worktree add` at this path, which the caller reports; guessing wider costs
 * somebody else's worktree.
 */
function dropWorktreeRegistration(
  cwd: string,
  tree: string,
  adminDir: string | null,
): void {
  if (adminDir !== null) {
    try {
      rmSync(adminDir, { recursive: true, force: true });
    } catch {
      // Unremovable: the next `worktree add` here says "already registered",
      // which is loud and recoverable.
    }
    return;
  }
  // No usable pointer — the case this whole step exists for, since a tree whose
  // `.git` is corrupt is exactly the one `worktree remove` refuses and the next
  // `add` then calls "already registered". Fall back to the reverse scan, and
  // only for entries whose named tree is GONE: a live worktree's registration
  // is never this cleanup's business, whatever its `gitdir` file claims.
  const common = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8', env: sanitizedGitEnv() },
  );
  if (common.status !== 0 || typeof common.stdout !== 'string') return;
  const dir = join(common.stdout.trim(), 'worktrees');
  let ids: string[];
  try {
    ids = readdirSync(dir);
  } catch {
    return; // No linked worktrees at all.
  }
  const wanted = samePath(tree);
  for (const id of ids) {
    try {
      const gitdir = readFileSync(join(dir, id, 'gitdir'), 'utf8').trim();
      const named = dirname(gitdir);
      if (samePath(named) !== wanted) continue;
      if (existsSync(named)) continue;
      rmSync(join(dir, id), { recursive: true, force: true });
    } catch {
      // Unreadable entry: leave it. The next `add` will say so.
    }
  }
}

/**
 * The admin directory a worktree's own gitfile points at, or null.
 *
 * `<tree>/.git` holds `gitdir: <common>/worktrees/<id>`. Reading the pointer
 * FROM THE TREE is what makes the later removal precise: the reverse mapping —
 * scanning every `<common>/worktrees/<id>/gitdir` for one whose content names
 * this path — reads files any same-user process can rewrite, so a tampered one
 * would hand this cleanup somebody else's registration to delete.
 */
function adminDirOf(tree: string): string | null {
  try {
    const pointer = readFileSync(join(tree, '.git'), 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) return null;
    const dir = resolve(dirname(resolve(tree)), match[1].trim());
    // It must look like a linked-worktree admin dir, and it must still name
    // this tree back: `<id>/gitdir` is written by git when the worktree is
    // created, and a mismatch means the pointer is not describing this pair.
    const back = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
    return samePath(dirname(back)) === samePath(tree) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * A path in the one spelling both sides of that comparison can produce.
 *
 * git records the entry's path as git resolved it, and this code holds the path
 * as the caller spelled it — on macOS that is `/private/var/…` against
 * `/var/…`, and the entry then matches nothing. The PARENT is resolved rather
 * than the path itself, because the tree is usually already deleted by the time
 * this runs.
 */
function samePath(p: string): string {
  const abs = resolve(p);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/**
 * The residue probe's build-artifact exclusion, enforced by the PIPELINE
 * rather than borrowed from the commit: `core.excludesFile` applies whether
 * or not the HEAD `.gitignore` covers these names (see worktreeResidue).
 * Writing the repository's own `info/exclude` is not an option: from a linked
 * worktree it resolves to the user's COMMON repository.
 */
let pipelineExcludesFile: string | null = null;
function pipelineExcludeArgs(): string[] {
  if (pipelineExcludesFile === null) {
    try {
      // A PRIVATE directory, created fresh: the first cut wrote a constant name
      // in the shared temp dir, which git then re-read on every later `status`
      // — so anything able to write that path could add `*` to it and blind the
      // tripwire, and a pre-planted symlink there could redirect the write.
      // `mkdtempSync` yields a path nobody can predict, and `wx` refuses to
      // follow a link or overwrite.
      const file = join(
        mkdtempSync(join(tmpdir(), 'qwen-review-excludes-')),
        'excludes',
      )
        // Forward slashes: git's config parser reads backslashes as escapes.
        .split(sep)
        .join('/');
      writeFileSync(file, 'node_modules/\ndist/\n', {
        flag: 'wx',
        mode: 0o600,
      });
      pipelineExcludesFile = file;
    } catch {
      // No tmp file: fall back to the commit's own ignore rules, which cover
      // the ordinary repo.
      pipelineExcludesFile = '';
    }
  }
  return pipelineExcludesFile === ''
    ? []
    : ['-c', `core.excludesFile=${pipelineExcludesFile}`];
}

/**
 * True for a path the pipeline itself produced in the tree it is measuring.
 *
 * These are the excludes the residue probe applies in CODE rather than through
 * a rule file, because the ignore-independent listing honors no rule file at
 * all and a contaminator can reach every one that exists. `node_modules/` and
 * `dist/` are what the dependency farm and the build put there; `.husky/_/` is
 * what `npm ci` puts there, through the `prepare` hook, on any repo using
 * husky — an untracked directory hidden by an untracked `.gitignore` of its
 * own, so it survives every rule-provenance test below and would otherwise be
 * named as residue on every healthy run.
 *
 * The list is the pipeline's own footprint and nothing else. It is also, and
 * this is the honest half, three more places a probe can hide: the same
 * blindness `node_modules/` and `dist/` have always had here.
 */
function inPipelineFootprint(rec: string): boolean {
  const parts = rec.split('/');
  // Directory components only — a plain FILE named `dist` is not build output.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'node_modules' || parts[i] === 'dist') return true;
    if (
      parts[i] === '.husky' &&
      parts[i + 1] === '_' &&
      i + 1 < parts.length - 1
    )
      return true;
  }
  return false;
}

/** The ignore file that hid a path, and the pattern in it that matched. */
interface IgnoreRule {
  source: string;
  pattern: string;
}

/**
 * Which ignore rule hides each of these paths, asked of git rather than
 * guessed. `null` when the question could not be put — the caller reports
 * unmeasured rather than assuming either answer.
 */
function ignoreSourcesOf(
  cwd: string,
  paths: string[],
  anchor: readonly string[] = [],
): Map<string, IgnoreRule> | null {
  const r = spawnSync(
    'git',
    [
      ...anchor,
      ...pipelineExcludeArgs(),
      'check-ignore',
      '-z',
      '-v',
      '--stdin',
    ],
    {
      cwd,
      input: `${paths.join('\0')}\0`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  // 0 = at least one path is ignored, 1 = none of them are. Both are answers;
  // anything else is a failure to ask.
  if (
    r.error ||
    (r.status !== 0 && r.status !== 1) ||
    typeof r.stdout !== 'string'
  ) {
    return null;
  }
  // `<source>\0<line>\0<pattern>\0<path>\0` per record.
  const fields = r.stdout.split('\0');
  const rules = new Map<string, IgnoreRule>();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    rules.set(fields[i + 3], { source: fields[i], pattern: fields[i + 2] });
  }
  return rules;
}

/**
 * True for a pattern that hides EVERYTHING rather than naming something.
 *
 * This is the whitelist form — `*` at the top of a `.gitignore` with
 * `!`-negations under it — and it is the one shape a committed ignore file can
 * take that must not be trusted the way `coverage/` or `*.tsbuildinfo` are.
 * Those name a build artifact; `*` names nothing and swallows a probe's
 * leftovers along with everything else, which is #9207 with the tripwire
 * blindfolded. A repo may legitimately be written that way, so this is not a
 * finding about the repo — it is the reason its ignore rules cannot answer the
 * question this probe is asking.
 */
function hidesEverything(pattern: string): boolean {
  const core = pattern.replace(/^\//, '').replace(/\/$/, '');
  if (core.length === 0) return false;
  // Every segment wildcard-only, and at least one `*` so the pattern is not
  // length-limited to a fixed number of characters. That is `*`, `**`, `**/*`
  // — and `?*`, which the first cut missed: `?` matches any single character,
  // so `?*` is `*` with extra steps, and a `.gitignore` whose whitelist is
  // spelled that way would have vouched for everything it hid. Naming the
  // spellings one at a time is how that hole got made; the shape is "nothing
  // in this pattern names anything".
  const segments = core.split('/');
  return core.includes('*') && segments.every((seg) => /^[*?]+$/.test(seg));
}

/**
 * The subset of those ignore sources that the commit under review carries.
 *
 * Anything else is a rule this checkout did not come with: `info/exclude` in
 * the common dir, a `.gitignore` written after the checkout, an excludes file
 * outside the tree. A source git names with an absolute path or one climbing
 * out of the worktree is not asked about at all — `ls-files` would reject the
 * pathspec, and unknown provenance is untrusted provenance.
 */
function trackedIgnoreSources(
  cwd: string,
  sources: Set<string>,
  anchor: readonly string[] = [],
): Set<string> {
  const inside = [...sources].filter(
    (s) =>
      s.length > 0 && !isAbsolute(s) && !s.split('/').some((p) => p === '..'),
  );
  if (inside.length === 0) return new Set();
  const r = spawnSync('git', [...anchor, 'ls-files', '-z', '--', ...inside], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedGitEnv(),
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    return new Set();
  }
  return new Set(r.stdout.split('\0').filter((p) => p.length > 0));
}

/**
 * The residue list's default cap, exported so a caller that must name it —
 * the only way to reach the sha parameter after it — names THIS module's
 * default instead of restating a literal that could silently drift from it.
 */
export const RESIDUE_PATH_CAP = 12;

/**
 * Caps for the config screen, which reads attacker-writable files.
 *
 * `MAX_SCREEN_KEYS` bounds what a refusal REPORTS — the message names the
 * first keys and the caller says how many more; an unbounded join is its own
 * denial-of-service, the same rule the `unreadable` field follows by naming
 * one file rather than a list. `MAX_SCREEN_CANDIDATES` bounds what the screen
 * READS: one synchronous spawn per registered worktree, on a directory a
 * probe can fill. Both fail closed — past the candidate bound the screen
 * refuses, because skipping would let filler entries hide a real filter.
 */
export const MAX_SCREEN_KEYS = RESIDUE_PATH_CAP;
export const MAX_SCREEN_CANDIDATES = 256;

/**
 * The repo-local `filter.<name>` COMMANDS, when any are defined.
 *
 * A checkout EXECUTES these whenever it rewrites a file, and disabling hooks
 * does not cover filters — they are separate config. The callers that screen
 * through this function are the scratch tree's reset and rebuild, the probe
 * tree's per-run restore, and the probe tree's revert. That list is the set of
 * SCREENED sites, not a census of the pipeline's filter-executing checkouts:
 * the `worktree add` spawns that CREATE the probe and base trees run
 * unscreened today, and hooks are neutralised only at the spawns that pass
 * `core.hooksPath` explicitly, not pipeline-wide. Do not read this comment as
 * a completeness map — widening the screen means adding a call site, and the
 * count above is what has one.
 *
 * The planting surface this screen covers is two plain writes a probe can
 * make into the COMMON dir this command's report calls shared:
 * `git config filter.evil.smudge CMD` and one line appended to
 * `$(git rev-parse --git-path info/attributes)`. discard and cleanup never
 * wipe the common dir, so a filter planted while reviewing one PR fires on
 * every later matching checkout of the user's OWN repository — persistence
 * planted by reviewing a malicious PR, measured live. The candidate config
 * files are read with `--file … --includes` rather than merged config: filters
 * in the user's global config (git-lfs is the common one) are the user's own
 * contract, exactly like any git command they run, so global config stays out
 * of scope — but `--includes` follows the `include.path` / `includeIf` chain a
 * screened file itself names, because the checkout does, and a filter hidden
 * one include-hop behind a screened candidate would otherwise be invisible to
 * the screen and executed by the checkout. Screening repo-local-only is a
 * deliberate TRADE, not a claim that repo-local files are all a probe can reach: probe
 * code runs as the user, so `git config --global` is open to it, and a filter
 * planted there is read by every checkout here and never seen by this screen.
 * Refusing on merged config is not the answer — `git lfs install` writes
 * `filter.lfs.clean` globally, and refusing on that is permanent refusal for
 * every contributor who has git-lfs. The state cannot be told apart from a
 * filter the user set deliberately, and cannot be safely wiped, so a hit is a
 * refusal upstream, not a cleanup here.
 */
export interface LocalFilterScreen {
  /**
   * The repo-local `filter.<name>` command keys found, capped at
   * `MAX_SCREEN_KEYS`. `total` says how many there were before the cap, so a
   * refusal can name what it is not showing instead of silently shortening.
   */
  keys: string[];
  /** How many distinct keys the screen found, before the cap on `keys`. */
  total: number;
  /**
   * Why the screen stopped, when it did.
   *
   * `unreadable` and `over-cap` both refuse, but they call for opposite
   * remedies: an unreadable candidate is a file to fix or remove, while an
   * over-cap admin directory was read perfectly well and holds more
   * registered worktrees than the bound — "remove that file" there would
   * deregister every legitimate linked worktree, the pipeline's own included.
   */
  stopped: 'unreadable' | 'over-cap' | null;
  /**
   * The first candidate file the screen could not read to completion, when one
   * stopped it — otherwise null.
   *
   * Exit 1 is git's ordinary "no key matched" and is not a failure. Anything
   * else is: a spawn error, a config git could not parse to the end (a
   * malformed section, or an include it could not follow), or an ENOBUFS from
   * more filter keys than the buffer holds. Skipping such a file reports the
   * repository clean on the one file that might define the filter, so the caller
   * refuses instead. One file, not a list: the refusal only has to name where
   * the screen stopped, and an unbounded join is its own denial-of-service.
   */
  unreadable: string | null;
}

/**
 * The screened keys, flattened and counted, for a refusal message.
 *
 * `keys` arrives already capped by the producer, so this never re-slices; it
 * reports the shortfall instead. Both halves matter: `inertPath` because a
 * config subsection name legally carries control and format characters that
 * `--get-regexp` prints verbatim, and these strings land in the agent-facing
 * report; the count because a message naming 12 of 13 keys sends a user to
 * remove the 12 and be refused again on the one it never mentioned.
 */
export function screenKeyList(screen: LocalFilterScreen): string {
  const shown = screen.keys.map(inertPath).join(', ');
  return screen.total > screen.keys.length
    ? `${shown} (capped enumeration: ${screen.keys.length} shown of ${screen.total})`
    : shown;
}

/**
 * Why a screen that stopped could not finish, phrased for the reader who has
 * to act on it.
 *
 * The two causes need opposite remedies, so they must not share a sentence:
 * an unreadable candidate is a file to fix or remove, while an over-cap admin
 * directory was read perfectly well — telling that reader to "remove that
 * file" would deregister every legitimate linked worktree they have.
 */
export function screenStopDetail(screen: LocalFilterScreen): string {
  const where = inertPath(screen.unreadable ?? '');
  return screen.stopped === 'over-cap'
    ? `more than ${MAX_SCREEN_CANDIDATES} worktrees are registered under ${where} — more than this screen will walk, so it cannot tell whether one of them defines a content filter. Prune stale ones (\`git worktree prune\`) and re-run`
    : `${where} could not be read to the end`;
}

/**
 * A single `git rev-parse <flag>` answer, as a path, or null on any failure.
 *
 * One invocation per value, never a combined newline-delimited request: the
 * answers are arbitrary filesystem paths and a POSIX path may itself carry a
 * newline, so a combined answer cannot be split unambiguously — a healthy
 * worktree below a directory whose name holds a newline parses to extra
 * records, misassigns the paths, and the caller reports a live plant as clean
 * or a real worktree as not-a-worktree. Measured with exactly such a directory.
 * The only byte removed is git's terminal record delimiter; every other byte
 * belongs to the path, so neither a split nor a trim is a parse here. Callers
 * that need absolute paths pass `--path-format=absolute` as a leading flag.
 */
/**
 * The screen's spawn budget.
 *
 * Every read below opens attacker-writable config, and git follows an
 * `include.path` at startup — so a plant naming a FIFO (or a symlink to
 * `/dev/zero`) blocks the very first `rev-parse`. `spawnSync` blocks the event
 * loop, so no JS timer can interrupt it; the bound has to be on the spawn.
 */
const SCREEN_SPAWN_TIMEOUT_MS = 20_000;

/**
 * A rev-parse answer, or null when the screen could not get one.
 *
 * `encoding: 'utf8'` transcodes an invalid byte to U+FFFD, so a repository
 * under a path carrying one yields an answer that names no real file. Callers
 * must treat that as unmeasured rather than resolve candidates against it —
 * the residue walker in this file fails the same shape closed for the same
 * reason.
 */
function revParsePath(cwd: string, ...flags: string[]): string | null {
  const r = spawnSync('git', ['rev-parse', ...flags], {
    cwd,
    encoding: 'utf8',
    timeout: SCREEN_SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: sanitizedGitEnv(),
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

/** True when a transcode replaced bytes this screen would otherwise resolve. */
function carriesReplacementChar(value: string): boolean {
  return value.includes('\uFFFD');
}

/**
 * How many include hops the screen will follow before refusing.
 *
 * The graph is attacker-written and may be cyclic or merely deep; visited
 * targets are tracked, so this bounds work rather than correctness.
 */
const MAX_INCLUDE_HOPS = 32;

/**
 * The `include.path` / `includeIf.*.path` targets a candidate names, resolved.
 *
 * Read WITHOUT `--includes`, so git reports the directives this file literally
 * carries and evaluates no condition. Whether a conditional include would fire
 * is not a question this screen can answer — the condition is evaluated
 * against whichever tree git runs in, and the checkout runs in a different one
 * — so every target is followed regardless of its condition, and the decision
 * about which ones matter is made by LOCATION below, not by git.
 */
function includeTargetsOf(
  worktree: string,
  file: string,
): { targets: string[]; unreadable: boolean } {
  const r = spawnSync(
    'git',
    ['config', '--file', file, '--get-regexp', '^include(If\\..*)?\\.path$'],
    {
      cwd: worktree,
      encoding: 'utf8',
      timeout: SCREEN_SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...sanitizedGitEnv(), LC_ALL: 'C' },
    },
  );
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    return { targets: [], unreadable: true };
  }
  if (r.status === 1 || typeof r.stdout !== 'string') {
    return { targets: [], unreadable: false };
  }
  const targets: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.length === 0) continue;
    // `key value`, and only the FIRST space separates them — a path may hold
    // the rest, including further spaces.
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const raw = line.slice(sp + 1);
    if (raw.length === 0) continue;
    // git expands a leading `~` against HOME and resolves anything else
    // against the including file's directory. Expand it the same way rather
    // than skipping: a repository commonly lives under HOME, so `~/...` can
    // name a target INSIDE it, and the location test below is what decides.
    if (raw === '~' || raw.startsWith('~/')) {
      const home = process.env['HOME'];
      if (home === undefined || home.length === 0) continue;
      targets.push(resolve(home, raw.slice(raw === '~' ? 1 : 2)));
      continue;
    }
    // `~user/` is not expanded here — resolving another account's home is not
    // this screen's business, and an unexpanded path simply is not followed.
    if (raw.startsWith('~')) continue;
    targets.push(resolve(dirname(file), raw));
  }
  return { targets, unreadable: false };
}

export function localFilterCommands(worktree: string): LocalFilterScreen {
  const commonDir = revParsePath(worktree, '--git-common-dir');
  const gitDir = revParsePath(worktree, '--git-dir');
  if (commonDir === null || gitDir === null) {
    // Two very different reasons land here, and only one is benign. A plain
    // "not a repository" answer is the caller's own problem — its checkout has
    // nothing to run in either. But a discovery spawn KILLED at the timeout
    // above reaches this line too, and that one happens precisely when a plant
    // has made git block, so it must not read as clean. There is no way to
    // tell them apart from the outside, so this fails closed: a screen that
    // could not discover the repository did not screen it.
    return {
      keys: [],
      total: 0,
      unreadable: worktree,
      stopped: 'unreadable',
    };
  }
  if (carriesReplacementChar(commonDir) || carriesReplacementChar(gitDir)) {
    // An invalid byte in the repository path came back as U+FFFD, so every
    // candidate built from it names a file that does not exist, the admin
    // readdir hits ENOENT — "the ordinary case" — and the screen would answer
    // clean over whatever the real path holds. Unmeasured, not clean.
    return {
      keys: [],
      total: 0,
      unreadable: worktree,
      stopped: 'unreadable',
    };
  }
  const common = resolve(worktree, commonDir);
  const candidates = [
    join(common, 'config'),
    join(resolve(worktree, gitDir), 'config.worktree'),
  ];
  // Every OTHER worktree's per-worktree config too. This screen runs against
  // the review worktree, but the checkout it authorises runs in the SCRATCH
  // tree, whose own `<common>/worktrees/<label>/config.worktree` is honored
  // once `extensions.worktreeConfig` is on and was never read here — a filter
  // planted there executed during the reset while this function reported the
  // repository clean. The admin directory is one `readdir`, and a filter in
  // any of these is a plant whichever tree carries it.
  //
  // Bounded, and fail closed over the bound. Each entry costs one synchronous
  // `git config` spawn below, and the admin directory is the same never-wiped
  // surface the filter itself is planted in: M empty `worktrees/<e>/` dirs are
  // M spawns on EVERY screen call, which is once per mutant. A healthy repo
  // carries O(shards) entries. Past the cap the screen has not read what it
  // was asked to read, so it refuses rather than walking a plant's filler —
  // and refusing beats skipping, which would let filler hide a real filter.
  let worktreeEntries: string[] | null = null;
  try {
    worktreeEntries = readdirSync(join(common, 'worktrees'));
  } catch (e) {
    // ENOENT is the ordinary "no linked worktrees registered" — the two
    // candidates above are all of it. Anything else is a directory this
    // screen could NOT walk while git still opens each `config.worktree` by
    // direct path (the search bit alone suffices), so a swallowed EACCES
    // would answer clean on candidates that were never read. Refuse instead:
    // this is the directory-level twin of the per-file readability gate below.
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        keys: [],
        total: 0,
        unreadable: join(common, 'worktrees'),
        stopped: 'unreadable',
      };
    }
  }
  if (worktreeEntries && worktreeEntries.length > MAX_SCREEN_CANDIDATES) {
    return {
      keys: [],
      total: 0,
      unreadable: join(common, 'worktrees'),
      stopped: 'over-cap',
    };
  }
  for (const entry of worktreeEntries ?? []) {
    candidates.push(join(common, 'worktrees', entry, 'config.worktree'));
  }
  // Anything under these is the repository's own state, which a probe can
  // write and cleanup never wipes. Anything outside them is the user's — their
  // global config is their contract exactly as it is for any git command they
  // run, and `git lfs install` puts `filter.lfs.clean` there. So an include
  // whose target lands inside is followed and screened; one pointing out is
  // left alone. That is the whole rule, and it is a rule about LOCATION, which
  // is the same in every tree — unlike an `includeIf` condition, which is not.
  const repoRoots = [common, resolve(worktree, gitDir), resolve(worktree)].map(
    (d) => {
      try {
        return realpathSync(d);
      } catch {
        return d;
      }
    },
  );
  const insideRepo = (p: string): boolean => {
    let real = p;
    try {
      real = realpathSync(dirname(p)) + sep + basename(p);
    } catch {
      // Not yet resolvable: judge the literal path rather than skipping it.
    }
    return repoRoots.some(
      (root) => real === root || real.startsWith(root + sep),
    );
  };

  const found = new Set<string>();
  let unreadable: string | null = null;
  // Seeded with the candidates themselves, so an include pointing back at
  // one of them is not walked twice.
  const seen = new Set<string>(candidates);
  const queue = [...candidates];
  let hops = 0;
  for (const file of queue) {
    if (!existsSync(file)) continue;
    // Existence is not readability, and git does not distinguish them for us:
    // an unreadable `--file` exits 1 with a warning on stderr — byte-identical
    // in status to "no key matched" — so asking git and reading the exit code
    // reports a config this screen never read as clean. Settle it here instead,
    // by construction: a regular file (git follows symlinks to read config, so
    // this must too) that this process can open. Anything else is a candidate
    // the screen could not check, which is a refusal, not a pass.
    let readable = false;
    try {
      readable = statSync(file).isFile();
      if (readable) accessSync(file, fsConstants.R_OK);
    } catch {
      readable = false;
    }
    if (!readable) {
      unreadable ??= file;
      continue;
    }
    const r = spawnSync(
      'git',
      [
        'config',
        '--file',
        file,
        // NO `--includes`. It looks like the honest read — the checkout does
        // expand includes — but it makes git EVALUATE `includeIf` conditions
        // in this process's context, and the checkout this authorises runs in
        // a different tree. A condition false here and true there hides a
        // filter from the screen that the checkout then executes, and
        // `includeIf.hasconfig:remote.*.url:` never fires under `--file` at
        // all. There is no context that matches a cross-tree checkout, so the
        // include graph is walked explicitly below instead of delegated.
        // BEFORE the pattern: `--name-only` after it silently prints nothing
        // and exits 1 even with live keys. With it, each line is the whole key
        // and nothing has to be parsed out of a `key value` pair — a config
        // subsection name may legally carry whitespace, and splitting on it
        // named `filter.evil` for a planted `filter.evil name.smudge`, so the
        // refusal prescribed an unset that exits 5 while the plant stood. Key
        // names cannot contain newlines, so line-per-key is unambiguous.
        '--name-only',
        '--get-regexp',
        // `process` beside the pair: it is the third executable key (a
        // long-running filter git speaks a protocol to), and enumerating two
        // of three is how the first cut of this screen read as complete.
        '^filter\\..*\\.(smudge|clean|process)$',
      ],
      {
        cwd: worktree,
        encoding: 'utf8',
        // No raised `maxBuffer`: `--name-only` prints one KEY per matching line
        // and never the value, so a padded `smudge` value cannot reach stdout —
        // output is bounded by key count, not by an attacker-chosen length. A
        // config carrying more keys than the default holds sets `r.error`
        // (ENOBUFS), which the gate below turns into a refusal.
        timeout: SCREEN_SPAWN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        // Byte-wise regex semantics. `--get-regexp` is POSIX matching and is
        // locale-sensitive: under a UTF-8 locale a key whose subsection name
        // carries an invalid byte never matches, so git exits 1 and the gate
        // below reads that as the ordinary clean answer — while the checkout
        // resolves filter keys by exact name, which no locale affects. The
        // screen would certify clean over a filter the checkout runs.
        env: { ...sanitizedGitEnv(), LC_ALL: 'C' },
      },
    );
    // Exit 1 is "no key matched" — the ordinary clean answer. Every other
    // outcome means this file was not read to the end, and a screen that did
    // not finish must not be the reason a checkout is authorised.
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      unreadable ??= file;
      continue;
    }
    // Follow this file's includes, but only where they land inside the
    // repository. git expands them for the checkout regardless; the screen
    // declines to chase one into the user's own configuration, which it must
    // not refuse on.
    if (hops < MAX_INCLUDE_HOPS) {
      const inc = includeTargetsOf(worktree, file);
      if (inc.unreadable) unreadable ??= file;
      for (const target of inc.targets) {
        if (!insideRepo(target) || seen.has(target)) continue;
        seen.add(target);
        hops += 1;
        if (hops > MAX_INCLUDE_HOPS) {
          unreadable ??= file;
          break;
        }
        queue.push(target);
      }
    }
    if (r.status === 1 || typeof r.stdout !== 'string') continue;
    for (const line of r.stdout.split('\n')) {
      const key = line;
      // A Set, not `Array.includes`: the key names here are attacker-written and
      // as many as the 1 MiB output holds, so a linear membership test per line
      // is quadratic on exactly the input this screen exists to survive.
      // (Measured: 100k keys took 144 s as an array scan and 53 ms as a Set.)
      if (key) found.add(key);
    }
  }
  return {
    keys: [...found].slice(0, MAX_SCREEN_KEYS),
    total: found.size,
    unreadable,
    stopped: unreadable === null ? null : 'unreadable',
  };
}

/**
 * The paths a tree carries that its HEAD commit does not — probe residue, seen
 * from the reading side (#9207).
 *
 * A review worktree is a pristine detached checkout of the PR head, and every
 * build artifact the review produces there is gitignored, so in a healthy run
 * this is empty. What it catches is the one thing that is neither: a file some
 * agent wrote into the shared tree, or a line it edited there, while the
 * pipelined loop had another agent reading the same tree. Named paths, not a
 * boolean — "the tree is dirty" tells a reader nothing it can act on, whereas
 * "these three paths are not in the commit" tells it exactly which of its
 * evidence to distrust.
 *
 * Three flags decide whether the names are usable, and every one of them was
 * wrong in the first cut:
 *
 * - `-z` because the names become COMMANDS. Porcelain's rendered form quotes a
 *   path with spaces or non-ASCII bytes (`"caf\303\251.ts"`) and writes a
 *   rename as `orig -> new`, so a file literally named `a -> b.ts` parsed to
 *   `b.ts"` — a name matching nothing on disk, handed to an agent as the path
 *   to run `git show HEAD:` against. The NUL format is unquoted and puts a
 *   rename's original path in its own record.
 * - `--untracked-files=all` because `normal` collapses a new directory to one
 *   `probe_dir/` entry, and every recovery this pipeline prints — `git show
 *   HEAD:`, `git checkout HEAD --` — fails on a directory. The contamination
 *   shape this exists to catch (an agent dropping probe files into a new
 *   folder) is exactly the shape `normal` renders unactionable. One directory
 *   shape survives the flag: git will not recurse into an untracked directory
 *   that holds its own `.git`, so a cloned fixture still arrives as a single
 *   `dir/` entry — detected and disclosed, but recoverable only by `rm -rf`,
 *   which is what both renderers tell the reader to use for untracked residue.
 * - `maxBuffer` because the default is 1 MB and `spawnSync` answers ENOBUFS by
 *   returning no stdout — which this function would have read as "clean". The
 *   overload case is the one where the tree is dirtiest.
 *
 * Ignored files are excluded, and the pipeline's own build artifacts
 * (`node_modules`, `dist`) are excluded even when the COMMIT under review
 * does not ignore them: the review builds in this tree, and a PR whose
 * `.gitignore` does not cover its install used to turn that install into
 * residue — every verifier's first act aimed at deleting the very tree its
 * farm borrows from.
 *
 * The tree's identity is checked before its state: git's repository discovery
 * walks UP, so a directory whose `.git` file is gone answers `git status`
 * with the enclosing user checkout's dirty state — the wrong tree, measured
 * silently, and the restore recipe this probe triggers aimed at the user's
 * own files. That shape fails closed instead. So does a repository PLANTED at
 * the path — `rm .git && git init && git add -A && git commit` conceals any
 * contamination under a clean status — because no local check can tell a
 * planted repo from the tree it replaced: a genuine review worktree holds its
 * `.git` as a gitFILE naming its admin entry, and anything else is refused as
 * unmeasured rather than certified clean. Two further shapes fail closed on
 * the same principle. A symlink at the tree path or any ancestor redirects
 * every check into territory holding a completely genuine worktree pair
 * with the contamination committed — all of it resolving through the link
 * and agreeing with itself — so a path reached through a link is refused.
 * The walk that finds one stops at the repository the common dir belongs to
 * where that contains the tree; where it does not — a review worktree under
 * a checkout that is itself a linked worktree, a `--separate-git-dir`
 * clone — git puts no constraint on where a linked worktree lives, so the
 * walk lstats every component up to the filesystem root instead, and the
 * round trip and the sha pin below hold the layout. And a FORGED admin
 * entry — hand-written to name this tree back, which the round trip
 * cannot tell from the entry `worktree add` wrote — is refused when the
 * caller supplies the commit the tree must hold:
 * a forge carrying the contamination as committed content cannot also
 * reproduce the fetched head sha, so a pinned `rev-parse HEAD` disagreeing
 * with the caller's record is a refusal. The record arrives read from disk,
 * so it raises the plant's cost rather than making planting impossible.
 * Callers without any record still get residue NAMED — a forge answers
 * clean, never dirty, so dirty readings still point at the tree — but
 * never a verdict: without the record nothing separates the tree from a
 * forged pair whose index already holds the contamination as committed
 * content, so the measurement is refused as unmeasured, the paths
 * retained for the reader to act on.
 *
 * One blind spot the identity checks cannot close: `git status` never looks
 * INSIDE a committed gitlink (mode 160000), and untracked content there does
 * not dirty it — so a tree carrying submodules is measured for everything
 * except what those paths hold. When a gitlink's directory is non-empty, the
 * answer is unmeasured naming the path, never clean.
 *
 * Empty on any git failure: this is a diagnostic, and a diagnostic that throws
 * would fail the build it is only commenting on.
 *
 * One limit the NUL format does not remove: `encoding: 'utf8'` maps an invalid
 * UTF-8 byte in a filename to U+FFFD, so such a path is reported but no longer
 * resolves on disk. No string form of it can — Node's fs API takes strings here
 * — so the name is disclosed as git rendered it rather than silently dropped.
 */
export function worktreeResidue(
  cwd: string,
  cap = RESIDUE_PATH_CAP,
  expectedHeadSha?: string,
): WorktreeResidue {
  // A genuine review worktree carries its `.git` as a FILE naming its admin
  // entry. A `.git` DIRECTORY at this path is a repository planted over the
  // contamination — `git init` + a commit answers a clean `git status` for a
  // dirty tree — and no local check can tell it from the tree it replaced, so
  // it is refused as unmeasured rather than certified clean. (A main checkout
  // also carries a directory, and is refused the same way: the pipeline only
  // ever measures linked worktrees, and failing closed costs a warning where
  // failing open costs a verdict.)
  try {
    if (!lstatSync(join(cwd, '.git')).isFile()) {
      return {
        paths: [],
        total: 0,
        unmeasured:
          '.git is not a gitfile (a planted repository?) — a repo stood up ' +
          'at this path answers a clean status for a dirty tree, and the ' +
          'probe cannot tell the two apart',
      };
    }
  } catch {
    // No `.git` at all: the walk-up check below fails closed with its own
    // reason.
  }
  // git's discovery WALKS UP: with the `.git` file gone — a crash mid-`worktree
  // add`, a cleanup whose `rmSync` failed — `status` exits 0 against the
  // enclosing user checkout: the wrong tree's dirty state answered as this
  // one's. Fail closed the way a loud git failure below does.
  // One invocation per value (see `revParsePath`): the answers are three
  // arbitrary filesystem paths, a POSIX name may carry a newline, so no combined
  // newline-delimited answer can be split unambiguously — a healthy worktree
  // below a directory whose name holds one parses to extra records, misassigns
  // gitDir/commondir, and reports the checkout as not a worktree. These need
  // absolute paths, so they pass `--path-format=absolute`.
  const discover = (flag: string): string | null =>
    revParsePath(cwd, '--path-format=absolute', flag);
  const toplevel = discover('--show-toplevel');
  const gitDir = discover('--git-dir');
  const commonDir = discover('--git-common-dir');
  let isWorktree = false;
  let anchor: string[] = [];
  try {
    if (
      toplevel !== null &&
      gitDir !== null &&
      commonDir !== null &&
      realpathSync(toplevel) === realpathSync(cwd)
    ) {
      isWorktree = true;
      // First, the leaf itself: a symlink AT the tree path redirects the
      // chdir and every check after it. lstat, not realpath — canonicalising
      // would resolve away the thing being looked for.
      if (lstatSync(cwd).isSymbolicLink()) {
        return {
          paths: [],
          total: 0,
          unmeasured:
            `the path resolves through a symlink (${resolve(cwd)}) — ` +
            'every identity check resolves through it and agrees with ' +
            'itself, while the commands below would measure wherever it ' +
            'points',
        };
      }
      // No component of the path may be a symlink: a link planted at any
      // ancestor redirects the chdir into territory holding a completely
      // genuine `git init` + `worktree add` pair with the contamination
      // COMMITTED — no forged admin entry needed, the round trip below is
      // real git state — and every check here resolves THROUGH the link
      // and agrees with itself: `--show-toplevel` answers the physical
      // forge path and the self-equality above holds. Measured: the shape
      // certified a mutant clean before the walk. The walk's stop is the
      // checkout the common dir belongs to — above that is the user's own
      // layout, and `/var` is a symlink on every macOS box — and where the
      // bound IS an ancestor of the tree path it lstats every component
      // between them and stops there. Where it is NOT, the stop test never
      // fires and the walk lstats every component up to the filesystem
      // root instead: git puts no constraint on where a linked worktree
      // lives — a review worktree under a checkout that is itself a linked
      // worktree has the MAIN checkout's common dir, a sibling of its
      // path, and a `--separate-git-dir` clone's lives wherever the user
      // put it — so those layouts are held by the round trip and the sha
      // pin below, not refused here. Refusing them on the bound alone was
      // a false positive measured against both; the walk catches a
      // redirect in either layout, and a steered bound buys a forge
      // nothing the pin and the no-record refusal do not already cost it.
      const spelled = resolve(cwd);
      const bound = dirname(commonDir);
      const redirected = redirectedAncestor(dirname(spelled), bound);
      if (redirected !== null) {
        return {
          paths: [],
          total: 0,
          unmeasured:
            `the path resolves through a symlink (${redirected}) — every ` +
            'identity check resolves through it and agrees with itself, ' +
            'while the commands below would measure wherever it points',
        };
      }
      // And the gitfile must name an admin entry that names this tree BACK.
      // The pin below freezes THIS identity for the commands after it, so a
      // gitfile swapped after this gate cannot redirect them; it cannot help
      // when the swap is already in place when the probe starts, because then
      // the gate resolves the plant too — a repository whose `core.worktree`
      // points here answers `--show-toplevel` with this path. And it freezes
      // NAMES, not what they point at: a writer active between the pin and
      // the measurement can still rewrite the pinned admin entry's HEAD,
      // index and commondir — or swap the tree path itself — and every
      // "pinned" command measures the swap. The pin raises that attack's
      // cost — the swap must now land inside one function's window — it does
      // not close it; closing wants a snapshot measured at gate time or a
      // sandbox boundary (#9556). `scratch-tree` gates its own reset on the
      // round-trip
      // for the same reason, and a planted standalone repo has no admin entry
      // to round-trip at all. The two shapes get distinct reasons: the
      // standalone repo has no `gitdir` file to "not point back", and whoever
      // triages the refusal would otherwise hunt for one that does not exist.
      // Its own try: a plant has no `gitdir` file to read, and letting that
      // ENOENT fall into the outer catch reported it as "not a git worktree",
      // which is a different and much vaguer thing than what was found.
      let backpointer: string | null = null;
      try {
        backpointer = readFileSync(join(gitDir, 'gitdir'), 'utf8').trim();
      } catch {
        // No admin entry at all — a standalone repository answering for this
        // path, which is exactly the shape being refused.
      }
      if (backpointer === null) {
        return {
          paths: [],
          total: 0,
          unmeasured:
            'the .git gitfile names a repository with no admin entry for ' +
            'this tree — a standalone repository answering for this path, ' +
            'whose index the commands below would measure',
        };
      }
      let pointsBack = false;
      try {
        pointsBack =
          realpathSync(dirname(resolve(gitDir, backpointer))) ===
          realpathSync(cwd);
      } catch {
        // A backpointer that does not resolve does not point back at this
        // tree. Letting the ENOENT fall into the outer catch reported the
        // shape as "not a git worktree" — a different and much vaguer thing
        // than what was found.
      }
      if (!pointsBack) {
        return {
          paths: [],
          total: 0,
          unmeasured:
            'the .git gitfile names an admin entry that does not point back ' +
            'at this tree — the commands below would measure whichever ' +
            'repository it does name',
        };
      }
      // PIN the identity this gate just verified, for every spawn below.
      // Without it the gate is one-shot: each later command re-discovers the
      // repository through the same `.git` file the check read, and that file
      // is writable by anything running as this user — so a gitfile swapped in
      // afterwards, pointing at a repo whose index already holds the
      // contamination, answers a clean `status` for a dirty tree. Measured:
      // through discovery the swap certifies a mutant clean deterministically,
      // with no race; pinned, the same tree still reports ` M a.ts` and the
      // untracked probe file. Measured too, because a WRONG pin would be worse
      // than none: across a standalone checkout, a linked worktree, a
      // superproject with an initialised submodule and a worktree reached
      // through a symlinked ancestor, all five commands below return
      // byte-identical output pinned and unpinned.
      anchor = [
        `--git-dir=${realpathSync(gitDir)}`,
        `--work-tree=${realpathSync(toplevel)}`,
      ];
      // And the pinned identity must hold the commit the caller fetched, when
      // the caller brings that record. The round trip above proves only that
      // the admin entry the gitfile names SAYS this tree is its worktree — a
      // same-user planter writes both halves of the pair, so a forged entry
      // beside a repo carrying the contamination as committed content passes
      // every local check and measures clean. The one thing the forge cannot
      // reproduce is the fetched head sha: committing the contamination moves
      // its HEAD. The record is only as anchored as the caller's read of it
      // — a same-user writer who rewrites it feeds the pin the forge's own
      // sha — so this is cost, not closure. Measured: through the forge the
      // pinned call answers unmeasured, where round 1's unpinned probe
      // certified a mutant clean; the sha-less probe refuses its own clean
      // verdict for the same reason (see the end of this function).
      if (expectedHeadSha !== undefined) {
        const head = spawnSync('git', [...anchor, 'rev-parse', 'HEAD'], {
          cwd,
          encoding: 'utf8',
          env: sanitizedGitEnv(),
        });
        const got =
          head.error || head.status !== 0 || typeof head.stdout !== 'string'
            ? null
            : head.stdout.trim();
        if (
          got === null ||
          got.toLowerCase() !== expectedHeadSha.toLowerCase()
        ) {
          return {
            paths: [],
            total: 0,
            unmeasured:
              got === null
                ? 'the pinned identity could not read its own HEAD — the ' +
                  'commands below would have measured a repository git ' +
                  'cannot read'
                : `the pinned identity is checked out at ${got}, not the ` +
                  `fetched PR head ${expectedHeadSha} — the gitfile names ` +
                  'a repository answering for this path, and its index is ' +
                  'what the commands below would measure',
          };
        }
      }
    }
  } catch {
    // A cwd that no longer resolves is not a tree this probe can measure.
    isWorktree = false;
  }
  if (!isWorktree) {
    return {
      paths: [],
      total: 0,
      unmeasured:
        'the path is not a git worktree (repository discovery walks up into ' +
        'the enclosing checkout)',
    };
  }
  const r = spawnSync(
    'git',
    [
      ...anchor,
      ...pipelineExcludeArgs(),
      // The measurement must not itself become the execution: `core.fsmonitor`
      // runs a command on `status`, and this tree's config is writable by
      // anything running as the user. Emptying it here is the same discipline
      // as the checkouts' `core.hooksPath` — the tripwire is the one command
      // that must not be steerable by the tree it is measuring.
      '-c',
      'core.fsmonitor=',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '-z',
    ],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') {
    const why = r.error
      ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message)
      : `git status exited ${r.status}`;
    return { paths: [], total: 0, unmeasured: why };
  }
  const records = r.stdout.split('\0').filter((rec) => rec.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // `XY <path>` — the status letters are noise to a reader; the path is what
    // it has to act on. A rename or copy spends a SECOND record on the ORIGINAL
    // path, and both names are reported: the destination is what sits in the
    // tree, and the original is what is missing from it, so a restore needs
    // both. Reporting only the destination left the reader with a `D <orig>`
    // it had never been given the name of.
    const status = rec.slice(0, 2);
    paths.push(rec.slice(3));
    if (
      (status.includes('R') || status.includes('C')) &&
      i + 1 < records.length
    ) {
      paths.push(records[++i]);
    }
  }
  // `status` honors the ignore rules of the tree it measures, and those rules
  // belong to the very actor this probe exists to catch: a line appended to
  // the common repo's `info/exclude`, or a `.gitignore` planted at runtime,
  // hides the contamination — and itself — from `status`. So the untracked
  // side is listed a SECOND time under no ignore rule at all (`--others`
  // without `--exclude-standard`), and the two listings are reconciled below.
  //
  // Reporting that raw listing as residue is the obvious reconciliation and it
  // is wrong in the way a tripwire cannot afford. Measured on a healthy review
  // worktree of this repo, after the `npm ci` and build the pipeline itself
  // runs there: `git status` reported NOTHING and the raw listing reported
  // 3 957 paths — coverage HTML, `.tsbuildinfo`, husky's installed hooks. A
  // tripwire that fires on every healthy run stops being read, real
  // contamination drowns in it, and every verifier is handed `git checkout` /
  // `rm` recipes aimed at thousands of legitimate build artifacts.
  //
  // What separates the two is not the pattern, which is unbounded, but WHO
  // WROTE THE RULE. An ignore file the commit under review carries is ordinary
  // repo hygiene that every agent reading this tree sees identically; a rule
  // from anywhere else — `info/exclude`, a `.gitignore` written after the
  // checkout — is the plant. `check-ignore -v` names the source file for each
  // path, so the reconciliation asks git that question instead of inferring it
  // from the name.
  const others = spawnSync(
    'git',
    [...anchor, '-c', 'core.fsmonitor=', 'ls-files', '--others', '-z'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (
    others.error ||
    others.status !== 0 ||
    typeof others.stdout !== 'string'
  ) {
    const why = others.error
      ? ((others.error as NodeJS.ErrnoException).code ?? others.error.message)
      : `git ls-files exited ${others.status}`;
    return { paths: [], total: 0, unmeasured: why };
  }
  const seen = new Set(paths);
  // The status set, snapshotted before the extras below join it: an ignore
  // file that appears HERE is one the working tree has edited away from the
  // commit, so whatever it hides is not something the commit vouched for.
  const editedFromHead = new Set(paths);
  const extras: string[] = [];
  for (const rec of others.stdout.split('\0')) {
    if (rec.length === 0 || seen.has(rec)) continue;
    if (inPipelineFootprint(rec)) continue;
    seen.add(rec);
    extras.push(rec);
  }
  if (extras.length > 0) {
    const hiddenBy = ignoreSourcesOf(cwd, extras, anchor);
    if (hiddenBy === null) {
      return {
        paths: paths.slice(0, cap),
        total: paths.length,
        unmeasured:
          "the ignore rules hiding this tree's untracked files could not be " +
          'attributed, so `git status` cannot be trusted to have seen them',
      };
    }
    const fromTheCommit = trackedIgnoreSources(
      cwd,
      new Set([...hiddenBy.values()].map((rule) => rule.source)),
      anchor,
    );
    for (const rec of extras) {
      const rule = hiddenBy.get(rec);
      // No rule at all means nothing hid it, so `status` should have named it
      // and did not: unattributed goes to the reader, not to silence.
      if (
        rule !== undefined &&
        fromTheCommit.has(rule.source) &&
        // Tracked is not the same as unchanged. `ls-files` answers "is this
        // PATH in the index", and a `.gitignore` the commit carries can be
        // rewritten in the tree afterwards — at which point its rules are the
        // writer's, not the commit's, and vouch for nothing.
        !editedFromHead.has(rule.source) &&
        !hidesEverything(rule.pattern)
      ) {
        continue;
      }
      paths.push(rec);
    }
  }
  // `git status` never looks INSIDE a committed gitlink (mode 160000), and
  // untracked content there does not dirty the superproject — the raw oracle
  // this probe trusts is blind there. `worktree add` leaves submodules
  // uninitialized — an absent or empty directory at the gitlink — which
  // measures clean; anything non-empty — a probe's fixtures or caches, an
  // initialized submodule — is state the status above could not see, and the
  // answer is unmeasured naming the path rather than clean. `-z` here is the
  // same protection as the status call's: under default `core.quotepath` the
  // rendered form quotes a non-ASCII gitlink name into a spelling that never
  // resolves on disk, so the entry drops out of the blind set and a dirty
  // gitlink is certified clean.
  const stage = spawnSync(
    'git',
    [...anchor, '-c', 'core.fsmonitor=', 'ls-files', '-s', '-z'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (stage.error || stage.status !== 0 || typeof stage.stdout !== 'string') {
    const why = stage.error
      ? ((stage.error as NodeJS.ErrnoException).code ?? stage.error.message)
      : `git ls-files exited ${stage.status}`;
    return { paths: [], total: 0, unmeasured: why };
  }
  const blind = stage.stdout
    .split('\0')
    .filter((rec) => rec.startsWith('160000 '))
    .map((rec) => rec.slice(rec.indexOf('\t') + 1))
    .filter((gitlink) => {
      // A name carrying U+FFFD held bytes `encoding: 'utf8'` could not
      // decode — a committed gitlink can carry them — and no spelling of
      // such a name resolves on disk, so its directory cannot be proved
      // empty. That is the definition of unmeasured, not of clean.
      if (gitlink.includes('\uFFFD')) return true;
      try {
        return readdirSync(join(cwd, gitlink)).length > 0;
      } catch (err) {
        // ABSENT is the clean shape `worktree add` leaves, and only that one
        // is treated as nothing-to-hide. Anything else — a directory this
        // process cannot read, an I/O error — is a place the status could not
        // see AND this probe could not see either, which is the definition of
        // unmeasured, not of clean.
        return (err as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    });
  if (blind.length > 0) {
    return {
      paths: paths.slice(0, cap),
      total: paths.length,
      unmeasured:
        'git status cannot see inside the committed submodule path(s) ' +
        blind.join(', '),
    };
  }
  // The other way this oracle goes blind, and the one the scratch tree's reset
  // already refuses to certify around: `skip-worktree` and `assume-unchanged`
  // make git ignore a TRACKED file's working copy, so an edited file answers
  // `status` as clean. A reader told "clean" about a tree carrying a mutant is
  // the #9207 failure with the tripwire's own signature on it.
  //
  // `-z` for the same reason the calls above carry it, and here it also bounds
  // the output: without it `core.quotepath` octal-expands a non-ASCII name to
  // four times its length, which is the one way this call can outgrow the
  // buffer while its `-s -z` sibling fits. And it fails CLOSED like the
  // siblings — a spawn that dies leaves `status` null, which the earlier form
  // read as "no bits found" and fell through to a clean verdict.
  const bits = spawnSync(
    'git',
    [...anchor, '-c', 'core.fsmonitor=', 'ls-files', '-v', '-z'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    },
  );
  if (bits.error || bits.status !== 0 || typeof bits.stdout !== 'string') {
    const why = bits.error
      ? ((bits.error as NodeJS.ErrnoException).code ?? bits.error.message)
      : `git ls-files exited ${bits.status}`;
    return { paths: paths.slice(0, cap), total: paths.length, unmeasured: why };
  }
  if (bits.stdout.split('\0').some((rec) => /^[a-zS]/.test(rec))) {
    return {
      paths: paths.slice(0, cap),
      total: paths.length,
      unmeasured:
        'the index carries skip-worktree or assume-unchanged bits, so `git ' +
        'status` cannot see edits to the tracked files they cover',
    };
  }
  // Without the caller's record nothing above distinguishes this tree from
  // a forged pair whose index already holds the contamination as committed
  // content, so a measurement no record anchored is refused rather than
  // certified — clean or dirty. The named paths are kept either way: a
  // forge answers CLEAN, never dirty, so dirty readings still point at the
  // tree and the reader can act on them. And the refusal cannot wait for
  // an EMPTY measurement: a forged pair commits the contamination and
  // leaves one unrelated untracked decoy, and the decoy alone is what the
  // residue list then carries — the committed mutant is absent from any
  // such list by construction.
  if (expectedHeadSha === undefined) {
    return {
      paths: paths.slice(0, cap),
      total: paths.length,
      unmeasured:
        'the caller brought no record of the commit this tree must hold, ' +
        'and a status measured through an unanchored identity would ' +
        'certify whichever index the .git gitfile names — a forged pair ' +
        'answers clean — so the measurement is refused rather than ' +
        'certified',
    };
  }
  return { paths: paths.slice(0, cap), total: paths.length };
}

/** What a dependency farm run did, and whether it found one already standing. */
export interface DependencyFarm {
  /** Packages symlinked in by THIS call. */
  linked: number;
  /** Packages this call could not link — disclosed, never silently dropped. */
  failed: number;
  /** True when a farm was already in place, so this call had nothing to link. */
  alreadyPresent: boolean;
  /**
   * How many of the linked packages are the repo's OWN workspace members
   * (`node_modules/@scope/pkg` → `../../packages/pkg`). Those links resolve
   * back into the dependency root, so a mutation made in the disposable tree is
   * invisible to any import that goes through the package NAME. Counted so the
   * callers can say so rather than leave it as a property of the layout.
   */
  selfLinked: number;
}

/**
 * Make the dependency root's installed packages resolvable from a disposable
 * tree, by symlinking each `node_modules` entry into it.
 *
 * A fresh `git worktree add` has no `node_modules`, and a per-tree `npm ci`
 * costs minutes that neither the efficacy probe's budget nor a verifier's
 * patience has. So the packages are borrowed rather than installed: the tree
 * holds the CODE under test and reads its dependencies out of the tree that
 * already installed them.
 *
 * The root farm is not the whole job in a monorepo. npm hoists what it can, but
 * a version conflict leaves packages installed under the MEMBER
 * (`packages/cli/node_modules`), and Node resolves those by walking up from the
 * importing file — so a tree with only the root farm fails to resolve exactly
 * the dependency that could not be hoisted. Measured on this repo: a scratch
 * tree with 1 560 root packages linked still could not resolve
 * `@testing-library/react` for a UI probe, because that copy lives under
 * `packages/cli`. Each workspace member's farm is therefore built too, for the
 * members the disposable tree actually contains.
 *
 * Best-effort per entry, and deliberately so: one locked or concurrently
 * unlinked package must not throw out of the run that asked for the farm (for
 * the probe, that would re-class every mutant `inconclusive`). What could not
 * be linked is counted and disclosed by the caller, never silently dropped.
 *
 * **The links are read-write, and they point OUT of the disposable tree.** A
 * probe that writes through one — `writeFileSync(require.resolve('dep/x.js'))`,
 * an `npm rebuild`, a package that writes into its own directory at runtime —
 * lands in the dependency root's copy, which is the shared review worktree, and
 * `node_modules` is gitignored so the residue probe cannot see it. Copying the
 * farm instead would cost the minutes the farm exists to save, so the contract
 * is stated rather than enforced: the tree's own files are yours, its
 * dependencies are borrowed, and a probe that needs to modify a dependency must
 * replace the LINK with a copy rather than write through it. The verifier's
 * brief says the same in the words it acts on.
 *
 * Shared by `test-efficacy`'s `-probe` tree and `scratch-tree`'s per-verifier
 * tree, which is why it sits here rather than in either of them.
 */
export function exposeDependencies(
  probeTree: string,
  dependencyRoot: string,
  opts: { rebuild?: boolean } = {},
): DependencyFarm {
  const done: DependencyFarm = {
    linked: 0,
    failed: 0,
    alreadyPresent: false,
    selfLinked: 0,
  };
  if (probeTree === dependencyRoot) return done;
  let members: string[] = [];
  try {
    const graph = readWorkspacePackages(dependencyRoot);
    // `skipped` members are real directories npm links; the graph just cannot
    // model their ownership. Farming them costs one directory read each and
    // spares a probe an unresolvable import in a package that does exist.
    members = [...graph.packages.map((p) => p.dir), ...graph.skipped];
  } catch {
    // The workspace graph is an optimization on top of the root farm: a
    // manifest that will not read costs the tree its nested packages, never
    // the farm it already has.
  }
  // The member list comes from the ROOT MANIFEST OF THE CODE UNDER REVIEW, and
  // the farm loop both deletes and creates at the paths it names — so it is
  // treated as the untrusted input it is. `workspaces: ["../.."]` resolves to
  // a directory outside both trees (a scratch tree is a sibling, so the same
  // one for source and target), and the farm's opening `rmSync` would take
  // that directory's `node_modules` — the reviewer's own, in the layout this
  // pipeline builds. `realpathSync` rather than string arithmetic because a
  // COMMITTED SYMLINK at a workspace path is fully contained as a string and
  // still lands the same delete outside the tree; `readWorkspacePackages`
  // deliberately follows such links, because npm does.
  const memberSources = members
    .map((dir) => ({
      dir,
      source: containedIn(dependencyRoot, dir),
    }))
    // A member that resolves to the dependency ROOT is not a member. npm
    // accepts `workspaces: ["."]` in a root manifest and creates the self-link
    // itself, and `containedIn(root, '.')` answers the root — which would put
    // the whole shared review worktree into the whitelist below, so ANY
    // `node_modules` link resolving anywhere inside it would be mirrored into
    // the disposable tree as a read-write channel back. Reachable from a
    // committed manifest with nothing executed, which is the line this file
    // draws elsewhere.
    .filter((m) => {
      if (m.source === null) return true;
      try {
        return realpathSync(m.source) !== realpathSync(dependencyRoot);
      } catch {
        return true;
      }
    });
  // What a farm entry's symlink may resolve to, decided ONCE for every farm
  // this call builds: a `node_modules` it borrows from, or a workspace member
  // directory — npm's self-links. The resolved member directories are the
  // whitelist; everything else a committed symlink under `node_modules` names
  // is a PR-controlled channel out of the disposable tree (see
  // farmNodeModules).
  let rootNm: string | null = null;
  try {
    const nm = join(dependencyRoot, 'node_modules');
    if (lstatSync(nm).isDirectory()) rootNm = realpathSync(nm);
  } catch {
    // No install at the root: nothing can resolve there.
  }
  const containment = {
    rootNm,
    selfLinks: new Set<string>(
      memberSources.flatMap((m) => (m.source === null ? [] : [m.source])),
    ),
  };
  farmNodeModules(
    dependencyRoot,
    probeTree,
    done,
    containment,
    opts.rebuild === true,
  );
  // Every `node_modules` this call recreates. Anything else carrying the name
  // inside the disposable tree — a probe's own install at an intermediate path
  // Node resolves BEFORE the root farm, a module stub planted there between
  // two runs — survives the rebuild otherwise, and whatever occupies it
  // decides module resolution for every later run in that tree.
  const owned = new Set<string>([join(probeTree, 'node_modules')]);
  for (const { dir, source } of memberSources) {
    const target = containedIn(probeTree, dir);
    if (!source || !target) {
      // Only count it when the member exists at all — a workspace glob that
      // matches nothing is ordinary, an escape is not.
      if (existsSync(join(dependencyRoot, dir))) done.failed++;
      continue;
    }
    // Only for a member the disposable tree holds. A workspace the tree does
    // not contain has nothing to resolve FROM, and creating its directory just
    // to hang a `node_modules` off it would put a path in the tree that its
    // commit does not have.
    if (!existsSync(target)) continue;
    owned.add(join(target, 'node_modules'));
    // Per member, not around the loop: one unreadable member used to abort the
    // walk, so every alphabetically later member silently went unfarmed while
    // `failed` stayed 0 and the caller reported success.
    try {
      farmNodeModules(source, target, done, containment, opts.rebuild === true);
    } catch {
      done.failed++;
    }
  }
  if (opts.rebuild === true) {
    // The disclosure walk presents realpath'd spellings of what it finds
    // while `owned` holds the caller's — on a host whose tree path carries
    // a symlinked ancestor (macOS's `/var` vs `/private/var`) the two
    // disagree, and the farm this call just re-linked counted a phantom
    // failure. Normalize the set once, here, rather than at every
    // comparison.
    for (const path of [...owned]) {
      try {
        owned.add(realpathSync(path));
      } catch {
        // A concurrent unlink is the only throw; the as-spelled entry
        // still matches.
      }
    }
    removeUnownedNodeModules(probeTree, owned, done);
  }
  return done;
}

/**
 * Wipe every `node_modules` in a disposable tree that the farm does not
 * recreate, for callers passing `rebuild`.
 *
 * The farm owns the tree root's `node_modules` and one per workspace member;
 * Node's resolution walks UP from the importing file, so a `node_modules` at
 * ANY other path — `packages/node_modules` in a `workspaces: ["packages/*"]`
 * repo is the one measured — resolves before the root farm. The tree is
 * reused across probe runs with only this function between them, so whatever
 * a previous run left at such a path decides every later verdict; that is
 * precisely the shape the rebuild discipline exists to catch.
 *
 * The walk never follows links — farm entries are symlinks pointing OUT of
 * the tree — and skips the owned paths entirely: with `rebuild` the farm has
 * already wiped and re-linked them. `.git` holds nothing that resolves as a
 * dependency.
 */
function removeUnownedNodeModules(
  tree: string,
  owned: Set<string>,
  done: DependencyFarm,
): void {
  // Symlinked directories that resolve back inside the tree, judged after the
  // walk — see the branch that fills this.
  const inTreeLinks: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      done.failed++;
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Case-INSENSITIVE: APFS and NTFS are the two filesystems this file
      // already special-cases (macOS path spellings, Windows junctions), and on
      // both a `Node_Modules` a probe created resolves exactly like the real
      // one while an exact-match sweep walks past it.
      if (entry.name.toLowerCase() === 'node_modules') {
        // `isOwned` asks both spellings: the set holds the root as the caller
        // spelled the tree and each member as `containedIn` resolved it, and on
        // macOS those disagree (`/var/…` vs `/private/var/…`).
        if (!isOwned(owned, full)) {
          try {
            rmSync(full, { recursive: true, force: true });
          } catch {
            // Same best-effort contract as the farm itself: a wipe that throws
            // must not re-class every probe `inconclusive`. But it is COUNTED —
            // a planted `node_modules` that resists deletion otherwise survives
            // every rebuild and decides later verdicts with nothing disclosed.
            done.failed++;
          }
        }
        continue;
      }
      if (entry.name === '.git') continue;
      if (entry.isSymbolicLink()) {
        // Never FOLLOWED — the farm's own entries are links pointing out of the
        // tree, and following one would walk into the shared worktree. But a
        // link the COMMIT contains can hide a `node_modules` from every
        // rebuild, so a link that resolves back INSIDE this tree is disclosed
        // rather than silently skipped: the caller reports what it could not
        // clear.
        try {
          const real = realpathSync(full);
          const root = realpathSync(tree);
          if (!statSync(full).isDirectory()) {
            // A link to a FILE hides no directory tree.
          } else if (real === root || real.startsWith(root + sep)) {
            inTreeLinks.push(real);
          } else {
            // Resolving OUT of the tree, and this half was silently skipped:
            // the in-tree case got the disclosure and the outside case — the
            // one a COMMITTED `vendor -> ../stash` produces with no execution
            // at all — reported `{linked: n, failed: 0}` while a planted
            // `node_modules` under the target steered resolution for every
            // later run (Node realpaths the importing file, so an import under
            // the link resolves in the stash). The state cannot be wiped from
            // here — it is outside the tree this function owns — so it is
            // COUNTED, which is what the contract promises.
            done.failed++;
          }
        } catch {
          // Dangling or unreadable: nothing resolvable to hide anything.
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      walk(full);
    }
  };
  walk(tree);
  // Now that the walk has wiped what it could reach: a link still leading to a
  // `node_modules` this call neither owns nor deleted is dependency state that
  // survives every rebuild, and the caller says so rather than the tree hiding
  // it. Owned farms are the ones this call just re-linked.
  for (const real of inTreeLinks) {
    if (isOwned(owned, real)) continue;
    if (holdsNodeModules(real, owned)) done.failed++;
  }
}

/**
 * Is this path one of the farms the current call built?
 *
 * `owned` mixes spellings by construction — the tree root as the caller spelled
 * it, each member as `containedIn` resolved it — and a path reached through a
 * symlink arrives in a third. Comparing one spelling was how the disclosure
 * below counted a failure for a farm the same call had just re-linked, so both
 * the given path and its resolved form are asked.
 */
function isOwned(owned: Set<string>, path: string): boolean {
  if (owned.has(path)) return true;
  try {
    return owned.has(realpathSync(path));
  } catch {
    return false;
  }
}

/**
 * Does this subtree hold a `node_modules` at any depth?
 *
 * Used only to DISCLOSE what the wipe walk deliberately did not follow: a
 * symlinked directory inside the tree can hide dependencies from every rebuild,
 * and the walk must not follow it (the farm's own entries are links out of the
 * tree), so the honest answer is a counted failure rather than silence.
 */
function holdsNodeModules(dir: string, owned: Set<string>): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    // A farm this call owns is not hidden dependency state — it is the
    // dependency state, re-linked moments ago.
    if (entry.name.toLowerCase() === 'node_modules') {
      if (!isOwned(owned, full)) return true;
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name === '.git') continue;
    if (holdsNodeModules(full, owned)) return true;
  }
  return false;
}

/**
 * `<root>/<dir>` when it really is inside `<root>`, and null when it is not.
 *
 * Both halves are resolved through symlinks before the comparison, so neither a
 * `..` in the manifest's own string nor a committed symlink at the member path
 * can point the caller's `rmSync` outside the tree it was given. A directory
 * that does not exist yet resolves through its nearest existing ancestor, which
 * is the case a fresh probe tree hits for every member it does not contain.
 */
function containedIn(root: string, dir: string): string | null {
  try {
    const base = realpathSync(resolve(root));
    const full = resolve(base, dir);
    const real = existsSync(full) ? realpathSync(full) : full;
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The file a farm this code built leaves behind, so a later call can tell its
 * own work from anything else that happens to sit at that path.
 *
 * `node_modules` is gitignored, which is what lets a scratch tree's reset spare
 * it — and equally what lets a probe's own `npm install`, a killed install, or
 * a planted module stub survive that reset. Without a marker the reuse path
 * certified any non-empty directory as "the farm already in place", and every
 * later probe in that shard resolved its imports through whatever was there.
 */
const FARM_MARKER = '.qwen-review-farm';

/**
 * Where a farm entry's symlink may resolve.
 *
 * `internal` — inside a `node_modules` the farm borrows from: the ordinary
 * shape, and pnpm-style links into the dependency root's store. `self` — an
 * npm workspace SELF-link (`@scope/pkg` → `../../packages/pkg`), resolving
 * to a member directory. Those are the links a disposable tree cannot make
 * local: they resolve to the dependency root's copy, which is the tree the
 * caller is trying to stay out of, so a mutation made in the disposable tree
 * is invisible to any import that goes through the package NAME rather than
 * a relative path. Re-pointing them at the disposable tree would break
 * resolution outright for a package whose entry point is a build artifact
 * the fresh checkout does not have — so they are counted and disclosed
 * instead of silently mirrored. null — anywhere else: a commit can name it
 * (force-add defeats gitignore), and the disposable tree must not reach it.
 */
function farmLinkVerdict(
  real: string,
  sourceNm: string,
  containment: { rootNm: string | null; selfLinks: ReadonlySet<string> },
): 'internal' | 'self' | null {
  if (insideDir(sourceNm, real)) return 'internal';
  if (containment.rootNm !== null && insideDir(containment.rootNm, real)) {
    return 'internal';
  }
  for (const member of containment.selfLinks) {
    if (insideDir(member, real)) return 'self';
  }
  return null;
}

function insideDir(base: string, real: string): boolean {
  return real === base || real.startsWith(base + sep);
}

/**
 * Was this farm built by this code, for this dependency root?
 *
 * Existence alone is not provenance: `node_modules` is gitignored by
 * convention, not by rule, so a pull request can force-add
 * `node_modules/.qwen-review-farm` beside its own module stubs and `git
 * worktree add` will check both out — PR CONTENT reaching the certification
 * path with no execution at all. The marker therefore records the dependency
 * root it was built from, and a marker that does not name this one is not ours.
 * (The callers that reuse a tree across probe runs pass `rebuild` and never
 * consult this at all.)
 */
function marksOurFarm(target: string, sourceDir: string): boolean {
  try {
    return (
      readFileSync(join(target, FARM_MARKER), 'utf8').trim() ===
      resolve(sourceDir)
    );
  } catch {
    return false;
  }
}

/**
 * One directory's `node_modules`, mirrored entry by entry.
 *
 * A directory that already has one is left alone only for callers that do NOT
 * pass `rebuild` — and that case is RECORDED rather than merely skipped:
 * `{linked: 0, failed: 0}` otherwise reads the same whether the farm was
 * already standing or the source had nothing to link (a killed `npm install`
 * leaves a `node_modules` holding one lockfile), and the two want opposite
 * things said to the verifier — "your harness is ready" versus "no harness
 * will start here". The production callers — scratch-tree's reuse path and
 * the probe suite — all pass `rebuild`, so a standing farm is wiped and
 * re-linked every time; the reuse branch is reachable only from tests.
 */
function farmNodeModules(
  sourceDir: string,
  targetDir: string,
  done: DependencyFarm,
  containment: { rootNm: string | null; selfLinks: ReadonlySet<string> },
  rebuild = false,
): void {
  const source = join(sourceDir, 'node_modules');
  const target = join(targetDir, 'node_modules');
  if (!existsSync(source)) {
    // With `rebuild`, the target is cleared even when there is nothing to link
    // from: the caller is resetting a tree it will hand to another probe, and a
    // farm the PREVIOUS probe installed there (a member whose source has no
    // `node_modules`, or a root the review worktree never installed) would
    // otherwise survive a reset the report calls pristine.
    if (rebuild) {
      // `lstatSync`, not `existsSync`: the latter follows links, so a DANGLING
      // symlink at the target read as absent and the wipe was skipped — while
      // the link itself stayed to redirect whatever wrote there next.
      try {
        lstatSync(target);
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') done.failed++;
      }
    }
    return;
  }
  // `existsSync` follows links, so a symlink at the dependency root's
  // `node_modules` would redirect every farm — every probe tree of every shard
  // — at whatever it points to. A real install is a directory.
  try {
    if (!lstatSync(source).isDirectory()) {
      done.failed++;
      return;
    }
  } catch {
    done.failed++;
    return;
  }
  let sourceNm: string;
  try {
    sourceNm = realpathSync(source);
  } catch {
    done.failed++;
    return;
  }
  // `lstatSync`, not `existsSync`: the latter follows links, so a DANGLING
  // symlink at the target reads as absent, the wipe below is skipped, and
  // `mkdirSync` dies EEXIST on every attempt. A PR can commit `node_modules`
  // as exactly that — force-add defeats gitignore — and `checkout --force` /
  // `clean -ffdx` both spare a TRACKED symlink, so every reset recreates the
  // shape. Same hazard, and same fix, as the no-source branch above.
  let targetPresent = true;
  try {
    lstatSync(target);
  } catch {
    targetPresent = false;
  }
  if (targetPresent) {
    // A standing farm counts only if THIS code built it: the marker is the
    // difference between "the packages I linked last time" and "whatever a
    // probe left in the one directory it is allowed to install into". Anything
    // else at that path is cleared and re-linked, because a probe's leftover
    // module resolving as a dependency is a wrong verdict with a deterministic
    // source tag on it. `rebuild` goes further and distrusts even a marked
    // farm — the caller that reuses a tree ACROSS probe runs cannot know what
    // ran in it, and re-linking costs a second where trusting costs a verdict.
    if (!rebuild && marksOurFarm(target, sourceDir)) {
      done.alreadyPresent = true;
      return;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Cannot clear it: leave it, and report nothing linked rather than
      // claiming a farm this code did not build.
      done.failed++;
      return;
    }
  }
  try {
    mkdirSync(target);
  } catch {
    // Same best-effort contract as the per-entry steps below: a farm that
    // cannot be created costs a harness, and must not throw out of the run
    // that asked for it.
    done.failed++;
    return;
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  let entries: Dirent[];
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    // The source is the SHARED review worktree: a concurrent `npm ci` there can
    // unlink it between the `existsSync` above and this read.
    done.failed++;
    return;
  }
  const before = done.linked;
  for (const entry of entries) {
    if (entry.name === '.vite' || entry.name === '.vite-temp') continue;
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    // Every per-entry step is guarded: this is best-effort, so one locked or
    // concurrently-unlinked entry must not throw out of the probe run (which
    // would mark every probe `inconclusive`). What cannot be linked is counted
    // and disclosed by the caller — never silently dropped.
    let sourceStats: Stats;
    try {
      sourceStats = lstatSync(sourceEntry);
    } catch {
      done.failed++;
      continue;
    }
    if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
      continue;
    }
    if (sourceStats.isSymbolicLink()) {
      // Where the link RESOLVES decides whether mirroring it is safe: the
      // commit controls symlink entries under `node_modules` (force-add
      // defeats gitignore), and mirrored unchecked they become write
      // channels from the disposable tree to wherever they point —
      // re-established on every rebuild. Only entries staying inside a
      // `node_modules` this farm borrows from, and npm's workspace
      // self-links, pass; everything else is counted and disclosed like
      // any entry that cannot be linked.
      let real: string;
      try {
        real = realpathSync(sourceEntry);
      } catch {
        // A DANGLING link is a package the tree will not resolve, and the
        // caller's whole contract is that what could not be linked is counted.
        done.failed++;
        continue;
      }
      const verdict = farmLinkVerdict(real, sourceNm, containment);
      if (verdict === null) {
        done.failed++;
        continue;
      }
      if (verdict === 'self') done.selfLinked++;
      try {
        if (!statSync(sourceEntry).isDirectory()) continue;
      } catch {
        done.failed++;
        continue;
      }
    }
    if (entry.name.startsWith('@')) {
      let pkgs: string[];
      try {
        mkdirSync(targetEntry);
        pkgs = readdirSync(sourceEntry);
      } catch {
        done.failed++;
        continue;
      }
      for (const pkg of pkgs) {
        const scopedSource = join(sourceEntry, pkg);
        // The same containment as the top level, and for the same reason: a
        // SCOPE directory can itself be an escaping link — the readdir above
        // followed it — so each entry's resolution is what is asked.
        let real: string;
        try {
          real = realpathSync(scopedSource);
        } catch {
          done.failed++;
          continue;
        }
        const verdict = farmLinkVerdict(real, sourceNm, containment);
        if (verdict === null) {
          done.failed++;
          continue;
        }
        if (verdict === 'self') done.selfLinked++;
        // Same skip the top-level branch applies: a stray FILE under a scope
        // directory is not a package, and linking it as one is a link the
        // resolver will follow to something that cannot be imported.
        try {
          if (!statSync(scopedSource).isDirectory()) continue;
        } catch {
          done.failed++;
          continue;
        }
        try {
          symlinkSync(scopedSource, join(targetEntry, pkg), linkType);
          done.linked++;
        } catch {
          done.failed++;
        }
      }
    } else {
      try {
        symlinkSync(sourceEntry, targetEntry, linkType);
        done.linked++;
      } catch {
        done.failed++;
      }
    }
  }
  // Marked only when something was actually linked. A farm of zero packages is
  // not one a later call should reuse — the killed-install shape (a
  // `node_modules` holding one lockfile) produces exactly that, and certifying
  // it sends the verifier into a `vitest: not found` the note promised it had
  // avoided.
  if (done.linked > before) {
    try {
      writeFileSync(join(target, FARM_MARKER), `${resolve(sourceDir)}\n`);
    } catch {
      // No marker: the next call rebuilds the farm. Costly, never wrong.
    }
  }
}

/**
 * The reason a disposable worktree could not be created.
 *
 * The stale-sweep's stderr is folded in because it is usually the explanation:
 * when `add` fails on a leftover the sweep could not clear, the sweep is what
 * says why. Pure, and extracted for that reason — the branch it lives on fires
 * only when `git worktree add` fails, and there is no portable way to force that
 * in a real-git test (the one lever, making `.git/worktrees` unwritable, is
 * bypassed by root and behaves differently under CI's unprivileged user).
 */
export function worktreeCreateFailureDetail(
  label: string,
  err: unknown,
  sweepStderr: string,
): string {
  const sweepErr = sweepStderr.trim();
  return (
    `${label} worktree could not be created: ${err instanceof Error ? err.message : String(err)}` +
    (sweepErr ? ` (stale-tree sweep also reported: ${sweepErr})` : '')
  );
}
