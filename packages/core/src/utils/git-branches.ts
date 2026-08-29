/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { isValidGitSha, isValidRefName } from './gitDirect.js';
import { findGitRoot } from './gitUtils.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_RECENT_BRANCHES = 20;
const MAX_REFLOG_ENTRIES = 200;

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  upstream?: string;
  /**
   * `true` when the configured upstream ref no longer exists (git's
   * `[gone]` tracking state, e.g. after the remote branch was deleted and
   * pruned). `upstream` still names the configured ref in that case.
   */
  upstreamGone?: boolean;
  ahead: number;
  behind: number;
  /** Unix epoch seconds of the branch tip commit. */
  commitDate: number;
  commitSubject: string;
}

export interface GitTagInfo {
  name: string;
  /** Unix epoch seconds of the tag (annotated) or tagged commit (lightweight). */
  date: number;
  subject: string;
}

export interface GitBranchesResult {
  local: GitBranchInfo[];
  remote: GitBranchInfo[];
  tags: GitTagInfo[];
  recent: string[];
  head: string;
  detached: boolean;
}

// Repository-shifting variables that a daemon process may inherit from its
// launch environment.  Clearing them prevents a trusted workspace request
// from operating on a completely different repository despite the resolved
// `cwd`.
const GIT_ENV_VARS_TO_CLEAR = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  // Repository selectors that an inherited daemon environment could use to
  // redirect a trusted-workspace git/gh invocation to a different repository
  // or object database despite the resolved cwd.
  'GH_REPO',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

// Command-scope config injection uses numbered GIT_CONFIG_KEY_<n> /
// GIT_CONFIG_VALUE_<n> pairs (an inherited `url.<base>.insteadOf` can retarget
// a clone/push). The index count is unbounded, so strip them by prefix.
const GIT_ENV_PREFIXES_TO_CLEAR = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

export function gitEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env = { ...(base ?? process.env) };
  for (const key of GIT_ENV_VARS_TO_CLEAR) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (GIT_ENV_PREFIXES_TO_CLEAR.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  env['LC_ALL'] = 'C';
  env['LANG'] = 'C';
  return env;
}

function runGit(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: gitEnv(env),
  }).then(({ stdout }) => stdout);
}

const SEPARATOR = '\x00';

/**
 * List all local branches, remote branches, tags, and recent branches for
 * the repository at `cwd`. Uses `git for-each-ref` for structured output and
 * `git reflog` for recency.
 */
export async function fetchGitBranches(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitBranchesResult> {
  // Defining probe: fail fast with a clear error when `cwd` is not inside a
  // git repository, instead of letting every individual query swallow its
  // error and returning an empty-but-"available" result.
  await runGit(cwd, ['rev-parse', '--git-dir'], env);

  const [localRaw, remoteRaw, tagsRaw, headRaw, reflogRaw] = await Promise.all([
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)',
        'refs/heads/',
      ],
      env,
    ).catch(() => ''),
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)',
        'refs/remotes/',
      ],
      env,
    ).catch(() => ''),
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(creatordate:unix)%00%(subject)',
        '--sort=-creatordate',
        'refs/tags/',
      ],
      env,
    ).catch(() => ''),
    readHeadBranchName(cwd, env),
    runGit(
      cwd,
      ['reflog', 'show', '--format=%gs', `-${MAX_REFLOG_ENTRIES}`],
      env,
    ).catch(() => ''),
  ]);

  const local = parseBranchLines(localRaw);
  const remote = parseBranchLines(remoteRaw);
  const tags = parseTagLines(tagsRaw);
  const recent = parseRecentBranches(reflogRaw, headRaw.trim());

  const headTrimmed = headRaw.trim();
  const detached = !headTrimmed;

  return {
    local,
    remote,
    tags,
    recent,
    head: headTrimmed || (await getDetachedHead(cwd, env)),
    detached,
  };
}

