/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  fetchGitHubPullRequestView,
  type GitHubPullRequestView,
} from '@qwen-code/qwen-code-core/utils/github-prs.js';
import type { SessionPrBindingSummary } from '../routes/session-pr-bindings.js';
import { scanWorkspaceBindings } from '../routes/session-pr-bindings.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import type { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  claimPrWatchOwnershipSync,
  PR_WATCH_CI_FIRED_CAP,
  PR_WATCH_PENDING_CAP,
  prWatchFileKey,
  prWatchFilePath,
  readPrWatchStateSync,
  writePrWatchStateSync,
  type PrTransitionType,
  type PrWatchIdentity,
  type PrWatchState,
} from './pr-watch-store.js';
import { pullRequestKey } from './session-pr-url.js';

/**
 * A fresh observation of one PR, as `fetchGitHubPullRequestView` reports it.
 * `mergeable` absent means GitHub returned `UNKNOWN` (still computing); the
 * stored value is then preserved and no conflict transition fires.
 */
export interface PrWatchObservation {
  state: 'open' | 'merged' | 'closed';
  title?: string;
  headSha: string;
  checks: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  /** Untrusted failing rollup names, in rollup order. */
  failingChecks?: string[];
}

export interface DetectedPrTransition {
  type: PrTransitionType;
  key: string;
  summary: string;
  detectedAt: string;
}

export interface PrWatchDetection {
  /** The next watch state to persist (observation + ciFired + pending). */
  state: PrWatchState;
  /** Transitions detected by this observation, oldest first. */
  transitions: DetectedPrTransition[];
}

/**
 * The prompt route's `idempotencyKey` cap; must match
 * `PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH` in routes/session-prompt-admission.ts.
 * Delivery admits the key suffixed with `:<group>` (master §3/§4), so the
 * base key reserves room for the longest suffix (`:untyped`); otherwise a
 * base key near the cap would exceed it once suffixed and be rejected.
 */
const TRANSITION_KEY_MAX_LENGTH = 200;
const MAX_ROLE_GROUP_SUFFIX_LENGTH = ':untyped'.length;
const FAILING_CHECKS_IN_SUMMARY = 5;

