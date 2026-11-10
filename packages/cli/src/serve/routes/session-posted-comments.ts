/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getSubagentSessionDir } from '@qwen-code/qwen-code-core/agents/agent-transcript.js';
import { isValidSessionId } from '../../config/session-id.js';
import { postedCommentIdsForTranscript } from '../server/posted-comment-attribution.js';
import {
  createWorkspaceRuntimeSessionService,
  runWithWorkspaceRuntimeStorage,
} from '../workspace-runtime-storage.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

export interface SessionPostedCommentsRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  sendBridgeError: SendBridgeError;
}

/** Bounds how many of a session's subagent transcripts one lookup scans. */
const MAX_SUBAGENT_TRANSCRIPTS_PER_SESSION = 64;

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
      // The chats dir is keyed by the sanitized cwd, so two projects whose paths
      // sanitize identically share it. Gate the read on project membership, as
      // the sibling /sessions/pr-bindings route does, so a caller cannot scan a
      // foreign project's transcript by asserting this workspace's cwd.
      if (
        !(await sessionService.sessionPrSidecarBelongsToCurrentProject(
          sessionId,
          'active',
        ))
      ) {
        res.status(200).json({ ids: [] });
        return;
      }
      // Use core's canonical accessor rather than re-deriving the transcript
      // as a sibling of the PR sidecar, so a layout change cannot silently
      // disable attribution.
      const transcriptPath = sessionService.getSessionTranscriptPath(sessionId);
      const ids = new Set(await postedCommentIdsForTranscript(transcriptPath));
      // A post delegated to a subagent is still this session's own comment:
      // the subagent's tool results land in separate transcripts under
      // <projectDir>/subagents/<sessionId>/. Attribute those too (bounded), or
      // the watch echoes the session's delegated comment back to it. Best
      // effort: the session's own transcript ids stand even if the subagent
      // tree cannot be read.
      try {
        const projectDir = runWithWorkspaceRuntimeStorage(runtime, () =>
          new Storage(runtime.workspaceCwd).getProjectDir(),
        );
        const subagentDir = getSubagentSessionDir(projectDir, sessionId);
        const names = await readdir(subagentDir).catch(() => [] as string[]);
        let scanned = 0;
        for (const name of names) {
          if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
          if (scanned >= MAX_SUBAGENT_TRANSCRIPTS_PER_SESSION) break;
          scanned += 1;
          const subIds = await postedCommentIdsForTranscript(
            join(subagentDir, name),
          );
          for (const id of subIds) ids.add(id);
        }
      } catch {
        // Fail-open: subagent attribution is additive evidence.
      }
      res.status(200).json({ ids: [...ids] });
    } catch (err) {
      deps.sendBridgeError(res, err, { route });
    }
  });
}