function parseBranchLines(raw: string): GitBranchInfo[] {
  if (!raw.trim()) return [];
  return (
    raw
      .trim()
      .split('\n')
      .filter(Boolean)
      // Filter symbolic refs (e.g. origin/HEAD → origin/main) by their symref
      // target rather than by a /HEAD name suffix, which would also remove
      // legitimate user branches like feature/HEAD.
      .filter((line) => {
        const parts = line.split(SEPARATOR);
        return !(parts[6] ?? '');
      })
      .map((line) => {
        const parts = line.split(SEPARATOR);
        const name = parts[0] ?? '';
        const isHead = parts[1] === '*';
        const upstream = parts[2] || undefined;
        const track = parts[3] ?? '';
        const commitDate = parseInt(parts[4] ?? '0', 10) || 0;
        const commitSubject = parts[5] ?? '';

        let ahead = 0;
        let behind = 0;
        const aheadMatch = /ahead (\d+)/.exec(track);
        const behindMatch = /behind (\d+)/.exec(track);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);
        // `%(upstream:track,nobracket)` prints `gone` when the upstream is
        // configured but its ref is missing; ahead/behind are meaningless then.
        const upstreamGone = upstream !== undefined && /\bgone\b/.test(track);

        return {
          name,
          isHead,
          upstream,
          ...(upstreamGone ? { upstreamGone } : {}),
          ahead,
          behind,
          commitDate,
          commitSubject,
        };
      })
  );
}

function parseTagLines(raw: string): GitTagInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEPARATOR);
      return {
        name: parts[0] ?? '',
        date: parseInt(parts[1] ?? '0', 10) || 0,
        subject: parts[2] ?? '',
      };
    });
}

function parseRecentBranches(reflogRaw: string, currentHead: string): string[] {
  if (!reflogRaw.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of reflogRaw.trim().split('\n')) {
    // reflog messages for checkouts look like:
    //   "checkout: moving from X to Y"
    if (!line.startsWith('checkout: moving from ')) continue;
    const idx = line.indexOf(' to ');
    if (idx === -1) continue;
    const branch = line.slice(idx + 4);
    if (
      branch &&
      !seen.has(branch) &&
      branch !== currentHead &&
      !/^[0-9a-f]{7,40}$/.test(branch)
    ) {
      seen.add(branch);
      result.push(branch);
      if (result.length >= MAX_RECENT_BRANCHES) break;
    }
  }
  return result;
}

async function getDetachedHead(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env);
    return sha.trim();
  } catch {
    return '';
  }
}

/**
 * The branch HEAD points at, or '' when detached. Reads the full symbolic
 * ref and strips the prefix: unlike `symbolic-ref --short`, which shortens
 * to the shortest unambiguous name and reports `heads/<branch>` when a tag
 * of the same name exists, the full form always yields the real branch
 * name. Every checkout-internal decision (landing checks, rollback
 * targets, reported results) must use this form, or a colliding-ref repo
 * resolves the wrong ref.
 */
async function readHeadBranchName(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const raw = (
    await runGit(cwd, ['symbolic-ref', '--quiet', 'HEAD'], env).catch(() => '')
  ).trim();
  return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
}

/**
 * The attached branch HEAD points at, tri-state for landing verification:
 * '' means detached, a read failure THROWS. `readHeadBranchName` swallows
 * failures into the same '' as a detached HEAD, which `checkoutLanded`
 * cannot distinguish — a swallowed transient failure there could flip a
 * landed switch into a rollback. `branch --show-current` exits zero with
 * empty output on a detached HEAD and reports the full branch name without
 * the colliding-ref lengthening `--abbrev-ref` applies.
 */
async function readCurrentBranchName(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return (await runGit(cwd, ['branch', '--show-current'], env)).trim();
}

/**
 * The number of entries in HEAD's reflog, or 0 when it cannot be read
 * (unborn HEAD, reflogging disabled). Snapshotted before a checkout step:
 * entries added afterwards belong to the step and any hooks it ran — the
 * per-repository checkout serialization holds across snapshot, step, and
 * hooks, so no other daemon checkout can interleave — and they are the
 * evidence of the step's moves even when a hook moves HEAD away again.
 */
