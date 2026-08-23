/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  SESSION_PR_LIST_LIMIT,
  fetchGitHubPullRequests,
  readSessionPrs,
  readWorktreeSession,
  upsertSessionPr,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

// `--worktree=#<N>` launches persist slug `pr-<N>` with branch
// `worktree-pr-<N>` (see worktreeStartup / worktreeBranchForSlug); the
// sidecars survive restarts, so they are the zero-network backfill source.
const SLUG_PR_PATTERN = /^pr-(\d{1,9})$/;
const BRANCH_PR_PATTERN = /^worktree-pr-(\d{1,9})$/;

/**
 * Extracts the PR number a worktree sidecar's slug/branch convention names.
 * The slug wins: a custom-renamed branch under a `pr-<N>` slug still refers
 * to PR N, while a custom slug keeps a conventional branch matchable.
 */
export function parsePrNumberFromWorktree(
  slug?: string,
  branch?: string,
): number | undefined {
  const slugMatch = SLUG_PR_PATTERN.exec(slug ?? '');
  if (slugMatch) {
    const number = Number(slugMatch[1]);
    // `pr-0` is a legal user slug, but 0 is not a PR number — binding it
    // would invalidate the whole sidecar (isValidSessionPr rejects it).
    return number > 0 ? number : undefined;
  }
  const branchMatch = BRANCH_PR_PATTERN.exec(branch ?? '');
  if (branchMatch) {
    const number = Number(branchMatch[1]);
    return number > 0 ? number : undefined;
  }
  return undefined;
}

/**
 * Converts a git remote URL (https / ssh / scp-style) to the repository's
 * web URL, used to build `<repo>/pull/<N>` when `gh` is unavailable.
 */
export function normalizeRemoteToWebUrl(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;
  let input = trimmed;
  if (input.startsWith('git@')) {
    input = `https://${input.slice('git@'.length).replace(':', '/')}`;
  } else if (input.startsWith('ssh://')) {
    input = `https://${input.slice('ssh://'.length)}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const pathname = url.pathname.replace(/\.git\/?$/, '');
  if (!pathname || pathname === '/') return undefined;
  return `${url.protocol}//${url.host}${pathname}`.replace(/\/$/, '');
}

function getRemoteWebUrl(cwd: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return normalizeRemoteToWebUrl(remote);
  } catch {
    return undefined;
  }
}

export interface SessionPrBackfillWorkspaceResult {
  workspaceCwd: string;
  /** Persisted sessions scanned (active + archived). */
  scanned: number;
  /** New PR bindings written by this run (a session may bind several). */
  bound: number;
  /** Resolved bindings that already existed in the sidecar. */
  alreadyBound: number;
  /** Resolved numbers skipped because they exceed the sidecar cap. */
  overLimit: number;
  /** Convention numbers whose URL could not be resolved. */
  unresolved: number;
  /** Sidecar writes that failed; the affected session keeps its bindings. */
  writeErrors?: number;
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /** Worktree branch plus every `gitBranch` seen in the transcript. */
  branches: readonly string[];
}

// Transcript records carry the branch the session was on; the set is small
// per session and only ever compared against PR head branches.
const GIT_BRANCH_PATTERN = /"gitBranch":"([^"]+)"/g;
const MAX_DISTINCT_BRANCHES = 64;

async function collectTranscriptBranches(
  filePath: string,
): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const branches = new Set<string>();
  for (const match of raw.matchAll(GIT_BRANCH_PATTERN)) {
    branches.add(match[1]);
    if (branches.size >= MAX_DISTINCT_BRANCHES) break;
  }
  return [...branches];
}

/**
 * Backfills PR bindings onto a workspace's persisted sessions. Sources, in
 * priority order: the worktree slug/branch convention (names the number
 * without any network); and one batched `gh pr list --state all` per
 * workspace mapping head branches — the worktree branch and every
 * `gitBranch` recorded in the session's transcript — to PR numbers and URLs.
 * The URL comes from `gh` when available, else from the git remote web URL
 * (convention numbers only). A session may bind several PRs.
 */
