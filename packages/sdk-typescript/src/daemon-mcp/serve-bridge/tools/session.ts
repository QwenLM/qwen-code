/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import {
  handler,
  resolveSessionId,
  startEventStream,
  stopEventStream,
} from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function sessionTools(state: BridgeState): any[] {
  return [
    tool(
      'session_create',
      'Create a new qwen-code session or attach to an existing one. The created session becomes the default for subsequent tool calls.',
      {
        workspace_cwd: z
          .string()
          .optional()
          .describe('Workspace path. Defaults to daemon bound workspace.'),
        model_service_id: z
          .string()
          .optional()
          .describe('Model service to use.'),
        session_scope: z
          .enum(['single', 'thread'])
          .optional()
          .describe('Session scope.'),
      },
      handler(async (args) => {
        const session = await state.client.createOrAttachSession({
          workspaceCwd: args.workspace_cwd ?? state.workspaceCwd,
          modelServiceId: args.model_service_id,
          sessionScope: args.session_scope,
        });
        state.defaultSessionId = session.sessionId;
        // Start persistent SSE connection for this session
        startEventStream(state, session.sessionId);
        return formatJsonResult(session);
      }),
    ),

    tool(
      'session_load',
      'Restore a persisted session with SSE history replay. Sets the loaded session as the default.',
      {
        session_id: z.string().describe('Session ID to restore.'),
        workspace_cwd: z.string().optional().describe('Workspace path.'),
      },
      handler(async (args) => {
        const result = await state.client.loadSession(args.session_id, {
          workspaceCwd: args.workspace_cwd,
        });
        state.defaultSessionId = result.sessionId;
        startEventStream(state, result.sessionId);
        return formatJsonResult(result);
      }),
    ),

    tool(
      'session_resume',
      'Restore a session without history replay. Sets the resumed session as the default.',
      {
        session_id: z.string().describe('Session ID to resume.'),
        workspace_cwd: z.string().optional().describe('Workspace path.'),
      },
      handler(async (args) => {
        const result = await state.client.resumeSession(args.session_id, {
          workspaceCwd: args.workspace_cwd,
        });
        state.defaultSessionId = result.sessionId;
        startEventStream(state, result.sessionId);
        return formatJsonResult(result);
      }),
    ),

    tool(
      'session_close',
      'Force-close a live session.',
      {
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        // Stop persistent SSE before closing session
        stopEventStream(state, sessionId);
        await state.client.closeSession(sessionId);
        if (state.defaultSessionId === sessionId) {
          state.defaultSessionId = undefined;
        }
        return formatJsonResult({ ok: true, sessionId });
      }),
    ),

    tool(
      'session_update_metadata',
      'Update session metadata such as display name.',
      {
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
        display_name: z
          .string()
          .optional()
          .describe('New display name for the session.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.updateSessionMetadata(sessionId, {
          displayName: args.display_name,
        });
        return formatJsonResult(result);
      }),
    ),

    tool(
      'session_list',
      'List live sessions for a workspace.',
      {
        workspace_cwd: z
          .string()
          .describe('Workspace path to list sessions for.'),
      },
      handler(async (args) => {
        const sessions = await state.client.listWorkspaceSessions(
          args.workspace_cwd,
        );
        return formatJsonResult({ sessions });
      }),
    ),
  ];
}
