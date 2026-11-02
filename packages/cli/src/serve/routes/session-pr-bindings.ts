/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { sanitizeLogText } from '@qwen-code/channel-base';
import type { SendBridgeError } from '../server/error-response.js';
import {
  listWorkspaceSessionsForResponse,
  type ListWorkspaceSessionsResult,
} from '../server/session-list.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

/**
 * Process-global, read-only reverse lookup: every active session that has PR
 * bindings, across trusted workspaces. Channel workers use it to route GitHub
 * events into the session that follows a PR instead of a channel-owned
 * session. Same ownership class as `POST /sessions/backfill-prs`.
 */

export interface SessionPrBindingEntry {
  number: number;
  url: string;
  state?: 'open' | 'merged' | 'closed';
}

export interface SessionPrBindingSummary {
  sessionId: string;
  workspaceCwd: string;
  sourceType?: string;
  updatedAt?: string;
  prs: SessionPrBindingEntry[];
}

const PAGE_SIZE = 100;
// Bounds one workspace's scan so a pathological catalog cannot pin the route.
const MAX_PAGES = 50;

export interface SessionPrBindingsRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  sendBridgeError: SendBridgeError;
  /** Test seam; the daemon uses the real session list. */
  listSessions?: (
    runtime: WorkspaceRuntime,
    cursor: string | undefined,
  ) => Promise<ListWorkspaceSessionsResult>;
}

async function listActiveSessionsPage(
  runtime: WorkspaceRuntime,
  cursor: string | undefined,
): Promise<ListWorkspaceSessionsResult> {
  return runWithWorkspaceRuntimeStorage(runtime, () =>
    listWorkspaceSessionsForResponse(
      runtime.bridge,
      runtime.workspaceCwd,
      {
        archiveState: 'active',
        size: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      },
      {
        mergeLive: true,
        paginateMerged: true,
        runtimeBaseDir: runtime.sessionRuntimeBaseDir,
      },
    ),
  );
}

export function registerSessionPrBindingsRoutes(
  app: Application,
  deps: SessionPrBindingsRouteDeps,
): void {
  app.get('/sessions/pr-bindings', async (_req, res) => {
    const route = 'GET /sessions/pr-bindings';
    try {
      const listPage = deps.listSessions ?? listActiveSessionsPage;
      const bindings: SessionPrBindingSummary[] = [];
      // A missing binding is only an authoritative absence when the scan
      // was complete; callers hold state keyed by bindings and must not
      // destroy it on a partial answer.
      let partial = false;
      for (const entry of deps.workspaceRegistry.listAllEntries()) {
        const runtime = entry.current?.runtime;
        if (!runtime || entry.state !== 'active') {
          // A workspace that is draining/transitioning/blocked still serves
          // sessions but cannot be enumerated here. Its absence is NOT an
          // authoritative "no bindings": flag the answer incomplete so
          // callers retain known bindings and skip watch-state pruning.
          // listAllEntries() already excludes removed entries (legitimate
          // absence); untrusted workspaces are skipped by contract below.
          partial = true;
          continue;
        }
        if (!runtime.trusted) {
          // Session creation/restore exempts primary from the trust gate, so
          // an untrusted PRIMARY still serves bound sessions. Skipping it
          // without flagging partial would hand callers an authoritative
          // absence over bindings that still exist, degrading private
          // delivery to public (and pruning watch state on a trusted→
          // untrusted flip). Non-primary untrusted workspaces cannot create
          // or restore sessions, so their absence is legitimate.
          if (runtime.primary) partial = true;
          continue;
        }
        let cursor: string | undefined;
        try {
          let pages = 0;
          for (;;) {
            const result = await listPage(runtime, cursor);
            // A degraded success (live-merge failure) is as incomplete as a
            // truncated scan: callers must not treat it as authoritative.
            if (result.truncated || result.liveMergeFailed) partial = true;
            for (const session of result.sessions) {
              const prs = session.prs;
              if (!prs || prs.length === 0) continue;
              bindings.push({
                sessionId: session.sessionId,
                workspaceCwd: runtime.workspaceCwd,
                ...(session.sourceType !== undefined
                  ? { sourceType: session.sourceType }
                  : {}),
                // Live-only summaries may lack updatedAt; createdAt is
                // always present and keeps fresh live sessions from losing
                // the recency comparison to stale persisted ones.
                ...((session.updatedAt ?? session.createdAt) !== undefined
                  ? { updatedAt: session.updatedAt ?? session.createdAt }
                  : {}),
                prs: prs.map((pr) => ({
                  number: pr.number,
                  url: pr.url,
                  ...(pr.state !== undefined ? { state: pr.state } : {}),
                })),
              });
            }
            pages += 1;
            if (!result.nextCursor) break;
            // Activity-ordered pagination is not snapshot-isolated: a live
            // session whose activity advances between page fetches can be
            // skipped on every page while the scan still finishes clean.
            // Any multi-page scan is therefore non-authoritative.
            partial = true;
            if (pages >= MAX_PAGES) break;
            cursor = result.nextCursor;
          }
        } catch (err) {
          // One unreadable workspace must not hide the others' bindings;
          // the partial flag tells callers the answer is incomplete. Name
          // the workspace and cause: a persistent partial otherwise stalls
          // the channel with zero log lines pointing at the source.
          process.stderr.write(
            `[serve] PR bindings scan failed for workspace ${runtime.workspaceCwd}, answer partial: ${sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              200,
            )}\n`,
          );
          partial = true;
          continue;
        }
      }
      res.status(200).json({ bindings, partial });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
