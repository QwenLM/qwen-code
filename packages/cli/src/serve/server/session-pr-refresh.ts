/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// This module must stay OUT of the serve pre-listen static closure: it
// pulls the SessionService chain (glob et al.) via the core barrel, which
// the fast-path bundle closure check forbids before listen. `run-qwen-serve`
// therefore loads it through a dynamic import(); keep every import here
// static — a dynamic import() of the barrel from inside would make the
// barrel's full namespace live and poison the shared chunk for every
// static barrel importer (ACP agent included).
import { existsSync } from 'node:fs';
import {
  fetchGitHubPullRequestIssues,
  fetchGitHubPullRequests,
  readSessionPrs,
  updateSessionPrStates,
  type SessionPrIssue,
  type SessionPrState,
} from '@qwen-code/qwen-code-core';
import {
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  defaultAoneMrBackend,
  isAoneDetailUrlForRepo,
  resolveAoneWorkspaceRepo,
  type AoneMrBackend,
} from './aone-mrs.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  DaemonDrainingError,
  type SessionArchiveCoordinator,
} from './session-archive.js';
import { invalidateWorkspaceSessionListCache } from './session-list.js';

export const DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Aggregate deadline for one workspace's capped `mr view` loop. The
 * per-call timeout bounds a single view; this bounds the loop — worst case
 * 25 sequential views x 20s would outrun the sweep interval, and the
 * timer's re-entrancy guard would then pause EVERY workspace's refresh for
 * the whole stall. Once past the deadline the loop stops starting views;
 * the remainder degrades exactly like a per-number failure and the
 * rotating window retries it on later sweeps.
 */
export const AONE_SWEEP_VIEW_BUDGET_MS = 60_000;

/**
 * Identity of a PR url as `host/owner/repo` plus number, tolerant of the
 * spellings the bind path accepts (`www.`, `http:`, a `/files` suffix,
 * case). Wider than `canonicalSessionPrUrl` on purpose and local to this
 * sweep's lookup matching: same-PR identity everywhere else (re-binds, the
 * sidecar's write gate, the session-list merge) keeps the canonical rule.
 */
function pullRequestKey(
  url: string,
): { repo: string; number: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(
    parsed.pathname,
  );
  if (!match) return undefined;
  const host = parsed.hostname.replace(/^www\./, '');
  return {
    repo: `${host}/${match[1]}/${match[2]}`.toLowerCase(),
    number: Number(match[3]),
  };
}

function samePullRequest(left: string, right: string): boolean {
  const a = pullRequestKey(left);
  const b = pullRequestKey(right);
  return (
    a !== undefined &&
    b !== undefined &&
    a.repo === b.repo &&
    a.number === b.number
  );
}

/**
 * The slice of {@link SessionArchiveCoordinator} the sweep needs: the
 * per-session shared lane that archive/delete take exclusively, so a sidecar
 * commit and an archive move of the same session never interleave.
 */
export type SessionPrArchiveLane = Pick<
  SessionArchiveCoordinator,
  'runSharedMany'
>;

export interface SessionPrRefreshOptions {
  /**
   * Serialises each sidecar commit with archive/delete of the same session.
   * Omitted only by callers that own no coordinator (tests); the daemon
   * always passes the app-wide one.
   */
  archiveCoordinator?: SessionPrArchiveLane;
  /**
   * The a1 read backend for Aone workspaces. Tests substitute fakes; the
   * daemon uses {@link defaultAoneMrBackend}.
   */
  aoneBackend?: AoneMrBackend;
  /**
   * Start offset of the capped Aone view window into the pending set. The
   * timer advances it per workspace per sweep, so a pending set larger
   * than the cap is refreshed in consecutive windows instead of starving a
   * fixed prefix. Defaults to 0.
   */
  sweepStart?: number;
  /** Injectable clock for the aggregate view budget (tests substitute). */
  now?: () => number;
}

/**
 * `QWEN_SESSION_PR_REFRESH_MINUTES`: refresh interval in minutes; `0`
 * disables the sweep. Missing, blank, invalid, sub-minute, and
 * timer-overflowing values fall back to the default.
 */
