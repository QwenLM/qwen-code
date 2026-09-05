/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GET /background-agents` — the sessions a supervisor is running.
 *
 * The daemon has its own idea of what a session is, and it is not this
 * one: `standalone-session-service` tracks conversations the daemon
 * itself hosts, in its own memory. A background agent started with
 * `qwen --bg` is owned by the Agent View supervisor and appears nowhere
 * in it.
 *
 * The rows come from `managedSessionRows`, the same function
 * `qwen sessions ps` renders, so the CLI and anything built on this route
 * cannot describe one session two different ways. See
 * `docs/plans/2026-09-04-background-agent-surfaces.md` for why the roster
 * is the authority rather than the daemon's own model.
 *
 * Read-only by design. Acting on a background agent — answering it,
 * stopping it — goes through the supervisor's own socket, which the CLI
 * already does; routing those through the daemon would put a second
 * writer on state the supervisor owns.
 */

import type { Application } from 'express';
import { listAgentViewSessionSnapshots } from '../../agent-view/supervisor-store.js';
import { managedSessionRows } from '../../commands/sessions/managed-rows.js';
import type { AgentViewTaskState } from '../../agent-view/presentation.js';
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
   * the day someone rewords a column.
   */
  taskState: AgentViewTaskState;
  cwd: string;
  /** Absent when no process is running for this session. */
  pid?: number;
  /** ISO 8601, absent when the recorded stamp is unusable. */
  startedAt?: string;
}

export interface RegisterBackgroundAgentRoutesDeps {
  /** Overridden in tests; defaults to the real supervisor store. */
  listSnapshots?: typeof listAgentViewSessionSnapshots;
  isWorkspaceTrusted?: () => boolean;
}

export function registerBackgroundAgentRoutes(
  app: Application,
  deps: RegisterBackgroundAgentRoutesDeps = {},
): void {
  const listSnapshots = deps.listSnapshots ?? listAgentViewSessionSnapshots;

  app.get('/background-agents', async (_req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    try {
      const rows = managedSessionRows(await listSnapshots());
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
