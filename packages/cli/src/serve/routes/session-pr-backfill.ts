/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Application, RequestHandler } from 'express';
import {
  SESSION_PR_LIST_LIMIT,
  canonicalSessionPrUrl,
  fetchGitHubPullRequests,
  getDefaultBranch,
  gitEnv,
  readSessionPrs,
  readWorktreeSession,
  replaceSessionPrs,
  type SessionArchiveState,
  type SessionPr,
} from '@qwen-code/qwen-code-core';
import type { SendBridgeError } from '../server/error-response.js';
import {
  AONE_BACKFILL_PAGES_PER_STATE,
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  defaultAoneMrBackend,
  isAoneDetailUrlForRepo,
  resolveAoneWorkspaceRepo,
  type AoneMrBackend,
} from '../server/aone-mrs.js';
import { DaemonDrainingError } from '../server/session-archive.js';
import { invalidateWorkspaceSessionListCache } from '../server/session-list.js';
import type { SessionPrArchiveLane } from '../server/session-pr-refresh.js';
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
  /**
   * The a1 read backend for Aone workspaces. Tests substitute fakes; the
   * daemon uses {@link defaultAoneMrBackend}.
   */
  aoneBackend?: AoneMrBackend;
}

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

function getRemoteWebUrl(cwd: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Sanitize like every sibling git/gh call in this path: without an
      // env option the spawn inherits the daemon's raw process.env, and an
      // inherited GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* would resolve origin
      // against a different repository despite the cwd.
      env: gitEnv(),
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
  /** Sidecar writes persisted, including eviction-only rewrites. */
  written: number;
  /** Resolved bindings that already existed in the sidecar. */
  alreadyBound: number;
  /** Resolved numbers skipped because they exceed the sidecar cap. */
  overLimit: number;
  /**
   * Planned numbers whose URL could not be resolved this run. On GitHub
   * only convention numbers (branch-mapped ones always carry a list URL);
   * on Aone any planned number, since every URL comes from a capped
   * `mr view` and can fail or lose the view-budget race.
   */
  unresolved: number;
  /**
   * Whether the workspace's `gh pr list` succeeded. False means transcript-
   * branch mappings were skipped this run, so a zero `bound` count is a
   * degraded run, not a genuinely empty one.
   */
  ghAvailable?: boolean;
  /** The detected PR platform for this workspace's origin. */
  platform?: 'github' | 'aone';
  /**
   * Aone analogue of {@link ghAvailable}: whether `a1 repo mr list`
   * succeeded. False means transcript-branch mappings were skipped this run
   * (convention/slug bindings survive on `mr view` alone).
   */
  aoneAvailable?: boolean;
  /** Sidecar writes that failed; the affected session keeps its bindings. */
  writeErrors?: number;
  error?: string;
}

interface BackfillCandidate {
  sessionId: string;
  archiveState: SessionArchiveState;
  /** Transcript path the candidate was scanned from, in this archive state. */
  transcriptPath: string;
  /** PR number named by the worktree slug/branch convention, if any. */
  conventionNumber: number | undefined;
  /** Worktree branch plus every `gitBranch` seen in the transcript. */
  branches: readonly string[];
}

// Transcript records carry the branch the session was on; the set is small
// per session and only ever compared against PR head branches.
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
  // Structured per-line parse: a `gitBranch` key nested anywhere inside a
  // record (tool-call arguments/results, MCP payloads) must not be taken
  // for the record's own top-level branch — a text regex cannot tell them
  // apart once the record is JSON-stringified.
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== 'object') continue;
    const branch = (record as Record<string, unknown>)['gitBranch'];
    if (typeof branch === 'string' && branch.length > 0) {
      branches.add(branch);
      if (branches.size >= MAX_DISTINCT_BRANCHES) break;
    }
  }
  return [...branches];
}

/**
 * Backfills PR bindings onto a workspace's persisted sessions. Sources, in
 * priority order: the worktree slug/branch convention (names the number
 * without any network); and a batched platform listing mapping head
 * branches — the worktree branch and every `gitBranch` recorded in the
 * session's transcript — to PR numbers and URLs. GitHub workspaces pay one
 * `gh pr list --state all`; Aone workspaces page `a1 repo mr list` per
 * state, and EVERY bound URL comes from `a1 repo mr view` (Aone links are
 * never assembled from the remote). A session may bind several PRs.
 */
