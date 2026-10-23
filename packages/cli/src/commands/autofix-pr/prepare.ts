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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  historyPath,
  readHistory,
  readState,
  repoRoot,
  sameRepository,
  writeState,
  type AutofixPrHistory,
  type AutofixPrState,
} from './state.js';

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
  } catch {
    // Not a collaborator (404), or an account GitHub will not describe.
    return false;
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
      authorCanPush: state.authorCanPush ?? false,
      ...extra,
    }),
  );
}

export interface PrepareArgs {
  pr: number;
  repo: string;
  host?: string;
}

export function runPrepare(args: PrepareArgs): void {
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(`--repo must be <owner>/<repo>, got ${args.repo}`);
  }
  const [owner, repoName] = args.repo.split('/');
  const host = resolveGhHost(args.host) ?? 'github.com';
  const root = repoRoot();
  const paths = autofixPrPaths(root, args.pr);

  const existing = readState(paths.statePath);
  if (existing) {
    assertOwnedBySession(existing);
    // State is keyed by PR number alone, and one clone can reach several
    // repositories with a PR of that number.
    const watched = `${existing.host}/${existing.owner}/${existing.repo}`;
    if (!sameRepository(existing, { host, owner, repo: repoName })) {
      throw new Error(
        `PR #${args.pr} here is a watch of ${watched}, not ${host}/${args.repo}. ` +
          `Run \`qwen autofix-pr cleanup ${args.pr}\` first.`,
      );
    }
    // The recorded path goes stale when the clone moves; this one does not.
    if (existsSync(paths.worktreePath)) {
      report(
        { ...existing, worktreePath: paths.worktreePath },
        { resumed: true },
      );
      return;
    }
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

  const remoteV = git('remote', '-v');
  const remote = onlyRemote(remoteV, owner, repoName, host);
  if (!remote) {
    throw new Error(
      `no single git remote here serves ${host}/${args.repo}; autofix needs a clone of the PR's repository.`,
    );
  }
  const pushTarget = pushTargetFor(remoteV, host, headOwner, headName);

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

  const redirected = redirectedAncestor(dirname(paths.worktreePath), root);
  if (redirected !== null) {
    throw new Error(
      `refusing to create ${paths.worktreePath}: ${redirected} is a symlink.`,
    );
  }
  // Not into submodules: a submodule commit the PR records but no remote
  // has must not fail the PR's own fetch, which would leave the branch
  // behind with no state file to account for it.
  git(
    'fetch',
    '--quiet',
    '--no-recurse-submodules',
    remote,
    `+refs/pull/${args.pr}/head:refs/heads/${paths.branch}`,
  );
  const headSha = git('rev-parse', `refs/heads/${paths.branch}`);
  mkdirSync(dirname(paths.worktreePath), { recursive: true });
  // Submodules stay unpopulated whatever `submodule.recurse` says: a fix
  // that needs one checks it out itself.
  git(
    '-c',
    'submodule.recurse=false',
    'worktree',
    'add',
    '--quiet',
    paths.worktreePath,
    paths.branch,
  );

  let history: AutofixPrHistory | null = null;
  try {
    history = readHistory(historyPath(paths, { host, owner, repo: repoName }));
  } catch {
    // An unreadable history is ignored; cleanup replaces it.
  }
  if (history && !sameRepository(history, { host, owner, repo: repoName })) {
    history = null;
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
    authorCanPush: authorCanPush(args.repo, pr.author?.login ?? '', viewer),
    lastKnownHeadSha: headSha,
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
        }
      : {}),
  };
  writeState(paths.statePath, state);

  // Commits on the user's own copy of the branch that the PR does not have
  // yet: the worktree starts from the PR head and never sees them. Only a
  // local branch tracking the head on the push remote is that copy; a fork's
  // `main` is not the user's `main`.
  const upstream = gitOpt(
    'for-each-ref',
    '--format=%(upstream:short)',
    `refs/heads/${pr.headRefName}`,
  );
  const localUnpushed =
    upstream === `${pushTarget}/${pr.headRefName}`
      ? gitOpt(
          'rev-list',
          '--count',
          `refs/heads/${pr.headRefName}`,
          '--not',
          headSha,
        )
      : null;
  report(state, {
    resumed: false,
    url: pr.url,
    isDraft: pr.isDraft,
    isCrossRepository: pr.isCrossRepository,
    localUnpushedCommits: localUnpushed === null ? 0 : Number(localUnpushed),
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
      }),
  handler: (argv) => {
    const host = (argv as { host?: string }).host;
    setGhHost(host);
    runPrepare({ pr: Number(argv['pr']), repo: String(argv['repo']), host });
  },
};
