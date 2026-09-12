/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review base-tree`: stand up a BUILT tree at the merge base, so a claim
// about changed behaviour can be measured instead of read.
//
// Every other step in this pipeline looks at one tree. The agents read the PR's
// code, the verifier traces a failure scenario through the PR's code, and even
// the probe capability — which does run something — runs it against the PR's
// code alone. The merge base is known (`fetch-pr` resolves `mergeBaseSha`) and
// is used for exactly one thing: choosing the diff range. Nothing has ever built
// it.
//
// That leaves a whole class of claim decided by reading. "This preserves the
// existing output." "This only adds a field." "Cancelled calls looked the same
// as failures before." Each is a statement about the DIFFERENCE between two
// programs, and the review has only ever had one of them in front of it. Reading
// a diff and concluding what the old behaviour was is exactly the step that goes
// wrong quietly: the new lines are always right there and always look correct,
// and whether they change what a user observes routinely turns on code the diff
// never touches.
//
// With a built base tree the same input can be fed to both and the two outputs
// compared. That is a different kind of evidence from anything else here — not a
// stronger argument, but an observation — and it is the only kind that settles a
// disagreement about what a program used to do.
//
// **What this command deliberately does NOT do: run anything.** It creates the
// tree and builds it, which is the expensive, fiddly, failure-prone half (a
// detached worktree at the right SHA, a stale sibling from a crashed run, the
// minimal build set, the widening loop, deadlines that a real build can meet).
// WHAT to run is the reviewer's question, not this command's — it depends
// entirely on the claim under test, and a fixed scenario would fit almost none
// of them. So the report hands back a path and gets out of the way.
//
// Cost is why this is on demand rather than part of every review: the base
// worktree is a cold checkout, so this is an install AND a build. It is worth it for one claim that turns on it and wasted on
// a review with none, which is why the verifier's brief offers it per finding
// instead of the pipeline spending it up front.

import type { CommandModule } from 'yargs';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { baseWorktreePath, REVIEW_TMP_DIR } from './lib/paths.js';
import {
  untrustedGitfile,
  discardWorktree,
  sanitizedGitEnv,
  worktreeCreateFailureDetail,
  type SweepResult,
} from './lib/worktree.js';
import { runBuildTest, type BuildTestReport } from './build-test.js';
import {
  baseTreeTrustPath,
  builtTreeRecord,
  dropBuiltTree,
  establishTrust,
  recordBuiltTree,
  runIdentity,
  type BuiltTreeStat,
  type TrustState,
} from './lib/base-tree-trust.js';

export interface BaseTreeReport {
  /**
   * True when a tree stands at `path` and its build succeeded — the only state
   * in which an A/B comparison means anything. A tree that would not compile
   * cannot be run, and a difference measured against one that half-built is not
   * a difference between the two programs.
   */
  available: boolean;
  /** Absolute path to the base worktree, when one was created. */
  path?: string;
  /** The commit it holds — the merge base of the PR and its target branch. */
  baseSha?: string;
  /** The build that ran there; null when the tree could not be created or a fast-path reuse found it already built. */
  build: BuildTestReport | null;
  /** What happened, in one line. Rendered to the reviewer verbatim. */
  note: string;
}

export interface BaseTreeArgs {
  plan: string;
  worktree: string;
  out?: string;
  timeout: number;
  install: boolean;
  /** Test seam: the build step. Production runs the real `runBuildTest`. */
  build?: (worktree: string) => BuildTestReport;
  /**
   * Test seam: runs inside the reuse arm, between the inventory walk and the
   * index-refreshing `git status`.
   *
   * That gap is a real window — the walk is ~1 s on a built tree — and what
   * lands in it is a rewritten `<base>/.git`, after which the `status` runs
   * the planted repository's `filter.<driver>.clean` on the host. The gate
   * re-asks the pointer question there, and a guard with no way to stage the
   * window is a guard no test can hold to account: the entry check fires
   * first for anything planted before the call, so without this seam the
   * re-ask is unreachable from a test and a mutation that deletes it
   * survives. Undefined in production.
   */
  onReuseWindow?: () => void;
}

// Sanitized env on both helpers: an exported GIT_DIR redirects repository
// discovery for every call at once — the base tree would be added into the
// redirected repository and its reuse check would read HEAD from it, an A/B
// against the wrong program while every check against the given tree passes.
//
// Every invocation also carries the config neutralization `revParse` carries
// in lib/worktree.ts: these reads run against trees the containerized build
// just held read-write, and a planted `core.fsmonitor` fires on an ordinary
// index read while a planted `core.hooksPath` rides any command that takes
// hooks — both are inert arguments under the `-c` pins, wherever the
// resolved repository's own config points. `maxBuffer` because the ignored
// listing of a real built tree (~100k paths under node_modules/ and dist/,
// measured at 6+ MB) blows straight through spawnSync's 1 MiB default, and
// the fence's record silently never lands when it does — the cap is a
// ceiling, not an allocation.
const GIT_NEUTRALIZE = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null/no-hooks',
];
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
/**
 * A deadline on every spawn here, the way `revParse` carries one in
 * lib/worktree.ts.
 *
 * These run against a tree the containerized build just held read-write, and
 * a `git` that never returns is not a theoretical shape: a planted
 * repository on an unreachable mount, or a `filter.<driver>.clean` that
 * blocks, hangs the shard with no output and no report — the A/B lane
 * suppressed for the round and read as infrastructure trouble. Generous
 * compared to `revParse`'s 30 s because these ARE the big reads (a real
 * tree's listing measured 131 ms and its `status` more), and a ceiling is
 * not a budget: it only has to be shorter than the caller's own.
 */
const GIT_TIMEOUT_MS = 120_000;

function gitOut(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

/**
 * The NUL-delimited form, in RAW BYTES.
 *
 * No `encoding`, so `stdout` arrives as a Buffer: a filename is a byte
 * string, not text, and decoding it as utf8 replaces every undecodable byte
 * with U+FFFD — which is exactly the thing the `-z` form exists to preserve.
 * One `touch $'plant-\xff-name.js'` inside the mount was enough to make the
 * decoded path fail `lstat` with ENOENT, throw out of the whole enumeration,
 * and leave the build with no record at all — suppressing the A/B lane for
 * the round through a note that reads as infrastructure. Bytes in, bytes
 * compared, bytes recorded (see `inventoryKey`).
 *
 * `.trim()` is not applied either — `gitOut`'s would eat a leading-space
 * filename, and the record separator here is NUL, not whitespace.
 *
 * A non-empty stderr on an otherwise-successful listing is an INCOMPLETE
 * answer, not a warning to ignore: `ls-files` reports a directory it could
 * not read as `warning: unable to readdir …`, skips that subtree, and still
 * exits 0. Returning the short listing would write a baseline that silently
 * omits every path under it, so anything dropped there afterwards is
 * invisible to the fence. The caller treats the throw the way it treats any
 * other "could not enumerate" — decline, never destroy.
 */
function gitOutZ(cwd: string, ...args: string[]): Buffer {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  if (stderr !== '') {
    throw new Error(
      `git ${args.join(' ')} answered with warnings, so the listing is ` +
        `incomplete and cannot be a baseline: ${stderr}`,
    );
  }
  const out = r.stdout ?? Buffer.alloc(0);
  return out.length > 0 && out[out.length - 1] === 0
    ? out.subarray(0, out.length - 1)
    : out;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', [...GIT_NEUTRALIZE, ...args], {
    cwd,
    encoding: 'utf8',
    env: sanitizedGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr ?? ''}`);
  }
}

