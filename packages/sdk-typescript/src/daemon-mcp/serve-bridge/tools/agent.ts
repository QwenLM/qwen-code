/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import { handler, resolveSessionId, createPromptCollector } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function agentTools(state: BridgeState): any[] {
  return [
    tool(
      'prompt',
      'Send a prompt to the qwen-code agent and wait for the full response. Collects all agent output text from the SSE event stream. Note: this call can take a long time as the agent processes the prompt.',
      {
        prompt: z.string().describe('The prompt text to send to the agent.'),
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);

        // Use the persistent SSE stream established at session_create.
        const stream = state.eventStreams.get(sessionId);
        if (!stream) {
          throw new Error(
            'No SSE stream for session. Was the session created via session_create?',
          );
        }

        // Install a new collector to capture this prompt's response chunks.
        const collector = createPromptCollector();
        stream.activeCollector = collector;

        try {
          // Send prompt — response text arrives via the persistent SSE stream.
          const result = await state.client.prompt(sessionId, {
            prompt: [{ type: 'text', text: args.prompt }],
          });

          // Wait for the collector to be resolved by _meta event (with timeout).
          const COLLECT_TIMEOUT_MS = 30000;
          let timedOut = false;
          await Promise.race([
            collector.promise,
            new Promise<void>((r) =>
              setTimeout(() => {
                timedOut = true;
                r();
              }, COLLECT_TIMEOUT_MS),
            ),
          ]);

          if (timedOut && collector.texts.length === 0) {
            throw new Error(
              `Timed out waiting for agent response (${COLLECT_TIMEOUT_MS / 1000}s). ` +
                'The agent may still be processing. Check session_context for status.',
            );
          }

          const responseText =
            collector.texts.join('') || '(task completed, no text output)';
          return formatJsonResult({
            session_id: sessionId,
            stop_reason: result.stopReason,
            response: responseText,
          });
        } finally {
          // Clear the collector regardless of outcome.
          stream.activeCollector = null;
        }
      }),
    ),

    tool(
      'prompt_cancel',
      'Cancel the currently active prompt in a session.',
      {
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        await state.client.cancel(sessionId);
        return formatJsonResult({ ok: true, sessionId });
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