function transitionKey(
  identity: PrWatchIdentity,
  type: PrTransitionType,
  detail: string,
  detectedAt: string,
): string {
  const raw = `pr-state:${identity.repo}#${identity.number}:${type}:${detail}:${detectedAt}`;
  if (raw.length + MAX_ROLE_GROUP_SUFFIX_LENGTH <= TRANSITION_KEY_MAX_LENGTH) {
    return raw;
  }
  return `pr-state:h:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

/**
 * Compare a fresh observation with the PR's last watch state and produce the
 * next state plus the transitions it fires (master design §3). Pure: no I/O,
 * no clock — the caller stamps `detectedAt` with the observation's start time
 * and persists the result under the PR's lock.
 *
 * A first observation — no previous file, or a slim-only file with no
 * `headSha` — initialises silently and fires nothing, even if CI is already
 * failing or the PR is already conflicting.
 */
export function detectPrTransitions(
  identity: PrWatchIdentity,
  previous: PrWatchState | undefined,
  observation: PrWatchObservation,
  detectedAt: string,
): PrWatchDetection {
  const transitions: DetectedPrTransition[] = [];
  const prevHead = previous?.headSha;
  // Once a file has a headSha it is baselined; a slim-only file (state and
  // observedAt only) initialises silently on its first full view.
  const baselined = previous !== undefined && prevHead !== undefined;

  // UNKNOWN never overwrites the last known mergeability.
  const mergeable = observation.mergeable ?? previous?.mergeable;

  let ciFired = previous?.ciFired ? [...previous.ciFired] : [];

  if (baselined) {
    if (prevHead !== observation.headSha) {
      transitions.push({
        type: 'head_change',
        key: transitionKey(
          identity,
          'head_change',
          `${prevHead}→${observation.headSha}`,
          detectedAt,
        ),
        summary: `head changed ${prevHead} → ${observation.headSha}`,
        detectedAt,
      });
    }

    // Once per head: a head already in ciFired never fires again, and a head
    // that was already failing at the previous observation is not a new edge.
    // A new head resets the comparison (its first failing observation fires).
    const sameHeadAlreadyFailing =
      prevHead === observation.headSha && previous?.checks === 'failing';
    if (
      observation.checks === 'failing' &&
      !ciFired.includes(observation.headSha) &&
      !sameHeadAlreadyFailing
    ) {
      ciFired = [...ciFired, observation.headSha].slice(-PR_WATCH_CI_FIRED_CAP);
      const names = (observation.failingChecks ?? []).slice(
        0,
        FAILING_CHECKS_IN_SUMMARY,
      );
      transitions.push({
        type: 'ci_failure',
        key: transitionKey(
          identity,
          'ci_failure',
          observation.headSha,
          detectedAt,
        ),
        summary:
          names.length > 0 ? `CI failing: ${names.join(', ')}` : 'CI failing',
        detectedAt,
      });
    }

    // Edge-triggered into conflicting; a never-known mergeable counts as
    // non-conflicting once the file has a headSha.
    if (
      observation.mergeable === 'conflicting' &&
      previous?.mergeable !== 'conflicting'
    ) {
      transitions.push({
        type: 'merge_conflict',
        key: transitionKey(
          identity,
          'merge_conflict',
          observation.headSha,
          detectedAt,
        ),
        summary: 'merge conflict detected',
        detectedAt,
      });
    }

    if (previous?.state === 'open' && observation.state !== 'open') {
      transitions.push({
        type: 'state_change',
        key: transitionKey(
          identity,
          'state_change',
          `${previous.state}→${observation.state}`,
          detectedAt,
        ),
        summary: `PR ${observation.state}`,
        detectedAt,
      });
    }
  }

  const pending = [
    ...(previous?.pending ?? []),
    ...transitions.map(({ type, key, summary, detectedAt: at }) => ({
      type,
      key,
      summary,
      detectedAt: at,
    })),
  ].slice(-PR_WATCH_PENDING_CAP);

  const state: PrWatchState = {
    pr: {
      host: identity.host,
      repo: identity.repo,
      number: identity.number,
    },
    ...(previous?.lastBoundAt !== undefined
      ? { lastBoundAt: previous.lastBoundAt }
      : {}),
    observedAt: detectedAt,
    state: observation.state,
    ...(observation.title !== undefined ? { title: observation.title } : {}),
    headSha: observation.headSha,
    checks: observation.checks,
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(ciFired.length > 0 ? { ciFired } : {}),
    ...(previous?.delivered !== undefined
      ? { delivered: [...previous.delivered] }
      : {}),
    ...(pending.length > 0 ? { pending } : {}),
  };

  return { state, transitions };
}

/** View cap per workspace sweep (master design §1). */
export const PR_WATCH_VIEW_CAP = 30;

/** Normalise a host for the allowed-host comparison: lowercase, no `www.`. */
export function normalizeWatchHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * The watch identity of a binding URL, normalised exactly as `pullRequestKey`
 * normalises it (host lowercased with `www.` stripped and port dropped). The
 * `host/owner/repo` key is split into the store's `host` + `owner/repo`.
 */
export function prWatchIdentityFromUrl(
  url: string,
): PrWatchIdentity | undefined {
  const key = pullRequestKey(url);
  if (!key) return undefined;
  const slash = key.repo.indexOf('/');
  if (slash <= 0) return undefined;
  return {
    host: key.repo.slice(0, slash),
    repo: key.repo.slice(slash + 1),
    number: key.number,
  };
}

export interface PrWatchObservationDeps {
  /** Daemon-private watch directory; also the view's working directory. */
  watchDir: string;
  locks: PathMutexRegistry;
  /** Normalised allowed hosts (see {@link normalizeWatchHost}). */
  allowedHosts: ReadonlySet<string>;
  /** The swept workspace's environment (its own GH_TOKEN/GH_CONFIG_DIR). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam; defaults to {@link fetchGitHubPullRequestView}. */
  viewPullRequest?: typeof fetchGitHubPullRequestView;
  /**
   * Asserts the swept workspace's generation is still open before each view,
   * so a retired generation never runs `gh` with its stale env (the refresh
   * asserts the same guard). A throw skips the view fail-closed.
   */
  assertGenerationOpen?: () => void;
  now?: () => number;
  log?: (message: string) => void;
}

export interface ObserveWorkspacePrBindingsOptions {
  /** Rotating window start into the view set; the timer advances it. */
  sweepStart?: number;
  /** Absolute ms deadline; no view starts past it (one may run out). */
  deadline?: number;
  /** PR keys the slim listing returned this sweep (closed-not-listed view). */
  listedKeys?: ReadonlySet<string>;
  /** PR keys already viewed this tick, for cross-workspace dedup. */
  viewedThisTick?: Set<string>;
  cap?: number;
}

export interface ObserveWorkspacePrBindingsResult {
  /** Views actually started (the timer advances the rotation by this). */
  consumed: number;
  /** Views accepted and written to a watch file. */
  observed: number;
  /** Views that failed or were discarded (host/number mismatch). */
  failed: number;
}

interface ViewTarget {
  identity: PrWatchIdentity;
  key: string;
  url: string;
}

function observationFromView(view: GitHubPullRequestView): PrWatchObservation {
  return {
    state: view.state,
    title: view.title,
    headSha: view.headSha,
    checks: view.checks,
    ...(view.mergeable !== undefined ? { mergeable: view.mergeable } : {}),
    failingChecks: view.failingChecks,
  };
}

/**
 * Observe one workspace's bound PRs and detect transitions into their watch
 * files (master design §1 + §3). No delivery: detected transitions accumulate
 * in `pending` for the drain increment. The caller holds ownership of the
 * watch directory; a non-owner must not call this. Each watch-file mutation
 * runs under the PR's `PathMutexRegistry` lock (the view-set's state read is a
 * non-authoritative pre-check outside the lock); a read error other than
 * absent/invalid skips the PR for the tick (fail closed).
 */
export async function observeWorkspacePrBindings(
  bindings: readonly SessionPrBindingSummary[],
  deps: PrWatchObservationDeps,
  options: ObserveWorkspacePrBindingsOptions = {},
): Promise<ObserveWorkspacePrBindingsResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const view = deps.viewPullRequest ?? fetchGitHubPullRequestView;
  const cap = options.cap ?? PR_WATCH_VIEW_CAP;

  // Build the unique view set: open bound PRs plus closed PRs the listing
  // did not return; merged is terminal by the newest observation.
  const targets = new Map<string, ViewTarget>();
  for (const summary of bindings) {
    for (const entry of summary.prs) {
      const identity = prWatchIdentityFromUrl(entry.url);
      if (!identity) continue;
      const key = prWatchFileKey(identity);
      if (targets.has(key)) continue;
      if (!deps.allowedHosts.has(normalizeWatchHost(identity.host))) {
        log(
          `PR watch: skipping binding on non-allowed host ${identity.host} for ${identity.repo}#${identity.number}`,
        );
        continue;
      }
      const existing = readPrWatchStateSync(deps.watchDir, identity);
      const effectiveState =
        existing.kind === 'state' ? existing.state.state : entry.state;
      if (effectiveState === 'merged') continue;
      if (effectiveState === 'closed' && options.listedKeys?.has(key)) {
        // The slim listing observes a closed PR it returns; only a closed PR
        // outside the listing stays in the view rotation to catch a reopen.
        continue;
      }
      targets.set(key, { identity, key, url: entry.url });
    }
  }

  const all = [...targets.values()];
  const start = all.length === 0 ? 0 : (options.sweepStart ?? 0) % all.length;
  const rotated = [...all.slice(start), ...all.slice(0, start)];

  let consumed = 0;
  let observed = 0;
  let failed = 0;
  for (const target of rotated) {
    // The cap bounds views actually started, not the rotated window: a PR
    // already viewed by another workspace this tick is skipped without
    // consuming the cap (master §1), so unique PRs past it are still observed.
    if (consumed >= cap) break;
    if (options.deadline !== undefined && now() > options.deadline) break;
    if (options.viewedThisTick?.has(target.key)) continue;
    consumed += 1;
    const startedAt = now();
    const detectedAt = new Date(startedAt).toISOString();
    let result: Awaited<ReturnType<typeof fetchGitHubPullRequestView>>;
    try {
      // A retired generation must not run gh with its stale env.
      deps.assertGenerationOpen?.();
      result = await view(target.url, deps.watchDir, deps.env);
    } catch (error) {
      failed += 1;
      log(
        `PR watch: view failed for ${target.identity.repo}#${target.identity.number}: ${String(error)}`,
      );
      continue;
    }
    if (result.kind !== 'ok') {
      failed += 1;
      log(
        `PR watch: view unavailable for ${target.identity.repo}#${target.identity.number}: ${result.kind}`,
      );
      continue;
    }
    // Identity check by host and number only: a renamed/transferred repository
    // (same host and number, different owner/repo) is accepted and logged.
    const viewIdentity = prWatchIdentityFromUrl(result.view.url);
    if (
      !viewIdentity ||
      normalizeWatchHost(viewIdentity.host) !==
        normalizeWatchHost(target.identity.host) ||
      viewIdentity.number !== target.identity.number
    ) {
      failed += 1;
      log(
        `PR watch: discarding view of ${result.view.url} for binding ${target.identity.repo}#${target.identity.number} (host or number mismatch)`,
      );
      continue;
    }
    if (viewIdentity.repo !== target.identity.repo) {
      log(
        `PR watch: ${target.identity.repo}#${target.identity.number} resolved to renamed repository ${viewIdentity.repo}; keeping the binding's own watch file`,
      );
    }
    const filePath = prWatchFilePath(deps.watchDir, target.identity);
    try {
      await deps.locks.runExclusive(filePath, async () => {
        const read = readPrWatchStateSync(deps.watchDir, target.identity);
        if (read.kind === 'error') {
          // Fail closed: leave the file and its pending entries intact.
          failed += 1;
          log(
            `PR watch: read error for ${filePath}; skipping this tick: ${String(read.error)}`,
          );
          return;
        }
        const previous = read.kind === 'state' ? read.state : undefined;
        // A slow view can never roll the baseline back.
        if (
          previous?.observedAt !== undefined &&
          startedAt < Date.parse(previous.observedAt)
        ) {
          return;
        }
        const detection = detectPrTransitions(
          target.identity,
          previous,
          observationFromView(result.view),
          detectedAt,
        );
        if (
          (previous?.pending?.length ?? 0) + detection.transitions.length >
          PR_WATCH_PENDING_CAP
        ) {
          log(
            `PR watch: pending overflow for ${target.identity.repo}#${target.identity.number}; dropping the oldest entries (cap ${PR_WATCH_PENDING_CAP})`,
          );
        }
        writePrWatchStateSync(deps.watchDir, target.identity, detection.state);
        options.viewedThisTick?.add(target.key);
        observed += 1;
      });
    } catch (error) {
      failed += 1;
      log(
        `PR watch: write failed for ${target.identity.repo}#${target.identity.number}: ${String(error)}`,
      );
    }
  }
  return { consumed, observed, failed };
}