/**
 * The tree's untracked AND ignored entries, as raw byte paths relative to
 * the tree.
 *
 * ONE `ls-files` call, not `git status` and not two: status collapses a
 * directory to one `dir/` entry, and a plant dropped INSIDE a directory the
 * build left — `dist/cli.js`, `node_modules/.bin/<x>`, exactly what a
 * host-side A/B executes — then changes no set membership. And `--others`
 * WITHOUT `--exclude-standard` already returns the union of the untracked
 * and the ignored, so the two filtered walks this used to pay for were one
 * walk's worth of answer bought twice.
 *
 * `ls-files --others` collapses in ONE case, which the earlier comment here
 * denied: it stops descending at a nested repository and emits the single
 * entry `dir/`. A dependency fetched from a git URL, a submodule
 * materialised during install, or a `git init` run inside the mount all
 * produce one. `expandCollapsed` walks those itself rather than refusing
 * them — refusing would kill the A/B lane for the round on a legitimate
 * tree, which is the failure this fence keeps being asked not to cause.
 */
function untrackedPaths(tree: string): Buffer[] {
  const split = (out: Buffer): Buffer[] => {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const nul = out.indexOf(0, at);
      const end = nul === -1 ? out.length : nul;
      if (end > at) parts.push(out.subarray(at, end));
      if (nul === -1) break;
      at = nul + 1;
    }
    return parts;
  };
  // ONE walk, not two. `--exclude-standard` is what makes `--others` skip
  // ignored paths, so WITHOUT it a single `--others` returns the union the
  // two filtered walks were being paid for separately — measured on a
  // fixture holding an ignored directory, a nested repository and plain
  // untracked files, the unfiltered walk returns exactly the concatenation.
  // At real scale that is ~100k paths listed once instead of twice.
  //
  // No sort either: the inventory is a map, so the order it is built in
  // moves no comparison, and git's own output order is already
  // deterministic for the record's readability.
  const out: Buffer[] = [];
  for (const entry of split(gitOutZ(tree, 'ls-files', '-z', '--others'))) {
    if (entry[entry.length - 1] === SEP_BYTE) {
      expandCollapsed(tree, entry.subarray(0, entry.length - 1), out);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** `/` as a byte — what git terminates a collapsed directory entry with. */
const SEP_BYTE = 0x2f;

/**
 * How many entries a nested repository may contribute before the listing
 * counts as unmeasurable. A real built tree lists ~100k paths in total, so a
 * single nested repository past this is not a dependency — and an inventory
 * this walk could not finish must decline rather than be recorded short.
 */
const MAX_COLLAPSED_ENTRIES = 200_000;

/**
 * Enumerate a directory git collapsed, depth-first, appending byte paths
 * relative to the tree.
 *
 * `withFileTypes` so the walk never follows a link: a symlink inside a
 * nested repository is recorded as a link (see `untrackedInventory`), never
 * descended into.
 */
function expandCollapsed(tree: string, rel: Buffer, out: Buffer[]): void {
  const stack: Buffer[] = [rel];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const abs = joinBytes(tree, dir);
    let entries: Array<Dirent<Buffer>>;
    try {
      entries = readdirSync(abs, { withFileTypes: true, encoding: 'buffer' });
    } catch (err) {
      // Unreadable is the same class as `ls-files`' own readdir warning: an
      // inventory that omits a subtree is not a baseline.
      throw new Error(
        `could not enumerate the nested repository at ${dir.toString('utf8')}: ` +
          `${(err as Error).message}`,
      );
    }
    for (const entry of entries) {
      const name = entry.name as unknown as Buffer;
      // Never descend into the nested repository's own `.git`. It is git's
      // bookkeeping, not build output: every loose object and pack in it
      // would be recorded and re-stat'ed on every ask, and any ordinary git
      // command inside that repository — which nothing here runs, but a
      // developer might — rewrites it. Recording it would make an honest
      // repository's own housekeeping read as tampering.
      if (entry.isDirectory() && name.equals(Buffer.from('.git'))) continue;
      const child = Buffer.concat([dir, Buffer.from([SEP_BYTE]), name]);
      if (++seen > MAX_COLLAPSED_ENTRIES) {
        throw new Error(
          `the nested repository at ${rel.toString('utf8')} holds more than ` +
            `${MAX_COLLAPSED_ENTRIES} entries, so its inventory cannot be measured`,
        );
      }
      if (entry.isDirectory()) stack.push(child);
      else out.push(child);
    }
  }
}

/** `<tree>/<rel>` with the relative part kept byte-exact. */
function joinBytes(tree: string, rel: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${tree}${sep}`), rel]);
}

/**
 * A byte path as an object key, losslessly.
 *
 * `latin1` maps each byte to exactly one code point in U+0000-U+00FF, so a
 * filename holding any byte sequence round-trips through the JSON record
 * unchanged — which `utf8` does not (see `gitOutZ`). ASCII paths, which is
 * all of them in practice, are unchanged by it and stay readable in the
 * file.
 */
function inventoryKey(rel: Buffer): string {
  return rel.toString('latin1');
}

/**
 * The untracked inventory a build leaves, per file with the stat pair the
 * reuse fence compares — membership alone is blind to an in-place rewrite
 * of a recorded path (`dist/cli.js` keeps its name while its bytes become
 * the reviewed code's), and `BuiltTreeStat` says why the pair is size and
 * ctime.
 *
 * Nothing is excluded. The in-tree marker files this command used to write
 * are gone — see the module's own reasoning at the trust store: every write
 * into the mounted tree is a write through whatever the reviewed code left
 * at that path (a symlink at the marker name turned the "note for a human"
 * into an arbitrary host-file truncate; a FIFO turned it into a hang no
 * `catch` can reach), and a note nothing reads is not worth either. So a
 * file that happens to carry a marker's NAME is inventory like any other:
 * recorded when the build leaves it, and an unrecorded extra when the
 * reviewed code plants it.
 */
function untrackedInventory(tree: string): Record<string, BuiltTreeStat> {
  // No prototype: a path literally named `__proto__` is a legal filename,
  // and the plain-object setter would swallow it — recorded nowhere, so a
  // plant at that path would be invisible to the fence.
  const inventory: Record<string, BuiltTreeStat> = Object.create(null);
  // BOTH spellings of the tree root. A link that resolves back INSIDE the
  // tree is enumerated on its own account by the walk, so it needs no target
  // stat; judging that against the canonical root alone misread every such
  // link on a host where an ancestor is itself a link (`/tmp` on macOS is
  // the everyday case), and recorded a second, redundant stat pair whose
  // churn then declined honest rebuilds twice over.
  // ONE basis: the canonical tree root, because the thing compared against it
  // is canonical too (`escapesTree` realpaths the target). Comparing a
  // realpath against a lexical root is what misreads every in-tree link on a
  // host where an ancestor is itself a link — `/tmp` on macOS is the everyday
  // case. The lexical spelling is the fallback for a tree that cannot be
  // resolved at all, where the caller's own gates rule anyway.
  let treeRoot: string;
  try {
    treeRoot = realpathSync(tree);
  } catch {
    treeRoot = resolve(tree);
  }
  const insideAnyRoot = (target: string): boolean => {
    const rel = relative(treeRoot, target);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  /**
   * Does this link's target lie outside the tree?
   *
   * RESOLVED, not lexical. A lexical test reads
   * `node_modules/.bin/tool -> ../pkg/payload.js` as in-tree and records no
   * target pair for it — while `node_modules/pkg` is itself a link out, so
   * the file that actually runs is outside the tree and unwatched. The
   * realpath answers where the bytes are; the lexical spelling only answers
   * where the name points.
   *
   * A target that cannot be resolved counts as escaping: it is the one
   * answer that cannot be checked cheaply, and recording the sentinel for it
   * is what makes a later ask that CAN resolve it a change rather than a
   * silent match.
   */
  const escapesTree = (target: string): boolean => {
    try {
      // The RESOLVED path decides, with no lexical short-circuit ahead of
      // it: answering "inside" as soon as the spelling looks inside is the
      // whole bug — `../pkg-real` is lexically in-tree while `pkg-real` is
      // itself a link out, so the file that actually runs is outside and
      // went unwatched.
      return !insideAnyRoot(realpathSync(target));
    } catch {
      // Unresolvable counts as escaping: it is the one answer that cannot be
      // checked cheaply, and recording the sentinel for it is what makes a
      // later ask that CAN resolve it a change rather than a silent match.
      return true;
    }
  };
  for (const rel of untrackedPaths(tree)) {
    const abs = joinBytes(tree, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      // Gone between the listing and the stat. That is ordinary churn on a
      // tree a sibling shard may be running an A/B in, and it must NOT be
      // fatal: a throw here lands no record at all at build time, and every
      // later shard then declines for the rest of the round — the A/B lane
      // killed by one file that moved. Skipping is fail-closed on its own
      // terms: the path is simply not in this inventory, so a later ask that
      // finds it there sees an unrecorded extra and declines.
      //
      // Only ENOENT. Any other errno is a tree this walk cannot describe,
      // and an inventory that silently omits a subtree is not a baseline.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const entry: BuiltTreeStat = { size: st.size, ctimeMs: st.ctimeMs };
    if (st.isSymbolicLink()) {
      // `lstat` describes the LINK, which is the right choice for spotting a
      // planted link but the wrong one for describing what the A/B's base
      // side actually executes: rewriting the TARGET moves neither the
      // link's size nor its ctime. So the target is recorded too.
      //
      // The target's own name is recorded for every link (a relinked
      // `node_modules/.bin/x` is a rewrite the stat pair cannot see), and
      // the target's stat only when the target ESCAPES the tree — a target
      // inside the tree is enumerated on its own account by the walk above,
      // so stat-ing it here would record the same file twice and make an
      // honest rebuild's ctime churn read as two mismatches instead of one.
      entry.link = readlinkSync(abs, 'buffer').toString('latin1');
      const resolved = resolve(dirname(abs.toString('latin1')), entry.link);
      if (escapesTree(resolved)) {
        try {
          // A BUFFER path, latin1-encoded back to the bytes it came from.
          // Handing `statSync` the string re-encodes it as UTF-8, so any
          // byte >= 0x80 anywhere on the path — a non-ASCII home directory
          // is enough — addressed a path that does not exist, the catch
          // recorded the dangling sentinel for a LIVE target, and a later
          // rewrite recomputed the same sentinel and matched.
          const target = statSync(Buffer.from(resolved, 'latin1'));
          entry.targetSize = target.size;
          entry.targetCtimeMs = target.ctimeMs;
          if (target.isDirectory()) {
            // A directory's own size and ctime do not move when a child is
            // rewritten in place, so the pair says nothing about what runs.
            // Rather than pretend, record that the target is a directory —
            // an escaping link to one is not something this pipeline's build
            // produces, and a tree that holds one is not a tree this fence
            // can describe. `-2` is distinct from the dangling `-1`, so the
            // two never silently compare equal.
            entry.targetSize = -2;
            entry.targetCtimeMs = -2;
            entry.targetUndescribable = true;
          }
        } catch {
          // A dangling escape: recorded as such, so a later ask that finds
          // it resolvable is a change rather than a silent match.
          entry.targetSize = -1;
          entry.targetCtimeMs = -1;
        }
      }
    }
    inventory[inventoryKey(rel)] = entry;
  }
  return inventory;
}

/**
 * Whether everything this run RECORDED is still there, unchanged.
 *
 * The comparison iterates `recorded`, and both directions it does not take
 * are deliberate.
 *
 * It used to iterate `current` instead, which caught a rewrite and an
 * addition and missed a DELETION — so removing `dist/cli.js`, the file this
 * module's own docs name as "exactly what a host-side A/B executes", passed
 * the fence and left the base side running against a tree missing its built
 * executable, reading as "fails on base too". That half is closed: every
 * recorded path must still be present with the same stat pair.
 *
 * Then it iterated BOTH, and the addition arm turned out to fire on the
 * pipeline's own sanctioned use. `test-delta` runs the base side with its cwd
 * INSIDE this tree, so the A/B's own cache and coverage output lands here as
 * untracked files; the listing is deliberately unfiltered, so it sees them,
 * and every later shard of the round then declined — measured, three
 * consecutive asks after a single honest A/B, where the pre-fence merge base
 * reused. An `available: false` base tree makes the agent fall back to the
 * path rule, so that decline waves through a real regression in an untouched
 * file. No adversary is involved: it is what an honest round does to itself.
 *
 * So an ADDITION is tolerated. That is a real loss and it is named here
 * rather than papered over: a file planted at a NEW path inside the tree —
 * `node_modules/.bin/x`, a file dropped inside the `dist/` the build left —
 * is no longer seen by this compare.
 *
 * It is the lesser loss, for three reasons. The lane dying on every honest
 * round is a total loss of the feature, and an `available: false` base tree
 * makes the agent fall back to the path rule, which waves through exactly
 * the regressions the A/B exists to catch. There is no discriminator: the
 * A/B's base side runs the reviewed repository's own test code IN this tree,
 * so "the run wrote it" and "the reviewed code wrote it" are the same event
 * — re-recording the extras would promote a plant into "what this run
 * built", which is a false statement written into the record itself, and
 * gating on the build lock only discriminates during the build, which is not
 * when the A/B writes. And the arm was never a complete defence anyway: the
 * base tree's own PARENT is the mounted directory, so `node_modules/.bin`
 * one level up outranks anything inside the tree on npm's PATH
 * (`unfencedResolutionAncestor`).
 *
 * So the claim this function makes is stated exactly, and it is the claim
 * the fence can actually keep: what this run BUILT is still here and still
 * what it was. It does not claim the tree holds nothing else. The durable
 * fix for that half is not here — it is for the A/B's base side to run in a
 * throwaway copy of the certified tree rather than in the tree itself, which
 * is `test-delta`'s to make and is filed as follow-up.
 */
function inventoryMatches(
  current: Record<string, BuiltTreeStat>,
  recorded: Record<string, BuiltTreeStat>,
): boolean {
  const same = (a: BuiltTreeStat, b: BuiltTreeStat): boolean =>
    a.size === b.size &&
    a.ctimeMs === b.ctimeMs &&
    a.link === b.link &&
    a.targetSize === b.targetSize &&
    a.targetCtimeMs === b.targetCtimeMs &&
    a.targetUndescribable === b.targetUndescribable;
  for (const p of Object.keys(recorded)) {
    // `Object.prototype.hasOwnProperty.call`, not `current[p]`: a path named
    // `constructor` would otherwise resolve to an inherited value. (`current`
    // is null-prototype, `recorded` is parsed from JSON and is not.)
    if (!Object.prototype.hasOwnProperty.call(current, p)) return false;
    if (!same(current[p], recorded[p])) return false;
  }
  return true;
}

/**
 * A path whose recorded entry says the fence cannot describe what it points
 * at — an escaping symlink to a DIRECTORY — or null.
 *
 * The flag is set at record time; this is where it bites. A tree holding one
 * cannot be certified, because a rewrite of any file under that directory is
 * invisible to the stat pair while being exactly what the A/B's base side
 * would execute through the link. Refusing rather than declining silently:
 * the note names the path, so an operator can see what to remove.
 */
function undescribableEntry(
  inventory: Record<string, BuiltTreeStat>,
): string | null {
  for (const [p, st] of Object.entries(inventory)) {
    if (st.targetUndescribable) return p;
  }
  return null;
}

/**
 * A directory ABOVE the base tree, inside the mounted review temp dir, that
 * holds module-resolution state — or null.
 *
 * The fence bounds itself to the tree, and the tree's own parent is the
 * directory the sandbox hands the reviewed code read-write. Both of the
 * things the A/B's base side runs walk UP through it: npm prepends every
 * ancestor `node_modules/.bin` ahead of the inherited PATH, and Node resolves
 * a bare specifier by walking ancestors' `node_modules`. So
 * `<repo>/.qwen/tmp/node_modules/.bin/node` — written during the
 * containerized phase, never touching the base tree at all — wins over
 * `/usr/bin/node` for every command the shard runs in the certified tree, on
 * the HOST, outside the container. Measured on npm 10 / node 22: an ancestor
 * `node_modules/.bin` entry ran, and a bare `require` resolved from an
 * ancestor `node_modules`.
 *
 * The walk stops at the review temp root: above it is the user's own layout,
 * where a `node_modules` is ordinary and not something the reviewed code put
 * there.
 *
 * Refusing rather than declining, and refusing rather than sweeping: the
 * directory is not this command's to delete, and certifying a tree whose
 * execution environment is the reviewed code's is the one thing this fence
 * exists to prevent.
 */
function undescribableNote(where: string): string {
  return (
    `the base tree holds a symlink whose target is a DIRECTORY outside the ` +
    `tree (${where}), and a directory's own size and ctime do not move when ` +
    'a file under it is rewritten — so what the base side would execute ' +
    'through that link cannot be watched. Declining to certify this tree; ' +
    'remove the link and re-run. An A/B is not available for this review ' +
    '(this is an infrastructure result, never a finding against the PR)'
  );
}

