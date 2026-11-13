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
import { pullRequestKey, samePullRequest } from './session-pr-url.js';
import {
  claimPrWatchOwnershipSync,
  prWatchFileKey,
  prWatchFilePath,
  readPrWatchStateSync,
  writePrWatchStateSync,
  PR_WATCH_PENDING_CAP,
  type PrWatchIdentity,
} from './pr-watch-store.js';
import type { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  runPrWatchObservationTick,
  type PrWatchObservationTickDeps,
  prWatchIdentityFromUrl,
  detectPrTransitions,
  normalizeWatchHost,
} from './pr-watch-observation.js';
import {
  scanWorkspaceBindings,
  type SessionPrBindingSummary,
} from '../routes/session-pr-bindings.js';
import {
  createPrWatchDrainState,
  runPrWatchDrainTick,
  stopPrWatch,
  type PrWatchDrainDeps,
} from './pr-watch-drain.js';

export const DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Internal switch for the daemon PR-state watch observation (master design
 * §7, PR A). It stays off: the refresh runs no `gh pr view`, writes no watch
 * file and claims no ownership, and the `sessionPrWatch` setting is not read.
 * A later increment turns it on; tests exercise the observation functions
 * directly rather than through this gated timer hook. The explicit `boolean`
 * annotation keeps the literal `false` from narrowing the gated block to
 * unreachable dead code (hence the no-inferrable-types exemption).
 */
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
export const SESSION_PR_WATCH_OBSERVATION_ENABLED: boolean = false;

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
  /**
   * The PR watch's storage seam. Present only when the watch is enabled, so
   * the listing records each listed PR's state in its watch file and returns
   * the keys it covered. Omitted by every other caller, which keeps the
   * refresh's own behaviour unchanged.
   */
  prWatch?: {
    watchDir: string;
    locks: PathMutexRegistry;
    /**
     * The same set the observation gates views on. The listing write needs it
     * too: it now records transitions, and the drain delivers `pending`
     * without any host check of its own.
     */
    allowedHosts: ReadonlySet<string>;
    log?: (message: string) => void;
  };
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
  /**
   * PR keys the slim listing returned this sweep. The timer carries them into
   * the next tick's observation so a closed PR the listing covered leaves the
   * view rotation, while a closed PR outside the listing stays to catch a
   * reopen. Absent on the Aone path and when the listing did not run or failed.
   */
  listedKeys?: ReadonlySet<string>;
}

/**
 * Records what the slim listing already observed, and returns the keys it
 * covered. The listing is an observation of every PR it returns, so its state
 * is recorded without spending a `gh pr view`; the returned keys are what lets
 * the observation drop a closed PR from the view rotation while keeping one the
 * listing did not cover. Only PRs with an active binding get a file — the keys
 * still cover the whole listing.
 *
 * Writes only while this daemon holds the owner record — a non-owner records
 * nothing, exactly as it views nothing — and each write takes the same per-PR
 * lock the observation uses, so a listing write and a view write of one PR
 * cannot interleave. A PR whose file cannot be read is skipped rather than
 * overwritten: the same fail-closed rule the observation applies before it
 * spends a view.
 */
