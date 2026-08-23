/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  readWorktreeSession,
  repoKeyFromWebUrl,
  upsertSessionPr,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { isValidSessionId } from '../../config/session-id.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

// `--worktree=#<N>` launches persist slug `pr-<N>` with branch
// `worktree-pr-<N>` (see worktreeStartup / worktreeBranchForSlug); the
// sidecars survive restarts, so they are the zero-network backfill source.
// `[1-9]` mirrors parsePRReference's n > 0 invariant: `pr-0` is a legal
// user-chosen slug but PR 0 does not exist, and a persisted number 0 poisons
// the whole sidecar read; leading zeros stay out for unambiguous round-trips.
const SLUG_PR_PATTERN = /^pr-([1-9]\d{0,8})$/;
const BRANCH_PR_PATTERN = /^worktree-pr-([1-9]\d{0,8})$/;

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
  if (slugMatch) return Number(slugMatch[1]);
  const branchMatch = BRANCH_PR_PATTERN.exec(branch ?? '');
  if (branchMatch) return Number(branchMatch[1]);
  return undefined;
}

export interface SessionPrBackfillWorkspaceResult {
  workspaceCwd: string;
  /** Persisted sessions scanned (active + archived). */
  scanned: number;
  /** New PR bindings written by this run (a session may bind several). */
  bound: number;
  /** Resolved bindings that already existed in the sidecar. */
  alreadyBound: number;
  /** Convention numbers whose URL could not be resolved. */
  unresolved: number;
  /** Candidates whose sidecar write failed; the run continues past them. */
  failed: number;
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

function collectTranscriptBranches(raw: string): readonly string[] {
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
 *
 * URLs printed in transcripts are NOT a source: text cannot attribute a
 * printed URL to the session's own `gh pr create`, so persisting one would
 * let forged bindings survive retroactively. What gh itself cannot vouch
 * for stays unbound.
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
    unresolved: 0,
    failed: 0,
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
        // `item.sessionId` comes verbatim from the transcript's first
        // record, and every sidecar path below embeds it — a traversal id
        // must be rejected before path construction, the same way the
        // sibling sidecar routes gate.
        if (!isValidSessionId(item.sessionId)) continue;
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
        let transcriptRaw: string;
        try {
          transcriptRaw = await fs.readFile(
            path.join(dir, `${item.sessionId}.jsonl`),
            'utf8',
          );
        } catch {
          transcriptRaw = '';
        }
        const branches = [
          ...(worktree ? [worktree.worktreeBranch] : []),
          ...collectTranscriptBranches(transcriptRaw),
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

  // One remote lookup per backfill run; async so the daemon event loop is
  // never blocked by it.
  const remote = await fetchRemoteWebUrl(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const workspaceRepoKey = remote ? repoKeyFromWebUrl(remote) : undefined;

  // gh's page is authoritative for everything it lists: `pageUrlByNumber`
  // records every entry BEFORE the repo gate so a fork layout — where gh
  // resolves the PARENT repo for list queries — still attributes a
  // convention number to the parent PR the session exists for. The gated
  // maps hold only same-repo entries: branch-mapping a foreign head branch
  // would bind a stranger's PR on a bare name collision.
  const numberToUrl = new Map<number, string>();
  const branchToNumber = new Map<string, number>();
  const pageUrlByNumber = new Map<number, string>();
  const pageStateByNumber = new Map<number, 'open' | 'merged' | 'closed'>();
  const prs = await fetchPullRequests(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
    { state: 'all', limit: 500, slim: true },
  );
  if (prs.kind === 'ok') {
    for (const pr of prs.pullRequests) {
      // The sidecar snapshot has no 'draft' variant — a draft is still open.
      const state = pr.state === 'draft' ? 'open' : pr.state;
      pageUrlByNumber.set(pr.number, pr.url);
      pageStateByNumber.set(pr.number, state);
      // Fork layout: gh resolves the PARENT repo for list queries when the
      // origin is a fork, so the page can hold another repository's PRs. A
      // bare head-branch collision with one of them would bind a stranger's
      // PR into this workspace's sessions — reject every foreign URL. Fail
      // CLOSED when the workspace key is unknown (no resolvable origin): gh
      // may then resolve a default repo that is not this workspace's, and
      // the convention URL fallback is already disabled in that state.
      if (
        workspaceRepoKey === undefined ||
        repoKeyFromWebUrl(pr.url) !== workspaceRepoKey
      ) {
        continue;
      }
      numberToUrl.set(pr.number, pr.url);
      // First wins: the list is newest-updatedAt-first, so a head branch
      // shared by two PRs maps to the newer one (a last-write `.set()` would
      // resolve to the oldest, making the current PR unreachable).
      if (pr.headRefName && !branchToNumber.has(pr.headRefName)) {
        branchToNumber.set(pr.headRefName, pr.number);
      }
    }
  }

  for (const candidate of candidates) {
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail-10 cap: branch-mapped first (a head-branch name
    // collision is the weakest signal) and the worktree slug/branch
    // convention last (the session exists FOR that PR, so it must never be
    // evicted by weaker numbers).
    const numbers: number[] = [];
    for (const branch of candidate.branches) {
      const mapped = branchToNumber.get(branch);
      if (mapped !== undefined && !numbers.includes(mapped)) {
        numbers.push(mapped);
      }
    }
    if (candidate.conventionNumber !== undefined) {
      const conventionNumber = candidate.conventionNumber;
      const rest = numbers.filter((n) => n !== conventionNumber);
      numbers.length = 0;
      numbers.push(...rest, conventionNumber);
    }
    if (numbers.length === 0) continue;
    // One unwritable sidecar (EISDIR/EACCES/EIO) must not abort the whole
    // workspace run and drop every later candidate; record and continue.
    try {
      await bindCandidateNumbers(
        sessionService,
        candidate,
        numbers,
        {
          numberToUrl,
          pageUrlByNumber,
          pageStateByNumber,
          remote,
        },
        result,
      );
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function bindCandidateNumbers(
  sessionService: ReturnType<typeof createWorkspaceRuntimeSessionService>,
  candidate: BackfillCandidate,
  numbers: readonly number[],
  sources: {
    numberToUrl: ReadonlyMap<number, string>;
    pageUrlByNumber: ReadonlyMap<number, string>;
    pageStateByNumber: ReadonlyMap<number, 'open' | 'merged' | 'closed'>;
    remote: string | undefined;
  },
  result: SessionPrBackfillWorkspaceResult,
): Promise<void> {
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
  const initialNumbers = new Set(existing?.map((pr) => pr.number));
  let persisted: Awaited<ReturnType<typeof upsertSessionPr>> | undefined;
  for (const number of numbers) {
    const isConvention = number === candidate.conventionNumber;
    if (initialNumbers.has(number)) {
      result.alreadyBound += 1;
      // Plain skip for EVERY already-bound number: a re-upsert would move
      // the entry to the end with a fresh createdAt, violating the
      // binding-time order the badge and tooltip render by.
      continue;
    }
    let url = sources.numberToUrl.get(number);
    if (url === undefined && isConvention) {
      // Fork layout: the repo gate above rejects the parent-repo page, but
      // gh's own attribution still names the PR authoritatively — prefer it
      // over a synthesized fork URL (forks host no PRs, the link would
      // 404). Only a number gh's page lacks entirely falls back to the
      // workspace remote (gh unavailable or outside the list window).
      url = sources.pageUrlByNumber.get(number);
      if (url === undefined && sources.remote !== undefined) {
        url = `${sources.remote}/pull/${number}`;
      }
    }
    if (url === undefined) {
      result.unresolved += 1;
      continue;
    }
    const state = sources.pageStateByNumber.get(number);
    persisted = await upsertSessionPr(prPath, {
      number,
      url,
      ...(state ? { state } : {}),
    });
    result.bound += 1;
  }
  // Eviction repair: this run's NEW bindings can push pre-existing entries
  // past the tail cap — including live gh-backed bindings, the strongest
  // signal class, which no other path restores. Re-upsert every initially
  // bound number the run evicted (URL/state from the pre-run snapshot).
  // Runs that bind nothing new leave the sidecar untouched.
  if (persisted !== undefined && existing) {
    let survivors = new Set(persisted.map((pr) => pr.number));
    for (const entry of existing) {
      if (survivors.has(entry.number)) continue;
      persisted = await upsertSessionPr(prPath, {
        number: entry.number,
        url: entry.url,
        ...(entry.state ? { state: entry.state } : {}),
      });
      survivors = new Set(persisted.map((pr) => pr.number));
    }
  }
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
            unresolved: 0,
            failed: 0,
            error: 'untrusted workspace skipped',
          });
          continue;
        }
        try {
          const result = await backfillWorkspaceSessionPrs(runtime);
          // New bindings write sidecars the daemon never sees; bump the
          // catalog revision so live-state clients refetch, the way every
          // other daemon-side writer of persisted session state does.
          if (result.bound > 0) runtime.bridge.markSessionCatalogChanged();
          workspaces.push(result);
        } catch (error) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            alreadyBound: 0,
            unresolved: 0,
            failed: 0,
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
