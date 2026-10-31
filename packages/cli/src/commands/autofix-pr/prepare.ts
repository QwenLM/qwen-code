/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr prepare`: check that a PR can be watched and fixed from
// here, then give it a pushable worktree and a state file. Re-running it in
// the session that owns the watch reports the existing state, so a watch
// resumes without losing its cursor or work in progress.

import type { CommandModule } from 'yargs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { realpathNearestExisting } from '@qwen-code/qwen-code-core/utils/paths.js';
import { isWithinRoot } from '../../config/path-comparison.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  currentUser,
  ensureAuthenticated,
  gh,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from '../review/lib/gh.js';
import { git, gitOpt, refExists } from '../review/lib/git.js';
import { matchRemotes } from '../review/lib/remote-match.js';
import { redirectedAncestor } from '../review/lib/worktree.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  currentSessionId,
  ghNotFound,
  historyPath,
  isBranchName,
  isCommandSafeName,
  cloneWorktreeRoots,
  findWatchRoot,
  vouchedScanRoots,
  readHistory,
  readState,
  repoRoot,
  watchRoot,
  requireState,
  sameRepository,
  withKnownHead,
  withWatchLock,
  writeAnchor,
  writeState,
  type AutofixPrHistory,
  type AutofixPrState,
} from './state.js';
import { assertNoFixInFlight, clearAbandonedFix } from './fix.js';
import { checkoutHoldsWork, isAncestor, networkGit } from './worktree.js';

export interface PrView {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  headRepository: { name: string } | null;
  headRepositoryOwner: { login: string } | null;
  author: { login: string } | null;
}

export interface RepoView {
  viewerPermission: string | null;
  defaultBranchRef: { name: string } | null;
}

const PR_FIELDS =
  'number,state,url,isDraft,headRefName,headRefOid,baseRefName,' +
  'isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner,author';

const WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/** Why this PR cannot be watched and pushed to by `viewer`, or null. */
export function eligibilityError(
  pr: PrView,
  repo: RepoView,
  viewer: string,
): string | null {
  if (pr.state !== 'OPEN') {
    return `PR #${pr.number} is ${pr.state.toLowerCase()}; autofix needs an open PR.`;
  }
  if (!pr.headRepository || !pr.headRepositoryOwner) {
    return `PR #${pr.number}'s head repository no longer exists.`;
  }
  if (!isBranchName(pr.headRefName)) {
    return `PR #${pr.number}'s head branch ${JSON.stringify(pr.headRefName)} is not a name autofix can hand to git.`;
  }
  // The round's brief has the fix agent merge the base by name.
  if (!isBranchName(pr.baseRefName) || !isCommandSafeName(pr.baseRefName)) {
    return `PR #${pr.number}'s base branch ${JSON.stringify(pr.baseRefName)} cannot be named in a command as it is.`;
  }
  if (!pr.isCrossRepository && pr.headRefName === repo.defaultBranchRef?.name) {
    return `PR #${pr.number}'s head is the default branch (${pr.headRefName}); autofix never pushes there.`;
  }
  const canWrite = WRITE_PERMISSIONS.has(repo.viewerPermission ?? '');
  if (!pr.isCrossRepository) {
    return canWrite
      ? null
      : `${viewer} cannot push to this repository (permission: ${repo.viewerPermission ?? 'none'}).`;
  }
  if (pr.headRepositoryOwner.login === viewer) return null;
  if (canWrite && pr.maintainerCanModify) return null;
  return `${viewer} cannot push to the fork ${pr.headRepositoryOwner.login}/${pr.headRepository.name}: the PR does not allow edits from maintainers.`;
}

export function pushUrl(
  host: string,
  owner: string,
  repo: string,
  protocol: string,
): string {
  if (protocol !== 'ssh') return `https://${host}/${owner}/${repo}.git`;
  // The scp-like form has no port: git would read `host:8443:owner/repo`
  // as host `host` and path `8443:owner/repo`.
  return host.includes(':')
    ? `ssh://git@${host}/${owner}/${repo}.git`
    : `git@${host}:${owner}/${repo}.git`;
}

function onlyRemote(
  remoteV: string,
  owner: string,
  repo: string,
  host: string,
): string | null {
  const { matched } = matchRemotes(remoteV, { owner, repo, host });
  return matched.length === 1 ? matched[0] : null;
}

/**
 * Where pushes to the head repository go: the one local remote that fetches
 * from it, when every URL that remote pushes to names it as well, else the
 * repository's URL. `matchRemotes` reads the fetch side only, and a remote
 * may push elsewhere — through its own `pushurl`, or through a second `url`
 * entry, which git fetches from the first of and pushes to all of. Each
 * effective push URL is judged by the same matcher that chose the remote.
 */