export interface PrWatchObservationTickDeps {
  watchDir: string;
  locks: PathMutexRegistry;
  allowedHosts: ReadonlySet<string>;
  /**
   * Per-workspace view environment. Trusted workspaces use their own
   * effectiveEnv; the untrusted primary uses the daemon's own environment
   * (no gh runs in its checkout). Defaults to the workspace's effectiveEnv.
   */
  envForWorkspace?: (
    runtime: WorkspaceRuntime,
  ) => Readonly<Record<string, string | undefined>>;
  viewPullRequest?: typeof fetchGitHubPullRequestView;
  now?: () => number;
  log?: (message: string) => void;
}

export interface PrWatchObservationTickOptions {
  /** Refresh interval; the tick deadline is half of it. */
  intervalMs: number;
  /** Per-workspace rotating GitHub view offset, kept across ticks. */
  sweepOffsets: Map<string, number>;
  /**
   * Absolute tick-level deadline (master §1: tick start + half the interval).
   * The timer computes it when the tick starts, before the state refresh, so
   * a slow refresh cannot push the observation deadline past the interval.
   * Defaults to now() + intervalMs/2 when omitted.
   */
  deadline?: number;
}

/**
 * One daemon PR-watch observation tick (master design §1): claim the watch
 * ownership, then observe each workspace's bound PRs under one tick-level
 * deadline, advancing the per-workspace rotating window and deduplicating a
 * PR viewed by an earlier workspace in the same tick. A daemon that does not
 * hold the owner record observes nothing. The caller passes the workspaces in
 * the tick's rotated order (trusted plus the untrusted primary). No delivery:
 * detected transitions accumulate in the watch files' `pending`.
 */