export function resolveSessionPrRefreshIntervalMs(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env['QWEN_SESSION_PR_REFRESH_MINUTES'];
  // Blank means "unset" in templated env files; Number('') is 0 and would
  // silently disable the sweep.
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  }
  if (minutes === 0) return undefined;
  // Sub-minute values degenerate into a near-continuous sweep, and once the
  // converted ms exceeds setInterval's 32-bit max Node clamps the delay to
  // 1 ms — turning a "longer" interval into a hot loop.
  if (minutes < 1) return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  const ms = minutes * 60_000;
  return ms <= 2 ** 31 - 1 ? ms : DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
}

export interface SessionPrRefreshResult {
  /** Sidecars read (sessions with at least one binding). */
  scanned: number;
  /** Bindings whose state or issue snapshot was rewritten. */
  updated: number;
  /**
   * Aone only: how many unique numbers the view loop actually started this
   * sweep. The timer advances the rotating window by THIS, not the fixed
   * cap — when the aggregate budget truncates the sweep, the next window
   * must pick up where this one stopped, or the truncated tail falls in the
   * gap between consecutive windows and is never revisited. Absent on the
   * GitHub path.
   */
  aoneConsumed?: number;
}

/**
 * Refreshes the persisted `state` snapshot of one workspace's PR bindings,
 * and on GitHub the `issues` snapshot (the closing references) too. Only
 * merged is terminal (closed PRs can reopen), so workspaces whose bindings
 * are all merged — with an issue snapshot in place — cost no platform call
 * at all. GitHub workspaces pay one slim `gh pr list --state all` per sweep
 * for states plus one by-number GraphQL lookup for the closing issues
 * (which can change while the PR is open, and which legacy bindings lack);
 * Aone workspaces pay one `a1 repo mr view` per unique pending number (list
 * output carries no state+URL pair, and closed MRs are not listable — a
 * reopen reappears as opened and self-heals). Rewritten in place (order and
 * createdAt preserved).
 */