export function pushTargetFor(
  remoteV: string,
  host: string,
  owner: string,
  repo: string,
): string {
  const remote = onlyRemote(remoteV, owner, repo, host);
  if (remote !== null && remotePushesTo(remote, host, owner, repo)) {
    return remote;
  }
  return pushUrl(
    host,
    owner,
    repo,
    gh('config', 'get', 'git_protocol', '-h', host),
  );
}

function remotePushesTo(
  remote: string,
  host: string,
  owner: string,
  repo: string,
): boolean {
  const pushUrls = gitOpt('remote', 'get-url', '--push', '--all', remote);
  if (pushUrls === null) return false;
  const urls = pushUrls
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return (
    urls.length > 0 &&
    urls.every((url) =>
      // The matcher reads `<name>\t<url> (fetch)` lines; one line per push
      // URL asks it the same question about each destination.
      matchRemotes(`${remote}\t${url} (fetch)`, {
        owner,
        repo,
        host,
      }).matched.includes(remote),
    )
  );
}

/**
 * Whether the PR's author could push to the base repository: the user, or
 * someone with write access. Anyone else's PR is never watched: verifying a
 * fix runs its code with the user's credentials in reach (design Section 8).
 */
function authorCanPush(slug: string, author: string, viewer: string): boolean {
  if (!author) return false;
  if (author === viewer) return true;
  try {
    const permission = gh(
      'api',
      `repos/${slug}/collaborators/${encodeURIComponent(author)}/permission`,
      '--jq',
      '.permission',
    );
    return permission === 'admin' || permission === 'write';
  } catch (err) {
    // Not a collaborator: GitHub answers 404. Anything else — a rate
    // limit, the network — says nothing of the author, and must not pass
    // for a no: a resume would end a watch over it.
    if (ghNotFound(err)) return false;
    const text = `${(err as Error).message}\n${String((err as { stderr?: unknown }).stderr ?? '')}`;
    throw new Error(
      `could not ask GitHub whether ${author} can push to ${slug}; try again: ${text.trim().split('\n').at(-1) ?? ''}`,
    );
  }
}

function report(state: AutofixPrState, extra: Record<string, unknown>): void {
  writeStdoutLine(
    JSON.stringify({
      worktreePath: state.worktreePath,
      branch: state.branch,
      headSha: state.lastKnownHeadSha,
      headRefName: state.headRefName,
      baseRefName: state.baseRefName,
      pushTarget: state.pushTarget,
      viewer: state.viewer,
      prAuthor: state.prAuthor,
      sessionId: state.sessionId,
      host: state.host,
      preparedAt: state.preparedAt ?? null,
      authorCanPush: state.authorCanPush ?? false,
      ...extra,
    }),
  );
}

/**
 * What the user's own copy of the watch's head branch holds, as the report
 * says it: commits the PR does not have, uncommitted work in a checkout of
 * that copy, and whether any of it could not be read — never a "no" that
 * only means git could not answer. Only a local branch whose upstream is the
 * head branch on the push remote counts as that copy.
 */