function unfencedNote(where: string): string {
  return (
    `an ancestor of the base tree inside the review temp dir holds module ` +
    `resolution state (${where}), and both npm's PATH and Node's resolver ` +
    'walk up through it — so a command run in the base tree would resolve ' +
    'from a directory the reviewed code holds read-write, on the host. ' +
    'Declining to certify this tree; remove that directory and re-run. An ' +
    'A/B is not available for this review (this is an infrastructure ' +
    'result, never a finding against the PR)'
  );
}

function unfencedResolutionAncestor(tree: string): string | null {
  // The mount root is derived from the TREE, lexically — not from
  // `process.cwd()`. `REVIEW_TMP_DIR` is a relative constant, so resolving it
  // against the process directory answers for whatever directory the command
  // happens to be run from, which is not the tree's repository in the nested
  // geometry and is not the fixture's in a test. The base tree always sits
  // at `<root>/.qwen/tmp/<name>-base`, so the marker on its own path is the
  // answer; the LAST occurrence, because an inner review's tree carries the
  // outer review's marker too and the directory that matters here is the one
  // this tree's own commands resolve through.
  const resolved = resolve(tree);
  const marker = `${sep}${REVIEW_TMP_DIR}${sep}`;
  const at = resolved.lastIndexOf(marker);
  if (at < 0) return null;
  const mountRoot = resolved.slice(0, at + marker.length - 1);
  let dir = dirname(resolved);
  for (;;) {
    const rel = relative(mountRoot, dir);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return null;
    if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules');
    if (rel === '') return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function runBaseTree(args: BaseTreeArgs): BaseTreeReport {
  const unavailable = (note: string): BaseTreeReport => ({
    available: false,
    build: null,
    note,
  });

  let plan: { mergeBaseSha?: unknown; baseFetchFailed?: unknown };
  try {
    plan = JSON.parse(readFileSync(args.plan, 'utf8'));
  } catch (err) {
    return unavailable(
      `cannot read the plan ${args.plan}: ${(err as Error).message}`,
    );
  }

  const baseSha = plan.mergeBaseSha;
  if (
    typeof baseSha === 'string' &&
    baseSha &&
    !/^[0-9a-f]{40}$/.test(baseSha)
  ) {
    // Shape-checked before any git call and independently of the host-side
    // anchor below: the plan is inside the mount, and everything downstream
    // — `worktree add`, the `rev-parse HEAD` compare, the note text — takes
    // this string on trust. A full lowercase object name is the only thing
    // the capture ever writes here.
    return unavailable(
      "the plan's mergeBaseSha is not a full 40-character object name, and " +
        'the plan lives inside the review temp dir — declining to act on it; ' +
        'an A/B is not available for this review',
    );
  }
  if (typeof baseSha !== 'string' || !baseSha) {
    // A local review, a bare `plan-diff`, or a PR whose merge base could not be
    // resolved. There is no "before" to build, and saying so plainly beats
    // guessing at one — an A/B against the wrong base is worse than no A/B.
    return unavailable(
      'the plan carries no mergeBaseSha, so there is no base commit to build ' +
        '(a local review, or a merge base that could not be resolved)',
    );
  }
  // `fetch-pr` sets this when it could not fetch the base branch, which leaves
  // `mergeBaseSha` possibly stale — pointing at whatever the local ref happened
  // to be. A comparison against a stale base attributes the base branch's own
  // movement to this PR, which is the same class of error two-dot diffs made.
  if (plan.baseFetchFailed === true) {
    return unavailable(
      'the base branch could not be fetched, so mergeBaseSha may be stale; an ' +
        "A/B against it would attribute the base branch's own commits to this PR",
    );
  }

  const worktree = resolve(args.worktree);
  if (!existsSync(worktree)) {
    return unavailable(`the review worktree ${worktree} does not exist`);
  }

  const tree = baseWorktreePath(worktree);
  const lock = `${tree}.lock`;
  /**
   * How long a build lock may stand before it is a corpse rather than a
   * builder. Longer than any plausible install+build; a lock older than this
   * is swept and the build taken.
   */
  const LOCK_STALE_MS = 30 * 60 * 1000;
  /**
   * Is a sibling building RIGHT NOW?
   *
   * `mkdirSync` without `recursive` is the atomic test-and-set below, and the
   * lock directory's mtime is its creation time (nothing touches it after),
   * so this answers the question the reuse arm needs: "the tree exists with
   * no record — is that a torn write, or the ordinary state of a build in
   * flight?". `worktree add` creates the tree as its first act and the record
   * lands only after the whole install+build, so the in-flight window is
   * several minutes wide and is not an anomaly.
   */
  const buildLockHeld = (): boolean => {
    try {
      return Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS;
    } catch {
      return false;
    }
  };
  const BUSY_NOTE =
    'another probe is building the base tree right now — retry when it ' +
    'finishes (the fast path will then reuse it), or settle the claim by ' +
    'reading; do not sweep the tree out from under the builder';
  // Idempotent fast path — and the CONCURRENCY guard. Step 4 launches its
  // verifier shards together, the brief offers every one of them this command,
  // and they all resolve the same path; without this, shard B's opening sweep
  // destroys the tree shard A is mid-A/B in, and A's base side silently reads
  // as empty output — a fabricated difference with a deterministic source tag.
  // A tree that exists, holds the right commit, and carries a host-side
  // record this run wrote is returned as-is: same answer, no clobber, and the
  // duplicate install+build cost gone with it. (Not a lock: two shards racing
  // the FIRST build can still collide — the window is narrow and the failure
  // is a build error, not a wrong verdict. A record for the wrong SHA — a
  // rebase between runs — falls through to the rebuild below.)
  // The fence reads this run's trust record, kept OUTSIDE the mount beside
  // the worktree leases (see lib/base-tree-trust.ts). It used to read a
  // marker file inside the tree stamped with a per-run secret — but the
  // marker lived inside the directory the sandbox mounts read-write, and a
  // secret readable from the mount authenticates nothing: the reviewed code
  // could copy it into a forged failed-marker and settle the A/B lane into
  // "infrastructure" for the whole round, or stamp an ok marker over a tree
  // it shaped. So the record — which the mount cannot supply — is the whole
  // of the fence, and the in-tree markers are gone entirely rather than
  // demoted: keeping them meant this command still WROTE into the tree
  // (through whatever the reviewed code left at that path) and still READ
  // one (with a bare `readFileSync` a planted FIFO turned into a hang).
  // Without the record no tree is reused and no failure is settled, so its
  // absence fails the command, not the fence.
  let trustPath: string;
  let trust: TrustState;
  let identityMs: number;
  let anchoredBaseSha: string | undefined;
  try {
    // `runIdentity` first: it is the one that refuses a worktree with no
    // host-side lease naming it, and `baseTreeTrustPath` keys under the same
    // target — so a refusal here must happen before any path is derived.
    const identity = runIdentity(worktree);
    trustPath = baseTreeTrustPath(worktree, args.plan);
    identityMs = identity.identity;
    anchoredBaseSha = identity.mergeBaseSha;
  } catch (err) {
    return unavailable(
      `could not establish the run's trust artifact: ${(err as Error).message}`,
    );
  }
  // The plan is inside the mount; the lease is not. The merge base the
  // CAPTURE resolved is what this run is entitled to build against, and the
  // plan agreeing with it is a precondition — not a source.
  //
  // The pin alone could not carry this. It authenticates the plan against
  // the FIRST ask's reading of the plan, and the containerized build/test
  // phase runs before any `base-tree` ask exists — so the reviewed code
  // holds the plan read-write before that first reading. Rewriting
  // `mergeBaseSha` to the PR head (a real commit, so `worktree add`
  // succeeds) made the run build, certify and pin a "base" the PR chose,
  // after which both A/B arms emit identical output.
  //
  // This rules BEFORE `establishTrust`, and the order is load-bearing: pinned
  // first, a tampered first ask made the tampered sha the run's authoritative
  // pin, and every later HONEST capture in the session was then declined as
  // "the plan moved" — the attack's cost landing on the operator after the
  // attack ended, with no recovery short of a real rebase.
  //
  // And a MISSING anchor refuses rather than passing. Skipping the check when
  // the lease carries no merge base left the mount-writable plan as the sole
  // authority again on exactly the rounds where the capture could not record
  // one — the whole of the original hole, on a branch that merely looked like
  // an edge case.
  if (anchoredBaseSha === undefined) {
    return unavailable(
      "this review's capture recorded no merge base host-side, so the only " +
        'source for one is the plan inside the review temp dir — declining ' +
        'to build or reuse at a sha nothing outside the mount vouches for; ' +
        'an A/B is not available for this review (re-run `fetch-pr` to ' +
        'record it)',
    );
  }
  if (anchoredBaseSha !== baseSha) {
    return unavailable(
      `the plan names merge base ${baseSha.slice(0, 9)} but this review's ` +
        `capture recorded ${anchoredBaseSha.slice(0, 9)} host-side, and the ` +
        'plan lives inside the review temp dir — declining to build or ' +
        'reuse at a sha the capture never resolved; an A/B is not available ' +
        'for this review',
    );
  }
  try {
    trust = establishTrust(trustPath, identityMs, baseSha);
  } catch (err) {
    return unavailable(
      `could not establish the run's trust artifact: ${(err as Error).message}`,
    );
  }
  if (trust.conflict) {
    // The plan now names a different merge base than the one this run pinned
    // at establishment. The plan lives inside the mount, so a mid-run
    // rewrite of `mergeBaseSha` is how the reviewed code would choose the
    // base every later A/B certifies; re-pinning would make the rewritten
    // value authoritative, so the answer is to decline. A genuine rebase
    // arrives through a fresh capture — a new identity (minted host-side
    // when the capture records a moved merge base), a rotation, a clean pin.
    return unavailable(
      'the plan now names a different merge base than the one this run ' +
        'pinned when it started, and the plan lives inside the review temp ' +
        'dir — declining to build or reuse at a sha named after the fact; ' +
        'an A/B is not available for this review',
    );
  }
  try {
    const recorded = builtTreeRecord(trustPath, tree);
    // `state: 'truncated'` is deliberately NOT in this condition: the budget
    // cut an earlier ask's build short, which says nothing about this sha, so
    // this ask repays the build rather than reusing a tree that was never
    // finished or re-serving the truncation as an answer. It falls through to
    // `buildBaseTree`, whose opening `dropBuiltTree` clears the entry before
    // the sweep.
    if (
      existsSync(tree) &&
      recorded !== null &&
      recorded.baseSha === baseSha &&
      recorded.state !== 'truncated'
    ) {
      if (recorded.state === 'failed') {
        // A base that FAILED to build is a settled answer too — and the
        // record, not any in-tree marker, is what settles it: this branch
        // answers with NO build at all, so a planted note must not reach it.
        // Without the record every shard that asks re-sweeps and re-pays the
        // install+build to relearn the same "unavailable" — and the sweep
        // destroys the evidence tree the failure deliberately leaves
        // standing.
        return {
          available: false,
          path: tree,
          baseSha,
          build: null,
          note:
            `the base tree at ${baseSha.slice(0, 9)} already failed to build (an earlier probe measured it); ` +
            'an A/B is not available for this review (infrastructure, never a finding against the PR)',
        };
      }
      // ...and THIS run built it — genuinely: the record lives outside the
      // mount, so a mount-local writer cannot have written or refreshed it.
      // `cleanStale` never releases `-base`, so an earlier round's
      // tree stands into this one with a whole containerized build/test
      // phase in between — long enough for the reviewed code to drop
      // untracked executables in here, and `dist/cli.js` is what a host-side
      // A/B runs.
      // The reuse path RETURNS, so the gate below the rebuild never runs
      // for it — and both facts these arms establish come from inside the
      // mount: `rev-parse HEAD` resolves through that tree's own `.git`,
      // and its working files are a direct child of the directory the
      // sandbox mounts read-write. A planted repository answers the right
      // sha for a working tree holding anything at all; a plain copy
      // overwrites the tracked sources while HEAD never moves — and the
      // A/B's BASE side is then the reviewed code's own, so a test the PR
      // breaks fails identically on both sides and reads as pre-existing.
      const pointerWhy = untrustedGitfile(tree);
      if (
        pointerWhy !== null ||
        gitOut(tree, 'rev-parse', 'HEAD') !== baseSha
      ) {
        // A rewritten pointer or a moved HEAD has NO benign cause: this
        // run's build does not touch either, and a concurrent A/B does not
        // move HEAD. Not the busy arm — the discard-and-rebuild below is
        // exactly what sweeps the plant, and declining here would leave it
        // standing for the rest of the run.
      } else {
        // Tracked dirt OR an untracked change. Both have benign causes
        // on a tree this run built: codegen and lockfile rewrites from
        // this run's own build, a concurrent shard's snapshot `--update`
        // mid-A/B, the A/B's own cache output. Both are also what a plant
        // looks like — and that ambiguity is exactly why the answer is to
        // DECLINE rather than to discard: discarding on this signal
        // sweeps a live tree another shard may be mid-A/B in (the
        // concurrent-shard clobber this fast path exists to prevent),
        // while a genuine plant wedged here is never executed, and the
        // next run's rotation discards it.
        //
        // `--untracked-files=no` for the tracked arm: the pipeline's own
        // build leaves `node_modules/` and `dist/` here, so an
        // untracked-inclusive check would call every correctly-built
        // tree dirty and disable reuse outright — the untracked surface
        // is the inventory arm's, recorded host-side at build time. An
        // inventory that cannot be re-measured declines like a failed one:
        // "could not enumerate" is not evidence worth destroying a live
        // tree over.
        let inventory: Record<string, BuiltTreeStat> | null;
        try {
          inventory = untrackedInventory(tree);
        } catch {
          inventory = null;
        }
        // The pointer question, asked AGAIN — immediately before the one
        // command in this arm that is not a safe read.
        //
        // The entry check above answered about the pointer as it stood then;
        // the inventory walk between the two is ~1 s on a real tree (~100k
        // lstats), and a sibling tree under the same read-write mount is
        // enough for the reviewed code to rewrite `<base>/.git` inside that
        // window. `git status` REFRESHES THE INDEX: it re-hashes every
        // stat-dirty tracked file, which runs the resolved repository's
        // `filter.<driver>.clean` — on the host, as the review user. A
        // rewritten pointer aimed at a planted commondir carrying such a
        // filter therefore turns this check into execution. Asking here
        // shortens the window from "one inventory walk" to the two
        // statements between this call and the spawn.
        //
        // `gitOut`'s `-c` pins blank `core.fsmonitor` and `core.hooksPath`,
        // but `filter.*` cannot be blanked generically — there is no
        // wildcard for it — so the pointer is the thing that has to be
        // right, not the config.
        args.onReuseWindow?.();
        const unfenced = unfencedResolutionAncestor(tree);
        if (unfenced !== null) {
          return unavailable(unfencedNote(unfenced));
        }
        const opaque =
          inventory === null ? null : undescribableEntry(inventory);
        if (opaque !== null) {
          return unavailable(undescribableNote(opaque));
        }
        const stillTrusted = untrustedGitfile(tree);
        if (stillTrusted !== null) {
          return unavailable(
            `the base tree at ${baseSha.slice(0, 9)} had its .git pointer ` +
              `rewritten while this ask was measuring it (${stillTrusted}), ` +
              'so the reuse check cannot be completed safely; declining to ' +
              `reuse or discard it — remove ${tree} to force a rebuild`,
          );
        }
        if (
          gitOut(tree, 'status', '--porcelain', '--untracked-files=no') !==
            '' ||
          inventory === null ||
          !inventoryMatches(inventory, recorded.untracked)
        ) {
          // Terminal within the run, and deliberately so. The two-way
          // inventory compare means an absence declines too, and a decline
          // that could re-record itself would let anything that changed the
          // tree re-baseline the fence against its own change — which is the
          // whole property this arm exists for. So the recovery named here
          // is the one that actually works and cannot be driven from inside
          // the mount: remove the tree, which makes the next ask rebuild it.
          // The earlier text prescribed "retry when the probe finishes",
          // which for the residue shape is advice that can never succeed —
          // the residue is still there at the retry.
          return unavailable(
            `the base tree at ${baseSha.slice(0, 9)} was built by this run ` +
              'but no longer holds exactly what this run recorded (a ' +
              'concurrent probe may be writing it mid-A/B, or something ' +
              'changed it); declining to reuse or discard it — settle the ' +
              `claim by reading, or remove ${tree} to force a rebuild`,
          );
        }
        return {
          available: true,
          path: tree,
          baseSha,
          build: null,
          note: `base tree already built at ${baseSha.slice(0, 9)} in ${tree} (reusing it — a concurrent or earlier probe built it)`,
        };
      }
    } else if (existsSync(tree) && recorded === null) {
      // A standing tree with NO record in this run's trust file. Two shapes:
      // a leftover this run has no history of (an earlier run's tree, a
      // plant, a crashed pre-record build — the rebuild sweeps it), and a
      // tree THIS run built whose record never landed or tore (the build
      // lock serializes builders, so the tree may be mid-A/B in a sibling
      // shard — discarding on a bookkeeping gap is the clobber this fence
      // exists to prevent).
      //
      // What tells them apart is `established`, and ONLY that: `adopted`
      // means an earlier shard of THIS run minted the trust file, `healed`
      // means this run's file tore. Both are host-side evidence that this
      // run has been here. The earlier cut read an in-tree marker for the
      // same question — a file inside the surface the reviewed code holds
      // read-write, which could be planted to force this decline (and whose
      // bare `readFileSync` hung the shard outright on a FIFO). The trust
      // file answers it strictly better, so the marker is gone.
      const pointerWhy = untrustedGitfile(tree);
      if (
        pointerWhy !== null ||
        gitOut(tree, 'rev-parse', 'HEAD') !== baseSha
      ) {
        // The same no-benign-cause arm as above: a rewritten pointer is the
        // plant the rebuild sweeps, whatever the bookkeeping says.
      } else if (buildLockHeld()) {
        // A sibling is building RIGHT NOW. `worktree add` creates the tree
        // as its first act and the record lands only after the whole
        // install+build, so "the tree exists with no record" is the ORDINARY
        // state for the several minutes of the first build — not a torn
        // write. Answering the torn-write decline here was a false claim
        // with a recovery ("remove the tree") that is the concurrent-shard
        // clobber this fast path exists to prevent, and which the agent
        // briefs forbid verbatim. The busy answer is retryable and true.
        return unavailable(BUSY_NOTE);
      } else if (
        trust.established === 'adopted' ||
        trust.established === 'healed'
      ) {
        return unavailable(
          `the base tree at ${baseSha.slice(0, 9)} was built by this run ` +
            'but its host-side build record is missing or unreadable — a ' +
            'torn write says nothing about the tree, and discarding on it ' +
            'would sweep a live tree another probe may be mid-A/B in; ' +
            'declining to reuse or discard it — settle the claim by ' +
            `reading, or remove ${tree} to force a rebuild`,
        );
      }
    }
    // No tree, no record, a record naming a different base (the pin makes
    // that unreachable from a same-run plan rewrite, so what remains is
    // contradiction — the one disagreeing state that IS evidence of a
    // plant), or a foreign marker: not a refusal, an unusable leftover is
    // what the rebuild exists for. Falling through discards the tree
    // (removing a plant with it) and creates a fresh one through the review
    // worktree's pointer, which the gate before `worktree add` checks. Same
    // shape as `scratch-tree`'s reuse path, for the same reason.
  } catch {
    // No marker, an unanswerable tree: rebuild.
  }
  // A real mutual-exclusion lock around sweep+add+build, not just the marker.
  // The reuse fast path covers the AFTER-build window; this covers the build
  // itself: measured in review, shard B's opening sweep deleted the tree shard
  // A was mid-`npm ci` in, both installed into the same directory, and
  // whichever finished stamped the marker for a tree the other was still
  // mutating. `mkdirSync` without `recursive` is the atomic test-and-set; the
  // loser returns busy rather than waiting out a multi-minute build.
  // Staleness: a builder killed without its finally leaves the lock forever,
  // and within the same review every later probe reports busy until cleanup.
  // A lock older than any plausible install+build is a corpse — sweep it and
  // take the build. `buildLockHeld` above reads the same bound, so the reuse
  // arm's busy answer and this sweep can never disagree about which it is.
  try {
    if (!buildLockHeld()) {
      rmSync(lock, { recursive: true, force: true });
    }
  } catch {
    // No lock — the normal case.
  }
  try {
    mkdirSync(lock);
  } catch (err) {
    // Only EEXIST means "another builder holds it". EPERM/EROFS/ENOSPC is a
    // real failure this run owns — reporting it as busy sends the caller into
    // a retry loop against a lock that will never appear.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return unavailable(
        `could not take the base-tree build lock: ${(err as Error).message}`,
      );
    }
    return unavailable(BUSY_NOTE);
  }
  try {
    return buildBaseTree(baseSha);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }

  // The parameter re-narrows: TS narrowing does not cross function scopes.
  function buildBaseTree(baseSha: string): BaseTreeReport {
    let sweep: SweepResult | undefined;
    try {
      // The record goes FIRST, before the tree it describes stops existing:
      // `trees` is keyed by path, the base tree's path is fixed for the
      // review, and a rebuild the whole-call budget cuts short writes no new
      // record — so a surviving entry would certify a tree that was never
      // built. Dropping before the sweep means a crash in between leaves the
      // recoverable state, not the certifying one.
      dropBuiltTree(trustPath, identityMs, tree);
      // Clear a stale base tree left by a crashed run — it would fail `add`. Its
      // stderr is kept, because it is usually what explains that failure.
      sweep = discardWorktree(worktree, tree);
      // The same question the probe phase asks before its own `worktree add`:
      // this resolves the repository through the REVIEW worktree's gitfile,
      // which lives inside the directory the sandbox mounts read-write and
      // which the build/test phase already gave the reviewed code a chance to
      // rewrite. `worktree add` checks files out, so it runs whatever that
      // pointer leads to, on the host. See `untrustedGitfile`.
      const untrusted = untrustedGitfile(worktree);
      if (untrusted !== null) {
        throw new Error(`refusing to create a base tree: ${untrusted}`);
      }
      git(worktree, 'worktree', 'add', '--detach', tree, baseSha);
    } catch (e) {
      return unavailable(
        worktreeCreateFailureDetail('base', e, String(sweep?.stderr ?? '')),
      );
    }

    const build = args.build
      ? args.build(tree)
      : runBuildTest({
          plan: args.plan,
          worktree: tree,
          timeout: args.timeout,
          install: args.install,
          // The base tree's own suite says nothing about this PR — it was green
          // before the PR existed. What the A/B needs from here is a compiled
          // tree to run against.
          buildOnly: true,
        });

    // A build the whole-call budget truncated is NOT available: rerunning the
    // PR's failing files against packages that were never compiled
    // manufactures failures that read as "fails on base too" — pre-existing
    // by measurement — and waves a real regression through. But it is not a
    // settled answer about this SHA either (with more budget it may build
    // fully), so NO marker is written — a later shard may repay and succeed.
    if ((build.notBuilt?.length ?? 0) > 0) {
      // Recorded as `truncated`, not left as an absence. A standing tree
      // with NO record is ambiguous — either this, or a record that never
      // landed or tore — and the arm that reads the absence has to pick one
      // answer for both. Saying which one this is, host-side, lets the next
      // shard repay the build (the note's own promise) while a torn record
      // still declines.
      try {
        recordBuiltTree(trustPath, identityMs, tree, {
          baseSha,
          state: 'truncated',
          untracked: {},
        });
      } catch {
        // Unwritable: the next shard meets the ambiguous absence, which
        // declines. Fail-closed, and never a certification.
      }
      return {
        available: false,
        path: tree,
        baseSha,
        build,
        note:
          `the base tree build at ${baseSha.slice(0, 9)} was cut short by the ` +
          `whole-call budget (${build.notBuilt!.join(', ')} not built), so a ` +
          'rerun against it would manufacture pre-existing failures; an A/B ' +
          'is not available for this review (this is an infrastructure ' +
          'result, never a finding against the PR)',
      };
    }

    // `ok: true` is not enough: `runBuildTest` returns `ok: true` for a handoff
    // that built nothing — an `unsupported` toolchain (a changed dir the merge
    // base maps to no package, e.g. a package this PR adds), or an npm scope with
    // nothing to compile. Such a tree was never built, so it cannot be run against;
    // stamping it `available` would let an A/B read the absence of a build as a
    // behavioural difference.
    if (!build.ok || build.toolchain !== 'npm' || build.build.length === 0) {
      // Two outcomes wear one shape here, and only ONE of them is settled.
      //
      // `!build.ok` is a base that genuinely failed to compile: a fact about
      // this sha, worth re-serving to every later shard without re-paying the
      // build, and worth leaving the tree standing for (`cleanup` sweeps it
      // at the end of the review either way).
      //
      // "Built NOTHING" is not that. `runBuildTest` answers `ok: true` with
      // an empty build list when the scope it derived is empty — and that
      // scope comes from the plan's `files`, which lives inside the directory
      // the sandbox mounts read-write, before any `base-tree` ask exists.
      // Rewriting `files` to `[]` therefore let the reviewed code STEER the
      // build into producing nothing, and recording that as `failed` settled
      // the A/B lane as "infrastructure" for the whole run — host-side, in
      // the record this module presents as the thing a mount cannot supply.
      // It could not forge the record, so it chose its content instead.
      //
      // So an empty build is `truncated`: unavailable, never settled, and the
      // next shard repays it. That costs a repeated build on an honest
      // no-op scope and buys back the only host-side suppression left.
      const settled = !build.ok;
      try {
        recordBuiltTree(trustPath, identityMs, tree, {
          baseSha,
          state: settled ? 'failed' : 'truncated',
          untracked: {},
        });
      } catch {
        // The record could not be written. The next shard meets a standing
        // tree with no record, which is the ambiguous absence: it answers
        // BUSY while a builder holds the lock, and otherwise declines on the
        // torn-record arm. It does NOT repay this build — that would need a
        // record saying `truncated`, which is exactly what failed to land —
        // so the honest statement is that this answer was not settled and
        // the next shard's is a decline, not a retry.
      }
      return {
        available: false,
        path: tree,
        baseSha,
        build,
        note: settled
          ? `the base tree at ${baseSha.slice(0, 9)} did not build, so nothing can be run ` +
            'against it; an A/B is not available for this review (this is an ' +
            'infrastructure result, never a finding against the PR)'
          : `the base tree at ${baseSha.slice(0, 9)} built nothing — the ` +
            'toolchain or the scope the plan named produced no build step, ' +
            'and the plan lives inside the review temp dir, so this is not ' +
            'settled as a fact about the sha; an A/B is not available for ' +
            'this review (this is an infrastructure result, never a finding ' +
            'against the PR)',
      };
    }

    // The containerized build just held this tree read-write for minutes —
    // long enough for the reviewed code to rewrite its `.git`. Re-ask the
    // pointer question before the record's evidence-gathering:
    // `untrackedInventory` resolves the repository through that pointer, and
    // through a plant its reads would answer for — and run config out of —
    // whatever the plant names, on the host, outside the container.
    const pointerWhy = untrustedGitfile(tree);
    if (pointerWhy !== null) {
      return unavailable(
        `the base tree's .git pointer was rewritten during the build ` +
          `(${pointerWhy}), so its residue cannot be measured safely and ` +
          'nothing was recorded about it; the next ask rebuilds it, which ' +
          'sweeps the plant — copy the tree aside first if you want to ' +
          'inspect it. An A/B is not available for this review (this is an ' +
          'infrastructure result, never a finding against the PR)',
      );
    }
    // The execution environment the certified tree would be USED in, asked
    // before the record is written: an ancestor `node_modules` inside the
    // mount outranks the tree's own on npm's PATH and on Node's resolution
    // walk, so certifying here would certify a tree whose commands are the
    // reviewed code's to choose.
    const unfencedAfterBuild = unfencedResolutionAncestor(tree);
    if (unfencedAfterBuild !== null) {
      return unavailable(unfencedNote(unfencedAfterBuild));
    }
    // The inventory is taken ONCE, and what it says about itself is ruled on
    // before it becomes a certification: an entry the fence cannot describe
    // — an escaping link to a directory — must not be written into the
    // record as though the pair beside it meant something.
    let built: Record<string, BuiltTreeStat> | null;
    try {
      built = untrackedInventory(tree);
    } catch {
      built = null;
    }
    if (built !== null) {
      const opaque = undescribableEntry(built);
      if (opaque !== null) {
        return unavailable(undescribableNote(opaque));
      }
    }
    // The host-side record is the whole of the fence. Nothing is written
    // into the tree beside it: an in-tree note would be a host-side write
    // through whatever the reviewed code left at that path for the minutes
    // the containerized build held it — a symlink there makes the write an
    // arbitrary host-file truncate, and a FIFO makes it a hang inside
    // `open(2)` that no surrounding `catch` can reach.
    try {
      if (built === null) {
        throw new Error('the base tree residue could not be enumerated');
      }
      recordBuiltTree(trustPath, identityMs, tree, {
        baseSha,
        state: 'ok',
        untracked: built,
      });
    } catch {
      // The record could not be written (a full disk, a torn rename). THIS
      // call's answer stands — the build just succeeded in front of us —
      // and later shards decline on the missing record rather than reusing
      // what they cannot verify or discarding what a sibling may be using.
    }
    return {
      available: true,
      path: tree,
      baseSha,
      build,
      note:
        `base tree built at ${baseSha.slice(0, 9)} in ${tree}. Run the same input here and in the ` +
        'PR worktree and compare the observed output; a difference is evidence, a ' +
        'reading is not.',
    };
  }
}

export const baseTreeCommand: CommandModule = {
  command: 'base-tree',
  describe:
    "Build the PR's merge base in a sibling worktree, so a claim about changed " +
    'behaviour can be measured against the code as it stood before',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'The plan report from fetch-pr (it carries `mergeBaseSha`)',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: "The PR's worktree — the base tree is created beside it",
      })
      .option('out', { type: 'string', describe: 'Write the JSON report here' })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe: "Per-command deadline in seconds, as `build-test`'s",
      })
      .option('install', {
        type: 'boolean',
        default: true,
        describe: 'Run `npm ci` first when node_modules is absent',
      }),
  handler: (argv) => {
    const args = argv as unknown as BaseTreeArgs;
    try {
      const report = runBaseTree(args);
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`base-tree: ${report.note}`);
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
