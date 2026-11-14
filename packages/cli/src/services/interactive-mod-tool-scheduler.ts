/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CoreToolScheduler,
  type CompletedToolCall,
  type ToolCall,
} from '@qwen-code/qwen-code-core/core/coreToolScheduler.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core/core/turn.js';
import {
  captureHookExecutionOwner,
  runWithHookExecutionOwner,
} from '@qwen-code/qwen-code-core/hooks/hook-execution-context.js';
import {
  executeModTool,
  modToolRequest,
} from '@qwen-code/qwen-code-core/mods/tool-execution.js';
import type { ModToolCheck } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { getInteractiveModSession } from './interactive-mod-session.js';

export type InteractiveCompletedToolCall =
  | CompletedToolCall
  | {
      status: 'success';
      request: ToolCallRequestInfo;
      response: ToolCallResponseInfo;
      tool?: CompletedToolCall['tool'];
      invocation?: CompletedToolCall['invocation'];
      durationMs?: number;
    };

export type InteractivePendingToolCall = {
  status: 'scheduled';
  request: ToolCallRequestInfo;
  tool?: undefined;
  invocation?: undefined;
};
export type InteractiveToolCall = (
  | ToolCall
  | InteractiveCompletedToolCall
  | InteractivePendingToolCall
) & {
  nativeAttemptsObserved?: boolean;
};

function logicalCompletion(
  request: ToolCallRequestInfo,
  response: ToolCallResponseInfo,
  completed?: CompletedToolCall,
): InteractiveCompletedToolCall & { nativeAttemptsObserved: true } {
  if (completed?.status === 'cancelled')
    return { ...completed, request, response, nativeAttemptsObserved: true };
  if (response.error)
    return {
      ...completed,
      status: 'error',
      request,
      response,
      nativeAttemptsObserved: true,
    };
  return {
    ...completed,
    status: 'success',
    request,
    response,
    nativeAttemptsObserved: true,
  };
}

const logger = createDebugLogger('INTERACTIVE_MOD_TOOLS');

type NativeOptions = ConstructorParameters<typeof CoreToolScheduler>[0];
type Options = Omit<
  NativeOptions,
  'onAllToolCallsComplete' | 'onToolCallsUpdate'
> & {
  onAllToolCallsComplete: (
    calls: Array<
      InteractiveCompletedToolCall & {
        nativeAttemptsObserved?: boolean;
      }
    >,
  ) => Promise<void>;
  onToolCallsUpdate?: (calls: InteractiveToolCall[]) => void;
  onNativeAttempt?: (call: CompletedToolCall) => Promise<void>;
};

/** Keeps the native batch path intact unless this session has tool middleware. */
export class InteractiveModToolScheduler {
  private readonly native: CoreToolScheduler;
  private tail: Promise<unknown> = Promise.resolve();
  private displayOwner?: object;

  constructor(private readonly options: Options) {
    this.native = new CoreToolScheduler(options);
  }

