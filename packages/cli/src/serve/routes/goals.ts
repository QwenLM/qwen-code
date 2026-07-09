/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace-wide `/goal` listing — the daemon-side surface behind the Web Shell
 * "Goals" page.
 *
 * A goal is a session-scoped Stop hook whose state (condition, judge turn count,
 * last verdict) lives only in the `qwen --acp` child's in-memory store. The serve
 * process holds no copy, so this route fans out one `sessionGoalGet` ext-method
 * call per live session and collects the answers. There is no durable goal store
 * to read instead: a goal only advances while its session is resident, so "the
 * live sessions" IS the complete set of goals that are actually running.
 *
 * A session whose child is wedged or dying rejects; those are dropped rather
 * than failing the whole list, so one bad session can't hide the others. The
 * per-call timeout is the bridge's, and the calls run concurrently, so a wedged
 * child costs one timeout rather than one per session.
 *
 * Read-only: clearing a goal stays on `POST /session/:id/goal/clear`, and
 * setting one stays a prompt (`/goal <condition>` registers the hook and kicks
 * off the first turn — it is not a pure write).
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

/** One row of the Goals page. */
interface GoalView {
  sessionId: string;
  /** The session's label, when it has one — otherwise the client shows the id. */
  displayName: string | null;
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
  /** True while the session is mid-turn, i.e. the goal loop is actively working. */
  running: boolean;
}

export function registerGoalsRoutes(
  app: Application,
  deps: RegisterGoalsRoutesDeps,
): void {
  const { boundWorkspace, bridge } = deps;

  app.get('/goals', async (_req, res) => {
    try {
      const sessions = bridge.listWorkspaceSessions(boundWorkspace);
      const settled = await Promise.allSettled(
        sessions.map(async (session) => ({
          session,
          goal: await bridge.getSessionGoal(session.sessionId),
        })),
      );

      const goals: GoalView[] = [];
      for (const outcome of settled) {
        // A session that died between the list and the probe simply has no
        // goal to report.
        if (outcome.status !== 'fulfilled') continue;
        const { session, goal } = outcome.value;
        if (!goal.active) continue;
        goals.push({
          sessionId: session.sessionId,
          displayName: session.displayName ?? null,
          condition: goal.active.condition,
          iterations: goal.active.iterations,
          setAt: goal.active.setAt,
          ...(goal.active.lastReason !== undefined
            ? { lastReason: goal.active.lastReason }
            : {}),
          running: session.hasActivePrompt,
        });
      }
      // Newest first, matching the scheduled-tasks page.
      goals.sort((a, b) => b.setAt - a.setAt);

      res.status(200).json({ v: 1, goals });
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
