/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-client wiring (P1d): builds a real agent-loop event source from a
 * qwen-code `Config` and maps it onto the neutral `StreamEvent` so the OpenTUI
 * backend renders a LIVE conversation (requires valid API credentials at run
 * time). Without credentials this throws and callers fall back to
 * resume/scripted modes.
 *
 * The optional `AbortSignal` is forwarded to `client.sendMessageStream` so the
 * UI can interrupt the live stream (Esc); the generator then rejects with the
 * abort error and the caller settles the UI state.
 *
 * Experimental: part of PR #8677; the legacy ink TUI remains the default until
 * feature parity + regression are complete.
 */

import { appendFileSync } from 'node:fs';
import type { Config } from '@qwen-code/qwen-code-core';
import { CoreToolScheduler, SendMessageType } from '@qwen-code/qwen-code-core';
import type { Part, PartListUnion } from '@google/genai';
import {
  createEventMapper,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';

interface LooseCompletedCall {
  request: { callId: string };
  status: string;
  response?: {
    responseParts?: Part[];
    resultDisplay?: unknown;
    error?: unknown;
  };
}

/** Options the backend passes through to the live turn. */
export interface LivePromptOptions {
  /** Per-turn model override (submit_prompt's modelOverride parity). */
  modelOverride?: string;
}

/**
 * Sends one user prompt through the real client and yields neutral events.
 * The caller (backend) drains this into the streaming model.
 *
 * The prompt is forwarded as a full `PartListUnion` (string or part list,
 * multimodal parts included) — exactly what `submit_prompt` outcomes carry —
 * and an optional per-turn `modelOverride` travels through
 * `SendMessageOptions` the way useGeminiStream feeds it.
 */
export async function* livePromptEvents(
  config: Config,
  prompt: PartListUnion,
  signal?: AbortSignal,
  options?: LivePromptOptions,
): AsyncGenerator<OpenTuiStreamEvent> {
  try {
    await config.initialize();
  } catch {
    /* already initialized by command loading / startup */
  }
  const client = config.getGeminiClient();
  const promptId = `opentui-${Date.now()}`;
  const map = createEventMapper();
  const abort = signal ?? new AbortController().signal;
  const dbg = process.env['QWEN_OPENTUI_DEBUG'];

  // The ink app drives tool EXECUTION via useReactToolScheduler: the client
  // only yields `tool_call_request` and ends the turn, then the UI schedules
  // the tool and submits the functionResponses to continue. Replicate that
  // loop here so tools actually run under OpenTUI (drain -> schedule ->
  // submit results -> drain again).
  let nextPrompt: PartListUnion = prompt;
  let first = true;
  for (;;) {
    const sendOptions = first
      ? options?.modelOverride
        ? {
            type: SendMessageType.UserQuery,
            modelOverride: options.modelOverride,
          }
        : undefined
      : { type: SendMessageType.ToolResult };
    first = false;
    const pending: Array<{ callId: string; name: string; args?: unknown }> = [];
    const stream = client.sendMessageStream(
      nextPrompt,
      abort,
      promptId,
      sendOptions,
    );
    for await (const ev of stream) {
      if (dbg) {
        try {
          appendFileSync(
            '/tmp/opentui-events.log',
            `${(ev as { type?: string }).type}\n`,
          );
        } catch {
          /* ignore */
        }
      }
      if ((ev as { type?: string }).type === 'tool_call_request') {
        pending.push(
          (ev as { value: { callId: string; name: string; args?: unknown } })
            .value,
        );
      }
      for (const neutral of map(ev)) yield neutral;
    }
    if (pending.length === 0 || abort.aborted) return;

    const completed = await new Promise<LooseCompletedCall[]>((resolve) => {
      const scheduler = new CoreToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onAllToolCallsComplete: async (calls) => {
          resolve(calls as unknown as LooseCompletedCall[]);
        },
      });
      void scheduler.schedule(pending as never, abort);
    });

    const responseParts: Part[] = [];
    for (const call of completed) {
      const resp = call.response;
      const display = renderResultDisplay(resp?.resultDisplay);
      if (display)
        yield { type: 'tool-result', id: call.request.callId, display };
      const failed = call.status === 'error' || call.status === 'cancelled';
      yield {
        type: 'tool-end',
        id: call.request.callId,
        success: !failed,
        summary: failed ? 'error' : 'ok',
      };
      if (resp?.responseParts) responseParts.push(...resp.responseParts);
    }
    if (responseParts.length === 0) return;
    nextPrompt = responseParts;
  }
}
