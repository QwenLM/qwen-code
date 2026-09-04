/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-initiated tool scheduling for the OpenTUI backend (audit 01 G-6b).
 *
 * Ink commands that return `{ type: 'tool' }` (/restore, /setup-github) are
 * scheduled through `useGeminiStream`'s `schedule_tool` branch: a
 * `ToolCallRequestInfo` with `isClientInitiated: true` goes to the
 * `CoreToolScheduler`, and the completed calls are NOT fed back to the model
 * (useGeminiStream only submits functionResponses for provider-initiated
 * calls). This module reproduces that one-shot schedule as a neutral event
 * stream the backend folds into its transcript, using the same scheduler
 * callbacks the live turn uses (approval requests included).
 */

import {
  CoreToolScheduler,
  type Config,
  type ToolCallConfirmationDetails,
  type ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import {
  extractFileDiff,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';

interface LooseCompletedCall {
  request: { callId: string; name?: string; args?: unknown };
  status: string;
  response?: {
    responseParts?: unknown[];
    resultDisplay?: unknown;
    error?: unknown;
  };
}

export interface ClientToolRunOptions {
  /**
   * Scheduler-level confirmation requests (DEFAULT mode edit/exec approval).
   * The backend renders the dialog and resolves the call through
   * `confirmationDetails.onConfirm`; without it the call never settles.
   */
  onWaitingCall?: (call: {
    callId: string;
    name: string;
    confirmationDetails: ToolCallConfirmationDetails;
  }) => void;
}

/**
 * Runs one client-initiated tool call through the real CoreToolScheduler and
 * yields neutral events (tool-start → args/output/result → tool-end, ending
 * with `done`). Esc aborts through the signal.
 */
export async function* clientToolEvents(
  config: Config,
  toolName: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
  options?: ClientToolRunOptions,
): AsyncGenerator<OpenTuiStreamEvent> {
  const abort = signal ?? new AbortController().signal;
  const callId = `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request: ToolCallRequestInfo = {
    callId,
    name: toolName,
    args: toolArgs,
    isClientInitiated: true,
    prompt_id: `opentui-cmd-${Date.now()}`,
  };

  yield { type: 'tool-start', id: callId, tool: toolName, title: toolName };
  const formattedArgs = JSON.stringify(toolArgs ?? {});
  if (formattedArgs !== '{}') {
    yield { type: 'tool-args', id: callId, args: formattedArgs };
  }

  let waitingSeen = false;
  const completed = await new Promise<LooseCompletedCall[]>((resolve) => {
    const scheduler = new CoreToolScheduler({
      config,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
      // No outputUpdateHandler: like the live turn, the completion path
      // emits the full result; execution-time chunks are not streamed.
      onToolCallsUpdate: (calls) => {
        if (!options?.onWaitingCall) return;
        for (const call of calls) {
          if (call.status !== 'awaiting_approval') continue;
          if (waitingSeen) continue;
          waitingSeen = true;
          options.onWaitingCall({
            callId: call.request.callId,
            name: call.request.name,
            confirmationDetails: call.confirmationDetails,
          });
        }
      },
      onAllToolCallsComplete: async (calls) => {
        resolve(calls as unknown as LooseCompletedCall[]);
      },
    });
    void scheduler.schedule([request], abort);
  });

  for (const call of completed) {
    // FileDiff results ride as structured payloads so the tool card renders
    // colored diff lines (ink DiffResultRenderer parity).
    const diff = extractFileDiff(call.response?.resultDisplay);
    if (diff) {
      yield { type: 'tool-result', id: call.request.callId, display: '', diff };
    } else {
      const display = renderResultDisplay(call.response?.resultDisplay);
      if (display) {
        yield { type: 'tool-result', id: call.request.callId, display };
      }
    }
    const failed = call.status === 'error' || call.status === 'cancelled';
    yield {
      type: 'tool-end',
      id: call.request.callId,
      success: !failed,
      summary: failed
        ? call.status === 'cancelled'
          ? 'cancelled'
          : 'error'
        : 'ok',
    };
  }
  // Client-initiated tools never feed the model back (ink parity: only
  // provider-initiated calls become functionResponses).
  yield { type: 'done' };
}