export async function runPrWatchObservationTick(
  workspaces: readonly WorkspaceRuntime[],
  deps: PrWatchObservationTickDeps,
  options: PrWatchObservationTickOptions,
): Promise<{ claimed: boolean; observed: number }> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const claim = claimPrWatchOwnershipSync(deps.watchDir, log);
  if (claim.kind === 'blocked') {
    // A non-owner views, writes, drains and deletes nothing.
    return { claimed: false, observed: 0 };
  }
  const deadline = options.deadline ?? now() + options.intervalMs / 2;
  const viewedThisTick = new Set<string>();
  let observed = 0;
  for (const runtime of workspaces) {
    const bindings: SessionPrBindingSummary[] = [];
    try {
      await scanWorkspaceBindings(runtime, bindings);
    } catch (error) {
      log(
        `PR watch: bindings scan failed for ${runtime.workspaceCwd}: ${String(error)}`,
      );
      continue;
    }
    const sweepStart = options.sweepOffsets.get(runtime.workspaceCwd) ?? 0;
    const result = await observeWorkspacePrBindings(
      bindings,
      {
        watchDir: deps.watchDir,
        locks: deps.locks,
        allowedHosts: deps.allowedHosts,
        env: deps.envForWorkspace
          ? deps.envForWorkspace(runtime)
          : runtime.env.effectiveEnv,
        viewPullRequest: deps.viewPullRequest,
        assertGenerationOpen: () => runtime.generationGuard?.assertOpen(),
        now,
        log,
      },
      { sweepStart, deadline, viewedThisTick },
    );
    options.sweepOffsets.set(
      runtime.workspaceCwd,
      sweepStart + result.consumed,
    );
    observed += result.observed;
  }
  return { claimed: true, observed };
}