async function headReflogCount(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const out = (
    await runGit(cwd, ['rev-list', '--count', '-g', 'HEAD'], env).catch(
      () => '',
    )
  ).trim();
  const count = parseInt(out, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Whether `value` is safe to pass to git as a checkout target or branch start
 * point: a plausible ref name (branch, tag, or short/full SHA) that cannot be
 * mistaken for a git option (`-f`, `--patch`, `--output=…`) or a pathspec (`.`)
 * that `git checkout` would act on destructively.
 */
export function isValidCheckoutRef(value: string): boolean {
  const ref = value.trim();
  if (!ref || ref.startsWith('-')) return false;
  // 'HEAD' is a valid checkout target/start point even though
  // isValidRefName rejects it as a branch name.
  if (ref === 'HEAD') return true;
  return isValidRefName(ref) || isValidGitSha(ref);
}

export interface GitCheckoutResult {
  branch: string;
  detached: boolean;
}

interface CheckoutLanding {
  /** Branch HEAD should be on after the switch (branch/DWIM targets). */
  branch?: string;
  /** Ref whose commit HEAD should point at (branch, tag, or SHA targets). */
  commitRef?: string;
}

interface CheckoutOriginal {
  /** Branch HEAD was on before the step ('' when detached). */
  ref: string;
  /** Commit HEAD pointed at before the step ('' when attached). */
  commit: string;
  /** HEAD was unborn before the step (no commit resolved). */
  unborn: boolean;
  /** HEAD's reflog length before the step (see headReflogCount). */
  reflogCount: number;
}

// Checkouts are serialized per REPOSITORY, not per request cwd: git
// operations from any workspace-contained subdirectory act on the same HEAD
// and reflog, so keying the queue on the raw cwd would run two spellings of
// one repository (root vs subdirectory, or a symlinked path) in parallel.
// The reflog attribution below cannot tell this step's entries apart from a
// CONCURRENT same-target checkout's, so without one queue per repository a
// failed step could pass its movement proof on the other step's entry and
// its rollback would undo a concurrent successful switch.
const checkoutSerializers = new Map<string, Promise<void>>();

/**
 * The queue key for a checkout from `cwd`: the repository root, so every cwd
 * spelling that acts on the same repository shares one queue. Resolves
 * symlinks first so aliased spellings of the same path converge too. A path
 * that is not inside a repository (the checkout will fail with a clearer
 * error) or cannot be resolved keys on its raw spelling.
 */
function checkoutSerializerKey(cwd: string): string {
  let start = cwd;
  try {
    start = realpathSync(cwd);
  } catch {
    // Leave `start` on the raw spelling; the fallback below keys on it.
  }
  return findGitRoot(start) ?? start;
}

function serializeCheckout<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const key = checkoutSerializerKey(cwd);
  const previous = checkoutSerializers.get(key) ?? Promise.resolve();
  const result = previous.then(work);
  const settled: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  checkoutSerializers.set(key, settled);
  void settled.then(() => {
    if (checkoutSerializers.get(key) === settled) {
      checkoutSerializers.delete(key);
    }
  });
  return result;
}

/**
 * Run one `git checkout` step, absorbing a failing post-checkout hook: git
 * runs that hook AFTER HEAD has moved and exits non-zero when it fails, even
 * though the switch itself completed. Verify where HEAD landed instead of
 * trusting the exit code: on the expected target the step is treated as
 * successful so callers report (and refresh) the real state; anywhere else
 * roll back to the captured original HEAD and rethrow, so a failed checkout
 * never leaves the workspace half-moved. When the landing verification
 * itself cannot run (a transient read failure), neither outcome is provable:
 * absorb nothing and roll nothing back, so a read failure can never convert
 * a landed switch into a rollback.
 */
async function runCheckoutStep(
  cwd: string,
  args: string[],
  landing: CheckoutLanding,
  original: CheckoutOriginal,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  try {
    await runGit(cwd, args, env);
    return;
  } catch (err) {
    let landed: boolean;
    try {
      landed = await checkoutLanded(cwd, landing, original, env);
    } catch {
      throw err;
    }
    if (landed) return;
    // Roll back only when HEAD's reflog records this step's checkout among
    // the entries added since the pre-step snapshot — the evidence that the
    // step moved HEAD before failing. Without that proof a merely refused
    // checkout would restore its stale snapshot over a concurrent checkout
    // that legitimately landed HEAD elsewhere in the meantime, undoing a
    // successful switch.
    if (await checkoutMovedHead(cwd, landing, original, env)) {
      if (original.ref) {
        await runGit(cwd, ['checkout', original.ref, '--'], env).catch(
          (rollbackErr) => {
            // A refused restore leaves the workspace half-moved against the
            // captured original; surface it instead of failing silently.
            // eslint-disable-next-line no-console
            console.error('git checkout rollback failed:', rollbackErr);
          },
        );
      } else if (original.commit) {
        await runGit(
          cwd,
          ['checkout', '--detach', original.commit, '--'],
          env,
        ).catch((rollbackErr) => {
          // eslint-disable-next-line no-console
          console.error('git checkout rollback failed:', rollbackErr);
        });
      }
    }
    throw err;
  }
}

/**
 * Whether HEAD's reflog records this step's checkout as a move to
 * `landing`. Matches among the entries added after the pre-step snapshot
 * count, not just the newest one: a failing post-checkout hook can run its
 * own `git checkout`, moving HEAD again and leaving ITS entry newest — a
 * newest-only scan would miss the step's entry, which is still present, and
 * away. The per-repository checkout serialization covers the snapshot, the
 * step, and its hooks, so every post-snapshot entry belongs to them. Hook
 * entries of another shape (empty-message `symbolic-ref`, `update-ref -m`)
 * do not match the checkout form. With reflogging disabled there is no
 * evidence the step moved HEAD, so this stays `false`.
 */
async function checkoutMovedHead(
  cwd: string,
  landing: CheckoutLanding,
  original: CheckoutOriginal,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (!landing.branch) return false;
  const fresh = (await headReflogCount(cwd, env)) - original.reflogCount;
  if (fresh <= 0) return false;
  const out = await runGit(
    cwd,
    ['reflog', '--format=%gs', `-${fresh}`, 'HEAD'],
    env,
  ).catch(() => '');
  const suffix = ` to ${landing.branch}`;
  for (const line of out.split('\n')) {
    if (line.startsWith('checkout: moving from ') && line.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * The commit `landing` points at, or '' when the landing expects a local
 * branch that does not exist yet the bare ref still resolves (tag/SHA
 * targets fall through to the bare `commitRef`). The final resolution THROWS
 * on a git failure: `checkoutLanded` must not mistake a transient read
 * failure for "the target does not resolve", which would report a landed
 * detached switch as not landed and roll it back.
 */
async function resolveLandingCommit(
  cwd: string,
  landing: CheckoutLanding,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  // `git checkout <name>` resolves a colliding name to the LOCAL BRANCH, but
  // a bare `rev-parse` prefers refs/tags/: resolve through refs/heads/ first
  // when the landing expects a branch, so the landing check compares against
  // the same target the switch used. A miss here is expected (tag/SHA
  // landings carry no refs/heads/ entry), so it falls through instead of
  // failing the verification.
  if (landing.branch) {
    const viaHeads = (
      await runGit(
        cwd,
        [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `refs/heads/${landing.branch}^{commit}`,
        ],
        env,
      ).catch(() => '')
    ).trim();
    if (viaHeads) return viaHeads;
  }
  if (!landing.commitRef) return '';
  return (
    await runGit(
      cwd,
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${landing.commitRef}^{commit}`,
      ],
      env,
    )
  ).trim();
}

async function checkoutLanded(
  cwd: string,
  landing: CheckoutLanding,
  original: CheckoutOriginal,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  // Every read here is tri-state: a transient git failure THROWS, and
  // `runCheckoutStep` treats the throw as "landing unproven" — no absorb and
  // no rollback. '' is a real state in this comparison (detached/unborn), so
  // a read failure swallowed into '' is indistinguishable from it, and
  // concluding "not landed" from a failed read would roll back a switch that
  // actually landed.
  const [nowBranchRaw, nowCommitRaw, targetCommitRaw] = await Promise.all([
    readCurrentBranchName(cwd, env),
    runGit(cwd, ['rev-parse', 'HEAD'], env),
    resolveLandingCommit(cwd, landing, env),
  ]);
  const nowCommit = nowCommitRaw.trim();
  // Equality with the pre-step branch proves nothing for a born HEAD — it
  // already held before the step ran, so absorbing the equality would report
  // a refused switch as a success. An unborn HEAD is the exception: the
  // equality gains meaning only when the step borned HEAD (a commit now
  // resolves) — a fatally refused checkout leaves it unborn, so the
  // unborn→born move is the proof the switch happened.
  if (landing.branch && nowBranchRaw.trim() === landing.branch) {
    return (
      original.ref !== landing.branch || (original.unborn && nowCommit !== '')
    );
  }
  // Commit equality only proves HEAD sits on the target commit, not that the
  // requested switch happened. That is sufficient for detached landings
  // (tag/SHA targets expect no branch); while HEAD is still attached to a
  // branch the same equality held before the step ran, so absorbing it would
  // report a refused switch as a success. The same holds when HEAD was
  // ALREADY detached at the target commit before the step: a refused
  // checkout leaves that exact state behind, so the pre-step snapshot must
  // not match the target either.
  if (nowBranchRaw.trim() !== '') return false;
  const targetCommit = targetCommitRaw.trim();
  if (targetCommit === '' || nowCommit !== targetCommit) return false;
  return original.commit === '' || original.commit !== targetCommit;
}

/**
 * Checkout a branch, tag, or revision. Returns the resulting HEAD state.
 * Throws on dirty tree or invalid ref. Serialized per repository so
 * concurrent checkouts acting on the same HEAD — from any cwd spelling
 * inside it — cannot cross-contaminate each other's snapshot/landing/
 * rollback window.
 */
export function gitCheckout(
  cwd: string,
  ref: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  return serializeCheckout(cwd, () => performCheckout(cwd, ref, env));
}

async function performCheckout(
  cwd: string,
  ref: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  if (!isValidCheckoutRef(ref)) {
    throw new Error(`invalid checkout ref: ${ref}`);
  }
  // Fully qualified refs (what the Web Shell pickers submit) name the exact
  // namespace of the row the user selected; a bare `git checkout <name>`
  // re-resolves the short name and can land on a colliding ref instead.
  // Normalize each namespace to the form the disambiguation below handles
  // explicitly. `refs/tags/` stays qualified: git resolves it unambiguously
  // and detaches, which is the tag semantic.
  let headsQualified = false;
  if (ref.startsWith('refs/heads/')) {
    ref = ref.slice('refs/heads/'.length);
    headsQualified = true;
  } else if (ref.startsWith('refs/remotes/')) {
    ref = ref.slice('refs/remotes/'.length);
  }
  if (!isValidCheckoutRef(ref)) {
    throw new Error(`invalid checkout ref: ${ref}`);
  }
  // Snapshot HEAD before switching: `runCheckoutStep` needs it both to
  // verify a hook-failed landing and to roll back a genuinely failed one.
  const originalRef = await readHeadBranchName(cwd, env);
  // Probed unconditionally: the unborn flag needs it even when attached (see
  // checkoutLanded) — on an unborn HEAD branch equality alone cannot tell a
  // refused checkout from a landed one.
  const originalCommit = (
    await runGit(cwd, ['rev-parse', 'HEAD'], env).catch(() => '')
  ).trim();
  const original: CheckoutOriginal = {
    ref: originalRef,
    commit: originalRef ? '' : originalCommit,
    unborn: originalCommit === '',
    reflogCount: await headReflogCount(cwd, env),
  };
  // A remote-tracking ref (remote/branch) needs more than a bare
  // `git checkout <branch>`: with two remotes carrying the same branch name
  // the bare name is ambiguous ("matched multiple remote tracking branches"),
  // and checking out the remote ref directly detaches HEAD. When no local
  // branch of that name exists yet, create one tracking the exact remote ref
  // so a fork layout (origin + upstream) lands on the clicked commit.
  // Skip the probe when the input named refs/heads/ explicitly: a local
  // branch whose slashed name mirrors a remote-tracking ref (a legal ref,
  // listable in the pickers) must resolve as that local branch, not be
  // rerouted down the tracking-checkout path of the mirror name.
  const isRemoteTracking =
    !headsQualified &&
    (await runGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`],
      env,
    )
      .then(() => true)
      .catch(() => false));
  if (isRemoteTracking) {
    const localName = ref.slice(ref.indexOf('/') + 1);
    if (!isValidCheckoutRef(localName)) {
      throw new Error(
        `invalid local branch name derived from remote ref: ${localName}`,
      );
    }
    const hasLocal = await runGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${localName}`],
      env,
    )
      .then(() => true)
      .catch(() => false);
    if (hasLocal) {
      await runCheckoutStep(
        cwd,
        ['checkout', localName, '--'],
        { branch: localName, commitRef: localName },
        original,
        env,
      );
    } else {
      // `--track` forces commit-ish interpretation of the verified
      // remote-tracking ref, so no pathspec terminator is needed.
      await runCheckoutStep(
        cwd,
        ['checkout', '--track', ref],
        { branch: localName, commitRef: ref },
        original,
        env,
      );
    }
    const head = await readHeadBranchName(cwd, env);
    if (head) {
      return { branch: head, detached: false };
    }
    // An absorbed hook failure can leave HEAD detached on the target commit
    // (the bare path's fall-through covers the same state); report the real
    // landing instead of a malformed `{ branch: '', detached: false }`.
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env);
    return { branch: sha.trim(), detached: true };
  }
  if (headsQualified) {
    // The picker row named refs/heads/: if the branch vanished since the
    // list was fetched, reject — the bare checkout below would DWIM onto a
    // same-named tag and silently detach HEAD.
    const exists = await runGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`],
      env,
    )
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error(`branch not found: ${ref}`);
    }
  }
  // `--` terminates options/pathspecs so a validated ref can never be
  // reinterpreted as a path (e.g. `.` wiping the working tree).
  await runCheckoutStep(
    cwd,
    ['checkout', ref, '--'],
    { branch: ref, commitRef: ref },
    original,
    env,
  );
  const head = await readHeadBranchName(cwd, env);
  if (head) {
    return { branch: head, detached: false };
  }
  const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env);
  return { branch: sha.trim(), detached: true };
}

