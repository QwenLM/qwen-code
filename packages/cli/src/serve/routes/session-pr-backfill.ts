/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  commandRunsGhPrCreate,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readWorktreeSession,
  repoKeyFromWebUrl,
  upsertSessionPrs,
  type SessionArchiveState,
  type SessionPrState,
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
  /** PRs the session created via `gh pr create` (number → printed URL). */
  direct: ReadonlyMap<number, string>;
  /** PR numbers the session was asked to review (`/review <N|url>`). */
  reviewed: readonly number[];
}

// A printed URL only counts when gh itself printed it in the response of
// the very `gh pr create` run (paired by part id) AND it belongs to the
// workspace's own repo — text alone must never forge a binding.
const PRINTED_PR_URL_PATTERN =
  /https?:\/\/[A-Za-z0-9][^\s"'<>)]*\/pull\/(\d{1,9})/g;

// `/review 9584`, `/review #9584`, `/review https://…/pull/9584 …`, read
// only at COMMAND position (line start): user-turn prose — including
// bundled skill bodies recorded verbatim as user records — mentions
// `/review` mid-line, and only a line-leading command names a PR to bind.
// The bare-number alternative comes first: `/review 42 and fix #7` names 42,
// and the lazy span alternative would otherwise consume the line and
// capture the later token. Bare session git branches are NOT a source: they
// bind the workspace's current branch PR onto every session (including
// unrelated chats and reviews of other PRs) — measured pure noise, removed
// with cleanup.
const REVIEW_COMMAND_PATTERN =
  /(?:^|\n)\s*\/review\s+#?(\d{1,9})|(?:^|\n)\s*\/review\b[^\n"\\]*?(https?:\/\/[A-Za-z0-9][^\s"'<>)]*\/pull\/(\d{1,9}))/g;

const EMPTY_NUMBER_URL_MAP: ReadonlyMap<number, string> = new Map();

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

function collectGhPrCreateBindings(
  raw: string,
  workspaceRepoKey: string | undefined,
): ReadonlyMap<number, string> {
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
      if (command === undefined || !commandRunsGhPrCreate(command)) {
        continue;
      }
      if (command.includes('--dry-run')) continue;
      for (const match of response.response.output.matchAll(
        PRINTED_PR_URL_PATTERN,
      )) {
        const url = match[0];
        // Elided owner/repo placeholders are not link targets; foreign
        // repos must never bind into this workspace.
        if (url.includes('...')) continue;
        if (
          workspaceRepoKey === undefined ||
          repoKeyFromWebUrl(url) !== workspaceRepoKey
        ) {
          continue;
        }
        bindings.set(Number(match[1]), url);
      }
    }
  }
  return bindings;
}

// Only USER text records count: assistant prose, tool calls, and tool
// results (read_file echoes of fixtures/docs) quote `/review <N>` without
// requesting one, and raw-text matching over escaped JSON would bind them.
function collectReviewedPrNumbers(
  raw: string,
  workspaceRepoKey: string | undefined,
): readonly number[] {
  const numbers = new Set<number>();
  for (const line of raw.split('\n')) {
    if (!line.includes('/review')) continue;
    let record: {
      type?: string;
      message?: {
        parts?: Array<{ text?: string; functionResponse?: unknown }>;
      };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'user') continue;
    for (const part of record.message?.parts ?? []) {
      if (typeof part.text !== 'string' || part.functionResponse) {
        continue;
      }
      for (const match of part.text.matchAll(REVIEW_COMMAND_PATTERN)) {
        const bareNumber = match[1];
        if (bareNumber !== undefined) {
          // `\d{1,9}` admits 0; PR 0 does not exist and the sidecar write
          // declines it, so it must never count as a binding.
          if (Number(bareNumber) > 0) numbers.add(Number(bareNumber));
          continue;
        }
        const url = match[2];
        const urlNumber = match[3];
        if (url === undefined || urlNumber === undefined) continue;
        // The URL form names the repo it reviewed. Resolution would prefer
        // the workspace's own page and bind its same-numbered PR instead,
        // so gate here: a foreign repo's PR must never bind into this
        // workspace, and an unknown workspace key fails closed.
        if (
          workspaceRepoKey === undefined ||
          repoKeyFromWebUrl(url) !== workspaceRepoKey
        ) {
          continue;
        }
        if (Number(urlNumber) > 0) numbers.add(Number(urlNumber));
      }
    }
  }
  return [...numbers];
}

