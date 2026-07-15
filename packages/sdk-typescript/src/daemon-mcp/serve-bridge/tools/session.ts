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
  createBinding,
  releaseBinding,
  replaceBinding,
  resolveBinding,
  rethrowBindingError,
  trackLifecycle,
  withSessionLock,
} from '../bindings.js';
import { handler, resolveSessionId } from '../helpers.js';

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
          .describe('Workspace path. Defaults to daemon primary workspace.'),
        model_service_id: z
          .string()
          .optional()
          .describe('Model service to use.'),
        session_scope: z
          .enum(['single', 'thread'])
          .optional()
          .describe('Session scope.'),
      },
      handler((args) =>
        trackLifecycle(state, async () => {
          const session = await state.client.createOrAttachSession({
            workspaceCwd: args.workspace_cwd ?? state.workspaceCwd,
            modelServiceId: args.model_service_id,
            sessionScope: args.session_scope,
          });
          await withSessionLock(state, session.sessionId, async () => {
            await replaceBinding(
              state,
              createBinding(session.sessionId, session.clientId),
            );
          });
          return formatJsonResult(session);
        }),
      ),
    ),

    tool(
      'session_load',
      'Restore a persisted session with SSE history replay. Sets the loaded session as the default.',
      {
        session_id: z.string().describe('Session ID to restore.'),
        workspace_cwd: z.string().optional().describe('Workspace path.'),
      },
      handler((args) =>
        trackLifecycle(state, async () => {
          const result = await withSessionLock(
            state,
            args.session_id,
            async () => {
              const current = state.bindings.get(args.session_id);
              if (current?.stream.activeCollector) {
                throw new Error(
                  'Cannot replace a session binding while a prompt is in progress.',
                );
              }
              const loaded = await state.client
                .loadSession(
                  args.session_id,
                  {
                    workspaceCwd: args.workspace_cwd ?? state.workspaceCwd,
                  },
                  current?.clientId,
                )
                .catch(async (err: unknown) => {
                  if (current) {
                    return rethrowBindingError(state, current, err);
                  }
                  throw err;
                });
              await replaceBinding(
                state,
                createBinding(loaded.sessionId, loaded.clientId),
              );
              return loaded;
            },
          );
          return formatJsonResult(result);
        }),
      ),
    ),

    tool(
      'session_resume',
      'Restore a session without history replay. Sets the resumed session as the default.',
      {
        session_id: z.string().describe('Session ID to resume.'),
        workspace_cwd: z.string().optional().describe('Workspace path.'),
      },
      handler((args) =>
        trackLifecycle(state, async () => {
          const result = await withSessionLock(
            state,
            args.session_id,
            async () => {
              const current = state.bindings.get(args.session_id);
              if (current?.stream.activeCollector) {
                throw new Error(
                  'Cannot replace a session binding while a prompt is in progress.',
                );
              }
              const resumed = await state.client
                .resumeSession(
                  args.session_id,
                  {
                    workspaceCwd: args.workspace_cwd ?? state.workspaceCwd,
                  },
                  current?.clientId,
                )
                .catch(async (err: unknown) => {
                  if (current) {
                    return rethrowBindingError(state, current, err);
                  }
                  throw err;
                });
              await replaceBinding(
                state,
                createBinding(resumed.sessionId, resumed.clientId),
              );
              return resumed;
            },
          );
          return formatJsonResult(result);
        }),
      ),
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
      handler((args) =>
        trackLifecycle(state, async () => {
          const sessionId = resolveSessionId(state, args.session_id);
          await withSessionLock(state, sessionId, async () => {
            const binding = resolveBinding(state, sessionId);
            try {
              await state.client.closeSession(sessionId, binding.clientId);
            } catch (err) {
              await rethrowBindingError(state, binding, err);
            }
            await releaseBinding(state, binding, false);
          });
          return formatJsonResult({ ok: true, sessionId });
        }),
      ),
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

    tool(
      'session_set_model',
      'Switch the active model for a session.',
      {
        model_id: z.string().describe('Model ID to switch to.'),
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.setSessionModel(
          sessionId,
          args.model_id,
        );
        return formatJsonResult(result);
      }),
    ),

    tool(
      'session_context',
      'Get the current session model/mode/config state.',
      {
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.sessionContext(sessionId);
        return formatJsonResult(result);
      }),
    ),
  ];
}
