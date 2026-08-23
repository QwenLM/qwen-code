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
  detectGhPrCreateBinding,
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
  if (slugMatch) return Number(slugMatch[1]);
  const branchMatch = BRANCH_PR_PATTERN.exec(branch ?? '');
  if (branchMatch) return Number(branchMatch[1]);
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
  /** Convention numbers whose URL could not be resolved. */
  unresolved: number;
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /** PRs the session created via `gh pr create` (number → printed URL). */
  direct: ReadonlyMap<number, string>;
  /** PR numbers the session was asked to review (`/review <N|url>`). */
  reviewed: readonly number[];
}

// `/review 9584`, `/review #9584`, `/review https://…/pull/9584 …`. Bare
// session git branches are NOT a source: they bind the workspace's current
// branch PR onto every session (including unrelated chats and reviews of
// other PRs), which is noise, not signal.
const REVIEW_COMMAND_PATTERN =
  /\/review\b[^\n"\\]*?(?:pull\/|#)(\d{1,9})|\/review\s+(\d{1,9})/g;

function collectReviewedPrNumbers(raw: string): readonly number[] {
  const numbers = new Set<number>();
  for (const match of raw.matchAll(REVIEW_COMMAND_PATTERN)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) numbers.add(Number(value));
  }
  return [...numbers];
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
 * Backfills PR bindings onto a workspace's persisted sessions. Sources: the
 * worktree slug/branch convention (`pr-<N>`, zero network), `gh pr create`
 * traces in the transcript (number + printed URL), and explicit `/review
 * <N|url>` requests (the reviewed PR). Bare session git branches are NOT a
 * source — they bind the workspace's current branch PR onto every session.
 * URLs resolve from the batched slim `gh pr list --state all`, then the
 * printed create URL, then the git remote web URL (convention/review
 * numbers). A session may bind several PRs.
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
        const direct = collectGhPrCreateBindings(transcriptRaw);
        const reviewed = collectReviewedPrNumbers(transcriptRaw);
        const conventionNumber = worktree
          ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
          : undefined;
        if (
          conventionNumber === undefined &&
          direct.size === 0 &&
          reviewed.length === 0
        ) {
          continue;
        }
        candidates.push({
          sessionId: item.sessionId,
          archiveState,
          conventionNumber,
          direct,
          reviewed,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  if (candidates.length === 0) return result;

  const numberToUrl = new Map<number, string>();
  const numberToState = new Map<number, 'open' | 'merged' | 'closed'>();
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
    }
  }

  let remoteWebUrl: string | undefined;
  for (const candidate of candidates) {
    const numbers: number[] = [];
    if (candidate.conventionNumber !== undefined) {
      numbers.push(candidate.conventionNumber);
    }
    for (const directNumber of candidate.direct.keys()) {
      if (!numbers.includes(directNumber)) numbers.push(directNumber);
    }
    for (const reviewedNumber of candidate.reviewed) {
      if (!numbers.includes(reviewedNumber)) numbers.push(reviewedNumber);
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
      if (
        url === undefined &&
        (number === candidate.conventionNumber ||
          candidate.reviewed.includes(number))
      ) {
        remoteWebUrl ??= getRemoteWebUrl(runtime.workspaceCwd);
        if (remoteWebUrl !== undefined) url = `${remoteWebUrl}/pull/${number}`;
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