/**
 * Backfills PR bindings onto a workspace's persisted sessions. Sources, in
 * ascending authority order: `/review <N|#N|url>` commands in the session's
 * user records (the session merely looked at that PR); URLs gh itself
 * printed in the session's `gh pr create` runs (call/response paired by
 * part id, repo-gated — text alone must never forge a binding); and the
 * worktree slug/branch convention last (the session exists FOR that PR, so
 * it must never be evicted by weaker numbers). Numbers resolve to URLs via
 * one batched `gh pr list --state all` per workspace, else the workspace's
 * git remote web URL; a session may bind several PRs.
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
  // One remote lookup per backfill run, before transcript scanning so the
  // gh-create source can repo-validate printed URLs; async so the daemon
  // event loop is never blocked by it.
  const remote = await fetchRemoteWebUrl(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const workspaceRepoKey = remote ? repoKeyFromWebUrl(remote) : undefined;
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
        const direct = collectGhPrCreateBindings(
          transcriptRaw,
          workspaceRepoKey,
        );
        const reviewed = collectReviewedPrNumbers(
          transcriptRaw,
          workspaceRepoKey,
        );
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

  // gh's page is authoritative for everything it lists: `pageUrlByNumber`
  // records every entry BEFORE the repo gate so a fork layout — where gh
  // resolves the PARENT repo for list queries — still attributes a
  // convention number to the parent PR the session exists for. The gated
  // maps hold only same-repo entries: branch-mapping a foreign head branch
  // would bind a stranger's PR on a bare name collision.
  const numberToUrl = new Map<number, string>();
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
    }
  }

  for (const candidate of candidates) {
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail-10 cap: reviewed first (the session merely looked at
    // that PR), then gh-create traces, and the worktree slug/branch
    // convention last (the session exists FOR that PR, so it must never be
    // evicted by weaker numbers).
    const numbers: number[] = [];
    for (const reviewedNumber of candidate.reviewed) {
      if (!numbers.includes(reviewedNumber)) numbers.push(reviewedNumber);
    }
    for (const directNumber of candidate.direct.keys()) {
      // Filter+re-append, the same as the convention tier below: skipping
      // in place would leave the number at its weaker reviewed position,
      // where the tail cap evicts the strongest binding in the overlap.
      const rest = numbers.filter((n) => n !== directNumber);
      numbers.length = 0;
      numbers.push(...rest, directNumber);
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
          // The page map holds foreign entries too (fork layout needs them,
          // gh's own attribution names the PR authoritatively). Consuming
          // them with an unknown workspace key would bind whatever default
          // repo gh resolved — the exact collision numberToUrl fails
          // closed on — so the fallback map is empty in that state.
          pageUrlByNumber:
            workspaceRepoKey !== undefined
              ? pageUrlByNumber
              : EMPTY_NUMBER_URL_MAP,
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
  const bindings: Array<{
    number: number;
    url?: string;
    state?: SessionPrState;
  }> = [];
  for (const number of numbers) {
    const isConvention = number === candidate.conventionNumber;
    let url = sources.numberToUrl.get(number) ?? candidate.direct.get(number);
    if (
      url === undefined &&
      (isConvention || candidate.reviewed.includes(number))
    ) {
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
    const state = sources.pageStateByNumber.get(number);
    bindings.push({
      number,
      url,
      ...(state ? { state } : {}),
    });
  }
  // One locked read-modify-write per session: the read inside the mutation
  // sees bindings concurrent writers land during this run, the capped list
  // is computed once (a repeated re-upsert repair would cascade and evict
  // this run's own new bindings), and nothing is persisted until the final
  // list is complete — a mid-write failure cannot strand evicted entries.
  const applied = await upsertSessionPrs(prPath, bindings);
  result.bound += applied.added.length;
  result.alreadyBound += applied.alreadyBound.length;
  result.unresolved += applied.unresolved.length;
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
