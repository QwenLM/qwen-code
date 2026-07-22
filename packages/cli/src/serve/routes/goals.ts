/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace-wide `/goal` listing — the daemon-side surface behind the Web Shell
 * "Goals" page.
 *
 * Goal lifecycle state is owned by each live `qwen --acp` child. The serve
 * process holds no copy, so this route fans out one `sessionGoalGet` ext-method
 * call per live session and collects the authoritative v2 snapshots.
 *
 * A session whose child is wedged or dying rejects; those are dropped (and
 * logged) rather than failing the whole list, so one bad session can't hide the
 * others. The per-call timeout is the bridge's, and the calls run concurrently
 * (up to `PROBE_CONCURRENCY`), so a wedged child costs one timeout rather than
 * one per session.
 *
 * Read-only: controls stay on `POST /session/:id/goal` (with the legacy atomic
 * clear wrapper retained at `POST /session/:id/goal/clear`).
 */

import type { Application } from 'express';
import type {
  BridgeSessionGoal,
  BridgeSessionSummary,
} from '@qwen-code/acp-bridge';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

/**
 * The slice of the session bridge this route needs. Narrowed to a structural
 * type so tests can stub it without the full bridge.
 */
export interface GoalsSessionBridge {
  listWorkspaceSessions(workspaceCwd: string): BridgeSessionSummary[];
  getSessionGoal(sessionId: string): Promise<BridgeSessionGoal>;
}

export interface RegisterGoalsRoutesDeps {
  boundWorkspace: string;
  bridge: GoalsSessionBridge;
}

/**
 * Ceiling on in-flight `sessionGoalGet` probes. Each is an IPC round-trip to a
 * separate child process, so a workspace with dozens of live sessions would
 * otherwise open dozens at once every poll.
 */
const PROBE_CONCURRENCY = 10;

/**
 * `Promise.allSettled` over `items`, but with at most `limit` calls in flight.
 * Results stay index-aligned with `items` so the caller can still name the
 * session behind a rejection.
 */
async function allSettledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  // `Math.max(1, …)` so a zero limit can never leave the array sparse: the
  // caller reads `outcome.status` off every index.
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** One row of the Goals page. */
interface GoalView {
  sessionId: string;
  /** The session's label, when it has one — otherwise the client shows the id. */
  displayName: string | null;
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
  snapshot: NonNullable<BridgeSessionGoal['goalState']>;
  /**
   * The owning session is mid-turn. For a goal session that is almost always
   * the loop working, but a manual prompt in the same session sets it too — so
   * this reports what the daemon actually knows rather than claiming to know
   * that the goal specifically is running.
   */
  hasActivePrompt: boolean;
}

export function registerGoalsRoutes(
  app: Application,
  deps: RegisterGoalsRoutesDeps,
): void {
  const { boundWorkspace, bridge } = deps;

  app.get('/goals', async (_req, res) => {
    try {
      const sessions = bridge.listWorkspaceSessions(boundWorkspace);
      const settled = await allSettledWithLimit(
        sessions,
        PROBE_CONCURRENCY,
        async (session) => ({
          session,
          goal: await bridge.getSessionGoal(session.sessionId),
        }),
      );

      const goals: GoalView[] = [];
      const dropped: string[] = [];
      for (const [index, outcome] of settled.entries()) {
        // A session that died between the list and the probe simply has no
        // goal to report. Dropping it keeps one bad session from hiding the
        // others, but do not drop it silently: an empty page and a page whose
        // probes all failed look identical from the client.
        if (outcome.status !== 'fulfilled') {
          const sessionId = sessions[index]?.sessionId ?? '(unknown)';
          const reason =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          dropped.push(`${sessionId}: ${reason}`);
          continue;
        }
        const { session, goal } = outcome.value;
        const snapshot = goal.goalState;
        const record = snapshot?.goal;
        if (!record || record.status === 'complete') continue;
        goals.push({
          sessionId: session.sessionId,
          displayName: session.displayName ?? null,
          condition: record.objective,
          iterations: record.turnCount,
          setAt: record.createdAt,
          ...(record.lastReason !== undefined
            ? { lastReason: record.lastReason }
            : {}),
          hasActivePrompt: session.hasActivePrompt,
          snapshot,
        });
      }
      if (dropped.length > 0) {
        writeStderrLine(
          `qwen serve: GET /goals could not probe ${dropped.length} of ${sessions.length} session(s): ${dropped.join('; ')}`,
        );
      }

      // Newest first, matching the scheduled-tasks page.
      goals.sort((a, b) => b.setAt - a.setAt);

      // `droppedCount` lets the client tell "no goals" apart from "we could not
      // ask". Without it a brownout looks like an empty workspace, and the user
      // re-creates goals that are already running.
      res.status(200).json({ v: 1, goals, droppedCount: dropped.length });
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /goals failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to list active goals',
        code: 'goals_read_failed',
      });
    }
  });
}
