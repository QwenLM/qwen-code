/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  Config,
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
        resolve(completedToolCalls[0].response);
      },
      onToolCallsUpdate: options.onToolCallsUpdate,
      onToolResultFullTurnModel: options.onToolResultFullTurnModel,
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
    })
      .schedule(toolCallRequest, abortSignal)
      .catch(reject);
  });
}
