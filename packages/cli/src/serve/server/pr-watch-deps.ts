/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import { resolveGithubWebOrigin } from '@qwen-code/channel-github/web-origin';
import { defaultPrWatchDir } from './pr-watch-store.js';
import { readGhConfiguredHosts } from './pr-watch-gh-hosts.js';
import {
  normalizeWatchHost,
  prWatchIdentityFromUrl,
  type PrWatchObservationTickDeps,
} from './pr-watch-observation.js';
import type {
  PrWatchDrainDeps,
  PrWatchRecipient,
  PrWatchWakeOutcome,
} from './pr-watch-drain.js';
import {
  scanWorkspaceBindings,
  type SessionPrBindingSummary,
} from '../routes/session-pr-bindings.js';
import {
  admitSessionPrompt,
  type SessionPromptAdmissionDeps,
} from '../routes/session-prompt-admission.js';
import { cloneWorktreesOf } from '../routes/autofix-pr-watches.js';
import {
  autofixPrPaths,
  readState,
  sameRepository,
  vouchedScanRoots,
} from '../../commands/autofix-pr/state.js';
import {
  SessionArchivedError,
  SessionNotFoundError,
} from '../acp-session-bridge.js';
import {
  WorktreeMarkerMissingError,
  WorktreeResetInterruptedError,
  WorktreeSessionSupersededError,
} from './worktree-reset-errors.js';
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import type { SessionArchiveCoordinator } from './session-archive.js';
import type { SessionRestoreResult } from './session-restore.js';
import type { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

/**
 * The restore the serve root supplies, with the app-level options the core
 * needs (admission, replay modes, telemetry). Injected rather than rebuilt
 * here so this module never has to know how the route parses a request.
 */
type PrWatchRestore = (input: {
  runtime: WorkspaceRuntime;
  workspaceCwd: string;
  sessionId: string;
  archiveCoordinator: SessionArchiveCoordinator;
}) => Promise<SessionRestoreResult>;

export interface PrWatchDepsSources {
  workspaceRegistry: WorkspaceRegistry;
  /** Late-bound: the serve app is built after the refresh timer starts. */
  archiveCoordinator: () => SessionArchiveCoordinator | undefined;
  /**
   * Late-bound for the same reason. Only an internal (live-conversation)
   * runtime needs it, and an admission there without it is refused rather
   * than run ungated — the route does the same.
   */
  conversationRuntimeActivity?: () =>
    | ConversationRuntimeActivityGate
    | undefined;
  restore: PrWatchRestore;
  /**
   * Base URLs of the GitHub channels this daemon hosts, already filtered to
   * trusted workspaces by the caller. An untrusted workspace's settings must
   * never widen the allowed set.
   */
  hostedChannelBaseUrls: () => readonly unknown[];
  daemonLog?: DaemonLogger;
  log?: (message: string) => void;
  now?: () => number;
  /**
   * Reuse an existing registry when rebuilding after the hosted channels
   * change. A fresh one would give the observation and the drain different
   * in-process locks for the same files if a rebuild lands between their two
   * reads (master §2).
   */
  locks?: PathMutexRegistry;
}

export interface PrWatchDeps {
  watch: PrWatchObservationTickDeps;
  drain: PrWatchDrainDeps;
}

/**
 * A recipient is permanently gone when the session cannot come back: it is
 * absent, archived, or its worktree ownership was superseded, lost or left
 * mid-reset. `session_writer_conflict` is deliberately NOT here — another
 * process holds the writer now and may release it, so the drain retries.
 */
function isGone(error: unknown): boolean {
  return (
    error instanceof SessionNotFoundError ||
    error instanceof SessionArchivedError ||
    error instanceof WorktreeSessionSupersededError ||
    error instanceof WorktreeMarkerMissingError ||
    error instanceof WorktreeResetInterruptedError
  );
}

/**
 * Builds both seams over one watch directory and one lock registry, so the
 * owner's in-process locks are authoritative for every file (master §2).
 *
 * The allowed set degrades to `github.com` plus the hosted channels when the
 * `gh` configuration cannot be read — never to an empty set, which would
 * silently disable every view.
 */
export function createPrWatchDeps(sources: PrWatchDepsSources): PrWatchDeps {
  const log = sources.log ?? (() => {});
  const watchDir = defaultPrWatchDir();
  const locks = sources.locks ?? new PathMutexRegistry();
  const allowedHosts = new Set<string>(['github.com']);
  for (const host of readGhConfiguredHosts(process.env, log)) {
    allowedHosts.add(host);
  }
  for (const baseUrl of sources.hostedChannelBaseUrls()) {
    // resolveGithubWebOrigin returns a web ORIGIN ("https://host"), not a bare
    // host, and normalizeWatchHost does not strip the scheme. The watch identity
    // carries a bare hostname with no port, so take hostname — not host.
    let hostname: string;
    try {
      hostname = new URL(resolveGithubWebOrigin(baseUrl)).hostname;
    } catch {
      continue;
    }
    allowedHosts.add(normalizeWatchHost(hostname));
  }

  // Trust can be revoked while the drain still retains the workspace's rows —
  // revocation makes the tick partial, and a partial tick keeps them — so the
  // recipient is re-gated here, not only where the tick picks its workspaces.
  // Primary stays exempt: it still serves bound sessions (bindings route).
  const resolveRuntime = (workspaceCwd: string): WorkspaceRuntime | undefined =>
    sources.workspaceRegistry
      .listAll()
      .find(
        (runtime) =>
          runtime.workspaceCwd === workspaceCwd &&
          (runtime.trusted || runtime.primary),
      );

  const liveSummary = (
    runtime: WorkspaceRuntime,
    sessionId: string,
  ): { worktree?: { path: string } } | undefined => {
    try {
      return runtime.bridge
        .listWorkspaceSessions(runtime.workspaceCwd)
        .find((summary) => summary.sessionId === sessionId);
    } catch {
      return undefined;
    }
  };

  const admissionDeps = (): SessionPromptAdmissionDeps | undefined => {
    const archiveCoordinator = sources.archiveCoordinator();
    if (!archiveCoordinator) return undefined;
    return {
      archiveCoordinator,
      ...(sources.daemonLog ? { daemonLog: sources.daemonLog } : {}),
    };
  };

  const runRuntimeActivity = <T>(
    runtime: WorkspaceRuntime,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (!isInternalWorkspaceRuntime(runtime)) return operation();
    const gate = sources.conversationRuntimeActivity?.();
    if (!gate) {
      throw new Error('PR watch: no conversations runtime activity gate');
    }
    return gate.run(operation);
  };

  const watch: PrWatchObservationTickDeps = {
    watchDir,
    locks,
    allowedHosts,
    log,
    ...(sources.now ? { now: sources.now } : {}),
  };

  const drain: PrWatchDrainDeps = {
    watchDir,
    locks,
    scanBindings: async (runtime) => {
      const bindings: SessionPrBindingSummary[] = [];
      const partial = await scanWorkspaceBindings(runtime, bindings);
      return { bindings, partial };
    },
    resolveRuntime,
    isSessionLive: (runtime, sessionId) =>
      liveSummary(runtime, sessionId) !== undefined,
    wakeSession: async (
      sessionId,
      workspaceCwd,
    ): Promise<PrWatchWakeOutcome> => {
      const runtime = resolveRuntime(workspaceCwd);
      const archiveCoordinator = sources.archiveCoordinator();
      if (!runtime || !archiveCoordinator) return { kind: 'unavailable' };
      let result: SessionRestoreResult;
      try {
        result = await sources.restore({
          runtime,
          workspaceCwd,
          sessionId,
          archiveCoordinator,
        });
      } catch (error) {
        if (isGone(error)) return { kind: 'gone' };
        log(`PR watch: wake unavailable for ${sessionId}: ${String(error)}`);
        return { kind: 'unavailable' };
      }
      if (result.kind !== 'restored') return { kind: 'unavailable' };
      const restored = result.session;
      return {
        kind: 'restored',
        release: async () => {
          // The core leaves the client it minted attached on success — its own
          // cleanup only runs on failure. The route has a real client to
          // detach it later; an in-process wake has none, so without this the
          // session keeps a phantom attachment and never idle-closes.
          // Detach only: killing would drop the turn the drain just admitted.
          await runtime.bridge
            .detachClient(restored.sessionId, restored.clientId)
            .catch(() => {});
        },
      };
    },
    admitPrompt: async (runtime, sessionId, promptText, idempotencyKey) => {
      const deps = admissionDeps();
      if (!deps) throw new Error('PR watch: no archive coordinator');
      // The caller obligations admitSessionPrompt documents, in the route's
      // order. Without the shared hold a concurrent archive takes its
      // exclusive lane, kills the session and drops the turn this admission
      // enqueues — while the drain records the entry delivered. The seal also
      // reaches the drain only through runSharedMany.
      return runRuntimeActivity(runtime, () =>
        deps.archiveCoordinator.runSharedMany([sessionId], async () => {
          runtime.generationGuard?.assertOpen();
          // Synchronous, so no await separates the assert from the call.
          const admission = admitSessionPrompt(deps, {
            runtime,
            sessionId,
            prompt: [{ type: 'text', text: promptText }],
            request: {},
            // Both flags: relayed text is an external sender's message, so no
            // PR-binding backfill may run on it (master §4).
            classification: {
              channelPrompt: true,
              requestedChannelPrompt: true,
            },
            idempotencyKey,
          });
          return { deduplicated: admission.deduplicated };
        }),
      );
    },
    readPushedHeads: async (
      recipient: PrWatchRecipient,
    ): Promise<ReadonlySet<string> | undefined> => {
      const runtime = resolveRuntime(recipient.workspaceCwd);
      if (!runtime) return undefined;
      // No git runs in an untrusted primary's checkout: the coordinate alone
      // cannot vouch for a clone, so there is no ledger and the event delivers.
      if (runtime.primary && !runtime.trusted) return undefined;
      const identity = prWatchIdentityFromUrl(recipient.url);
      if (!identity) return undefined;
      const slash = identity.repo.indexOf('/');
      if (slash <= 0) return undefined;
      const coordinate = {
        host: identity.host,
        owner: identity.repo.slice(0, slash),
        repo: identity.repo.slice(slash + 1),
      };
      const clone =
        liveSummary(runtime, recipient.sessionId)?.worktree?.path ??
        recipient.workspaceCwd;
      let roots: string[];
      try {
        roots = await cloneWorktreesOf(clone);
      } catch {
        return undefined;
      }
      for (const root of vouchedScanRoots(roots)) {
        let state: ReturnType<typeof readState>;
        try {
          state = readState(autofixPrPaths(root, identity.number).statePath);
        } catch {
          continue;
        }
        if (!state) continue;
        if (state.sessionId !== recipient.sessionId) continue;
        if (
          !sameRepository(coordinate, {
            host: state.host,
            owner: state.owner,
            repo: state.repo,
          })
        ) {
          continue;
        }
        return new Set(state.pushedShas);
      }
      return undefined;
    },
    log,
    ...(sources.now ? { now: sources.now } : {}),
  };

  return { watch, drain };
}
