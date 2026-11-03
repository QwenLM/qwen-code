/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { readSessionPrsDetailed } from '@qwen-code/qwen-code-core/services/session-pr-service.js';
import type { BridgeSessionSummary } from '@qwen-code/acp-bridge/bridgeTypes';
import { isHiddenCatalogSource } from '../../runtime/agent-session-source.js';
import type { SendBridgeError } from '../server/error-response.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

/**
 * Process-global, read-only reverse lookup: every active session that has a
 * PR sidecar, across the workspaces that can serve sessions. Channel workers
 * use it to route GitHub events into the session that follows a PR instead
 * of a channel-owned session. Same ownership class as
 * `POST /sessions/backfill-prs`.
 *
 * The scan reads the `<chatsDir>/<sessionId>.pr.json` sidecars directly —
 * one `readdir` per workspace, the same enumeration the PR refresh timer
 * uses — instead of paginating the activity-ordered session list. A
 * directory listing is a snapshot, so the answer is complete unless a file
 * could not be read; `partial` therefore means an I/O failure, never "more
 * sessions than one page".
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

export interface SessionPrBindingsRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  sendBridgeError: SendBridgeError;
}

function later(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b > a ? b : a;
}

/**
 * Appends one row per readable sidecar of the workspace. Returns true when
 * a sidecar or its transcript could not be read, so the caller flags the
 * answer partial; such a session's bindings are UNKNOWN, not empty.
 */
async function scanWorkspaceBindings(
  runtime: WorkspaceRuntime,
  out: SessionPrBindingSummary[],
): Promise<boolean> {
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const sessionIds = sessionService.listSessionIdsWithPrSidecar('active');
  // Live sessions carry their attribution and activity in memory; a binding
  // written before the session's first transcript flush has no persisted
  // record yet, and a live session's activity can be newer than its last
  // flush. The live list only refines the persisted facts: without it the
  // scan still answers from the files.
  let live = new Map<string, BridgeSessionSummary>();
  try {
    live = new Map(
      runtime.bridge
        .listWorkspaceSessions(runtime.workspaceCwd)
        .map((summary) => [summary.sessionId, summary]),
    );
  } catch {
    // Persisted facts stand on their own.
  }
  let partial = false;
  for (const sessionId of sessionIds) {
    try {
      // The sidecar enumeration also sees sessions of other projects whose
      // sanitized cwds collide onto this chats dir.
      if (
        !(await sessionService.sessionPrSidecarBelongsToCurrentProject(
          sessionId,
          'active',
        ))
      ) {
        continue;
      }
      const sidecar = await readSessionPrsDetailed(
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
      );
      // Absent: unbound or archived between the listing and the read.
      if (sidecar.status === 'absent') continue;
      if (sidecar.status === 'invalid') {
        partial = true;
        continue;
      }
      const item = await sessionService.getSessionListItem(sessionId, 'active');
      const liveSummary = live.get(sessionId);
      const sourceType = item?.sourceType ?? liveSummary?.sourceType;
      // Machine-owned task sessions are not interactive delivery targets.
      if (isHiddenCatalogSource(sourceType)) continue;
      const updatedAt = later(
        item ? new Date(item.mtime).toISOString() : undefined,
        liveSummary?.updatedAt ?? liveSummary?.createdAt,
      );
      // Every readable sidecar gets a row, including an empty one: "scanned,
      // no bindings" (an observed unbind) must stay distinguishable from
      // "not enumerated" for callers that retain state across answers.
      out.push({
        sessionId,
        workspaceCwd: runtime.workspaceCwd,
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        prs: sidecar.prs.map((pr) => ({
          number: pr.number,
          url: pr.url,
          ...(pr.state !== undefined ? { state: pr.state } : {}),
        })),
      });
    } catch (err) {
      partial = true;
      process.stderr.write(
        `[serve] PR bindings scan failed for session ${sanitizeLogText(sessionId, 64)} in workspace ${runtime.workspaceCwd}, answer partial: ${sanitizeLogText(
          err instanceof Error ? err.message : String(err),
          200,
        )}\n`,
      );
    }
  }
  return partial;
}

export function registerSessionPrBindingsRoutes(
  app: Application,
  deps: SessionPrBindingsRouteDeps,
): void {
  app.get('/sessions/pr-bindings', async (_req, res) => {
    const route = 'GET /sessions/pr-bindings';
    try {
      const bindings: SessionPrBindingSummary[] = [];
      let partial = false;
      for (const entry of deps.workspaceRegistry.listAllEntries()) {
        const runtime = entry.current?.runtime;
        if (!runtime) {
          // Without a runtime the workspace's session storage cannot be
          // located; its bindings are unknown, not absent. listAllEntries()
          // already excludes removed entries (legitimate absence).
          partial = true;
          continue;
        }
        // Untrusted non-primary workspaces cannot create or restore
        // sessions, so they hold no deliverable binding. Primary is exempt
        // from the trust gate and still serves bound sessions, so it is
        // scanned like a trusted workspace. The entry state does not gate a
        // read-only file scan: a draining or transitioning workspace still
        // serves its sessions.
        if (!runtime.trusted && !runtime.primary) continue;
        try {
          if (await scanWorkspaceBindings(runtime, bindings)) partial = true;
        } catch (err) {
          // One unreadable workspace must not hide the others' bindings.
          process.stderr.write(
            `[serve] PR bindings scan failed for workspace ${runtime.workspaceCwd}, answer partial: ${sanitizeLogText(
              err instanceof Error ? err.message : String(err),
              200,
            )}\n`,
          );
          partial = true;
        }
      }
      res.status(200).json({ bindings, partial });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
