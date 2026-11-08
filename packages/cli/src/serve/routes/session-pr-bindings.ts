/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Application } from 'express';
import { sanitizeLogText } from '@qwen-code/channel-base';
import {
  readSessionPrsDetailed,
  SESSION_PR_LIST_LIMIT,
} from '@qwen-code/qwen-code-core/services/session-pr-service.js';
import type { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import type { BridgeSessionSummary } from '@qwen-code/acp-bridge/bridgeTypes';
import { isHiddenCatalogSource } from '../../runtime/agent-session-source.js';
import { laterActivityTimestamp } from '../server/activity-timestamp.js';
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
 * directory listing is a snapshot, so the answer is complete unless
 * something could not be read: a registry entry without a runtime, a chats
 * directory that cannot be listed, a sidecar or transcript that cannot be
 * read, or a live session list that cannot be fetched. `partial` therefore
 * means an I/O failure, never "more sessions than one page". Bindings the
 * bridge holds in memory but that have not reached a sidecar yet (the window
 * between the bridge update and the sidecar write, or a failed write) are
 * merged in from the live session list.
 */

export interface SessionPrBindingEntry {
  number: number;
  url: string;
  state?: 'open' | 'merged' | 'closed';
  role?: 'review' | 'verify' | 'fix';
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

function validTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function projectPrs(
  prs: ReadonlyArray<{
    number: number;
    url: string;
    state?: 'open' | 'merged' | 'closed';
    role?: 'review' | 'verify' | 'fix';
  }>,
): SessionPrBindingEntry[] {
  return prs.map((pr) => ({
    number: pr.number,
    url: pr.url,
    ...(pr.state !== undefined ? { state: pr.state } : {}),
    ...(pr.role !== undefined ? { role: pr.role } : {}),
  }));
}

type Attribution =
  | { kind: 'ok'; sourceType?: string; updatedAt?: string }
  /** Machine-owned task session: never a delivery target. */
  | { kind: 'hidden' }
  /** The transcript is archived; the active sidecar is a leftover. */
  | { kind: 'archived' }
  /** The transcript exists but could not be read: attribution unknown. */
  | { kind: 'unreadable' };

/**
 * Attribution comes from the persisted record, refined by the live session
 * when there is one. A session with neither has a binding written before
 * its first transcript flush (kept, unattributed) unless the transcript is
 * present but unreadable, or lives in the archive.
 */
async function resolveAttribution(
  sessionService: SessionService,
  sessionId: string,
  prPath: string,
  liveSummary: BridgeSessionSummary | undefined,
): Promise<Attribution> {
  const item = await sessionService.getSessionListItem(sessionId, 'active');
  // Ownership first, from whichever record states it: a machine-owned
  // session is skipped before any read that could fail and degrade the
  // answer on its behalf.
  const sourceType = item?.sourceType ?? liveSummary?.sourceType;
  if (isHiddenCatalogSource(sourceType)) return { kind: 'hidden' };
  if (item === undefined) {
    let stats: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      stats = await stat(join(dirname(prPath), `${sessionId}.jsonl`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // getSessionListItem swallows read errors into "no records"; a
    // non-empty (or non-file) transcript that produced none is unreadable,
    // live or not. An absent transcript is a binding before the first
    // flush (kept), unless the session is archived.
    if (stats !== undefined && (!stats.isFile() || stats.size > 0)) {
      return { kind: 'unreadable' };
    }
    if (
      stats === undefined &&
      liveSummary === undefined &&
      (await sessionService.getSessionListItem(sessionId, 'archived')) !==
        undefined
    ) {
      return { kind: 'archived' };
    }
  }
  // The shared recency rule: the later valid value wins, an unparseable live
  // value never displaces the persisted one, and the comparison is
  // chronological, not lexicographic. The live createdAt stands in for
  // activity only when there is no persisted record (a binding before the
  // first transcript flush): the bridge stamps a fresh createdAt on restore
  // too, so for a persisted session it would turn a mere restore into
  // activity and hand the PR's events to an idle follower.
  const liveActivity =
    validTimestamp(liveSummary?.updatedAt) ??
    (item === undefined ? validTimestamp(liveSummary?.createdAt) : undefined);
  const updatedAt = laterActivityTimestamp(
    liveActivity,
    item ? new Date(item.mtime).toISOString() : undefined,
  );
  return {
    kind: 'ok',
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/**
 * Appends one row per readable sidecar of the workspace, merges in the
 * bindings the bridge holds in memory, and returns true when anything could
 * not be read (a sidecar, a transcript, or the live session list), so the
 * caller flags the answer partial; such bindings are UNKNOWN, not absent.
 * Shared in-process by the bindings route and the daemon PR-watch refresh.
 */
export async function scanWorkspaceBindings(
  runtime: WorkspaceRuntime,
  out: SessionPrBindingSummary[],
): Promise<boolean> {
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const sessionIds = sessionService.listSessionIdsWithPrSidecar('active');
  // The live list is the only source for a binding that has not reached a
  // sidecar, so a failed read makes the answer incomplete.
  let live = new Map<string, BridgeSessionSummary>();
  let liveReadFailed = false;
  try {
    live = new Map(
      runtime.bridge
        .listWorkspaceSessions(runtime.workspaceCwd)
        .map((summary) => [summary.sessionId, summary]),
    );
  } catch (err) {
    liveReadFailed = true;
    process.stderr.write(
      `[serve] PR bindings scan: live session list unavailable in workspace ${runtime.workspaceCwd}, live-only bindings may be missing from this answer (partial): ${sanitizeLogText(
        err instanceof Error ? err.message : String(err),
        200,
      )}\n`,
    );
  }
  const rows = new Map<string, SessionPrBindingSummary>();
  const failures: Array<{ sessionId: string; cause: string }> = [];
  let examined = sessionIds.length;
  // Sessions whose persisted bindings are UNKNOWN this scan. The merge below
  // must not re-list them from the bridge's live subset: a listed row makes
  // the session look enumerated, and the adapter would drop the row it was
  // retaining with the persisted PR numbers.
  const unknown = new Set<string>();
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
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        'active',
      );
      // Non-targets are decided before the sidecar is read, so a
      // machine-owned session's corrupt or unreadable sidecar cannot make
      // the answer partial — and an empty sidecar of such a session is no
      // tombstone.
      const attribution = await resolveAttribution(
        sessionService,
        sessionId,
        prPath,
        live.get(sessionId),
      );
      if (attribution.kind === 'hidden' || attribution.kind === 'archived') {
        continue;
      }
      if (attribution.kind === 'unreadable') {
        unknown.add(sessionId);
        failures.push({ sessionId, cause: 'transcript could not be read' });
        continue;
      }
      const sidecar = await readSessionPrsDetailed(prPath);
      // Absent: unbound or archived between the listing and the read.
      if (sidecar.status === 'absent') continue;
      if (sidecar.status === 'invalid') {
        unknown.add(sessionId);
        failures.push({
          sessionId,
          cause: 'sidecar is invalid JSON or failed the shape check',
        });
        continue;
      }
      if (sidecar.prs.length === 0) {
        // Tombstone: "scanned, no bindings" (an observed unbind) must stay
        // distinguishable from "not enumerated" for callers that retain
        // state across answers. It names no delivery target, so it carries
        // no attribution.
        rows.set(sessionId, {
          sessionId,
          workspaceCwd: runtime.workspaceCwd,
          prs: [],
        });
        continue;
      }
      rows.set(sessionId, {
        sessionId,
        workspaceCwd: runtime.workspaceCwd,
        ...(attribution.sourceType !== undefined
          ? { sourceType: attribution.sourceType }
          : {}),
        ...(attribution.updatedAt !== undefined
          ? { updatedAt: attribution.updatedAt }
          : {}),
        prs: projectPrs(sidecar.prs),
      });
    } catch (err) {
      unknown.add(sessionId);
      failures.push({
        sessionId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Bindings the bridge holds but no sidecar has yet (the metadata route
  // updates the bridge before persisting the sidecar; the write can fail)
  // are still bindings: a session without a row gets one from the live
  // summary, and a non-empty row gains the PR numbers it lacks under the
  // same cap rule as the session list's merge — only while the persisted
  // list is below SESSION_PR_LIST_LIMIT, then trimmed to the newest. An
  // empty row is an observed unbind and stays a tombstone.
  for (const [sessionId, summary] of live) {
    if (unknown.has(sessionId) || !summary.prs?.length) continue;
    const row = rows.get(sessionId);
    if (row !== undefined) {
      if (row.prs.length === 0 || row.prs.length >= SESSION_PR_LIST_LIMIT) {
        continue;
      }
      // Keyed by PR number alone, like the session list's merge: the sidecar
      // writers replace an entry by number when it is re-bound to another
      // repository, so a bridge-held entry whose number the sidecar already
      // carries is either the same PR or the one that rebind replaced (the
      // bridge keeps the stale entry) — never a second binding to append.
      const known = new Set(row.prs.map((pr) => pr.number));
      row.prs.push(
        ...projectPrs(summary.prs.filter((pr) => !known.has(pr.number))),
      );
      row.prs = row.prs.slice(-SESSION_PR_LIST_LIMIT);
      continue;
    }
    examined += 1;
    try {
      // Same attribution as a sidecar row: the persisted record decides
      // ownership first (a restored agent task session carries no
      // sourceType on its bridge entry), and an unreadable transcript makes
      // the session unknown.
      const attribution = await resolveAttribution(
        sessionService,
        sessionId,
        sessionService.getPrSessionPathForArchiveState(sessionId, 'active'),
        summary,
      );
      if (attribution.kind === 'hidden' || attribution.kind === 'archived') {
        continue;
      }
      if (attribution.kind === 'unreadable') {
        failures.push({ sessionId, cause: 'transcript could not be read' });
        continue;
      }
      rows.set(sessionId, {
        sessionId,
        workspaceCwd: runtime.workspaceCwd,
        ...(attribution.sourceType !== undefined
          ? { sourceType: attribution.sourceType }
          : {}),
        ...(attribution.updatedAt !== undefined
          ? { updatedAt: attribution.updatedAt }
          : {}),
        prs: projectPrs(summary.prs).slice(-SESSION_PR_LIST_LIMIT),
      });
    } catch (err) {
      failures.push({
        sessionId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
  out.push(...rows.values());
  if (failures.length > 0) {
    // One line per workspace scan, not one per failing session per poll:
    // the route is polled every channel cycle.
    const first = failures[0]!;
    process.stderr.write(
      `[serve] PR bindings scan: ${failures.length} of ${examined} sessions could not be read in workspace ${runtime.workspaceCwd}, answer partial (first: ${sanitizeLogText(first.sessionId, 64)}: ${sanitizeLogText(first.cause, 200)})\n`,
    );
  }
  return liveReadFailed || failures.length > 0;
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
          process.stderr.write(
            `[serve] PR bindings scan: workspace ${entry.workspaceCwd} has no runtime (state ${entry.state}), answer partial\n`,
          );
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
