/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo, ToolCallResponseInfo } from './turn.js';
import type { Config } from '../config/config.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';
import type { ModToolCall, ModToolCheck } from '../mods/tool-events.js';
import { executeModTool, modToolRequest } from '../mods/tool-execution.js';
import {
  CoreToolScheduler,
  type AllToolCallsCompleteHandler,
  type OutputUpdateHandler,
  type ToolCallsUpdateHandler,
  type CompletedToolCall,
} from './coreToolScheduler.js';

export interface ExecuteToolCallOptions {
  modToolCall?: ModToolCall;
  modToolCheck?: ModToolCheck;
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
  const execution =
    options.modToolCall && (await modToolRequest(config, toolCallRequest));
  if (execution && options.modToolCall) {
    const { response, completed } = await executeModTool(
      toolCallRequest,
      execution,
      options.modToolCall,
      async (request, signal, check) => {
        let completed: CompletedToolCall | undefined;
        await executeToolCall(config, request, signal, {
          ...options,
          modToolCall: undefined,
          modToolCheck: check,
          recordToolResult: false,
          onAllToolCallsComplete: async (calls) => {
            completed = calls[0];
          },
        });
        if (!completed) throw new Error('Mod native tool did not complete.');
        return completed;
      },
      abortSignal,
    );
    if (completed)
      await options.onAllToolCallsComplete?.([{ ...completed, response }]);
    if (options.recordToolResult !== false)
      config
        .getChatRecordingService()
        ?.recordToolResult(response.responseParts, {
          ...response,
          status: completed?.status ?? (response.error ? 'error' : 'success'),
        });
    return response;
  }
  return new Promise<ToolCallResponseInfo>((resolve, reject) => {
    new CoreToolScheduler({
      config,
      modToolCheck: options.modToolCheck,
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
      .schedule(toolCallRequest, abortSignal, options.runtimeView)
      .catch(reject);
  });
}
