/**
 * @license
 * Copyright 2025 Qwen Team
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
      'Send a prompt to the qwen-code agent and wait for the response. This is the core interaction tool. Note: this call can take a long time as the agent processes the prompt.',
      {
        prompt: z.string().describe('The prompt text to send to the agent.'),
        session_id: z.string().optional().describe('Session ID. Uses default session if omitted.'),
      },
      handler(async (args) => {
        const sessionId = resolveSessionId(state, args.session_id);
        const result = await state.client.prompt(sessionId, {
          prompt: [{ type: 'text', text: args.prompt }],
        });
        return formatJsonResult(result);
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
