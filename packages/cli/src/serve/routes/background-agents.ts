/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GET /background-agents` — the sessions a supervisor knows about.
 *
 * The daemon has its own idea of what a session is, and it is not this
 * one: `standalone-session-service` tracks conversations the daemon
 * itself hosts, in its own memory. A background agent started with
 * `qwen --bg` is owned by the Agent View supervisor and appears nowhere
 * in it.
 *
 * The rows come from the same composition `qwen sessions ps` uses —
 * `managedSessionRows` merged with the live-session registry — so the CLI
 * and anything built on this route cannot describe one session two
 * different ways. The sessions are read from the supervisor's store,
 * which still lists one after its worker exits; the roster only supplies
 * display names. See
 * `docs/plans/2026-09-04-background-agent-surfaces.md` for why that store
 * is the authority rather than the daemon's own model.
 *
 * Read-only by design. Acting on a background agent — answering it,
 * stopping it — goes through the supervisor's own socket, which the CLI
 * already does; routing those through the daemon would put a second
 * writer on state the supervisor owns.
 */

import type { Application } from 'express';
import { listLiveSessions } from '@qwen-code/qwen-code-core/services/session-registry.js';
import { listAgentViewSessionSnapshots } from '../../agent-view/supervisor-store.js';
import {
  managedSessionRows,
  mergeSessionRows,
  reconcileRowLiveness,
} from '../../commands/sessions/managed-rows.js';
import type { AgentViewTaskState } from '../../agent-view/presentation.js';
import { isWithinRoot } from '../../config/path-comparison.js';
import { sendUntrustedWorkspaceResponse } from '../workspace-route-runtime.js';

/** One background agent, as this route reports it. */
export interface BackgroundAgentView {
  sessionId: string;
  /** Roster display name, the activity summary, or the launch prompt. */
  name: string;
  /**
   * What the session is doing: `running`, `waiting`, `ready`, `stopped`
   * or `failed`.
   *
   * The presentation layer's own token, not the label `qwen sessions ps`
   * prints. A JSON field pinned to display wording breaks every client
   * the day someone rewords a column. A session the store still calls
   * `running` or `waiting` with no process behind it is reported as
   * `failed`, the same verdict the supervisor's own heal reaches.
   */
  taskState: AgentViewTaskState;
  cwd: string;
  /** Absent when no process is running for this session. */
  pid?: number;
  /**
   * ISO 8601, absent when no process is running for this session or the
   * recorded stamp is unusable.
   */
  startedAt?: string;
}

export interface RegisterBackgroundAgentRoutesDeps {
  /** Overridden in tests; defaults to the real supervisor store. */
  listSnapshots?: typeof listAgentViewSessionSnapshots;
  /** Overridden in tests; defaults to the real live-session registry. */
  listRecords?: typeof listLiveSessions;
  isWorkspaceTrusted?: () => boolean;
  /**
   * The workspace this daemon is bound to. Only agents working inside it
   * are listed.
   *
   * The supervisor's store is process-global: it holds a row for every
   * background agent on this machine, whatever workspace it was launched
   * in. Without this the trust gate would be answering a question about
   * one workspace while the rows came from all of them — a daemon bound
   * to a trusted workspace would describe another workspace's agents,
   * including the prompt a `--bg` row falls back to for its name.
   * Scoping the rows is what makes the gate above cover exactly the data
   * the response carries, which is also what the acting routes already
   * assume: `POST /session` refuses a foreign `cwd` with
   * `workspace_mismatch`.
   *
   * Compared lexically, as `isWithinRoot` does wherever else serve draws
   * this boundary — no `realpath`, so an agent cwd reached through a
   * symlink can read as outside the workspace it belongs to. Registered
   * secondary workspaces are not covered either; this is the primary
   * workspace's roster.
   */
  boundWorkspace?: string;
}

export function registerBackgroundAgentRoutes(
  app: Application,
  deps: RegisterBackgroundAgentRoutesDeps = {},
): void {
  const listSnapshots = deps.listSnapshots ?? listAgentViewSessionSnapshots;
  const listRecords = deps.listRecords ?? listLiveSessions;

  app.get('/background-agents', async (_req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    try {
      // The composition `qwen sessions ps` uses. Merging first is what
      // `reconcileRowLiveness` documents as its precondition: a managed
      // row whose worker pid is not recorded yet keeps the pid the
      // registry half proved alive instead of reading as `failed`. The
      // filter drops the registry-only rows the merge appends — this
      // route reports background agents, not every session here — and
      // the ones belonging to another workspace, so what comes back is
      // the roster the trust gate above actually vouched for.
      const boundWorkspace = deps.boundWorkspace;
      const [records, snapshots] = await Promise.all([
        listRecords(),
        listSnapshots(),
      ]);
      const rows = reconcileRowLiveness(
        mergeSessionRows(records, managedSessionRows(snapshots)).filter(
          (row) =>
            row.managed &&
            (boundWorkspace === undefined ||
              isWithinRoot(row.cwd, boundWorkspace)),
        ),
      );
      // `taskState` is set on every row `managedSessionRows` returns —
      // it only maps owned snapshots. The guard is for the type, and for
      // the day that changes: an agent reported with no state at all is
      // worse than one not reported, because a caller would have to
      // invent a state to render it.
      const agents: BackgroundAgentView[] = rows.flatMap((row) =>
        row.taskState === undefined
          ? []
          : [
              {
                sessionId: row.sessionId,
                name: row.name,
                taskState: row.taskState,
                cwd: row.cwd,
                ...(row.pid === undefined ? {} : { pid: row.pid }),
                ...(row.startedAt === undefined
                  ? {}
                  : { startedAt: new Date(row.startedAt).toISOString() }),
              },
            ],
      );
      res.json({ agents });
    } catch (error) {
      // A supervisor store that cannot be read is not "no agents": a
      // client that cannot tell those apart would show an empty list to
      // someone whose agent is waiting for an answer.
      res.status(503).json({
        error: 'Background agents are unavailable.',
        code: 'background_agents_unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