  schedule(
    request: ToolCallRequestInfo | ToolCallRequestInfo[],
    signal: AbortSignal,
    runtimeView?: Parameters<CoreToolScheduler['schedule']>[2],
  ): Promise<void> {
    const session = getInteractiveModSession(this.options.config);
    // Client tools retain their existing scheduler, including concurrent batches.
    const requests = Array.isArray(request) ? request : [request];
    if (!session || requests.every((item) => item.isClientInitiated)) {
      return this.native.schedule(request, signal, runtimeView);
    }
    const owner = captureHookExecutionOwner(this.options.config);
    const sessionSignal = session.captureToolSignal();
    const active = AbortSignal.any([signal, sessionSignal]);
    const displayOwner = {};
    const clearDisplay = () => {
      if (this.displayOwner !== displayOwner) return;
      this.displayOwner = undefined;
      this.options.onToolCallsUpdate?.([]);
    };
    sessionSignal.addEventListener('abort', clearDisplay, { once: true });
    let delivered = false;
    const task = this.tail.then(() =>
      runWithHookExecutionOwner(owner, async () => {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(active.reason);
          if (active.aborted) return cancel();
          active.addEventListener('abort', cancel, { once: true });
          void session.ready.then(
            () => {
              active.removeEventListener('abort', cancel);
              resolve();
            },
            (error: unknown) => {
              active.removeEventListener('abort', cancel);
              reject(error);
            },
          );
        });
        active.throwIfAborted();
        const middleware = session.toolCall();
        if (!middleware)
          return this.native.schedule(request, active, runtimeView);
        const calls: InteractiveToolCall[] = requests.map((item) => ({
          status: 'scheduled',
          request: item,
          nativeAttemptsObserved: true,
        }));
        const attemptUpdates = new Map<number, InteractiveToolCall[]>();
        const publish = () => {
          if (!sessionSignal.aborted) {
            this.displayOwner = displayOwner;
            this.options.onToolCallsUpdate?.(
              calls.flatMap(
                (call, index) => attemptUpdates.get(index) ?? [call],
              ),
            );
          }
        };
        publish();
        for (let index = 0; index < requests.length; index++) {
          const original = requests[index];
          let last: CompletedToolCall | undefined;
          const execute = (
            nativeRequest: ToolCallRequestInfo,
            nativeSignal: AbortSignal,
            check?: ModToolCheck,
          ) =>
            new Promise<CompletedToolCall>((resolve, reject) => {
              nativeSignal.throwIfAborted();
              active.throwIfAborted();
              const attemptSignal = AbortSignal.any([active, nativeSignal]);
              attemptUpdates.delete(index);
              publish();
              const scheduler = new CoreToolScheduler({
                ...this.options,
                chatRecordingService: undefined,
                modToolCheck: check,
                outputUpdateHandler: (id, chunk) => {
                  if (!attemptSignal.aborted)
                    this.options.outputUpdateHandler?.(id, chunk);
                },
                onToolCallsUpdate: (updates) => {
                  if (attemptSignal.aborted || !updates.length) return;
                  attemptUpdates.set(
                    index,
                    updates.map((current) => {
                      if (current.request.callId !== nativeRequest.callId)
                        return current;
                      if (
                        current.status === 'success' ||
                        current.status === 'error' ||
                        current.status === 'cancelled'
                      ) {
                        return {
                          status: 'scheduled' as const,
                          request: original,
                          nativeAttemptsObserved: true,
                        };
                      }
                      return { ...current, nativeAttemptsObserved: true };
                    }),
                  );
                  publish();
                },
                onAllToolCallsComplete: async (completed) => {
                  last = completed[0];
                  attemptUpdates.delete(index);
                  publish();
                  try {
                    if (!sessionSignal.aborted)
                      await this.options.onNativeAttempt?.(last);
                    resolve(last);
                  } catch (error) {
                    logger.warn(
                      `Native tool observation failed: ${String(error)}`,
                    );
                    resolve(last);
                  }
                },
              });
              void runWithHookExecutionOwner(owner, () =>
                scheduler.schedule(nativeRequest, attemptSignal, runtimeView),
              ).catch(reject);
            });
          try {
            active.throwIfAborted();
            const execution =
              !original.isClientInitiated &&
              (await modToolRequest(this.options.config, original));
            const result = execution
              ? await executeModTool(
                  original,
                  execution,
                  middleware,
                  execute,
                  active,
                )
              : {
                  completed: await execute(original, active),
                  response: undefined,
                };
            const response = result.response ?? result.completed!.response;
            const completed = result.completed;
            calls[index] = logicalCompletion(original, response, completed);
          } catch (error) {
            const message = active.aborted
              ? 'Tool call cancelled.'
              : `Mod tool scheduling failed: ${String(error)}`;
            calls[index] = {
              ...last,
              status: active.aborted ? 'cancelled' : 'error',
              request: original,
              response: {
                callId: original.callId,
                responseParts: [
                  {
                    functionResponse: {
                      id: original.callId,
                      name: original.name,
                      response: { error: message },
                    },
                  },
                ],
                error: new Error(message),
                errorType: undefined,
                resultDisplay: message,
                executionStatus:
                  last?.response.executionStatus ?? 'not_started',
                contentLength: message.length,
              },
              nativeAttemptsObserved: true,
            };
          }
          publish();
        }
        sessionSignal.throwIfAborted();
        clearDisplay();
        delivered = true;
        await this.options.onAllToolCallsComplete(
          calls.filter(
            (call): call is InteractiveCompletedToolCall =>
              call.status === 'success' ||
              call.status === 'error' ||
              call.status === 'cancelled',
          ),
        );
      }),
    );
    const settled = task.catch(async (error: unknown) => {
      if (delivered || sessionSignal.aborted) throw error;
      clearDisplay();
      delivered = true;
      await this.options.onAllToolCallsComplete(
        requests.map((item) => ({
          status: active.aborted ? ('cancelled' as const) : ('error' as const),
          request: item,
          nativeAttemptsObserved: true,
          response: {
            callId: item.callId,
            error: new Error(String(error)),
            errorType: undefined,
            executionStatus: 'not_started' as const,
            resultDisplay: String(error),
            responseParts: [
              {
                functionResponse: {
                  id: item.callId,
                  name: item.name,
                  response: { error: String(error) },
                },
              },
            ],
          },
        })),
      );
    });
    const drained = settled.finally(() => {
      sessionSignal.removeEventListener('abort', clearDisplay);
    });
    this.tail = drained.catch(() => {});
    return drained;
  }
}