function localCopy(
  state: Pick<
    AutofixPrState,
    'headRefName' | 'pushTarget' | 'lastKnownHeadSha'
  >,
): {
  localUnpushedCommits: number;
  localUncommittedChanges: boolean;
  localWorkUnknown: boolean;
} {
  const upstream = gitOpt(
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${state.headRefName}`,
  );
  if (upstream !== `${state.pushTarget}/${state.headRefName}`) {
    return {
      localUnpushedCommits: 0,
      localUncommittedChanges: false,
      localWorkUnknown: false,
    };
  }
  // A head this clone does not have — pushed from another one — is unreadable
  // here, and a zero would read as "nothing unpushed".
  const unpushed = gitOpt(
    'rev-list',
    '--count',
    `refs/heads/${state.headRefName}`,
    '--not',
    state.lastKnownHeadSha,
  );
  const checkouts = worktreeCheckouts(state.headRefName);
  const work = checkouts?.map(checkoutHoldsWork) ?? null;
  return {
    localUnpushedCommits: unpushed === null ? 0 : Number(unpushed),
    localUncommittedChanges: work?.some((held) => held === true) ?? false,
    localWorkUnknown:
      unpushed === null || work === null || work.some((held) => held === null),
  };
}

/**
 * Paths of this clone's worktrees that have `branch` checked out: the copies
 * the user may be working in, or null when git cannot list them.
 */
function worktreeCheckouts(branch: string): string[] | null {
  // `-z` keeps a path git would otherwise C-quote, which `git -C` then
  // cannot open. Git before 2.36 has no `-z`; the line form still answers,
  // and a path it quotes reads as unknown rather than as no work.
  const z = gitOpt('worktree', 'list', '--porcelain', '-z');
  if (z !== null) return parseWorktrees(z.split('\0'), branch);
  const plain = gitOpt('worktree', 'list', '--porcelain');
  return plain === null ? null : parseWorktrees(plain.split('\n'), branch);
}

/** `git worktree list --porcelain` records, split into fields. */
function parseWorktrees(fields: string[], branch: string): string[] {
  const paths: string[] = [];
  let worktree: string | null = null;
  for (const field of fields) {
    if (field === '') {
      worktree = null;
    } else if (field.startsWith('worktree ')) {
      worktree = field.slice('worktree '.length);
    } else if (worktree !== null && field === `branch refs/heads/${branch}`) {
      paths.push(worktree);
    }
  }
  return paths;
}

/**
 * The clone's remote for the PR's repository and the target its head is
 * pushed to, from `git remote -v` — never from a state file, which the code
 * a round runs can reach.
 */
function remotesFor(
  host: string,
  owner: string,
  repo: string,
  headOwner: string,
  headName: string,
): { remote: string; pushTarget: string } {
  const remoteV = git('remote', '-v');
  const remote = onlyRemote(remoteV, owner, repo, host);
  if (!remote) {
    throw new Error(
      `no single git remote here serves ${host}/${owner}/${repo}; autofix needs a clone of the PR's repository.`,
    );
  }
  // The brief names it in the fix agent's merge command.
  if (!isBranchName(remote) || !isCommandSafeName(remote)) {
    throw new Error(
      `the remote ${JSON.stringify(remote)} cannot be named in a command as it is; rename it (\`git remote rename\`) to watch this PR.`,
    );
  }
  return {
    remote,
    pushTarget: pushTargetFor(remoteV, host, headOwner, headName),
  };
}

export interface PrepareArgs {
  pr: number;
  repo: string;
  host?: string;
  /** Move a watch another session owns to this one (`--take-over`). */
  takeOver?: boolean;
  /** Fix in the user's own checkout of the head branch (`--in-place`). */
  inPlace?: boolean;
}

/**
 * A daemon session runs the fix agent's commands only inside the session's own
 * working directory or a worktree that session owns, so a worktree outside it
 * can be created but never used: no test, no commit, no push. Refuse before a
 * fresh start creates anything, and before a resume reports that same
 * worktree as ready.
 */
function assertSessionCanRunWorktree(root: string, worktreePath: string): void {
  if (process.env['QWEN_CODE_SERVE'] !== '1') return;
  const sessionDir = realpathNearestExisting(process.cwd());
  if (isWithinRoot(realpathNearestExisting(worktreePath), sessionDir)) return;
  throw new Error(
    `${worktreePath} is outside this session's working directory ` +
      `(${sessionDir}): the daemon runs the fix agent's commands only there, ` +
      `so a watch here could never run its checks, commit or push. Prepare the ` +
      `PR from ${root}, where the worktree is inside the session's directory.`,
  );
}

/**
 * Reconcile a PR's history across the clone on a fresh prepare (a new watch or
 * a relocation). Several worktrees may hold a history — one per hop, including
 * the destination's own when a watch returns to a root it left — so the settled
 * lists (handled comments, posted replies, spent checks/reruns) are unioned
 * across every copy: a first-match would import a stale copy and re-answer what
 * a later hop handled, and skipping the destination's copy would lose what a
 * later hop settled on a return. The pending lists (holds, deferred runs,
 * announced posts) are settlement state, not a union: they come from the most
 * recently written copy, and a hold whose floor was already spent is dropped,
 * so a relocation never resurrects a hold a later watch spent (`keepHistory`
 * avoids merging these back for the same reason). Only JSON metadata is read;
 * no git command runs in a discovered worktree.
 */
