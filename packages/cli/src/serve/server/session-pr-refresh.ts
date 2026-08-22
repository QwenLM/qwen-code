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
  readSessionPrs,
  updateSessionPrStates,
  type SessionPrState,
} from '@qwen-code/qwen-code-core';
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
): Promise<SessionPrRefreshResult> {
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const pendingNumbers: Array<{ prPath: string; numbers: number[] }> = [];
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
        const numbers = prs
          // Only merged is terminal: closed PRs can be reopened, so they
          // keep participating in the sweep.
          .filter((p) => p.state !== 'merged')
          .map((p) => p.number);
        if (numbers.length > 0) {
          pendingNumbers.push({ prPath, numbers });
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  if (pendingNumbers.length === 0) return { scanned, updated: 0 };

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

  let updated = 0;
  for (const target of pendingNumbers) {
    const states = new Map<number, SessionPrState>();
    for (const number of target.numbers) {
      const state = numberToState.get(number);
      // Only a number ABSENT from gh's page is skipped (out of the limit
      // window); a present one is authoritative — including an 'open' that
      // supersedes a stale 'closed' after a reopen.
      if (state !== undefined) states.set(number, state);
    }
    if (states.size === 0) continue;
    if (await updateSessionPrStates(target.prPath, states)) {
      updated += states.size;
    }
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