/**
 * Create a new branch and check it out. Throws if the branch already exists
 * or the working tree is dirty. Shares the per-repository checkout
 * serialization so a concurrent checkout cannot land between the snapshot
 * and the rollback.
 */
export function gitCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  return serializeCheckout(cwd, () =>
    performCreateBranch(cwd, name, startPoint, env),
  );
}

async function performCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  if (!isValidRefName(name) || name.startsWith('-')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  const args = ['checkout', '-b', name];
  if (startPoint) {
    if (!isValidCheckoutRef(startPoint)) {
      throw new Error(`invalid start point: ${startPoint}`);
    }
    args.push(startPoint);
  }
  args.push('--');
  // `git checkout -b` creates the ref and switches HEAD before running the
  // post-checkout hook. If that hook fails the call throws even though the
  // workspace is already on the new branch; capture the previous HEAD so we
  // can roll the half-created branch back instead of leaving it in place.
  const originalRef = await readHeadBranchName(cwd, env);
  const originalCommit = originalRef
    ? ''
    : (await runGit(cwd, ['rev-parse', 'HEAD'], env).catch(() => '')).trim();
  try {
    await runGit(cwd, args, env);
  } catch (err) {
    const nowOn = await readHeadBranchName(cwd, env);
    if (nowOn === name) {
      if (originalRef) {
        await runGit(cwd, ['checkout', originalRef, '--'], env).catch(() => {});
      } else if (originalCommit) {
        await runGit(
          cwd,
          ['checkout', '--detach', originalCommit, '--'],
          env,
        ).catch(() => {});
      }
      await runGit(cwd, ['branch', '-D', name], env).catch(() => {});
    }
    throw err;
  }
  return { branch: name, detached: false };
}