function reconcileHistory(
  prNumber: number,
  repository: { host: string; owner: string; repo: string },
  local: AutofixPrHistory | null,
  localRoot: string,
): AutofixPrHistory | null {
  const union = (a: string[] = [], b: string[] = []) => [
    ...new Set([...a, ...b]),
  ];
  const copies: Array<{ history: AutofixPrHistory; mtimeMs: number }> = [];
  const consider = (h: AutofixPrHistory | null, path: string) => {
    if (!h || !sameRepository(h, repository)) return;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // An unreadable mtime only loses the recency tie-break.
    }
    copies.push({ history: h, mtimeMs });
  };
  consider(local, historyPath(autofixPrPaths(localRoot, prNumber), repository));
  const exclude = realpathNearestExisting(localRoot);
  for (const root of vouchedScanRoots(cloneWorktreeRoots())) {
    if (realpathNearestExisting(root) === exclude) continue;
    const path = historyPath(autofixPrPaths(root, prNumber), repository);
    let h: AutofixPrHistory | null = null;
    try {
      h = readHistory(path);
    } catch {
      continue;
    }
    consider(h, path);
  }
  if (copies.length === 0) return null;
  let merged: AutofixPrHistory = { ...copies[0]!.history };
  for (const { history } of copies.slice(1)) {
    merged = {
      ...merged,
      handledCommentIds: union(
        merged.handledCommentIds,
        history.handledCommentIds,
      ),
      postedCommentIds: union(
        merged.postedCommentIds,
        history.postedCommentIds,
      ),
      handledChecks: union(merged.handledChecks, history.handledChecks),
      rerunChecks: union(merged.rerunChecks, history.rerunChecks),
    };
  }
  const newest = copies.reduce((a, b) =>
    b.mtimeMs > a.mtimeMs ? b : a,
  ).history;
  const settledFloors = new Set(merged.rerunChecks ?? []);
  return {
    ...merged,
    // The conflict marker is a scalar settlement, not an accumulating list:
    // the most recent copy wins, so a stale main-root marker cannot override a
    // newer linked-root settlement (which would re-fix a conflict already left
    // to a human).
    handledConflictSha: newest.handledConflictSha ?? null,
    heldChecks: (newest.heldChecks ?? []).filter(
      (hold) => !settledFloors.has(hold.replace(/^\d+:/, '')),
    ),
    deferredRuns: newest.deferredRuns ?? [],
    pendingPosts: newest.pendingPosts ?? [],
  };
}

/**
 * `prepare --in-place`: the user's own checkout of the PR head branch is
 * the workspace — no worktree and no branch of the watch's own. Every
 * precondition is checked before anything is written; the checkout is
 * never repaired into shape, and nothing it holds is ever discarded.
 */