async function recordListedPrStates(
  listed: ReadonlyArray<{
    number: number;
    state: 'open' | 'closed' | 'merged' | 'draft';
    url: string;
  }>,
  prWatch: NonNullable<SessionPrRefreshOptions['prWatch']>,
  boundKeys: ReadonlySet<string>,
  assertGenerationOpen: () => void,
  now: () => number,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const rows: Array<{
    identity: PrWatchIdentity;
    state: 'open' | 'merged' | 'closed';
  }> = [];
  for (const pr of listed) {
    const identity = prWatchIdentityFromUrl(pr.url);
    if (!identity) continue;
    const key = prWatchFileKey(identity);
    keys.add(key);
    // Only bound PRs get a watch file. The drain deletes unbound ones on a
    // complete scan, so writing them would create and delete the same files
    // every tick — and log a deletion for each.
    if (!boundKeys.has(key)) continue;
    // The observation refuses to view a non-allowed host, and the drain
    // delivers `pending` with no host check of its own — so writing a
    // transition for one would deliver an event the watch may not observe.
    if (!prWatch.allowedHosts.has(normalizeWatchHost(identity.host))) continue;
    // The watch snapshot has no 'draft' variant — a draft is still open.
    const state = pr.state === 'draft' ? 'open' : pr.state;
    rows.push({ identity, state });
  }
  if (rows.length === 0) return keys;
  const log = prWatch.log ?? (() => {});
  if (claimPrWatchOwnershipSync(prWatch.watchDir, log).kind === 'blocked') {
    return keys;
  }
  // This advances the same baseline the observation's slow-view guard reads.
  // Safe because the listing runs after the observation within a tick and
  // ticks never overlap, so it is always the newer observation of the two.
  const observedAt = new Date(now()).toISOString();
  for (const { identity, state } of rows) {
    try {
      assertGenerationOpen();
      // This ladder mirrors the one in observeWorkspacePrBindings, which owns
      // the protocol: lock on the watch FILE PATH (not the logical key — that
      // would take a different mutex entry and serialize with nothing), read,
      // skip on a read error, log an invalid file, detect, log a pending
      // overflow, write. Keep those steps in sync with it. The final write
      // deliberately differs: the view path persists the detector's whole
      // state, while a listing is a partial observation and must carry the
      // fields it cannot see (title, headSha, checks) forward from the file.
      await prWatch.locks.runExclusive(
        prWatchFilePath(prWatch.watchDir, identity),
        async () => {
          const existing = readPrWatchStateSync(prWatch.watchDir, identity);
          if (existing.kind === 'error') {
            log(
              `PR watch: read error for ${existing.filePath}; listing write skipped: ${String(existing.error)}`,
            );
            return;
          }
          if (existing.kind === 'invalid') {
            // Same reason the observation logs it: a lost baseline must stay
            // distinguishable from a PR that simply had no transitions.
            log(
              `PR watch: invalid watch file ${existing.filePath}; listing write re-initialising it`,
            );
          }
          const base =
            existing.kind === 'state' ? existing.state : { pr: identity };
          // The listing is an observation too. When it is the first to see a
          // baselined PR leave open, it must fire the state_change the view
          // would have fired: the write below makes the observation skip that
          // view, and the view is the only other producer of transitions, so
          // without this the closure is recorded as a fait accompli and never
          // delivered. Reuse the detector so the two producers cannot drift.
          // Carrying the previous head/checks forward is what keeps it to
          // state_change alone — no head_change, ci_failure or merge_conflict.
          // A file with no headSha is not baselined and initialises silently,
          // exactly as it does on the view path.
          const detection =
            base.headSha !== undefined
              ? detectPrTransitions(
                  identity,
                  base,
                  {
                    state,
                    headSha: base.headSha,
                    checks: base.checks ?? 'none',
                  },
                  observedAt,
                )
              : undefined;
          // Same diagnostic the view path emits: an evicted entry is a lost
          // notification, and without this an operator cannot tell it apart
          // from a transition that never happened.
          if (
            detection &&
            (base.pending?.length ?? 0) + detection.transitions.length >
              PR_WATCH_PENDING_CAP
          ) {
            log(
              `PR watch: pending overflow for ${identity.repo}#${identity.number}; dropping the oldest entries (cap ${PR_WATCH_PENDING_CAP})`,
            );
          }
          writePrWatchStateSync(prWatch.watchDir, identity, {
            ...base,
            state,
            observedAt,
            ...(detection?.state.pending !== undefined
              ? { pending: detection.state.pending }
              : {}),
          });
        },
      );
    } catch (error) {
      log(
        `PR watch: listing write failed for ${identity.repo}#${identity.number}: ${String(error)}`,
      );
    }
  }
  return keys;
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
  let listedKeys: Set<string> | undefined;
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
        // Only the watch consumes these keys, so a caller without the seam
        // keeps the exact result shape it had before the watch existed.
        if (options.prWatch) {
          // Scanned here rather than at the top of the sweep: only this branch
          // has a listing to record, so an Aone workspace or an empty pending
          // list must not pay for a session-directory scan it discards.
          // The binder set is the shared scan's own answer, not a re-derivation
          // of it: that scan excludes archived, hidden-catalog and unreadable
          // sessions, and the drain deletes a watch file it does not list.
          const watchLog = options.prWatch.log ?? (() => {});
          const bindings: SessionPrBindingSummary[] = [];
          try {
            await scanWorkspaceBindings(runtime, bindings);
          } catch (error) {
            // Unknown binders, not absent ones: write nothing rather than guess.
            watchLog(
              `PR watch: bindings scan failed for ${runtime.workspaceCwd}; listing write skipped: ${String(error)}`,
            );
          }
          const boundKeys = new Set<string>();
          for (const summary of bindings) {
            for (const entry of summary.prs) {
              const identity = prWatchIdentityFromUrl(entry.url);
              if (identity) boundKeys.add(prWatchFileKey(identity));
            }
          }
          listedKeys = await recordListedPrStates(
            result.pullRequests,
            options.prWatch,
            boundKeys,
            assertGenerationOpen,
            options.now ?? Date.now,
          );
        }
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
      if (fetched !== undefined && samePullRequest(fetched.url, entry.url)) {
        // Written under the entry's own url: the sidecar's canonical gate
        // would drop a `/files`-spelled binding's state or snapshot
        // otherwise — the state too, so a lookup outage never leaves such
        // a binding's badge stale.
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
  return {
    scanned,
    updated,
    aoneConsumed,
    ...(listedKeys !== undefined ? { listedKeys } : {}),
  };
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
  /**
   * Resolved per tick for the daemon PR-state watch observation. Only read
   * when the observation switch is on; the daemon parks the watch dir, lock
   * registry and allowed hosts on the serve app.
   */
  getPrWatchDeps?: () => PrWatchObservationTickDeps | undefined;
  /**
   * Resolved per tick for the daemon PR-state watch delivery drain (master
   * §4/§5). Only read when the observation switch is on; the daemon parks the
   * admission, restore, bindings-scan and self-push access on the serve app
   * with the enablement increment. Unpopulated, the drain is inert.
   */
  getPrDrainDeps?: () => PrWatchDrainDeps | undefined;
  /**
   * Test seam overriding {@link SESSION_PR_WATCH_OBSERVATION_ENABLED} so a
   * fixture can exercise the on path. The daemon omits it, so production
   * stays governed by the internal constant (off).
   */
  observationEnabled?: boolean;
}):
  | {
      dispose(): void;
      stopWatch(): Promise<void>;
      drainNow(workspaceCwd: string): Promise<void>;
    }
  | undefined {
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
  // Rotating GitHub view-window offset per workspace for the PR-state watch
  // observation, and a tick counter that rotates the workspace order so a
  // persistent deadline overrun starves no workspace (master design §1).
  const githubSweepOffsets = new Map<string, number>();
  // The observation runs before the refresh, so the keys one tick's listing
  // produced are consumed by the next tick's observation. Kept per workspace
  // for the same reason the view offsets are.
  const listedKeysByWorkspace = new Map<string, ReadonlySet<string>>();
  let watchSeam: NonNullable<SessionPrRefreshOptions['prWatch']> | undefined;
  let watchTickCount = 0;
  // Retained binding rows, in-flight marks and restore slots for the delivery
  // drain, kept across ticks (master §4/§5).
  const prDrainState = createPrWatchDrainState();
  // Set only once a gated path actually claimed the watch — the tick's
  // observation block or an on-demand drain — so shutdown never reads a watch
  // seam while the switch is off (switch-off parity).
  let activeWatchDir: string | undefined;
  let running = false;
  // Latched by stopWatch so an on-demand drain cannot claim the watch
  // directory after the owner record has been handed back.
  let stopped = false;
  // The observation holds the owner record for the whole tick, and the drain
  // state cannot see that phase, so shutdown waits on the tick itself too.
  const tickWaiters = new Set<() => void>();
  const tickIdle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!running) {
        resolve();
        return;
      }
      tickWaiters.add(resolve);
    });
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Anchor the watch deadline at the tick start (master §1).
      const tickStart = (deps.now ?? Date.now)();
      // Resolved per tick, not carried: a tick whose watch deps have gone away
      // must not keep writing watch files through the previous tick's seam.
      watchSeam = undefined;
      const archiveCoordinator = deps.getArchiveCoordinator?.();
      const live = deps.workspaceRegistry.listAll();
      const liveCwds = new Set(live.map((r) => r.workspaceCwd));
      // Daemon PR-state watch observation (master design §1), gated off in
      // this increment. It runs BEFORE the state refresh so the observation
      // gets the tick-start deadline window even when the refresh is slow:
      // a refresh that outruns half the interval would otherwise leave the
      // observation no time and starve every workspace's views. With the
      // switch off this block is inert — no gh pr view, no watch-file write,
      // no ownership claim — and the refresh below is unchanged. The
      // workspace order rotates per tick so a persistent deadline overrun
      // starves no workspace; the untrusted primary is included for views
      // only (its env resolver runs no gh in the checkout).
      if (deps.observationEnabled ?? SESSION_PR_WATCH_OBSERVATION_ENABLED) {
        const watchDeps = deps.getPrWatchDeps?.();
        if (watchDeps) {
          activeWatchDir = watchDeps.watchDir;
          watchSeam = {
            watchDir: watchDeps.watchDir,
            locks: watchDeps.locks,
            allowedHosts: watchDeps.allowedHosts,
            // Without this the seam's `log` is a declared-and-read field with
            // no setter, and every listing-write refusal stays silent — the
            // claim's contract is that a blocked outcome is always logged.
            ...(watchDeps.log ? { log: watchDeps.log } : {}),
          };
          const watchWorkspaces = live.filter((r) => r.trusted || r.primary);
          const rotation = watchTickCount % Math.max(watchWorkspaces.length, 1);
          const ordered = [
            ...watchWorkspaces.slice(rotation),
            ...watchWorkspaces.slice(0, rotation),
          ];
          watchTickCount += 1;
          try {
            await runPrWatchObservationTick(ordered, watchDeps, {
              intervalMs,
              sweepOffsets: githubSweepOffsets,
              listedKeysByWorkspace,
              deadline: tickStart + intervalMs / 2,
            });
          } catch (error) {
            if (error instanceof DaemonDrainingError) return;
            // A failed observation tick must not starve the state refresh,
            // but log it: every other failure path in the watch logs, and a
            // tick that throws every tick would otherwise be invisible while
            // the switch is on.
            process.stderr.write(
              `[serve] PR watch observation tick failed: ${String(error)}\n`,
            );
          }
          for (const cwd of [...githubSweepOffsets.keys()]) {
            if (!liveCwds.has(cwd)) githubSweepOffsets.delete(cwd);
          }
          for (const cwd of [...listedKeysByWorkspace.keys()]) {
            if (!liveCwds.has(cwd)) listedKeysByWorkspace.delete(cwd);
          }
          // Delivery drain (master §4/§5): runs after the observation so it
          // can deliver the transitions this tick detected. Behind the same
          // off switch and its own unpopulated deps seam, so it is inert until
          // the enablement increment. Restores run off-tick inside the drain.
          const drainDeps = deps.getPrDrainDeps?.();
          if (drainDeps) {
            // `listAll()` omits every non-active entry, so a draining or
            // transitioning workspace's bindings are unknown, not absent.
            // Tell the drain before it makes a complete-scan deletion.
            const coveragePartial = deps.workspaceRegistry
              .listAllEntries()
              .some(
                (entry) => entry.state !== 'active' || !entry.current?.runtime,
              );
            try {
              await runPrWatchDrainTick(
                ordered,
                drainDeps,
                prDrainState,
                coveragePartial,
              );
            } catch (error) {
              if (error instanceof DaemonDrainingError) return;
              process.stderr.write(
                `[serve] PR watch drain tick failed: ${String(error)}\n`,
              );
            }
          }
        }
      }
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
              ...(watchSeam ? { prWatch: watchSeam } : {}),
            },
          );
          // Only trusted workspaces are refreshed, so the untrusted primary
          // never contributes keys. Its closed PRs therefore stay in the view
          // rotation — more views, never a missed reopen.
          if (result.listedKeys !== undefined) {
            listedKeysByWorkspace.set(runtime.workspaceCwd, result.listedKeys);
          } else {
            listedKeysByWorkspace.delete(runtime.workspaceCwd);
          }
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
      for (const cwd of [...aoneSweepOffsets.keys()]) {
        if (!liveCwds.has(cwd)) aoneSweepOffsets.delete(cwd);
      }
    } finally {
      running = false;
      for (const resolve of tickWaiters) resolve();
      tickWaiters.clear();
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  const dispose = (): void => {
    clearTimeout(first);
    clearInterval(timer);
  };
  return {
    dispose,
    /**
     * Stop the PR watch in the order master §2 requires: stop the timer, let
     * the in-flight observation, restores and admissions settle, then release
     * the owner record. A daemon that never ran the gated block has nothing to
     * stop and reads no seam, so the off state stays inert through shutdown too.
     */
    async stopWatch(): Promise<void> {
      stopped = true;
      if (activeWatchDir === undefined) {
        dispose();
        return;
      }
      await stopPrWatch({
        state: prDrainState,
        watchDir: activeWatchDir,
        stopTimer: dispose,
        waitForTick: tickIdle,
        log: (message) => process.stderr.write(`[serve] ${message}\n`),
      });
    },
    /**
     * Deliver a just-restored session's pending transitions without waiting for
     * the next tick (design §2). Runs on this timer's own drain state: a second
     * state would not see the in-flight marks and could deliver twice.
     *
     * Coverage is declared partial on purpose. Only one workspace is scanned,
     * so every other workspace's bindings are absent from the rows — a complete
     * scan would let the drain delete their watch files as unbound.
     */
    async drainNow(workspaceCwd: string): Promise<void> {
      // Same gate as the tick: with the switch off the watch is inert, and a
      // resume must not deliver from watch files a previous owner left behind.
      if (!(deps.observationEnabled ?? SESSION_PR_WATCH_OBSERVATION_ENABLED)) {
        return;
      }
      const drainDeps = deps.getPrDrainDeps?.();
      if (!drainDeps) return;
      const runtime = deps.workspaceRegistry
        .listAll()
        .find((candidate) => candidate.workspaceCwd === workspaceCwd);
      // Same trust filter as the tick's watch workspaces: an untrusted
      // non-primary is never observed, so it must not be drained on demand
      // either — the ledger would run git in its checkout.
      if (!runtime || !(runtime.trusted || runtime.primary)) return;
      // This drain claims the owner record too, and the first tick is a minute
      // away, so shutdown has to learn about the claim here as well. Otherwise
      // stopWatch takes its "nothing to stop" return, never waits for the
      // restores dispatched below, and leaves a record a successor reads as
      // held by a live pid — its whole watch stays inert until this process
      // dies. No await separates the latch check from the assignment.
      if (stopped) return;
      activeWatchDir = drainDeps.watchDir;
      await runPrWatchDrainTick([runtime], drainDeps, prDrainState, true);
    },
  };
}
