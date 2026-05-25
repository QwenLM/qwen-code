/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { tool } from '../../tool.js';
import { formatJsonResult } from '../../formatters.js';
import type { BridgeState } from '../types.js';
import { handler, resolveSessionId } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function agentTools(state: BridgeState): any[] {
  return [
    tool(
      'prompt',
      'Send a prompt to the qwen-code agent and wait for the full response. Collects all agent output text from the SSE event stream. Note: this call can take a long time as the agent processes the prompt.',
      {
        prompt: z.string().describe('The prompt text to send to the agent.'),
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);

        // Collect agent response text chunks from SSE in parallel with the prompt call.
        const collectedTexts: string[] = [];
        const abortCtrl = new AbortController();

        const ssePromise = (async () => {
          try {
            for await (const event of state.client.subscribeEvents(sessionId, {
              signal: abortCtrl.signal,
            })) {
              const data = event.data as Record<string, unknown> | undefined;
              if (!data) continue;
              const update = data['update'] as Record<string, unknown> | undefined;
              if (!update) continue;
              if (update['sessionUpdate'] === 'agent_message_chunk') {
                const content = update['content'] as Record<string, unknown> | undefined;
                if (content) {
                  const text = content['text'];
                  if (typeof text === 'string' && text) {
                    collectedTexts.push(text);
                  }
                  // _meta signals end of message
                  if ('_meta' in content) {
                    abortCtrl.abort();
                    return;
                  }
                }
              }
            }
          } catch {
            // SSE aborted or connection closed — expected on completion
          }
        })();

        // Small delay to ensure SSE connection is established before sending prompt
        await new Promise((r) => setTimeout(r, 200));

        const result = await state.client.prompt(sessionId, {
          prompt: [{ type: 'text', text: args.prompt }],
        });

        // Give SSE a moment to deliver remaining chunks after prompt returns
        await Promise.race([ssePromise, new Promise((r) => setTimeout(r, 3000))]);
        abortCtrl.abort();

        const responseText = collectedTexts.join('') || '(task completed, no text output)';
        return formatJsonResult({
          session_id: sessionId,
          stop_reason: result.stopReason,
          response: responseText,
        });
      }),
    ),

    tool(
      'prompt_cancel',
      'Cancel the currently active prompt in a session.',
      {
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
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
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.setSessionModel(sessionId, args.model_id);
        return formatJsonResult(result);
      }),
    ),

    tool(
      'session_context',
      'Get the current session model/mode/config state.',
      {
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.sessionContext(sessionId);
        return formatJsonResult(result);
      }),
    ),
  ];
}
