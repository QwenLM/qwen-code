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
}

/**
 * Refreshes the persisted `state` and `issues` snapshots of one workspace's
 * PR bindings. Only merged is terminal (closed PRs can reopen), so
 * workspaces whose bindings are all merged — with an issue snapshot in
 * place — cost no `gh` call at all. Per workspace per sweep: one slim
 * `gh pr list --state all` for states, and one by-number GraphQL lookup
 * for the closing issues (which can change while the PR is open, and which
 * legacy bindings lack). Rewritten in place (order and createdAt
 * preserved).
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
  }> = [];
  let needsStates = false;
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
      // Only merged is terminal: closed PRs can be reopened, so they keep
      // participating in the sweep. A merged binding still needs one lookup
      // when it predates the issue snapshot.
      if (prs.some((p) => p.state !== 'merged')) needsStates = true;
      const numbers = prs
        .filter((p) => p.state !== 'merged' || p.issues === undefined)
        .map((p) => p.number);
      if (numbers.length > 0) {
        pendingNumbers.push({ sessionId, prPath, numbers });
      }
    }
  }
  if (pendingNumbers.length === 0) return { scanned, updated: 0 };

  // The url rides along with the snapshot: the map is keyed by number, but a
  // binding may point at another repository whose same-numbered PR must
  // never supply this workspace's state or issues.
  const numberToFetch = new Map<
    number,
    { state?: SessionPrState; url: string; issues?: SessionPrIssue[] }
  >();
  if (needsStates) {
    assertGenerationOpen();
    const result = await fetchPullRequests(
      runtime.workspaceCwd,
      runtime.env.effectiveEnv,
      { state: 'all', limit: 500, slim: true },
    );
    if (result.kind === 'ok') {
      for (const pr of result.pullRequests) {
        // The sidecar snapshot has no 'draft' variant — a draft is still open.
        numberToFetch.set(pr.number, {
          state: pr.state === 'draft' ? 'open' : pr.state,
          url: pr.url,
        });
      }
    }
  }
  assertGenerationOpen();
  const issuesResult = await fetchGitHubPullRequestIssues(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv,
    [...new Set(pendingNumbers.flatMap((target) => target.numbers))],
  );
  if (issuesResult.kind === 'ok') {
    for (const [number, { url, issues }] of issuesResult.pullRequests) {
      // Both queries resolve the same repository, so a number present in
      // both names one PR; the state (if any) stays from the list query.
      numberToFetch.set(number, {
        ...(numberToFetch.get(number) ?? { url }),
        issues,
      });
    }
  }
  if (numberToFetch.size === 0) return { scanned, updated: 0 };

  let updated = 0;
  for (const target of pendingNumbers) {
    const states = new Map<
      number,
      { state?: SessionPrState; url: string; issues?: SessionPrIssue[] }
    >();
    for (const number of target.numbers) {
      const fetched = numberToFetch.get(number);
      // Only a number ABSENT from gh's page is skipped (out of the limit
      // window); a present one is authoritative — including an 'open' that
      // supersedes a stale 'closed' after a reopen.
      if (fetched !== undefined) states.set(number, fetched);
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
  /**
   * Resolved per tick (not at start) because the daemon parks the
   * coordinator on the serve app, which is built after this timer starts.
   */
  getArchiveCoordinator?: () => SessionPrArchiveLane | undefined;
}): { dispose(): void } | undefined {
  const intervalMs = resolveSessionPrRefreshIntervalMs(deps.env ?? process.env);
  if (intervalMs === undefined) return undefined;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const archiveCoordinator = deps.getArchiveCoordinator?.();
      for (const runtime of deps.workspaceRegistry.listAll()) {
        if (!runtime.trusted) continue;
        try {
          await refreshWorkspaceSessionPrStates(runtime, undefined, {
            archiveCoordinator,
          });
        } catch (error) {
          // A draining daemon rejects every workspace the same way.
          if (error instanceof DaemonDrainingError) return;
          // A single workspace's failure (including a generation retired
          // mid-sweep) must not starve the rest.
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