export async function refreshWorkspaceSessionPrStates(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
  options: SessionPrRefreshOptions = {},
): Promise<SessionPrRefreshResult> {
  // The runtime was snapshotted from the registry before this sweep awaited
  // anything; a trust/env replacement or removal closes its generation
  // guard while the sweep is in flight, and a retired generation must not
  // run `gh` with its stale env, commit sidecars, or notify its obsolete
  // bridge — the same guard every REST/ACP binding writer asserts.
  const assertGenerationOpen = (): void =>
    runtime.generationGuard?.assertOpen();
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const pendingNumbers: Array<{
    sessionId: string;
    prPath: string;
    numbers: number[];
    /** Every stored URL per pending number — the Aone refreshability filter. */
    urls: Map<number, string[]>;
    /** GitHub only: bindings whose issue snapshot is refreshed this sweep. */
    issueEntries: Array<{ number: number; url: string; merged: boolean }>;
  }> = [];
  let scanned = 0;
  for (const archiveState of ['active', 'archived'] as const) {
    // Sidecar-driven, not transcript-driven: a binding persisted before the
    // session's first flush has no transcript yet, and its state must not
    // stay frozen at bind time.
    for (const sessionId of sessionService.listSessionIdsWithPrSidecar(
      archiveState,
    )) {
      // The sidecar enumeration (unlike listSessions) sees foreign sessions
      // whose sanitized cwds collide onto this chats dir — never rewrite
      // another project's bindings.
      if (
        !(await sessionService.sessionPrSidecarBelongsToCurrentProject(
          sessionId,
          archiveState,
        ))
      ) {
        continue;
      }
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState,
      );
      let prs: Awaited<ReturnType<typeof readSessionPrs>>;
      try {
        prs = await readSessionPrs(prPath);
      } catch {
        continue;
      }
      if (!prs) continue;
      scanned += 1;
      const pending = prs.filter(
        // Only merged is terminal: closed PRs can be reopened, so they
        // keep participating in the sweep.
        (p) => p.state !== 'merged',
      );
      // Closing references change while a PR is open; a merged binding
      // still needs one lookup when it predates the issue snapshot.
      const issueEntries = prs
        .filter((p) => p.state !== 'merged' || p.issues === undefined)
        .map(({ number, url, state }) => ({
          number,
          url,
          merged: state === 'merged',
        }));
      if (pending.length > 0 || issueEntries.length > 0) {
        const urls = new Map<number, string[]>();
        for (const entry of pending) {
          const known = urls.get(entry.number);
          if (known) known.push(entry.url);
          else urls.set(entry.number, [entry.url]);
        }
        pendingNumbers.push({
          sessionId,
          prPath,
          numbers: pending.map((p) => p.number),
          urls,
          issueEntries,
        });
      }
    }
  }
  if (pendingNumbers.length === 0) return { scanned, updated: 0 };

  assertGenerationOpen();
  // The url rides along with the snapshot: the map is keyed by number, but a
  // binding may point at another repository whose same-numbered PR must
  // never supply this workspace's state or issues.
  const numberToFetch = new Map<
    number,
    { state?: SessionPrState; url: string; issues?: SessionPrIssue[] }
  >();
  // Once true, a merged binding lacking a snapshot that no lookup resolved
  // gets a converging empty one, so it leaves the sweep instead of
  // re-entering the lookup forever: the lookup succeeded (the repository
  // does not know the number), it is structurally impossible (no gh, no
  // git root), or the platform has no closing references at all (Aone).
  // A transient failure never converges — the PR may well have references.
  let convergeMerged = false;
  // The repository the list query resolved, as a `host/owner/repo` key. A
  // binding outside it (another repository's same-numbered PR) can never
  // resolve here, so it stays out of the lookup — the GitHub twin of the
  // Aone refreshability filter. Unknown (no list result) fails open into
  // the lookup, whose per-alias NOT_FOUND then converges it.
  let repoKey: string | undefined;
  const isForeign = (url: string): boolean =>
    repoKey !== undefined && pullRequestKey(url)?.repo !== repoKey;
  const aoneRepo = await resolveAoneWorkspaceRepo(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
  );
  let aoneConsumed: number | undefined;
  if (aoneRepo) {
    // A number whose every stored URL misses the detailUrl shape of THIS
    // repo — a foreign manual binding, a legacy fabricated entry awaiting
    // backfill repair, another repo's same-numbered MR — can never match
    // an attested detailUrl in updateSessionPrStates; viewing it would
    // only burn a capped slot, every sweep, forever.
    const refreshable = new Set<number>();
    for (const target of pendingNumbers) {
      for (const [number, urls] of target.urls) {
        if (refreshable.has(number)) continue;
        if (
          urls.some((url) =>
            isAoneDetailUrlForRepo(aoneRepo.repoPath, number, url),
          )
        ) {
          refreshable.add(number);
        }
      }
    }
    // Aone's global ids are platform-unique, so a number bound by several
    // sessions costs one mr view. The cap bounds one sweep's fan-out, and
    // the window ROTATES: the timer advances sweepStart per workspace per
    // sweep, so a refreshable set larger than the cap is fully refreshed
    // in ceil(size/cap) sweeps instead of starving a fixed prefix. A
    // per-number failure (403/404/timeout) leaves that entry at its last
    // state; the rotation retries it on a later sweep.
    const backend = options.aoneBackend ?? defaultAoneMrBackend;
    const all = [
      ...new Set(pendingNumbers.flatMap((target) => target.numbers)),
    ].filter((number) => refreshable.has(number));
    const start = all.length === 0 ? 0 : (options.sweepStart ?? 0) % all.length;
    const unique = [...all.slice(start), ...all.slice(0, start)].slice(
      0,
      AONE_MAX_MR_VIEW_CALLS_PER_RUN,
    );
    const now = options.now ?? Date.now;
    const deadline = now() + AONE_SWEEP_VIEW_BUDGET_MS;
    let consumed = 0;
    for (const number of unique) {
      // Aggregate budget: stop STARTING views once spent (the view in
      // flight may still finish out its own per-call timeout); the
      // remainder degrades like a per-number failure.
      if (now() > deadline) break;
      consumed += 1;
      try {
        const view = await backend.view(aoneRepo.repoPath, number);
        numberToFetch.set(view.number, { state: view.state, url: view.url });
      } catch {
        // Skip this entry; the rotation retries it on a later sweep.
      }
    }
    // Report how far the window got: the timer advances the rotation by
    // this, so a budget-truncated sweep's tail is picked up next sweep
    // instead of falling in the gap between fixed-cap windows.
    aoneConsumed = consumed;
    // Closing references are a GitHub notion; without this a merged Aone
    // binding would keep the workspace pending (one origin resolution per
    // sweep) forever.
    convergeMerged = true;
  } else {
    if (pendingNumbers.some((target) => target.numbers.length > 0)) {
      const result = await fetchPullRequests(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
        { state: 'all', limit: 500, slim: true },
      );
      if (result.kind === 'ok') {
        for (const pr of result.pullRequests) {
          // The sidecar snapshot has no 'draft' variant — a draft is still
          // open.
          numberToFetch.set(pr.number, {
            state: pr.state === 'draft' ? 'open' : pr.state,
            url: pr.url,
          });
        }
        const sample = result.pullRequests[0]?.url;
        if (sample !== undefined) repoKey = pullRequestKey(sample)?.repo;
      }
    }
    const issueNumbers = [
      ...new Set(
        pendingNumbers.flatMap((target) =>
          target.issueEntries
            .filter((entry) => !isForeign(entry.url))
            .map((entry) => entry.number),
        ),
      ),
    ];
    if (issueNumbers.length > 0) {
      assertGenerationOpen();
      const issuesResult = await fetchGitHubPullRequestIssues(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
        issueNumbers,
      );
      if (issuesResult.kind === 'ok') {
        convergeMerged = true;
        for (const [number, { url, issues }] of issuesResult.pullRequests) {
          // Both queries resolve the same repository, so a number present
          // in both names one PR; the state (if any) stays from the list
          // query.
          numberToFetch.set(number, {
            ...(numberToFetch.get(number) ?? { url }),
            issues,
          });
        }
      } else if (
        issuesResult.kind === 'cli_unavailable' ||
        issuesResult.kind === 'not_a_repo' ||
        issuesResult.kind === 'repo_unresolved'
      ) {
        convergeMerged = true;
      }
    }
  }

  let updated = 0;
  for (const target of pendingNumbers) {
    const states = new Map<
      number,
      { state?: SessionPrState; url: string; issues?: SessionPrIssue[] }
    >();
    for (const number of target.numbers) {
      const fetched = numberToFetch.get(number);
      // Only a number ABSENT from the fetched set is skipped (out of gh's
      // limit window, or beyond this a1 sweep's view cap); a present one
      // is authoritative — including an 'open' that supersedes a stale
      // 'closed' after a reopen.
      if (fetched !== undefined) states.set(number, fetched);
    }
    for (const entry of target.issueEntries) {
      const fetched = numberToFetch.get(entry.number);
      if (
        fetched?.issues !== undefined &&
        samePullRequest(fetched.url, entry.url)
      ) {
        // Written under the entry's own url: the sidecar's canonical gate
        // would drop a `/files`-spelled binding's snapshot otherwise.
        states.set(entry.number, { ...fetched, url: entry.url });
      } else if (entry.merged && (convergeMerged || isForeign(entry.url))) {
        // No lookup will ever snapshot this merged binding; an empty
        // snapshot (renders as none) retires it from the sweep. Open ones
        // stay pending for their state anyway.
        states.set(entry.number, { url: entry.url, issues: [] });
      }
    }
    if (states.size === 0) continue;
    const commit = (): Promise<number> =>
      updateSessionPrStates(target.prPath, states, {
        assertCanCommit: () => {
          assertGenerationOpen();
          // Belt and braces under the archive lane: a sidecar that vanished
          // between the queued read and this commit step (a delete that
          // took no lane) must not be resurrected by the write.
          if (!existsSync(target.prPath)) {
            throw new Error(
              `session PR sidecar vanished during refresh: ${target.prPath}`,
            );
          }
        },
      });
    try {
      // The archive lane is what makes the existence check above sufficient:
      // archive/delete hold the session's exclusive lane across their
      // renames, so while this commit holds the shared lane neither can
      // move the transcript or sidecar out from under the atomic write.
      updated += await (options.archiveCoordinator
        ? options.archiveCoordinator.runSharedMany([target.sessionId], commit)
        : commit());
    } catch (error) {
      // A draining daemon accepts no further session maintenance — stop the
      // sweep instead of failing every remaining target one by one.
      if (error instanceof DaemonDrainingError) throw error;
      // One unwritable (or archiving) sidecar must not starve the rest of
      // the sweep; the next tick picks it up.
    }
  }
  if (updated > 0) {
    // Same pairing as every other binding write in this feature: the
    // sidebar refetch is catalog-version-gated and the live-state payload
    // carries no `prs`, so a silent sidecar rewrite would leave stale
    // badges until an unrelated catalog change or a reload. Never notify a
    // retired generation's bridge: its successor owns the catalog now.
    assertGenerationOpen();
    invalidateWorkspaceSessionListCache({
      runtimeBaseDir: runtime.sessionRuntimeBaseDir,
      workspaceCwd: runtime.workspaceCwd,
      archiveStates: ['active', 'archived'],
    });
    runtime.bridge.markSessionCatalogChanged();
  }
  return { scanned, updated, aoneConsumed };
}