export async function backfillWorkspaceSessionPrs(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
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
  const candidates: BackfillCandidate[] = [];
  for (const archiveState of ['active', 'archived'] as const) {
    // Tie-safe exhaustive enumeration (see listAllProjectSessionIds): the
    // paged listSessions mtime cursor silently skips sessions tied with a
    // page's last entry, which an all-sessions sweep must never do.
    const sessionIds =
      await sessionService.listAllProjectSessionIds(archiveState);
    for (const sessionId of sessionIds) {
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
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const branches = [
        ...(worktree ? [worktree.worktreeBranch] : []),
        ...(await collectTranscriptBranches(transcriptPath)),
      ];
      const conventionNumber = worktree
        ? parsePrNumberFromWorktree(worktree.slug, worktree.worktreeBranch)
        : undefined;
      if (branches.length === 0 && conventionNumber === undefined) {
        continue;
      }
      candidates.push({
        sessionId,
        archiveState,
        transcriptPath,
        conventionNumber,
        branches,
      });
    }
  }
  if (candidates.length === 0) return result;

  assertGenerationOpen();
  const numberToUrl = new Map<number, string>();
  const numberToState = new Map<number, 'open' | 'merged' | 'closed'>();
  const branchToNumber = new Map<string, number>();
  // Resolves a URL for a number that numberToUrl does not hold. GitHub
  // fabricates `<origin>/pull/<N>` for the convention number; Aone views
  // each number through a1 instead — its links are never assembled.
  let resolveNumberUrl: (
    number: number,
    isConvention: boolean,
  ) => Promise<string | undefined>;
  // Set for Aone workspaces only: recognises the fabricated URLs the
  // pre-Aone backfill persisted, so the plan can repair them in place.
  let isLegacyFabricated:
    | ((url: string, number: number) => boolean)
    | undefined;

  const aoneBackend = options.aoneBackend ?? defaultAoneMrBackend;
  const aoneRepo = await resolveAoneWorkspaceRepo(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  if (aoneRepo) {
    result.platform = 'aone';
    result.aoneAvailable = false;
    try {
      const listed = [
        ...(await aoneBackend.list(
          aoneRepo.repoPath,
          'opened',
          AONE_BACKFILL_PAGES_PER_STATE,
        )),
        ...(await aoneBackend.list(
          aoneRepo.repoPath,
          'merged',
          AONE_BACKFILL_PAGES_PER_STATE,
        )),
      ];
      result.aoneAvailable = true;
      // The default-branch exclusion and highest-number-wins rule carry the
      // same rationale as the gh path below (a bare default-branch head
      // maps sessions to an unrelated MR; global ids are monotonic, so the
      // largest number is the newest MR on a reused head branch).
      let defaultBranch: string | undefined;
      let headBranchMapping = false;
      if (candidates.some((candidate) => candidate.branches.length > 0)) {
        const defaultRef = await getDefaultBranch(runtime.workspaceCwd);
        if (defaultRef) {
          defaultBranch = defaultRef.slice(defaultRef.indexOf('/') + 1);
          headBranchMapping = true;
        }
      }
      for (const mr of listed) {
        numberToState.set(mr.number, mr.state);
        if (!headBranchMapping) continue;
        const mapped = branchToNumber.get(mr.headRefName);
        if (
          mr.headRefName &&
          mr.headRefName !== defaultBranch &&
          (mapped === undefined || mr.number > mapped)
        ) {
          branchToNumber.set(mr.headRefName, mr.number);
        }
      }
    } catch {
      // A failed `mr list` skips transcript-branch mapping for this run
      // (the ghAvailable:false degraded mode); convention bindings survive
      // on `mr view` alone.
    }
    const viewCache = new Map<number, string | undefined>();
    let viewCalls = 0;
    resolveNumberUrl = async (number) => {
      if (viewCache.has(number)) return viewCache.get(number);
      let url: string | undefined;
      if (viewCalls < AONE_MAX_MR_VIEW_CALLS_PER_RUN) {
        viewCalls += 1;
        try {
          const view = await aoneBackend.view(aoneRepo.repoPath, number);
          url = view.url;
          // Refresh the state snapshot with what the view attested, and
          // record the attested URL: the commit planner's same-PR identity
          // guard keys on numberToUrl, and an empty map would disable the
          // foreign-binding protection the GitHub path pins.
          numberToState.set(number, view.state);
          numberToUrl.set(number, url);
        } catch {
          url = undefined;
        }
      }
      viewCache.set(number, url);
      return url;
    };
    // The pre-Aone backfill fabricated `<origin web URL>/pull/<N>` bindings
    // (the bug this provider fixes). Such an entry can never match a real
    // detailUrl — its state would stay frozen, and it would spend one view
    // call per refresh sweep, forever. Detect exactly that shape so the
    // plan repairs it; any other URL keeps its foreign-repo protection.
    let legacyPullRoot: string | undefined;
    let legacyPullResolved = false;
    isLegacyFabricated = (url, number) => {
      if (!legacyPullResolved) {
        legacyPullRoot = getRemoteWebUrl(runtime.workspaceCwd);
        legacyPullResolved = true;
      }
      return (
        legacyPullRoot !== undefined &&
        canonicalSessionPrUrl(url) ===
          canonicalSessionPrUrl(`${legacyPullRoot}/pull/${number}`)
      );
    };
  } else {
    result.platform = 'github';
    const prs = await fetchPullRequests(
      runtime.workspaceCwd,
      runtime.env.effectiveEnv,
      { state: 'all', limit: 500, slim: true },
    );
    result.ghAvailable = prs.kind === 'ok';
    if (prs.kind === 'ok') {
      // A session run on the repository's default branch cannot be
      // attributed to a PR by branch name: fork PRs opened from the fork's
      // default branch carry that same bare name as their headRefName (gh
      // does not qualify it by owner), so mapping it would bind every such
      // session to an unrelated contributor's PR — the highest-numbered
      // one.
      let defaultBranch: string | undefined;
      // Fail closed: when the default branch is undeterminable (no
      // refs/remotes/origin/HEAD — git init + remote add without a clone,
      // or `git remote set-head origin -d`), the exclusion below
      // degenerates to `headRefName !== undefined` and fork PRs carrying
      // the bare default-branch name would map again — the misattribution
      // this guard exists to prevent. Skip head-branch mapping for the
      // whole run instead; convention/slug bindings do not read
      // branchToNumber and survive.
      let headBranchMapping = false;
      if (candidates.some((candidate) => candidate.branches.length > 0)) {
        // Local ref read only — no credentials needed; getDefaultBranch
        // sanitizes the ambient env through gitEnv internally, the same
        // stripping getRemoteWebUrl applies to its git spawn.
        const defaultRef = await getDefaultBranch(runtime.workspaceCwd);
        if (defaultRef) {
          defaultBranch = defaultRef.slice(defaultRef.indexOf('/') + 1);
          headBranchMapping = true;
        }
      }
      for (const pr of prs.pullRequests) {
        numberToUrl.set(pr.number, pr.url);
        // The sidecar snapshot has no 'draft' variant — a draft is still
        // open.
        numberToState.set(pr.number, pr.state === 'draft' ? 'open' : pr.state);
        if (!headBranchMapping) continue;
        // Highest-number-wins a reused head branch: PR numbers are assigned
        // monotonically, so this picks the newest PR regardless of arrival
        // order — the slim field set omits updatedAt, so no sort order is
        // guaranteed to survive parsing.
        const mapped = branchToNumber.get(pr.headRefName);
        if (
          pr.headRefName &&
          pr.headRefName !== defaultBranch &&
          (mapped === undefined || pr.number > mapped)
        ) {
          branchToNumber.set(pr.headRefName, pr.number);
        }
      }
    }
    let remoteWebUrl: string | undefined;
    let remoteResolved = false;
    resolveNumberUrl = async (number, isConvention) => {
      if (!isConvention) return undefined;
      // Cache the miss too: an unresolvable remote must cost one blocking
      // git spawn per workspace, not one per candidate.
      if (!remoteResolved) {
        remoteWebUrl = getRemoteWebUrl(runtime.workspaceCwd);
        remoteResolved = true;
      }
      return remoteWebUrl !== undefined
        ? `${remoteWebUrl}/pull/${number}`
        : undefined;
    };
  }

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
    // The legacy-repair pass below must stay reachable for a session whose
    // branches no longer map into the list window (its typical state), so
    // only the GH-shaped path — which has no repairs — skips on empty
    // numbers before reading the sidecar.
    if (numbers.length === 0 && !isLegacyFabricated) continue;
    const prPath = sessionService.getPrSessionPathForArchiveState(
      candidate.sessionId,
      candidate.archiveState,
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
    // Repair legacy fabricated bindings: re-resolve their numbers through
    // the same capped view path. Successfully viewed ones are rewritten in
    // the commit below (keeping their createdAt); failed ones stay as they
    // are and the next run retries them.
    const repairs = new Map<
      number,
      { url: string; state?: SessionPr['state'] }
    >();
    if (isLegacyFabricated && existing) {
      for (const entry of existing) {
        if (!isLegacyFabricated(entry.url, entry.number)) continue;
        const url = await resolveNumberUrl(entry.number, false);
        if (url === undefined) continue;
        repairs.set(entry.number, {
          url,
          state: numberToState.get(entry.number),
        });
      }
    }
    if (numbers.length === 0 && repairs.size === 0) continue;
    // The convention number is planned last so a fresh write makes it the
    // sidecar's newest entry: capped lists evict from the oldest end, which
    // must stay branch mappings, not the session's own PR.
    if (candidate.conventionNumber !== undefined) {
      numbers = [...numbers.slice(1), candidate.conventionNumber];
    }
    const existingNumbers = new Set((existing ?? []).map((pr) => pr.number));
    const urls = new Map<number, string>();
    const states = new Map<number, SessionPr['state']>();
    for (const number of numbers) {
      if (existingNumbers.has(number)) continue;
      let url = numberToUrl.get(number);
      if (url === undefined) {
        url = await resolveNumberUrl(
          number,
          number === candidate.conventionNumber,
        );
      }
      if (url === undefined) {
        result.unresolved += 1;
        continue;
      }
      urls.set(number, url);
      const state = numberToState.get(number);
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
        if (!existsSync(candidate.transcriptPath)) return null;
        // Repair legacy fabricated URLs first (Aone only), so the repaired
        // entries plan under their real identity and their state unblocks
        // the refresh sweep. The re-check keeps a concurrently landed
        // non-legacy rewrite of the same number untouched.
        const base =
          repairs.size === 0
            ? fresh
            : fresh.map((entry) => {
                const repair = repairs.get(entry.number);
                return repair && isLegacyFabricated?.(entry.url, entry.number)
                  ? {
                      number: entry.number,
                      url: repair.url,
                      createdAt: entry.createdAt,
                      ...(repair.state !== undefined
                        ? { state: repair.state }
                        : {}),
                    }
                  : entry;
              });
        const freshNumbers = new Set(base.map((entry) => entry.number));
        // Only entries seen in the snapshot are subject to this plan; newer
        // ones are bindings this run never planned for and must keep. A
        // re-bind of a snapshot-held number commits with a fresh createdAt,
        // so it is no longer the entry this run planned for.
        const plannedFor = (entry: SessionPr): boolean => {
          // Same-PR identity is number + canonical url, as in
          // upsertSessionPr: a binding to another repository's
          // same-numbered PR is foreign to this plan and keeps its slot;
          // trimming it would let a later run flip it to this repo's PR.
          const resolved = numberToUrl.get(entry.number);
          // Aone fails CLOSED unless the entry is provably one of this
          // repo's own MRs — either mr-view-attested this run, or matching
          // the exact detailUrl shape for this repoPath (the shape a
          // previous successful bind or repair persisted). The shape check
          // is what keeps a full sidecar's re-planned entries trimmable
          // WITHOUT spending the view budget re-attesting them every run;
          // anything else stays foreign and kept. GitHub keeps the
          // fail-open default: an unlisted convention binding stays
          // re-plannable.
          const samePr = aoneRepo
            ? (resolved !== undefined &&
                canonicalSessionPrUrl(entry.url) ===
                  canonicalSessionPrUrl(resolved)) ||
              isAoneDetailUrlForRepo(aoneRepo.repoPath, entry.number, entry.url)
            : resolved === undefined ||
              canonicalSessionPrUrl(entry.url) ===
                canonicalSessionPrUrl(resolved);
          return (
            droppable.has(entry.number) &&
            existingNumbers.has(entry.number) &&
            entry.createdAt < snapshotAt &&
            samePr
          );
        };
        const foreignEntries = base.filter((entry) => !plannedFor(entry));
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
            // Keep the pr-<N> slug's PR and displace the oldest branch-
            // mapped numbers instead.
            const branchSlots = slots - 1;
            plan = [
              ...(branchSlots > 0 ? plan.slice(0, -1).slice(-branchSlots) : []),
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
        const kept = base.filter(
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
          additions.push({
            number,
            url,
            createdAt,
            ...(state !== undefined ? { state } : {}),
          });
        }
        added = additions.length;
        const next = [...kept, ...additions];
        // Compare against the PERSISTED list, not the repaired one: when a
        // repair rewrote an entry in `base`, `next` matching `base` is the
        // change that must commit, not a no-op.
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
          const result = await backfillWorkspaceSessionPrs(runtime, undefined, {
            archiveCoordinator: deps.archiveCoordinator,
          });
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
