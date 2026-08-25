/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  fetchAttributionRepoKeys,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  readWorktreeSession,
  repoKeyFromWebUrl,
  SESSION_PR_LIST_LIMIT,
  upsertSessionPrs,
  type SessionArchiveState,
  type SessionPrSource,
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
  /** `/review <N|#N>` numbers the session was asked to review. */
  reviewed: readonly number[];
  /** `/review <url>` forms, repo-gated once gh's page key is known. */
  reviewedUrlForms: ReadonlyArray<{ number: number; url: string }>;
}

// `/review 9584`, `/review #9584`, `/review https://…/pull/9584 …`, read
// only at COMMAND position — the very start of the prompt the user typed.
// User records lead with that prompt; @-imported file content is appended
// as later text parts, and shipped docs contain line-leading `/review N`
// examples, so nothing after the first part may seed a binding. `[ \t]+`
// (not `\s+`) keeps the number on the command's own line and isolates the
// command token — `/review-skill …` is another command and must not forge
// a binding. The bare-number alternative closes its token against filename
// characters (`(?!\w)`-class): `/review <file-path>` is another documented
// invocation form, so `/review 001_init.sql` must not forge PR 1. The URL
// alternative keeps `(?!\d)`: it rejects 10+-digit numbers instead of
// truncating them to a 9-digit prefix. The bare-number alternative comes
// first: `/review 42 and fix #7` names 42. Bare session git branches are
// NOT a source: they bind the workspace's current branch PR onto every
// session — measured pure noise, removed with cleanup.
const REVIEW_COMMAND_PATTERN =
  /^\s*\/review(?:[ \t]+#?(\d{1,9})(?![\w./-])|[ \t]+[^\n"\\]*?(https?:\/\/[A-Za-z0-9][^\s"'<>)]*\/pull\/(\d{1,9})(?!\d)))/;

const EMPTY_NUMBER_URL_MAP: ReadonlyMap<number, string> = new Map();
const EMPTY_STATE_MAP: ReadonlyMap<number, SessionPrState> = new Map();

// Only the prompt the user typed counts: assistant prose, tool calls, and
// tool results (read_file echoes of fixtures/docs) quote `/review <N>`
// without requesting one, and the parts after the first carry @-imported
// file content whose line-leading examples would forge bindings. The TUI
// expands bundled skills BEFORE recording: the user record's first part is
// the skill body with the typed command appended at its END, so the typed
// `/review <N>` survives only in the `slash_command` system record's
// `rawCommand` — read that when present, falling back to the user record's
// first text part (the daemon-provided prompt path carries no payload).
// The URL form names the repo it reviewed; it is repo-gated once gh's page
// key is known (see backfillWorkspaceSessionPrs) rather than here.
function collectReviewedPrNumbers(raw: string): {
  reviewed: readonly number[];
  reviewedUrlForms: ReadonlyArray<{ number: number; url: string }>;
} {
  const numbers = new Set<number>();
  const urlForms: Array<{ number: number; url: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('/review')) continue;
    let record: {
      type?: string;
      subtype?: string;
      systemPayload?: { phase?: string; rawCommand?: string };
      message?: {
        parts?: Array<{ text?: string; functionResponse?: unknown }>;
      };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    let prompt: string | undefined;
    if (
      record.type === 'system' &&
      record.subtype === 'slash_command' &&
      record.systemPayload?.phase === 'invocation' &&
      typeof record.systemPayload.rawCommand === 'string'
    ) {
      prompt = record.systemPayload.rawCommand;
    } else if (record.type === 'user') {
      const firstPart = record.message?.parts?.[0];
      if (typeof firstPart?.text === 'string' && !firstPart.functionResponse) {
        prompt = firstPart.text;
      }
    }
    if (prompt === undefined) continue;
    const match = REVIEW_COMMAND_PATTERN.exec(prompt);
    if (!match) continue;
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
    if (Number(urlNumber) > 0) {
      urlForms.push({ number: Number(urlNumber), url });
    }
  }
  return { reviewed: [...numbers], reviewedUrlForms: urlForms };
}

/**
 * Backfills PR bindings onto a workspace's persisted sessions. Sources, in
 * ascending authority order: `/review <N|#N|url>` commands the user typed
 * (the session merely looked at that PR), and the worktree slug/branch
 * convention last (the session exists FOR that PR, so it must never be
 * evicted by weaker numbers). Transcript `gh pr create` traces are
 * deliberately NOT a source: no gh-side attribution exists per historical
 * command, so text alone could forge a binding — live creates bind through
 * the shell tool post-hook, which verifies with gh itself. Numbers resolve
 * to URLs via one batched `gh pr list --state all` per workspace, else the
 * workspace's git remote web URL; a session may bind several PRs.
 */
export async function backfillWorkspaceSessionPrs(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
  fetchRepoKeys: typeof fetchAttributionRepoKeys = fetchAttributionRepoKeys,
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
  // /review URL form can repo-gate against it; async so the daemon event
  // loop is never blocked by it.
  const remote = await fetchRemoteWebUrl(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const workspaceRepoKey = remote ? repoKeyFromWebUrl(remote) : undefined;
  const candidates: BackfillCandidate[] = [];
  for (const archiveState of ['active', 'archived'] as const) {
    // Enumerate the chats dir directly: paging listSessions would
    // permanently skip every session whose mtime ties a page's last entry
    // (its cursor boundary is a strict `<`).
    for (const sessionId of await sessionService.enumerateSessionIdsForArchiveState(
      archiveState,
    )) {
      // The id comes verbatim from the transcript's first record, and every
      // sidecar path below embeds it — a traversal id must be rejected
      // before path construction, the same way the sibling sidecar routes
      // gate.
      if (!isValidSessionId(sessionId)) continue;
      result.scanned += 1;
      const dir = path.dirname(
        sessionService.getWorktreeSessionPathForArchiveState(
          sessionId,
          archiveState,
        ),
      );
      let worktree: Awaited<ReturnType<typeof readWorktreeSession>>;
      try {
        worktree = await readWorktreeSession(
          path.join(dir, `${sessionId}.worktree.json`),
        );
      } catch {
        worktree = null;
      }
      let transcriptRaw: string;
      try {
        transcriptRaw = await fs.readFile(
          path.join(dir, `${sessionId}.jsonl`),
          'utf8',
        );
      } catch {
        transcriptRaw = '';
      }
      const reviewed = collectReviewedPrNumbers(transcriptRaw);
      const conventionNumber = worktree
        ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
        : undefined;
      if (
        conventionNumber === undefined &&
        reviewed.reviewed.length === 0 &&
        reviewed.reviewedUrlForms.length === 0
      ) {
        continue;
      }
      candidates.push({
        sessionId,
        archiveState,
        conventionNumber,
        reviewed: reviewed.reviewed,
        reviewedUrlForms: reviewed.reviewedUrlForms,
      });
    }
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
  // gh lists one repo per page — the PARENT's in the fork layout. Record
  // its key once: PR URLs always point there in that layout, so
  // `/review <url>` forms naming it are legitimate even though the
  // workspace origin's key is the fork's.
  let pageRepoKey: string | undefined;
  const prs = await fetchPullRequests(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
    { state: 'all', limit: 500, slim: true },
  );
  // gh's page may only feed bindings when it lists the workspace's OWN
  // repo or a CONFIRMED fork parent: gh's repo resolution is git-config
  // driven (`gh repo set-default`, remaining remotes), so it can diverge
  // from the workspace repo entirely, and bare numbers resolving through a
  // divergent page would bind a stranger's same-numbered PR.
  let pageMapTrusted = false;
  if (prs.kind === 'ok') {
    for (const pr of prs.pullRequests) {
      // The sidecar snapshot has no 'draft' variant — a draft is still open.
      const state = pr.state === 'draft' ? 'open' : pr.state;
      pageUrlByNumber.set(pr.number, pr.url);
      pageStateByNumber.set(pr.number, state);
      pageRepoKey ??= repoKeyFromWebUrl(pr.url);
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
    if (pageRepoKey !== undefined) {
      if (workspaceRepoKey !== undefined && pageRepoKey === workspaceRepoKey) {
        pageMapTrusted = true;
      } else {
        // Fork layout: gh lists the PARENT repo's PRs from a fork
        // checkout. Trust the page only when gh's OWN resolution names
        // the workspace repo AND the page is that repo's fork parent —
        // a resolution diverged elsewhere (`gh repo set-default`) would
        // otherwise feed a stranger's PRs into bindings; an unrelated
        // page fails closed.
        const { resolved, parent } = await fetchRepoKeys(
          runtime.workspaceCwd,
          runtime.env.effectiveEnv,
        );
        pageMapTrusted =
          workspaceRepoKey !== undefined &&
          resolved === workspaceRepoKey &&
          parent === pageRepoKey;
      }
    }
  }

  // `/review <url>` names the repo it reviewed: accept the workspace's own
  // key OR the repo gh's page actually resolved to (the fork layout's
  // parent); a third repo's PR must never bind into this workspace. Fail
  // closed only when BOTH keys are unknown — with neither an origin nor a
  // gh page there is nothing to attribute the URL to.
  const allowedRepoKeys = new Set<string>();
  if (workspaceRepoKey !== undefined) allowedRepoKeys.add(workspaceRepoKey);
  if (pageRepoKey !== undefined) allowedRepoKeys.add(pageRepoKey);

  for (const candidate of candidates) {
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail-10 cap: reviewed first (the session merely looked at
    // that PR), and the worktree slug/branch convention last (the session
    // exists FOR that PR, so it must never be evicted by weaker numbers).
    const numbers: number[] = [];
    for (const reviewedNumber of candidate.reviewed) {
      if (!numbers.includes(reviewedNumber)) numbers.push(reviewedNumber);
    }
    for (const form of candidate.reviewedUrlForms) {
      const repoKey = repoKeyFromWebUrl(form.url);
      if (
        repoKey !== undefined &&
        allowedRepoKeys.has(repoKey) &&
        !numbers.includes(form.number)
      ) {
        numbers.push(form.number);
      }
    }
    if (candidate.conventionNumber !== undefined) {
      const conventionNumber = candidate.conventionNumber;
      const rest = numbers.filter((n) => n !== conventionNumber);
      numbers.length = 0;
      numbers.push(...rest, conventionNumber);
    }
    if (numbers.length === 0) continue;
    // Offer only FREE sidecar slots. Occupants this run does not re-offer
    // (live `create` bindings, pre-provenance entries) already hold slots;
    // offering past the free count would evict the weakest persisted entry
    // and re-append it with a fresh createdAt on every re-run — a
    // permanent rotation falsifying the binding-time order and bumping the
    // catalog each call. Sizing to the free slots keeps re-runs idempotent:
    // the strongest candidates land in the persisted tail and later runs
    // find everything bound. The pre-read is an unlocked sizing hint — the
    // locked mutation re-reads authoritative state.
    const prPath = sessionService.getPrSessionPathForArchiveState(
      candidate.sessionId,
      candidate.archiveState,
    );
    let existing = null as Awaited<ReturnType<typeof readSessionPrs>>;
    try {
      existing = await readSessionPrs(prPath);
    } catch {
      // An unwritable sidecar keeps today's offer shape; the write fails
      // and is counted per candidate below.
    }
    const freeSlots = SESSION_PR_LIST_LIMIT - (existing?.length ?? 0);
    if (freeSlots <= 0) {
      if (existing) {
        const present = new Set(existing.map((entry) => entry.number));
        result.alreadyBound += numbers.filter((number) =>
          present.has(number),
        ).length;
      }
      continue;
    }
    if (numbers.length > freeSlots) {
      numbers.splice(0, numbers.length - freeSlots);
    }
    // One unwritable sidecar (EISDIR/EACCES/EIO) must not abort the whole
    // workspace run and drop every later candidate; record and continue.
    try {
      await bindCandidateNumbers(
        sessionService,
        candidate,
        numbers,
        {
          numberToUrl,
          // The page maps hold foreign entries whenever gh resolved another
          // repo (divergent default, fork parent); only a RELATED page —
          // the workspace's own repo or a confirmed fork parent — may feed
          // a binding. Consuming a divergent page would bind a stranger's
          // same-numbered PR, the exact collision numberToUrl fails closed
          // on.
          pageUrlByNumber: pageMapTrusted
            ? pageUrlByNumber
            : EMPTY_NUMBER_URL_MAP,
          pageStateByNumber: pageMapTrusted
            ? pageStateByNumber
            : EMPTY_STATE_MAP,
          remote,
          allowedRepoKeys,
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
    allowedRepoKeys: ReadonlySet<string>;
  },
  result: SessionPrBackfillWorkspaceResult,
): Promise<void> {
  const prPath = sessionService.getPrSessionPathForArchiveState(
    candidate.sessionId,
    candidate.archiveState,
  );
  // `/review <url>` forms name their PR's URL explicitly — bind the named
  // URL itself instead of re-resolving the bare number, which could land
  // another repo's same-numbered PR. Only forms that PASS the repo gate
  // may supply a URL: the same number can also enter via a bare form, and
  // a gate-rejected foreign form would otherwise lend a stranger's URL to
  // the legitimate binding (the Map keeps the LAST entry per number).
  const formUrlByNumber = new Map<number, string>(
    candidate.reviewedUrlForms
      .filter((form) => {
        const repoKey = repoKeyFromWebUrl(form.url);
        return repoKey !== undefined && sources.allowedRepoKeys.has(repoKey);
      })
      .map((form) => [form.number, form.url]),
  );
  const bindings: Array<{
    number: number;
    url?: string;
    state?: SessionPrState;
    source?: SessionPrSource;
  }> = [];
  for (const number of numbers) {
    let url = sources.numberToUrl.get(number);
    if (url === undefined) {
      url = formUrlByNumber.get(number);
    }
    if (url === undefined) {
      // Fork layout: gh's own attribution names the parent repo's PR
      // authoritatively — a RELATED page (same repo or confirmed fork
      // parent) is preferred over a synthesized fork URL (forks host no
      // PRs, the link would 404). Only a number gh's page lacks entirely
      // falls back to the workspace remote (gh unavailable, divergent
      // page, or outside the list window).
      url = sources.pageUrlByNumber.get(number);
      if (url === undefined && sources.remote !== undefined) {
        url = `${sources.remote}/pull/${number}`;
      }
    }
    const state = sources.pageStateByNumber.get(number);
    bindings.push({
      number,
      url,
      source: number === candidate.conventionNumber ? 'worktree' : 'review',
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
