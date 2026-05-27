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
      'Send a prompt to the qwen-code agent and wait for the full response. Collects all agent output text from the SSE event stream. Times out after 30s if no response chunks are received (returns an error suggesting to check session_context). Note: this call can take a long time as the agent processes the prompt.',
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

        // Guard against concurrent prompts on the same session
        if (stream.activeCollector) {
          throw new Error(
            'Another prompt is already in progress for this session. Wait for it to complete or call prompt_cancel first.',
          );
        }

        // Install a new collector to capture this prompt's response chunks.
        stream.lastActivityMs = Date.now();
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
          let timeoutId: ReturnType<typeof setTimeout>;
          await Promise.race([
            collector.promise,
            new Promise<void>((r) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                r();
              }, COLLECT_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timeoutId!);

          // Guard against Promise.race microtask race: only treat as timeout
          // if collector was NOT already resolved by _meta
          if (timedOut && !collector.resolved) {
            try { await state.client.cancel(sessionId); } catch { /* best-effort */ }
            const partialText = collector.texts.join('');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                session_id: sessionId,
                stop_reason: 'timeout',
                response: partialText || '(no text received)',
                warning: 'Agent response may be incomplete. _meta event not received within 30s.',
              }, null, 2) }],
              isError: true,
            };
          }

          // SSE disconnect or stopEventStream resolved the collector
          if (collector.interrupted) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                session_id: sessionId,
                stop_reason: 'interrupted',
                response: collector.texts.join('') || '(no text received)',
                warning: 'SSE stream was closed before the response completed.',
              }, null, 2) }],
              isError: true,
            };
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
        const stream = state.eventStreams.get(sessionId);
        // Best-effort cancel — must not prevent collector resolution
        try {
          await state.client.cancel(sessionId);
        } catch { /* best-effort */ }
        // Resolve active collector so the prompt handler returns immediately
        if (stream?.activeCollector) {
          stream.activeCollector.interrupted = true;
          stream.activeCollector.resolve();
        }
        return formatJsonResult({ ok: true, sessionId });
      }),
    ),
  ];
}
