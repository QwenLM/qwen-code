/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import type { PromptResult } from '../../../daemon/types.js';
import {
  bindPromptCollector,
  completePromptCollector,
  createPromptCollector,
  interruptPromptCollector,
} from '../sse.js';
import { handler, resolveSessionId } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function agentTools(state: BridgeState): any[] {
  return [
    tool(
      'prompt',
      'Send a prompt to the qwen-code agent and wait for the full response. This tool blocks until the agent completes processing, which may take minutes for complex tasks. After a legacy blocking reply returns, a 30s collection timeout guards against missing output — if the collection signal is not received within 30s, partial text is returned with an error. Do not set a short client-side timeout.',
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
        // The daemon's subscription is live before its accepted SSE headers.
        // Wait for those headers so a fast prompt cannot finish before we listen.
        await stream.ready;
        if (
          stream.abortCtrl.signal.aborted ||
          state.eventStreams.get(sessionId) !== stream
        ) {
          throw new Error('SSE stream closed before the prompt could start.');
        }

        // Guard against concurrent prompts on the same session
        if (stream.activeCollector) {
          throw new Error(
            'Another prompt is already in progress for this session. Wait for it to complete or call prompt_cancel first.',
          );
        }

        // Install a new collector to capture this prompt's response chunks.
        const releasePromptSlot = state.client.reservePromptSlot(sessionId);
        stream.lastActivityMs = Date.now();
        const collector = createPromptCollector(true);
        stream.activeCollector = collector;

        try {
          // Send prompt — response text arrives via the persistent SSE stream.
          const response = await state.client.promptNonBlocking(sessionId, {
            prompt: [{ type: 'text', text: args.prompt }],
          });
          const nonblocking =
            typeof response.promptId === 'string' &&
            typeof response.lastEventId === 'number';
          bindPromptCollector(
            collector,
            nonblocking ? (response.promptId as string) : undefined,
          );

          // Use this same persistent stream for a nonblocking turn's text and
          // matching terminal. A second subscription could complete first and
          // discard text still in flight on this one.
          const COLLECT_TIMEOUT_MS = 30000;
          let timedOut = false;
          if (nonblocking) {
            await collector.promise;
          } else {
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
          }

          if (collector.error) throw collector.error;

          // Guard against Promise.race microtask race: only treat as timeout
          // if the collector was not already resolved.
          if (timedOut && !collector.resolved) {
            try {
              await state.client.cancel(sessionId);
            } catch {
              /* best-effort */
            }
            const partialText = collector.texts.join('');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      session_id: sessionId,
                      stop_reason: 'timeout',
                      response: partialText || '(no text received)',
                      warning:
                        'Agent response may be incomplete. _meta event not received within 30s.',
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          // SSE disconnect or stopEventStream resolved the collector
          if (collector.interrupted) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      session_id: sessionId,
                      stop_reason: 'interrupted',
                      response:
                        collector.texts.join('') || '(no text received)',
                      warning:
                        'SSE stream was closed before the response completed.',
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const responseText =
            collector.texts.join('') || '(task completed, no text output)';
          completePromptCollector(collector);
          const result = nonblocking
            ? collector.result!
            : (response as PromptResult);
          return formatJsonResult({
            session_id: sessionId,
            stop_reason: result.stopReason,
            response: responseText,
          });
        } finally {
          releasePromptSlot();
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
        } catch {
          /* best-effort */
        }
        // Resolve active collector so the prompt handler returns immediately
        interruptPromptCollector(stream?.activeCollector);
        return formatJsonResult({ ok: true, sessionId });
      }),
    ),
  ];
}
