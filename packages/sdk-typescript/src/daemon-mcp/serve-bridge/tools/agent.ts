/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import { isInvalidDaemonClientIdError } from '../../../daemon/DaemonHttpError.js';
import type { BridgeState } from '../types.js';
import { createPromptCollector } from '../sse.js';
import { handler, resolveSessionId } from '../helpers.js';
import {
  invalidateBinding,
  resolveBinding,
  rethrowBindingError,
  trackLifecycle,
} from '../bindings.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function agentTools(state: BridgeState): any[] {
  return [
    tool(
      'prompt',
      'Send a prompt to the qwen-code agent and wait for the full response. This tool blocks until the agent completes processing, which may take minutes for complex tasks. After the HTTP response returns, a 30s collection timeout guards against missing completion signals — if the SSE completion event is not received within 30s, partial text is returned with an error. Do not set a short client-side timeout.',
      {
        prompt: z.string().describe('The prompt text to send to the agent.'),
        session_id: z
          .string()
          .optional()
          .describe('Session ID. Uses default session if omitted.'),
      },
      handler((args, { signal }) =>
        trackLifecycle(state, async () => {
          const sessionId = resolveSessionId(state, args.session_id);
          const binding = resolveBinding(state, sessionId);
          const { stream } = binding;

          // Guard against concurrent prompts on the same session
          if (stream.activeCollector) {
            throw new Error(
              'Another prompt is already in progress for this session. Wait for it to complete or call prompt_cancel first.',
            );
          }

          // Install a new collector to capture this prompt's response chunks.
          signal?.throwIfAborted();
          stream.lastActivityMs = Date.now();
          const collector = createPromptCollector();
          stream.activeCollector = collector;
          let promptSettled = false;
          let cancelPromise: Promise<void> | undefined;
          const cancelCaptured = (): Promise<void> => {
            cancelPromise ??= state.client.cancel(sessionId, binding.clientId);
            return cancelPromise;
          };
          const awaitBestEffortCancel = async (): Promise<boolean> => {
            try {
              await cancelCaptured();
              return false;
            } catch (err) {
              if (isInvalidDaemonClientIdError(err)) {
                return await invalidateBinding(state, binding);
              }
              return false;
            }
          };
          const onAbort = () => {
            if (!collector.resolved) {
              collector.interrupted = true;
              collector.resolve();
            }
            if (promptSettled) {
              void awaitBestEffortCancel();
            }
          };
          signal?.addEventListener('abort', onAbort, { once: true });

          try {
            // Send prompt — response text arrives via the persistent SSE stream.
            const result = await state.client
              .prompt(
                sessionId,
                { prompt: [{ type: 'text', text: args.prompt }] },
                signal,
                binding.clientId,
              )
              .catch(async (err: unknown) =>
                rethrowBindingError(state, binding, err),
              );
            promptSettled = true;
            if (signal?.aborted) {
              await awaitBestEffortCancel();
            }

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
              const bindingInvalidated = await awaitBestEffortCancel();
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
                          'Agent response may be incomplete. _meta event not received within 30s.' +
                          (bindingInvalidated
                            ? ` Call session_resume with session_id "${sessionId}" before retrying.`
                            : ''),
                      },
                      null,
                      2,
                    ),
                  },
                ],
                isError: true,
              };
            }

            if (signal?.aborted) {
              await awaitBestEffortCancel();
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
            return formatJsonResult({
              session_id: sessionId,
              stop_reason: result.stopReason,
              response: responseText,
            });
          } finally {
            if (cancelPromise) {
              await awaitBestEffortCancel();
            }
            signal?.removeEventListener('abort', onAbort);
            // Clear the collector regardless of outcome.
            stream.activeCollector = null;
          }
        }),
      ),
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
      handler((args) =>
        trackLifecycle(state, async () => {
          const sessionId = resolveSessionId(state, args.session_id);
          const binding = resolveBinding(state, sessionId);
          const { stream } = binding;
          try {
            await state.client.cancel(sessionId, binding.clientId);
          } catch (err) {
            await rethrowBindingError(state, binding, err);
          } finally {
            // Resolve active collector even when the daemon rejects cancellation.
            if (stream.activeCollector) {
              stream.activeCollector.interrupted = true;
              stream.activeCollector.resolve();
            }
          }
          return formatJsonResult({ ok: true, sessionId });
        }),
      ),
    ),
  ];
}