export async function backfillWorkspaceSessionPrs(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
): Promise<SessionPrBackfillWorkspaceResult> {
  const result: SessionPrBackfillWorkspaceResult = {
    workspaceCwd: runtime.workspaceCwd,
    scanned: 0,
    bound: 0,
    alreadyBound: 0,
    overLimit: 0,
    unresolved: 0,
  };
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const candidates: BackfillCandidate[] = [];
  for (const archiveState of ['active', 'archived'] as const) {
    let cursor: number | undefined;
    do {
      const page = await sessionService.listSessions({
        cursor,
        size: 1000,
        archiveState,
      });
      for (const item of page.items) {
        result.scanned += 1;
        const dir = path.dirname(
          sessionService.getWorktreeSessionPathForArchiveState(
            item.sessionId,
            archiveState,
          ),
        );
        let worktree: Awaited<ReturnType<typeof readWorktreeSession>>;
        try {
          worktree = await readWorktreeSession(
            path.join(dir, `${item.sessionId}.worktree.json`),
          );
        } catch {
          worktree = null;
        }
        const branches = [
          ...(worktree ? [worktree.worktreeBranch] : []),
          ...(await collectTranscriptBranches(
            path.join(dir, `${item.sessionId}.jsonl`),
          )),
        ];
        const conventionNumber = worktree
          ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
          : undefined;
        if (branches.length === 0 && conventionNumber === undefined) {
          continue;
        }
        candidates.push({
          sessionId: item.sessionId,
          archiveState,
          conventionNumber,
          branches,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  if (candidates.length === 0) return result;

  const numberToUrl = new Map<number, string>();
  const numberToState = new Map<number, 'open' | 'merged' | 'closed'>();
  const branchToNumber = new Map<string, number>();
  const prs = await fetchPullRequests(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
    { state: 'all', limit: 500, slim: true },
  );
  if (prs.kind === 'ok') {
    for (const pr of prs.pullRequests) {
      numberToUrl.set(pr.number, pr.url);
      // The sidecar snapshot has no 'draft' variant — a draft is still open.
      numberToState.set(pr.number, pr.state === 'draft' ? 'open' : pr.state);
      // First-write-wins: the list arrives newest-first (gh's order
      // survives the slim fetch's no-op sort), so the newest PR owns a
      // reused head branch — overwriting would map the branch to the
      // oldest PR instead.
      if (pr.headRefName && !branchToNumber.has(pr.headRefName)) {
        branchToNumber.set(pr.headRefName, pr.number);
      }
    }
  }

  let remoteWebUrl: string | undefined;
  for (const candidate of candidates) {
    let numbers: number[] = [];
    if (candidate.conventionNumber !== undefined) {
      numbers.push(candidate.conventionNumber);
    }
    for (const branch of candidate.branches) {
      const mapped = branchToNumber.get(branch);
      if (mapped !== undefined && !numbers.includes(mapped)) {
        numbers.push(mapped);
      }
    }
    if (numbers.length === 0) continue;
    // Bind only the cap's tail: upsertSessionPr evicts the oldest entries
    // beyond the cap, so binding more would leave the evicted numbers
    // looking unbound — re-bound (with a fresh createdAt) on every run,
    // rotating the list forever instead of converging.
    if (numbers.length > SESSION_PR_LIST_LIMIT) {
      result.overLimit += numbers.length - SESSION_PR_LIST_LIMIT;
      if (candidate.conventionNumber !== undefined) {
        // The pr-<N> slug names the session's own PR — keep it and evict
        // the oldest branch-mapped numbers instead.
        numbers = [
          candidate.conventionNumber,
          ...numbers.slice(1).slice(-(SESSION_PR_LIST_LIMIT - 1)),
        ];
      } else {
        numbers = numbers.slice(-SESSION_PR_LIST_LIMIT);
      }
    }
    const prPath = sessionService.getPrSessionPathForArchiveState(
      candidate.sessionId,
      candidate.archiveState,
    );
    let existing: Awaited<ReturnType<typeof readSessionPrs>>;
    try {
      existing = await readSessionPrs(prPath);
    } catch {
      existing = null;
    }
    const have = new Set(existing?.map((pr) => pr.number));
    for (const number of numbers) {
      if (have.has(number)) {
        result.alreadyBound += 1;
        continue;
      }
      let url = numberToUrl.get(number);
      if (url === undefined && number === candidate.conventionNumber) {
        remoteWebUrl ??= getRemoteWebUrl(runtime.workspaceCwd);
        if (remoteWebUrl !== undefined) url = `${remoteWebUrl}/pull/${number}`;
      }
      if (url === undefined) {
        result.unresolved += 1;
        continue;
      }
      const state = numberToState.get(number);
      try {
        await upsertSessionPr(prPath, {
          number,
          url,
          ...(state ? { state } : {}),
        });
      } catch {
        // One unwritable sidecar must not abort the whole workspace.
        result.writeErrors = (result.writeErrors ?? 0) + 1;
        continue;
      }
      have.add(number);
      result.bound += 1;
    }
  }
  return result;
}

export function registerSessionPrBackfillRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  app.post('/sessions/backfill-prs', deps.mutate(), async (_req, res) => {
    const route = 'POST /sessions/backfill-prs';
    try {
      const workspaces: SessionPrBackfillWorkspaceResult[] = [];
      for (const runtime of deps.workspaceRegistry.listAll()) {
        if (!runtime.trusted) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            alreadyBound: 0,
            overLimit: 0,
            unresolved: 0,
            error: 'untrusted workspace skipped',
          });
          continue;
        }
        try {
          workspaces.push(await backfillWorkspaceSessionPrs(runtime));
        } catch (error) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            alreadyBound: 0,
            overLimit: 0,
            unresolved: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      res.status(200).json({
        v: 1,
        workspaces,
        scanned: workspaces.reduce((sum, w) => sum + w.scanned, 0),
        bound: workspaces.reduce((sum, w) => sum + w.bound, 0),
      });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
