/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { dirname, join } from 'node:path';
import { isValidSessionId } from '../../config/session-id.js';
import { postedCommentIdsForTranscript } from '../server/posted-comment-attribution.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

export interface SessionPostedCommentsRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  sendBridgeError: SendBridgeError;
}

/**
 * Process-global, read-only authorship lookup for the bound PR comment watch
 * (docs/design/2026-11-08-bound-pr-comment-watch.md): the set of GitHub
 * comment identifiers the given session has itself posted, derived from its
 * transcript. The channel uses it to withhold a comment from the session
 * that wrote it while still delivering every other author's comment —
 * including the same GitHub account used by a different session/agent.
 *
 * Fail-open: a workspace that cannot be resolved, an untrusted workspace, or
 * an absent/unreadable transcript answers an empty set so delivery is never
 * silently suppressed on missing evidence. Same ownership class as
 * `GET /sessions/pr-bindings`; authenticated like the other session routes.
 */
export function registerSessionPostedCommentsRoutes(
  app: Application,
  deps: SessionPostedCommentsRouteDeps,
): void {
  app.get('/sessions/:id/posted-comments', async (req, res) => {
    const route = 'GET /sessions/:id/posted-comments';
    try {
      const sessionId = req.params.id;
      if (!isValidSessionId(sessionId)) {
        res
          .status(400)
          .json({ error: 'Invalid session id', code: 'invalid_session_id' });
        return;
      }
      const workspaceCwd =
        typeof req.query['workspaceCwd'] === 'string'
          ? req.query['workspaceCwd']
          : undefined;
      const runtime = workspaceCwd
        ? deps.workspaceRegistry.getEntryByWorkspaceCwd(workspaceCwd)?.current
            ?.runtime
        : undefined;
      // Untrusted non-primary workspaces cannot serve bound sessions, so
      // they hold no delivery target; answer empty rather than reading them.
      if (!runtime || (!runtime.trusted && !runtime.primary)) {
        res.status(200).json({ ids: [] });
        return;
      }
      const sessionService = createWorkspaceRuntimeSessionService(runtime);
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        'active',
      );
      const transcriptPath = join(dirname(prPath), `${sessionId}.jsonl`);
      const ids = await postedCommentIdsForTranscript(transcriptPath);
      res.status(200).json({ ids: [...ids] });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