/**
 * Low-frequency daemon sweep that keeps bound PR states fresh. Runs off the
 * session-list polling path (its own timer), unref'd so it never keeps the
 * process alive, and the first run is delayed to stay out of boot's way.
 * Returns undefined when disabled via `QWEN_SESSION_PR_REFRESH_MINUTES=0`.
 */
export function startSessionPrRefreshTimer(deps: {
  workspaceRegistry: WorkspaceRegistry;
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Resolved per tick (not at start) because the daemon parks the
   * coordinator on the serve app, which is built after this timer starts.
   */
  getArchiveCoordinator?: () => SessionPrArchiveLane | undefined;
  /**
   * Test seam: the a1 backend handed to each sweep. The daemon omits it
   * (the sweep then uses {@link defaultAoneMrBackend}); tests substitute a
   * fake to observe the rotating view window without a live a1.
   */
  aoneBackend?: AoneMrBackend;
  /**
   * Test seam: the clock handed to each sweep's aggregate-budget deadline.
   * The daemon omits it (the sweep then uses Date.now); tests substitute a
   * controllable clock to drive budget truncation at the timer level.
   */
  now?: () => number;
}): { dispose(): void } | undefined {
  const intervalMs = resolveSessionPrRefreshIntervalMs(deps.env ?? process.env);
  if (intervalMs === undefined) return undefined;
  // Rotating Aone view-window offset per workspace: each sweep advances the
  // start by however many views the sweep actually STARTED (not the fixed
  // cap), so a pending set larger than the cap is fully refreshed over
  // consecutive sweeps, and a budget-truncated sweep's tail is picked up by
  // the next window instead of falling in the gap between fixed-cap
  // windows. Kept monotonic (not mod'd here) — the sweep reduces it modulo
  // the live set size itself, so a shrinking set never skews the rotation.
  const aoneSweepOffsets = new Map<string, number>();
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const archiveCoordinator = deps.getArchiveCoordinator?.();
      const live = deps.workspaceRegistry.listAll();
      for (const runtime of live) {
        if (!runtime.trusted) continue;
        const sweepStart = aoneSweepOffsets.get(runtime.workspaceCwd) ?? 0;
        try {
          const result = await refreshWorkspaceSessionPrStates(
            runtime,
            undefined,
            {
              archiveCoordinator,
              sweepStart,
              aoneBackend: deps.aoneBackend,
              now: deps.now,
            },
          );
          // Only the Aone path reports a consumed window — the GitHub path
          // never reads the offset, so don't write one for it.
          if (result.aoneConsumed !== undefined) {
            aoneSweepOffsets.set(
              runtime.workspaceCwd,
              sweepStart + result.aoneConsumed,
            );
          }
        } catch (error) {
          // A draining daemon rejects every workspace the same way.
          if (error instanceof DaemonDrainingError) return;
          // A single workspace's failure (including a generation retired
          // mid-sweep) must not starve the rest. Leave its offset unmoved
          // so the next tick retries the same window.
        }
      }
      // Prune offsets for workspaces no longer in the registry (removed or
      // never Aone): the daemon runs indefinitely, so an entry per
      // ever-seen cwd would grow without bound.
      const liveCwds = new Set(live.map((r) => r.workspaceCwd));
      for (const cwd of [...aoneSweepOffsets.keys()]) {
        if (!liveCwds.has(cwd)) aoneSweepOffsets.delete(cwd);
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    dispose(): void {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