function runInPlacePrepare(
  args: PrepareArgs,
  owner: string,
  repoName: string,
  host: string,
): void {
  const prNumber = args.pr;
  // A watch of this PR in either mode is cleaned up first: an in-place
  // start is always fresh (once-shaped), and a mode conversion goes the
  // same way.
  const found = findWatchRoot(prNumber);
  if (found !== null) {
    throw new Error(
      `PR #${prNumber} already has a watch in this clone (${found}); run \`qwen autofix-pr cleanup ${prNumber}\` first.`,
    );
  }
  // The checkout the session sits in.
  const checkout = git('rev-parse', '--show-toplevel');
  const sessionDir = realpathNearestExisting(process.cwd());
  const checkoutReal = realpathNearestExisting(checkout);
  if (process.env['QWEN_CODE_SERVE'] === '1') {
    // The daemon runs the fix agent's commands only inside the session's
    // directory: for a checkout toplevel that means the session root.
    if (!isWithinRoot(checkoutReal, sessionDir)) {
      throw new Error(
        `--in-place needs the session opened at the checkout root (${checkout}): the daemon runs the fix agent's commands only inside the session's working directory (${sessionDir}).`,
      );
    }
  } else if (!isWithinRoot(sessionDir, checkoutReal)) {
    throw new Error(
      `run --in-place from inside the checkout of the PR's head branch (${checkout}).`,
    );
  }

  ensureAuthenticated();
  const pr = JSON.parse(
    gh('pr', 'view', String(prNumber), '-R', args.repo, '--json', PR_FIELDS),
  ) as PrView;
  const repo = JSON.parse(
    gh(
      'repo',
      'view',
      args.repo,
      '--json',
      'viewerPermission,defaultBranchRef',
    ),
  ) as RepoView;
  const viewer = currentUser();
  const refusal = eligibilityError(pr, repo, viewer);
  if (refusal) throw new Error(refusal);
  const canPush = authorCanPush(args.repo, pr.author?.login ?? '', viewer);
  const { remote, pushTarget } = remotesFor(
    host,
    owner,
    repoName,
    pr.headRepositoryOwner!.login,
    pr.headRepository!.name,
  );

  // The head branch is checked out, tracks the push target, and is clean.
  const head = gitOpt('-C', checkout, 'symbolic-ref', '-q', 'HEAD');
  if (head !== `refs/heads/${pr.headRefName}`) {
    throw new Error(
      `--in-place needs the PR's head branch ${pr.headRefName} checked out in ${checkout} (it has ${head ? `branch ${head.replace(/^refs\/heads\//, '')}` : 'a detached HEAD'}); switch to it yourself first.`,
    );
  }
  // The push target must be a named remote: git can only track
  // `<remote>/<branch>`, never a URL, so a URL push target (no remote of
  // this clone serves the head repository) has no representable upstream.
  const remoteNames = (gitOpt('remote') ?? '')
    .split('\n')
    .filter((name) => name !== '');
  if (!remoteNames.includes(pushTarget)) {
    throw new Error(
      `--in-place needs a named git remote whose fetch and push URLs both serve ${pr.headRepositoryOwner!.login}/${pr.headRepository!.name}; add one (git remote add <name> <url>) and set ${pr.headRefName}'s upstream to <name>/${pr.headRefName}.`,
    );
  }
  const upstream = gitOpt(
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${pr.headRefName}`,
  );
  if (upstream !== `${pushTarget}/${pr.headRefName}`) {
    throw new Error(
      `the branch ${pr.headRefName} must track ${pushTarget}/${pr.headRefName} for --in-place (it tracks ${upstream || 'nothing'}); set its upstream first.`,
    );
  }
  const holds = checkoutHoldsWork(checkout);
  if (holds === null) {
    throw new Error(
      `git cannot read ${checkout}; --in-place needs a readable, clean checkout.`,
    );
  }
  if (holds) {
    throw new Error(
      `${checkout} has uncommitted changes; commit or stash them before starting --in-place.`,
    );
  }
  const paths = autofixPrPaths(checkout, prNumber);
  // The PR head, fetched into the watch's private ref without moving any
  // branch; the local tip is at it or behind it — never ahead, never
  // diverged. A behind branch is left for the first round's sync to
  // fast-forward. Not FETCH_HEAD: the user's concurrent fetches (an IDE's
  // autofetch, another terminal) rewrite it in this shared checkout.
  networkGit([
    '-C',
    checkout,
    'fetch',
    '--quiet',
    '--no-recurse-submodules',
    remote,
    `+refs/pull/${prNumber}/head:${paths.headRef}`,
  ]);
  const headSha = git('-C', checkout, 'rev-parse', `${paths.headRef}^{commit}`);
  const localSha = git(
    '-C',
    checkout,
    'rev-parse',
    `refs/heads/${pr.headRefName}`,
  );
  if (localSha !== headSha && !isAncestor(checkout, localSha, headSha)) {
    throw new Error(
      `${pr.headRefName} has commits the PR does not have; reconcile it with the PR head ${headSha.slice(0, 12)} first — an in-place watch never discards or rewrites your commits.`,
    );
  }

  mkdirSync(dirname(paths.lockPath), { recursive: true });
  const state = withWatchLock(paths, prNumber, () => {
    // Another start may have raced the check above.
    if (readState(paths.statePath)) {
      throw new Error(
        `PR #${prNumber} already has a watch in this clone; run \`qwen autofix-pr cleanup ${prNumber}\` first.`,
      );
    }
    let history: AutofixPrHistory | null = null;
    try {
      history = readHistory(
        historyPath(paths, { host, owner, repo: repoName }),
      );
    } catch {
      // An unreadable history is ignored; cleanup replaces it.
    }
    if (history && !sameRepository(history, { host, owner, repo: repoName })) {
      history = null;
    }
    history = reconcileHistory(
      prNumber,
      { host, owner, repo: repoName },
      history,
      checkout,
    );
    const next: AutofixPrState = {
      version: 1,
      sessionId: currentSessionId(),
      host,
      owner,
      repo: repoName,
      prNumber,
      remote,
      pushTarget,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      branch: pr.headRefName,
      worktreePath: checkout,
      inPlace: true,
      viewer,
      prAuthor: pr.author?.login ?? '',
      authorCanPush: canPush,
      lastKnownHeadSha: headSha,
      preparedAt: new Date().toISOString(),
      pushedShas: [],
      handledCommentIds: history?.handledCommentIds ?? [],
      postedCommentIds: history?.postedCommentIds ?? [],
      ...(history
        ? {
            handledChecks: history.handledChecks,
            rerunChecks: history.rerunChecks,
            handledConflictSha: history.handledConflictSha ?? null,
            pendingPosts: history.pendingPosts ?? [],
            deferredRuns: history.deferredRuns ?? [],
            heldChecks: history.heldChecks ?? [],
          }
        : {}),
    };
    writeAnchor({ host, owner, repo: repoName }, prNumber, repoRoot());
    writeState(paths.statePath, next);
    return next;
  });
  report(state, {
    resumed: false,
    inPlace: true,
    url: pr.url,
    isDraft: pr.isDraft,
    isCrossRepository: pr.isCrossRepository,
    ...localCopy(state),
  });
}