export interface GitPushResult {
  success: boolean;
  output: string;
}

/**
 * Push the current branch. When `setUpstream` is requested and the branch
 * already has an upstream, a plain `git push` is used so the configured
 * remote is preserved. Only when no upstream exists does it fall back to
 * `--set-upstream <remote> <branch>`, resolving the push remote with Git's
 * precedence (branch.<name>.pushRemote, remote.pushDefault,
 * branch.<name>.remote, sole remote, then origin).
 */
export async function gitPush(
  cwd: string,
  opts?: { setUpstream?: boolean; force?: boolean },
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPushResult> {
  const args = ['push'];
  if (opts?.force) args.push('--force-with-lease');
  if (opts?.setUpstream) {
    let branch: string;
    try {
      branch = (await runGit(cwd, ['symbolic-ref', 'HEAD'], env)).trim();
    } catch {
      throw new Error(
        'cannot push with --set-upstream in detached HEAD state; check out a branch first',
      );
    }
    branch = branch.replace(/^refs\/heads\//, '');
    // If the branch already tracks an upstream, push without rewriting it.
    const hasUpstream = await runGit(
      cwd,
      ['rev-parse', '--abbrev-ref', `${branch}@{u}`],
      env,
    ).catch(() => '');
    if (hasUpstream.trim()) {
      const output = await runGit(cwd, args, env);
      return { success: true, output: output.trim() };
    }
    // No upstream — resolve the push remote using Git's precedence:
    // branch.<name>.pushRemote, then remote.pushDefault, then the branch's
    // pull remote, then the sole configured remote, then `origin`. Pushing
    // with the pull remote when a push remote is configured would publish to
    // the wrong repository (e.g. the shared upstream instead of a fork).
    let remote = (
      await runGit(cwd, ['config', `branch.${branch}.pushRemote`], env).catch(
        () => '',
      )
    ).trim();
    if (!remote) {
      remote = (
        await runGit(cwd, ['config', 'remote.pushDefault'], env).catch(() => '')
      ).trim();
    }
    if (!remote) {
      remote = (
        await runGit(cwd, ['config', `branch.${branch}.remote`], env).catch(
          () => '',
        )
      ).trim();
    }
    if (!remote) {
      const remotes = (
        await runGit(cwd, ['remote'], env).catch(() => '')
      ).trim();
      const remoteList = remotes ? remotes.split('\n') : [];
      remote = remoteList.length === 1 ? (remoteList[0] ?? 'origin') : 'origin';
    }
    args.push('--set-upstream', remote, branch);
  }
  const output = await runGit(cwd, args, env);
  return { success: true, output: output.trim() };
}

export interface GitPullResult {
  success: boolean;
  output: string;
}

/**
 * Pull (fetch + merge) or fetch-only from the remote.
 */
export async function gitPull(
  cwd: string,
  opts?: { rebase?: boolean; fetchOnly?: boolean },
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  if (opts?.fetchOnly) {
    const output = await runGit(cwd, ['fetch', '--all', '--prune'], env);
    return { success: true, output: output.trim() };
  }
  const args = ['pull'];
  if (opts?.rebase) args.push('--rebase');
  const output = await runGit(cwd, args, env);
  return { success: true, output: output.trim() };
}

export interface GitCommitResult {
  sha: string;
  subject: string;
}

/**
 * Commit changes. With `all: true`, stages every change in the working tree
 * (including untracked files) via `git add -A` before committing, so the
 * commit matches what the UI displays.
 */
export async function gitCommit(
  cwd: string,
  message: string,
  opts?: { all?: boolean },
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCommitResult> {
  // Snapshot the index before `git add -A` so a failed commit (e.g. a
  // rejecting pre-commit hook) can restore the user's original staging
  // instead of leaving the whole working tree staged.
  let savedIndex: string | null = null;
  if (opts?.all) {
    const tree = (
      await runGit(cwd, ['write-tree'], env).catch(() => '')
    ).trim();
    if (tree) {
      savedIndex = tree;
    } else {
      // write-tree fails on an unmerged index; add -A would destroy the
      // conflict state with no way to roll back.
      const unmerged = (
        await runGit(cwd, ['ls-files', '--unmerged'], env)
      ).trim();
      if (unmerged) {
        throw new Error(
          'cannot stage all changes: unresolved merge conflicts in the index',
        );
      }
      throw new Error(
        'cannot stage all changes: failed to snapshot index (write-tree failed)',
      );
    }
  }
  try {
    if (opts?.all) {
      await runGit(cwd, ['add', '-A'], env);
    }
    await runGit(cwd, ['commit', '-m', message], env);
  } catch (err) {
    if (savedIndex) {
      await runGit(cwd, ['read-tree', savedIndex], env).catch((rollbackErr) => {
        // A failed rollback leaves the whole `add -A` result staged; surface
        // it so the stale index can be diagnosed instead of failing silently.
        // eslint-disable-next-line no-console
        console.error('git index rollback failed:', rollbackErr);
      });
    }
    throw err;
  }
  const sha = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env)).trim();
  const subject = (await runGit(cwd, ['log', '-1', '--format=%s'], env)).trim();
  return { sha, subject };
}
