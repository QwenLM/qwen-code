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
import {
  fetchGitHubPullRequests,
  fetchRemoteWebUrl,
  readSessionPrs,
  repoKeyFromWebUrl,
  updateSessionPrStates,
  type SessionPrState,
} from '@qwen-code/qwen-code-core';
import { isValidSessionId } from '../../config/session-id.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export const DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * `QWEN_SESSION_PR_REFRESH_MINUTES`: refresh interval in minutes; `0`
 * disables the sweep. Missing/invalid values fall back to the default.
 */
export function resolveSessionPrRefreshIntervalMs(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env['QWEN_SESSION_PR_REFRESH_MINUTES'];
  if (raw === undefined) return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  }
  if (minutes === 0) return undefined;
  return minutes * 60_000;
}

export interface SessionPrRefreshResult {
  /** Sidecars read (sessions with at least one binding). */
  scanned: number;
  /** Bindings whose state was rewritten (open → merged/closed). */
  updated: number;
}

/**
 * Refreshes the persisted `state` snapshot of one workspace's PR bindings.
 * Only merged is terminal (closed PRs can reopen), so workspaces whose
 * bindings are all merged cost no `gh` call at all. One slim
 * `gh pr list --state all` per workspace per sweep; rewritten in place
 * (order and createdAt preserved).
 */
export async function refreshWorkspaceSessionPrStates(
  runtime: WorkspaceRuntime,
  fetchPullRequests: typeof fetchGitHubPullRequests = fetchGitHubPullRequests,
  resolveRemoteWebUrl: (cwd: string) => Promise<string | undefined> = (cwd) =>
    fetchRemoteWebUrl(cwd, runtime.env.effectiveEnv),
): Promise<SessionPrRefreshResult> {
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const pendingBindings: Array<{
    prPath: string;
    bindings: Array<{ number: number; url: string }>;
  }> = [];
  let scanned = 0;
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
        // record and names the sidecar path below — a traversal id must be
        // rejected before path construction (the backfill route shares
        // this sink).
        if (!isValidSessionId(item.sessionId)) continue;
        const prPath = sessionService.getPrSessionPathForArchiveState(
          item.sessionId,
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
        const bindings = prs
          // Only merged is terminal: closed PRs can be reopened, so they
          // keep participating in the sweep.
          .filter((p) => p.state !== 'merged')
          .map((p) => ({ number: p.number, url: p.url }));
        if (bindings.length > 0) {
          pendingBindings.push({ prPath, bindings });
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  if (pendingBindings.length === 0) return { scanned, updated: 0 };

  // PR numbers are dense small integers — stamping states by bare number
  // would hit a same-numbered PR of another repository whenever a
  // binding's URL points elsewhere. Each binding's own URL names its
  // repository, so only bindings belonging to a repository this run
  // actually queried are updated.
  const remoteWebUrl = await resolveRemoteWebUrl(runtime.workspaceCwd);
  const workspaceRepoKey = remoteWebUrl
    ? repoKeyFromWebUrl(remoteWebUrl)
    : undefined;

  const result = await fetchPullRequests(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
    { state: 'all', limit: 500, slim: true },
  );
  if (result.kind !== 'ok') return { scanned, updated: 0 };
  const numberToState = new Map<number, SessionPrState>();
  for (const pr of result.pullRequests) {
    // The sidecar snapshot has no 'draft' variant — a draft is still open.
    numberToState.set(pr.number, pr.state === 'draft' ? 'open' : pr.state);
  }

  // Stamping authority is the repository this run actually queried, and the
  // page's own URLs name it. In the fork layout origin is the fork while
  // gh lists the PARENT repo's PRs — the same repo the writers bind — so
  // gating on the origin key alone would freeze every fork-layout binding.
  // Accept both identities; bindings matching neither stay skipped.
  const acceptedRepoKeys = new Set<string>();
  if (workspaceRepoKey) acceptedRepoKeys.add(workspaceRepoKey);
  for (const pr of result.pullRequests) {
    const key = repoKeyFromWebUrl(pr.url);
    if (key) acceptedRepoKeys.add(key);
  }

  let updated = 0;
  for (const target of pendingBindings) {
    const states = new Map<number, SessionPrState>();
    for (const binding of target.bindings) {
      const bindingRepoKey = repoKeyFromWebUrl(binding.url);
      if (!bindingRepoKey || !acceptedRepoKeys.has(bindingRepoKey)) continue;
      const state = numberToState.get(binding.number);
      // Only a number ABSENT from gh's page is skipped (out of the limit
      // window); a present one is authoritative — including an 'open' that
      // supersedes a stale 'closed' after a reopen.
      if (state !== undefined) states.set(binding.number, state);
    }
    if (states.size === 0) continue;
    updated += await updateSessionPrStates(target.prPath, states);
  }
  return { scanned, updated };
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
}): { dispose(): void } | undefined {
  const intervalMs = resolveSessionPrRefreshIntervalMs(deps.env ?? process.env);
  if (intervalMs === undefined) return undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const runtime of deps.workspaceRegistry.listAll()) {
        if (!runtime.trusted) continue;
        try {
          await refreshWorkspaceSessionPrStates(runtime);
        } catch {
          // A single workspace's failure must not starve the rest.
        }
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