export function runPrepare(args: PrepareArgs): void {
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(`--repo must be <owner>/<repo>, got ${args.repo}`);
  }
  const [owner, repoName] = args.repo.split('/');
  const host = resolveGhHost(args.host) ?? 'github.com';
  if (args.inPlace) {
    runInPlacePrepare(args, owner, repoName, host);
    return;
  }
  // Resume the watch wherever the clone holds it; a fresh one roots at the
  // session's own worktree. assertSessionCanRunWorktree below still refuses a
  // resolved worktree outside the session's working directory.
  const root = findWatchRoot(args.pr) ?? watchRoot();
  const paths = autofixPrPaths(root, args.pr);

  // A resume hands back the same worktree, so both refusals come before the
  // state is read: a symlinked parent would put the worktree somewhere else,
  // and a daemon session runs commands only inside its own directory.
  const redirected = redirectedAncestor(dirname(paths.worktreePath), root);
  if (redirected !== null) {
    throw new Error(
      `refusing to prepare ${paths.worktreePath}: ${redirected} is a symlink.`,
    );
  }
  assertSessionCanRunWorktree(root, paths.worktreePath);

  // State is keyed by PR number alone, and one clone can reach several
  // repositories with a PR of that number.
  const sameWatch = (state: AutofixPrState) => {
    if (!sameRepository(state, { host, owner, repo: repoName })) {
      const watched = `${state.host}/${state.owner}/${state.repo}`;
      throw new Error(
        `PR #${args.pr} here is a watch of ${watched}, not ${host}/${args.repo}. ` +
          `Run \`qwen autofix-pr cleanup ${args.pr}\` first.`,
      );
    }
  };
  // An in-place watch is never resumed or converted: cleanup, then a fresh
  // prepare in the mode the user asks for. Checked again under the lock —
  // an in-place start may land during the gh calls above.
  const inPlaceMismatch = `PR #${args.pr} here is an in-place watch (the user's own checkout); run \`qwen autofix-pr cleanup ${args.pr}\` first, then prepare again (with --in-place to keep fixing in your checkout).`;
  let existing = readState(paths.statePath);
  if (existing?.inPlace) {
    throw new Error(inPlaceMismatch);
  }
  let tookOver = false;
  let recreated = false;
  let wasEnded: AutofixPrState['ended'];
  const takesOver = (state: AutofixPrState) =>
    args.takeOver === true && state.sessionId !== currentSessionId();
  if (existing) {
    sameWatch(existing);
    // A fix agent works in the worktree now, for whichever session.
    assertNoFixInFlight(paths, args.pr);
    // The recorded path goes stale when the clone moves; this one does not.
    if (existsSync(paths.worktreePath)) {
      // A /clear or /resume gives the session a new id while its scheduled
      // task goes on: the user hands the watch, history and budgets kept,
      // to the session that asks. The other session's helpers refuse from
      // then on.
      if (!takesOver(existing)) assertOwnedBySession(existing);
      // The state file sits beside the worktree, in reach of the code a
      // round runs: whether the PR's author can push — which decides
      // whether the PR may be watched at all — is asked of GitHub again,
      // not read back from it. Asked first: a failure leaves the watch with
      // the session that has it.
      ensureAuthenticated();
      const live = JSON.parse(
        gh(
          'pr',
          'view',
          String(args.pr),
          '-R',
          args.repo,
          '--json',
          'author,headRepository,headRepositoryOwner,headRefOid',
        ),
      ) as Pick<
        PrView,
        'author' | 'headRepository' | 'headRepositoryOwner' | 'headRefOid'
      >;
      if (!live.headRepository || !live.headRepositoryOwner) {
        throw new Error(
          `PR #${args.pr}'s head repository no longer exists; nothing can be pushed to it.`,
        );
      }
      const canPush = authorCanPush(
        args.repo,
        live.author?.login ?? '',
        currentUser(),
      );
      // So are the remote a round merges from and the push target: this
      // clone must serve the repository the file names.
      const remotes = remotesFor(
        host,
        owner,
        repoName,
        live.headRepositoryOwner.login,
        live.headRepository.name,
      );
      existing = withWatchLock(paths, args.pr, () => {
        const current = requireState(paths.statePath, args.pr);
        if (takesOver(current)) tookOver = true;
        else assertOwnedBySession(current);
        assertNoFixInFlight(paths, args.pr);
        // An attempt whose session left it behind is no longer anyone's.
        if (tookOver) clearAbandonedFix(paths);
        // A start resumes a watch `cleanup` ended keeping its worktree: the
        // user asked for it, and the start's confirmation said what the
        // worktree holds. Read here, under the lock that also clears it.
        wasEnded = current.ended;
        const { ended: _resumed, ...rest } = current;
        const next = {
          ...rest,
          sessionId: currentSessionId(),
          authorCanPush: canPush,
          ...remotes,
        };
        // Re-confirm the anchor from the current cwd; this also re-establishes
        // it under a new main after a clone move (`git worktree repair`).
        writeAnchor(current, current.prNumber, repoRoot());
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          writeState(paths.statePath, next);
        }
        return next;
      });
      report(
        { ...existing, worktreePath: paths.worktreePath },
        {
          resumed: true,
          // Against the PR's head now, not the one the watch last synced:
          // a commit the user has since pushed is not unpushed.
          ...localCopy({ ...existing, lastKnownHeadSha: live.headRefOid }),
          ...(tookOver ? { tookOver } : {}),
          ...(wasEnded ? { wasEnded } : {}),
        },
      );
      return;
    }
    // A removed worktree is made again below, once the PR has been checked:
    // a take-over moves the watch only then, so a refusal leaves it with the
    // session that has it.
    if (!args.takeOver) assertOwnedBySession(existing);
  }

  ensureAuthenticated();
  const pr = JSON.parse(
    gh('pr', 'view', String(args.pr), '-R', args.repo, '--json', PR_FIELDS),
  ) as PrView;
  const repo = JSON.parse(
    gh(
      'repo',
      'view',
      args.repo,
      '--json',
      'viewerPermission,defaultBranchRef',
    ),
  ) as RepoView;
  const viewer = currentUser();
  const refusal = eligibilityError(pr, repo, viewer);
  if (refusal) throw new Error(refusal);
  const headOwner = pr.headRepositoryOwner!.login;
  const headName = pr.headRepository!.name;
  // Asked before anything is fetched or made: a refusal leaves nothing
  // behind.
  const canPush = authorCanPush(args.repo, pr.author?.login ?? '', viewer);

  const { remote, pushTarget } = remotesFor(
    host,
    owner,
    repoName,
    headOwner,
    headName,
  );

  // One start at a time: two sessions starting the same PR would both pass
  // the leftover checks, and the one whose `worktree add` failed would roll
  // back the worktree and branch the other just made.
  mkdirSync(dirname(paths.lockPath), { recursive: true });
  const state = withWatchLock(paths, args.pr, () => {
    // What was read before the lock may have moved since: another session
    // took the watch over, or a helper recorded more. Read it again.
    existing = readState(paths.statePath);
    if (existing?.inPlace) {
      throw new Error(inPlaceMismatch);
    }
    if (existing) {
      sameWatch(existing);
      // The state written below names this session.
      if (takesOver(existing)) tookOver = true;
      else assertOwnedBySession(existing);
      assertNoFixInFlight(paths, args.pr);
      if (tookOver) clearAbandonedFix(paths);
      recreated = true;
      // A watch `stop` ended keeping its worktree, the worktree removed
      // since: the start resumes it all the same, and says so.
      if (existing.ended) wasEnded = existing.ended;
    }
    // Never discard what an earlier watch left: only `cleanup` knows when that
    // is safe. The one exception is a branch whose worktree was removed and
    // that holds nothing beyond the PR head it was cut from.
    const leftover = `Run \`qwen autofix-pr cleanup ${args.pr}\` first.`;
    if (existsSync(paths.worktreePath)) {
      throw new Error(
        `${paths.worktreePath} is left over from an earlier watch. ${leftover}`,
      );
    }
    // A worktree deleted with `rm -rf` stays registered and pins its branch.
    gitOpt('worktree', 'prune');
    if (refExists(`refs/heads/${paths.branch}`)) {
      const ahead = existing
        ? gitOpt(
            'rev-list',
            '--count',
            `refs/heads/${paths.branch}`,
            '--not',
            existing.lastKnownHeadSha,
          )
        : null;
      if (ahead !== '0') {
        throw new Error(
          `branch ${paths.branch} is left over from an earlier watch and may hold unpushed work. ${leftover}`,
        );
      }
      git('branch', '-D', paths.branch);
    }

    // Not into submodules: a submodule commit the PR records but no remote
    // has must not fail the PR's own fetch, which would leave the branch
    // behind with no state file to account for it.
    networkGit([
      'fetch',
      '--quiet',
      '--no-recurse-submodules',
      remote,
      `+refs/pull/${args.pr}/head:refs/heads/${paths.branch}`,
    ]);
    const headSha = git('rev-parse', `refs/heads/${paths.branch}`);
    mkdirSync(dirname(paths.worktreePath), { recursive: true });
    // Submodules stay unpopulated whatever `submodule.recurse` says: a fix
    // that needs one checks it out itself.
    try {
      git(
        '-c',
        'submodule.recurse=false',
        'worktree',
        'add',
        '--quiet',
        paths.worktreePath,
        paths.branch,
      );
    } catch (err) {
      // A post-checkout hook that fails leaves the worktree made: with no
      // state file to account for it, neither a new `prepare` nor `cleanup`
      // could take it away. Nothing was done in it yet.
      gitOpt('worktree', 'remove', '--force', paths.worktreePath);
      gitOpt('worktree', 'prune');
      gitOpt('branch', '-D', paths.branch);
      throw err;
    }

    let history: AutofixPrHistory | null = null;
    try {
      history = readHistory(
        historyPath(paths, { host, owner, repo: repoName }),
      );
    } catch {
      // An unreadable history is ignored; cleanup replaces it.
    }
    if (history && !sameRepository(history, { host, owner, repo: repoName })) {
      history = null;
    }
    // A fresh prepare (a new watch or a relocation) reconciles the PR's history
    // across the clone, including the destination's own copy, so neither a
    // first move nor a return hop forgets what an earlier watch handled or
    // settled. A resume (`existing`) keeps the running watch's state as it is.
    if (!existing) {
      history = reconcileHistory(
        args.pr,
        { host, owner, repo: repoName },
        history,
        root,
      );
    }
    const state: AutofixPrState = {
      version: 1,
      sessionId: currentSessionId(),
      host,
      owner,
      repo: repoName,
      prNumber: args.pr,
      remote,
      pushTarget,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      branch: paths.branch,
      worktreePath: paths.worktreePath,
      viewer,
      prAuthor: pr.author?.login ?? '',
      authorCanPush: canPush,
      lastKnownHeadSha: headSha,
      preparedAt: new Date().toISOString(),
      // A watch whose worktree was removed keeps its history, so it does not
      // answer the same comments again, and keeps its budgets. A new watch of
      // a PR watched before starts from what that one posted and handled.
      pushedShas: existing?.pushedShas ?? [],
      handledCommentIds:
        existing?.handledCommentIds ?? history?.handledCommentIds ?? [],
      postedCommentIds:
        existing?.postedCommentIds ?? history?.postedCommentIds ?? [],
      ...(history && !existing
        ? {
            handledChecks: history.handledChecks,
            rerunChecks: history.rerunChecks,
            handledConflictSha: history.handledConflictSha ?? null,
            pendingPosts: history.pendingPosts ?? [],
            deferredRuns: history.deferredRuns ?? [],
            heldChecks: history.heldChecks ?? [],
          }
        : {}),
      ...(existing
        ? {
            handledChecks: existing.handledChecks,
            rerunChecks: existing.rerunChecks,
            handledConflictSha: existing.handledConflictSha,
            pushCount: existing.pushCount,
            summarizedSha: existing.summarizedSha,
            pendingPosts: existing.pendingPosts,
            deferredRuns: existing.deferredRuns,
            heldChecks: existing.heldChecks,
            failingChecks: existing.failingChecks,
            // The task `resume` starts again, and what is left for a person.
            watch: existing.watch,
            needsHuman: existing.needsHuman,
          }
        : {}),
    };
    // Record the clone this watch is confirmed against, in the anchor store
    // outside the workspace (defense-in-depth; see `anchorStoreRoot`).
    writeAnchor({ host, owner, repo: repoName }, args.pr, repoRoot());
    // A head someone else pushed gives every check its fix pushes back, as
    // `sync` adopting it does.
    const known = withKnownHead(state, headSha);
    writeState(paths.statePath, known);
    return known;
  });

  // Work in the user's own copy of the head branch: the worktree starts from
  // the PR head and never sees it, and the watch's push races the user's.
  report(state, {
    resumed: false,
    // The watch was there and keeps what it recorded: only its worktree is
    // new. A start that is cancelled must not clean it up.
    ...(recreated ? { recreated } : {}),
    ...(wasEnded ? { wasEnded } : {}),
    url: pr.url,
    isDraft: pr.isDraft,
    isCrossRepository: pr.isCrossRepository,
    ...localCopy(state),
    ...(tookOver ? { tookOver } : {}),
  });
}

export const prepareCommand: CommandModule = {
  command: 'prepare <pr>',
  describe:
    'Check that a PR can be watched and pushed to, then create its worktree and state file (re-running resumes an existing watch)',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: 'The PR repository as <owner>/<repo>',
      })
      .option('host', {
        type: 'string',
        describe:
          'GitHub host (omitted: inherit an exported GH_HOST, else github.com)',
      })
      .option('take-over', {
        type: 'boolean',
        default: false,
        describe:
          'Move a watch of this PR that another session owns to this session',
      })
      .option('in-place', {
        type: 'boolean',
        default: false,
        describe:
          "Fix in the user's own checkout of the PR head branch: attended, one round per start, nothing ever discarded",
      }),
  handler: (argv) => {
    const host = (argv as { host?: string }).host;
    setGhHost(host);
    runPrepare({
      pr: Number(argv['pr']),
      repo: String(argv['repo']),
      host,
      takeOver: Boolean(argv['takeOver']),
      inPlace: Boolean(argv['inPlace']),
    });
  },
};
