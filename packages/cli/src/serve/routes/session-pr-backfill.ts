/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  SESSION_PR_LIST_LIMIT,
  canonicalSessionPrUrl,
  fetchAttributionRepoKeys,
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  readWorktreeSession,
  replaceSessionPrs,
  repoKeyFromWebUrl,
  type SessionArchiveState,
  type SessionPr,
  type SessionPrSource,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import { DaemonDrainingError } from '../server/session-archive.js';
import { invalidateWorkspaceSessionListCache } from '../server/session-list.js';
import type { SessionPrArchiveLane } from '../server/session-pr-refresh.js';
import { isValidSessionId } from '../../config/session-id.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import {
  WorkspaceGenerationClosedError,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';

export interface SessionPrBackfillOptions {
  /**
   * Serialises each session's sidecar commit with archive/delete of that
   * session (see {@link SessionPrArchiveLane}). The daemon always passes the
   * app-wide coordinator; only tests omit it.
   */
  archiveCoordinator?: SessionPrArchiveLane;
}

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

/**
 * Converts a git remote URL (https / ssh / scp-style) to the repository's
 * web URL, used to build `<repo>/pull/<N>` when `gh` is unavailable.
 */
export function normalizeRemoteToWebUrl(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;
  let input = trimmed;
  // An ssh:// remote's explicit port is the SSH port, almost never the web
  // port — ssh-derived URLs drop it (scp-style remotes cannot carry one).
  // An https remote's port IS the web port and must survive.
  let sshDerived = false;
  if (input.startsWith('git@')) {
    input = `https://${input.slice('git@'.length).replace(':', '/')}`;
    sshDerived = true;
  } else if (input.startsWith('ssh://')) {
    input = `https://${input.slice('ssh://'.length)}`;
    sshDerived = true;
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
  const host = sshDerived ? url.hostname : url.host;
  return `${url.protocol}//${host}${pathname}`.replace(/\/$/, '');
}

export interface SessionPrBackfillWorkspaceResult {
  workspaceCwd: string;
  /** Persisted sessions scanned (active + archived). */
  scanned: number;
  /** New PR bindings written by this run (a session may bind several). */
  bound: number;
  /** Sidecar writes persisted, including eviction-only rewrites. */
  written: number;
  /** Resolved bindings that already existed in the sidecar. */
  alreadyBound: number;
  /** Resolved numbers skipped because they exceed the sidecar cap. */
  overLimit: number;
  /** Candidate numbers whose URL could not be resolved. */
  unresolved: number;
  /**
   * Whether the workspace's `gh pr list` succeeded. False means URL/state
   * resolution degraded to the remote-web-URL fallback (convention numbers
   * only), so a zero `bound` count is a degraded run, not an empty one.
   */
  ghAvailable?: boolean;
  /** Sidecar writes that failed; the affected session keeps its bindings. */
  writeErrors?: number;
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** Transcript path, used to never resurrect a removed session's sidecar. */
  transcriptPath: string;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /** `/review <N|#N>` numbers the session was asked to review. */
  reviewed: readonly number[];
  /** `/review <url>` forms, repo-gated once the page key is known. */
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
 * evicted by weaker numbers). Transcript `gh pr create` traces and bare
 * session git branches are deliberately NOT sources: text alone carries no
 * gh-side attribution (a forged binding vector), and the branch source
 * bound the workspace's current-branch PR onto every session (measured
 * pure noise). Numbers resolve to URLs via one batched
 * `gh pr list --state all` per workspace (repo-gated), else `/review <url>`
 * forms, else the workspace's git remote web URL (convention numbers only).
 */
