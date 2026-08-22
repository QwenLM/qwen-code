/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  detectGhPrCreateBinding,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  readWorktreeSession,
  repoKeyFromWebUrl,
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
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /** Worktree branch plus every `gitBranch` seen in the transcript. */
  branches: readonly string[];
  /** PRs the session created via `gh pr create` (number → printed URL). */
  direct: ReadonlyMap<number, string>;
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

interface TranscriptToolPart {
  functionCall?: {
    id?: string;
    name?: string;
    args?: { command?: string };
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: { output?: string };
  };
}

/**
 * Recovers PRs the session created by running `gh pr create` in the shell:
 * pairs each `run_shell_command` call (by part id) with its response and
 * applies the same command+URL gate as the live shell-tool binding. Covers
 * sessions that predate the live hook.
 */
function collectGhPrCreateBindings(raw: string): ReadonlyMap<number, string> {
  const commandById = new Map<string, string>();
  const bindings = new Map<number, string>();
  for (const line of raw.split('\n')) {
    if (!line.includes('run_shell_command')) continue;
    let parts: unknown;
    try {
      parts = (JSON.parse(line) as { message?: { parts?: unknown } })?.message
        ?.parts;
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const part of parts as TranscriptToolPart[]) {
      const call = part.functionCall;
      if (
        call?.name === 'run_shell_command' &&
        typeof call.id === 'string' &&
        typeof call.args?.command === 'string'
      ) {
        commandById.set(call.id, call.args.command);
        continue;
      }
      const response = part.functionResponse;
      if (
        response?.name !== 'run_shell_command' ||
        typeof response.id !== 'string' ||
        typeof response.response?.output !== 'string'
      ) {
        continue;
      }
      const command = commandById.get(response.id);
      if (command === undefined) continue;
      const binding = detectGhPrCreateBinding(
        command,
        response.response.output,
      );
      if (binding) bindings.set(binding.number, binding.url);
    }
  }
  return bindings;
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
        const direct = collectGhPrCreateBindings(transcriptRaw);
        const conventionNumber = worktree
          ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
          : undefined;
        if (
          branches.length === 0 &&
          conventionNumber === undefined &&
          direct.size === 0
        ) {
          continue;
        }
        candidates.push({
          sessionId: item.sessionId,
          archiveState,
          conventionNumber,
          branches,
          direct,
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
      // First wins: the list is newest-updatedAt-first, so a head branch
      // shared by two PRs maps to the newer one (a last-write `.set()` would
      // resolve to the oldest, making the current PR unreachable).
      if (pr.headRefName && !branchToNumber.has(pr.headRefName)) {
        branchToNumber.set(pr.headRefName, pr.number);
      }
    }
  }

  // One remote lookup per backfill run, cached by ATTEMPT (a failed lookup
  // must not re-spawn git for every candidate); async so the daemon event
  // loop is never blocked by it.
  let remoteWebUrl: string | undefined;
  let remoteAttempted = false;
  const resolveRemoteWebUrl = async (): Promise<string | undefined> => {
    if (!remoteAttempted) {
      remoteAttempted = true;
      remoteWebUrl = await fetchRemoteWebUrl(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
      );
    }
    return remoteWebUrl;
  };

  for (const candidate of candidates) {
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail-10 cap: branch-mapped first (a head-branch name
    // collision is the weakest signal), then `gh pr create` evidence, and
    // the worktree slug/branch convention last (the session exists FOR that
    // PR, so it must never be evicted by weaker numbers).
    const numbers: number[] = [];
    for (const branch of candidate.branches) {
      const mapped = branchToNumber.get(branch);
      if (mapped !== undefined && !numbers.includes(mapped)) {
        numbers.push(mapped);
      }
    }
    let repoKey: string | undefined;
    if (candidate.direct.size > 0) {
      const remote = await resolveRemoteWebUrl();
      repoKey = remote ? repoKeyFromWebUrl(remote) : undefined;
    }
    for (const [directNumber, directUrl] of candidate.direct) {
      // A transcript URL from another repository must not bind this
      // session; an unresolvable workspace remote cannot vouch for it.
      if (repoKey === undefined || repoKeyFromWebUrl(directUrl) !== repoKey) {
        continue;
      }
      if (!numbers.includes(directNumber)) numbers.push(directNumber);
    }
    if (candidate.conventionNumber !== undefined) {
      const conventionNumber = candidate.conventionNumber;
      const rest = numbers.filter((n) => n !== conventionNumber);
      numbers.length = 0;
      numbers.push(...rest, conventionNumber);
    }
    if (numbers.length === 0) continue;
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
      let url = numberToUrl.get(number) ?? candidate.direct.get(number);
      if (url === undefined && number === candidate.conventionNumber) {
        const remote = await resolveRemoteWebUrl();
        if (remote !== undefined) url = `${remote}/pull/${number}`;
      }
      if (url === undefined) {
        result.unresolved += 1;
        continue;
      }
      const state = numberToState.get(number);
      await upsertSessionPr(prPath, {
        number,
        url,
        ...(state ? { state } : {}),
      });
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
