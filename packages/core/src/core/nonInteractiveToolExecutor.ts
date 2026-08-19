/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  Config,
  RuntimeContentGeneratorView,
} from '../index.js';
import {
  CoreToolScheduler,
  type AllToolCallsCompleteHandler,
  type OutputUpdateHandler,
  type ToolCallsUpdateHandler,
} from './coreToolScheduler.js';

export interface ExecuteToolCallOptions {
  outputUpdateHandler?: OutputUpdateHandler;
  onAllToolCallsComplete?: AllToolCallsCompleteHandler;
  onToolCallsUpdate?: ToolCallsUpdateHandler;
  onToolResultFullTurnModel?: (model: string) => boolean;
  /** Direct calls record by default; aggregate callers can defer recording. */
  recordToolResult?: boolean;
  runtimeView?: RuntimeContentGeneratorView;
}

/**
 * Executes a single tool call non-interactively by leveraging the CoreToolScheduler.
 */
export async function executeToolCall(
  config: Config,
  toolCallRequest: ToolCallRequestInfo,
  abortSignal: AbortSignal,
  options: ExecuteToolCallOptions = {},
): Promise<ToolCallResponseInfo> {
  return new Promise<ToolCallResponseInfo>((resolve, reject) => {
    let settled = false;
    const settleResolve = (value: ToolCallResponseInfo) => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const settleReject = (reason: unknown) => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', onAbort);
      reject(reason);
    };
    const onAbort = () => {
      settleReject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error('Operation cancelled.'),
      );
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    new CoreToolScheduler({
      config,
      chatRecordingService:
        options.recordToolResult === false
          ? undefined
          : config.getChatRecordingService(),
      outputUpdateHandler: options.outputUpdateHandler,
      onAllToolCallsComplete: async (completedToolCalls) => {
        if (options.onAllToolCallsComplete) {
          await options.onAllToolCallsComplete(completedToolCalls);
        }
        settleResolve(completedToolCalls[0].response);
      },
      onToolCallsUpdate: options.onToolCallsUpdate,
      onToolResultFullTurnModel: options.onToolResultFullTurnModel,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
    })
      .schedule(toolCallRequest, abortSignal, options.runtimeView)
      .catch(settleReject);
  });
}