export async function backfillWorkspaceSessionPrs(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
  fetchRepoKeys: typeof fetchAttributionRepoKeys = fetchAttributionRepoKeys,
  options: SessionPrBackfillOptions = {},
): Promise<SessionPrBackfillWorkspaceResult> {
  // The route snapshots this runtime from the registry and then awaits
  // scans, `gh`, and queued writes; a trust/env replacement or removal
  // closes the generation guard meanwhile, and a retired generation must
  // not run `gh` with its stale env or commit sidecars — the same guard
  // every REST/ACP binding writer asserts around `upsertSessionPr`.
  const assertGenerationOpen = (): void =>
    runtime.generationGuard?.assertOpen();
  const result: SessionPrBackfillWorkspaceResult = {
    workspaceCwd: runtime.workspaceCwd,
    scanned: 0,
    bound: 0,
    written: 0,
    alreadyBound: 0,
    overLimit: 0,
    unresolved: 0,
  };
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  // One remote lookup per run, before scanning so the /review URL form can
  // repo-gate against it; async so the daemon event loop is never blocked.
  const remote = await fetchRemoteWebUrl(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  const workspaceRepoKey = remote ? repoKeyFromWebUrl(remote) : undefined;
  const candidates: BackfillCandidate[] = [];
  for (const archiveState of ['active', 'archived'] as const) {
    // Tie-safe exhaustive enumeration (see listAllProjectSessionIds): the
    // paged listSessions mtime cursor silently skips sessions tied with a
    // page's last entry, which an all-sessions sweep must never do.
    const sessionIds =
      await sessionService.listAllProjectSessionIds(archiveState);
    for (const sessionId of sessionIds) {
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
        transcriptPath: path.join(dir, `${sessionId}.jsonl`),
        conventionNumber,
        reviewed: reviewed.reviewed,
        reviewedUrlForms: reviewed.reviewedUrlForms,
      });
    }
  }
  if (candidates.length === 0) return result;

  assertGenerationOpen();
  // gh's page is authoritative for everything it lists: `pageUrlByNumber`
  // records every entry BEFORE the repo gate so a fork layout — where gh
  // resolves the PARENT repo for list queries — still attributes a
  // convention number to the parent PR the session exists for. The gated
  // map holds only same-repo entries.
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
  result.ghAvailable = prs.kind === 'ok';
  // gh's page may only feed bindings when it lists the workspace's OWN
  // repo or a CONFIRMED fork parent: gh's repo resolution is git-config
  // driven (`gh repo set-default`, remaining remotes), so it can diverge
  // from the workspace repo entirely, and bare numbers resolving through a
  // divergent page would bind a stranger's same-numbered PR. Fail CLOSED
  // when the workspace key is unknown (no resolvable origin): the remote
  // fallback is already disabled in that state.
  let pageMapTrusted = false;
  if (prs.kind === 'ok') {
    for (const pr of prs.pullRequests) {
      // The sidecar snapshot has no 'draft' variant — a draft is still open.
      const state = pr.state === 'draft' ? 'open' : pr.state;
      pageUrlByNumber.set(pr.number, pr.url);
      pageStateByNumber.set(pr.number, state);
      pageRepoKey ??= repoKeyFromWebUrl(pr.url);
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
        // Fork layout: gh lists the PARENT repo's PRs from a fork checkout.
        // Trust the page only when gh's OWN resolution names the workspace
        // repo AND the page is that repo's fork parent — a resolution
        // diverged elsewhere (`gh repo set-default`) would otherwise feed a
        // stranger's PRs into bindings; an unrelated page fails closed.
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
  // parent); a third repo's PR must never bind into this workspace.
  const allowedRepoKeys = new Set<string>();
  if (workspaceRepoKey !== undefined) allowedRepoKeys.add(workspaceRepoKey);
  if (pageRepoKey !== undefined) allowedRepoKeys.add(pageRepoKey);

  for (const candidate of candidates) {
    // Insert in ASCENDING authority so the strongest bindings survive the
    // sidecar's tail cap: reviewed first (the session merely looked at that
    // PR), and the worktree convention last (the session exists FOR that
    // PR, so it must never be evicted by weaker numbers).
    const numbers: number[] = [];
    for (const reviewedNumber of candidate.reviewed) {
      if (!numbers.includes(reviewedNumber)) numbers.push(reviewedNumber);
    }
    // `/review <url>` forms name their PR's URL explicitly — bind the named
    // URL itself instead of re-resolving the bare number, which could land
    // another repo's same-numbered PR. Only forms that PASS the repo gate
    // may supply a number at all.
    const formUrlByNumber = new Map<number, string>(
      candidate.reviewedUrlForms
        .filter((form) => {
          const repoKey = repoKeyFromWebUrl(form.url);
          return repoKey !== undefined && allowedRepoKeys.has(repoKey);
        })
        .map((form) => [form.number, form.url]),
    );
    for (const form of candidate.reviewedUrlForms) {
      if (formUrlByNumber.has(form.number) && !numbers.includes(form.number)) {
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
    // Re-resolve the session's CURRENT archive state immediately before the
    // snapshot read and locked write: an archive/restore transition landing
    // during the scan and gh window above must not strand the new bindings
    // in the wrong state's chats dir. A location that cannot be determined
    // keeps the enumerated state.
    let archiveState = candidate.archiveState;
    try {
      const location = await sessionService.getSessionLocation(
        candidate.sessionId,
      );
      if (location === 'active' || location === 'archived') {
        archiveState = location;
      }
    } catch {
      // Best-effort backfill: keep the enumerated state.
    }
    const prPath = sessionService.getPrSessionPathForArchiveState(
      candidate.sessionId,
      archiveState,
    );
    // The transcript moves with an archive transition; the write-time
    // existence guard must check the re-resolved location, not the
    // enumerated one.
    const transcriptPath = path.join(
      path.dirname(prPath),
      `${candidate.sessionId}.jsonl`,
    );
    // Captured before the snapshot read: an entry committed while this run
    // is in flight is newer than the plan and must not be trimmed by it.
    const snapshotAt = new Date().toISOString();
    let existing: Awaited<ReturnType<typeof readSessionPrs>>;
    try {
      existing = await readSessionPrs(prPath);
    } catch {
      existing = null;
    }
    const existingNumbers = new Set((existing ?? []).map((pr) => pr.number));
    const urls = new Map<number, string>();
    const states = new Map<number, SessionPr['state']>();
    for (const number of numbers) {
      if (existingNumbers.has(number)) continue;
      let url = numberToUrl.get(number);
      if (url === undefined) url = formUrlByNumber.get(number);
      if (url === undefined && pageMapTrusted) {
        url = pageUrlByNumber.get(number);
      }
      if (url === undefined) {
        // Fork layout: the RELATED page (confirmed fork parent) is preferred
        // over a synthesized fork URL (forks host no PRs; the link would
        // 404). Only a number the page lacks entirely falls back to the
        // workspace remote (gh unavailable, divergent page, or outside the
        // list window) — a bare reviewed number names this repo's PR N.
        if (remote !== undefined) url = `${remote}/pull/${number}`;
      }
      if (url === undefined) {
        result.unresolved += 1;
        continue;
      }
      urls.set(number, url);
      // The page's state belongs to the page's OWN url for the number: a
      // `/review <url>` form that resolved another repo's URL (the fork
      // layout) must not pair with the page repo's same-numbered PR — a
      // DIFFERENT PR whose terminal state would poison this binding.
      const state =
        pageMapTrusted && pageUrlByNumber.get(number) === url
          ? pageStateByNumber.get(number)
          : undefined;
      if (state !== undefined) states.set(number, state);
    }
    // The cap is shared with entries this run did not resolve and cannot
    // re-resolve (dialog-created bindings, PRs that fell out of the gh
    // window): they take their slots first, and the resolved numbers are
    // trimmed around them, counting the displaced in overLimit. The plan is
    // finalized inside the mutation queue, against the freshest list, so a
    // binding that lands between the snapshot read and this write is never
    // dropped and the slots are recomputed around it; sequential capped
    // upserts instead cascaded evictions through the list.
    const droppable = new Set(
      numbers.filter(
        (number) => existingNumbers.has(number) || urls.has(number),
      ),
    );
    const createdAt = new Date().toISOString();
    let added = 0;
    // A closed generation is a whole-run condition, not a per-session write
    // failure: surface it to the route (which reports the workspace as
    // failed) instead of miscounting it in writeErrors.
    assertGenerationOpen();
    const commit = async (): Promise<void> => {
      const persisted = await replaceSessionPrs(prPath, (fresh) => {
        assertGenerationOpen();
        // Under the archive lane no archive/delete rename can interleave
        // with this write; the existence check still covers a transcript
        // removed by a path that takes no lane, so the plan never
        // resurrects a sidecar for a session gone from this archive state.
        if (!existsSync(transcriptPath)) return null;
        const freshNumbers = new Set(fresh.map((entry) => entry.number));
        // Only entries seen in the snapshot are subject to this plan; newer
        // ones are bindings this run never planned for and must keep.
        // Snapshot-held numbers this run re-offers are occupants, not
        // additions (heldInFresh below) — a same-PR re-bind preserves
        // createdAt, so identity here is snapshot membership, not age.
        const plannedFor = (entry: SessionPr): boolean => {
          // Same-PR identity is number + canonical url, as in
          // upsertSessionPr: a binding to another repository's
          // same-numbered PR is foreign to this plan and keeps its slot;
          // trimming it would let a later run flip it to this repo's PR.
          const resolved =
            numberToUrl.get(entry.number) ?? urls.get(entry.number);
          const samePr =
            resolved === undefined ||
            canonicalSessionPrUrl(entry.url) ===
              canonicalSessionPrUrl(resolved);
          return (
            droppable.has(entry.number) &&
            existingNumbers.has(entry.number) &&
            entry.createdAt < snapshotAt &&
            samePr
          );
        };
        const foreignEntries = fresh.filter((entry) => !plannedFor(entry));
        // Fresh-foreign numbers already hold their slots; billing them
        // again as plan members trims a snapshot binding even though the
        // cap is never exceeded.
        const foreignNumbers = new Set(
          foreignEntries.map((entry) => entry.number),
        );
        const foreignCount = foreignEntries.length;
        const slots = Math.max(0, SESSION_PR_LIST_LIMIT - foreignCount);
        let plan = numbers.filter(
          (number) => droppable.has(number) && !foreignNumbers.has(number),
        );
        if (plan.length > slots) {
          result.overLimit += plan.length - slots;
          const convention = candidate.conventionNumber;
          if (slots === 0) {
            plan = [];
          } else if (
            convention !== undefined &&
            plan[plan.length - 1] === convention
          ) {
            // Keep the pr-<N> slug's PR and displace the oldest reviewed
            // numbers instead.
            const reviewSlots = slots - 1;
            plan = [
              ...(reviewSlots > 0 ? plan.slice(0, -1).slice(-reviewSlots) : []),
              convention,
            ];
          } else {
            plan = plan.slice(-slots);
          }
        }
        const planSet = new Set(plan);
        result.alreadyBound += plan.filter((number) =>
          freshNumbers.has(number),
        ).length;
        const kept = fresh.filter(
          (entry) => planSet.has(entry.number) || !plannedFor(entry),
        );
        const additions: SessionPr[] = [];
        for (const number of plan) {
          if (freshNumbers.has(number)) continue;
          const url = urls.get(number);
          // Snapshot-held numbers were skipped by the URL loop, so one
          // evicted concurrently has no URL here; re-adding it url-less
          // would fail isValidSessionPr and void the whole sidecar. Skip
          // it and let the next run re-bind it.
          if (url === undefined) continue;
          const state = states.get(number);
          const source: SessionPrSource =
            number === candidate.conventionNumber ? 'worktree' : 'review';
          additions.push({
            number,
            url,
            createdAt,
            ...(state !== undefined ? { state } : {}),
            source,
          });
        }
        added = additions.length;
        const next = [...kept, ...additions];
        return next.length === fresh.length &&
          next.every((entry, index) => entry === fresh[index])
          ? null
          : next;
      });
      if (persisted !== null) {
        result.bound += added;
        result.written += 1;
        // Every other binding writer keeps the hydrated bridge entry in
        // step with the sidecar; a capped plan can evict numbers, and the
        // stale entry would resurrect them in the summary merge until a
        // daemon restart. The sync runs inside the mutation queue against
        // the freshest list, so a bind queued between the rewrite's commit
        // and the sync keeps its slot instead of being clobbered by the
        // rewrite-time snapshot. No-op when the session is not live.
        await replaceSessionPrs(prPath, (fresh) => {
          // Never publish into a retired generation's bridge.
          assertGenerationOpen();
          runtime.bridge.setSessionPrs?.(
            candidate.sessionId,
            fresh.map(({ number, url, state }) => ({
              number,
              url,
              ...(state ? { state } : {}),
            })),
          );
          return null;
        });
      }
    };
    try {
      // The shared lane spans the rewrite AND the live-entry sync: archive
      // and delete take the exclusive lane across their renames, so while
      // this holds the session neither can move the transcript or sidecar
      // out from under the atomic write, and the sync publishes a list the
      // archive move cannot have split.
      await (options.archiveCoordinator
        ? options.archiveCoordinator.runSharedMany(
            [candidate.sessionId],
            commit,
          )
        : commit());
    } catch (error) {
      if (
        error instanceof WorkspaceGenerationClosedError ||
        error instanceof DaemonDrainingError
      ) {
        throw error;
      }
      // One unwritable (or concurrently archiving) sidecar must not abort
      // the whole workspace; the next run re-plans it.
      result.writeErrors = (result.writeErrors ?? 0) + 1;
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
    archiveCoordinator?: SessionPrArchiveLane;
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
            written: 0,
            alreadyBound: 0,
            overLimit: 0,
            unresolved: 0,
            error: 'untrusted workspace skipped',
          });
          continue;
        }
        try {
          const result = await backfillWorkspaceSessionPrs(
            runtime,
            undefined,
            undefined,
            {
              archiveCoordinator: deps.archiveCoordinator,
            },
          );
          // Same pairing as every other catalog mutation in this feature:
          // the sidebar refetch is catalog-version-gated, so a persisted
          // rewrite — new bindings or an eviction-only plan — stays
          // invisible until the cache scope is dropped and the revision
          // advances. Gate on writes, not additions: a capped plan can
          // evict an entry while adding none.
          if (result.written > 0) {
            // A generation retired after its last commit must not notify
            // its obsolete bridge; the successor owns the catalog now.
            runtime.generationGuard?.assertOpen();
            invalidateWorkspaceSessionListCache({
              runtimeBaseDir: runtime.sessionRuntimeBaseDir,
              workspaceCwd: runtime.workspaceCwd,
              archiveStates: ['active', 'archived'],
            });
            runtime.bridge.markSessionCatalogChanged();
          }
          workspaces.push(result);
        } catch (error) {
          workspaces.push({
            workspaceCwd: runtime.workspaceCwd,
            scanned: 0,
            bound: 0,
            written: 0,
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
