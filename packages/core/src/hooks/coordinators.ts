/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookCoordinatorAdapter,
  HookBeforeResult,
  HookAfterResult,
} from '../core/hook-coordinator-types.js';
import type { Config } from '../config/config.js';
import type { HookSystem } from './hookSystem.js';
import {
  HookEventName,
  UserPromptSubmitHookOutput,
  type StopFailureErrorType,
  type StopFailureOptions,
} from './types.js';


import { executeAutoDream } from '../services/autoDream/index.js';

export class NoopHookCoordinator implements HookCoordinatorAdapter {
  async fireBefore(): Promise<HookBeforeResult | null> {
    return null;
  }

  async fireAfter(): Promise<HookAfterResult | null> {
    return null;
  }

  drainPendingAsyncContext(): string | undefined {
    return undefined;
  }

  async fireStopFailure(): Promise<void> {}

  dispose(): void {}
}

interface HookOutputLike {
  shouldStopExecution(): boolean;
  shouldClearContext(): boolean;
  isBlockingDecision(): boolean;
  getEffectiveReason(): string;
  getAdditionalContext(): string | undefined;
  systemMessage?: string;
  modelInjection?: string;
  suppressOutput?: boolean;
}

function processAfterHookOutput(
  hookOutput: HookOutputLike,
  pendingAttachments?: Array<
    import('../attachments/types.js').HookAttachment
  >,
): HookAfterResult | null {
  if (hookOutput.shouldStopExecution()) {



    return {
      stopped: true,
      clearContext: hookOutput.shouldClearContext(),
      systemMessage: hookOutput.systemMessage,
      additionalContext: hookOutput.getAdditionalContext(),
      suppressOutput: hookOutput.suppressOutput || undefined,
      pendingAttachments: pendingAttachments?.length
        ? pendingAttachments
        : undefined,
    };
  }
  if (hookOutput.isBlockingDecision()) {


    // Use modelInjection (explicitly for LLM) over reason (human-readable text).
    // Do NOT use systemMessage here — it is UI-only for JSON hooks.
    const inject =
      hookOutput.modelInjection || hookOutput.getEffectiveReason();


    return {
      blocked: true,
      inject,
      clearContext: hookOutput.shouldClearContext(),
      retryAsStopHook: true,
      systemMessage: hookOutput.systemMessage,
      additionalContext: hookOutput.getAdditionalContext(),
      suppressOutput: hookOutput.suppressOutput || undefined,
      pendingAttachments: pendingAttachments?.length
        ? pendingAttachments
        : undefined,
    };
  }

  const result: HookAfterResult = {};
  const sysMsg = hookOutput.systemMessage;
  const addCtx = hookOutput.getAdditionalContext();
  if (sysMsg) result.systemMessage = sysMsg;
  if (addCtx) result.additionalContext = addCtx;
  if (hookOutput.suppressOutput) result.suppressOutput = true;
  if (pendingAttachments?.length)
    result.pendingAttachments = pendingAttachments;

  if (sysMsg || addCtx || result.suppressOutput || result.pendingAttachments) {


    return result;
  }


  return null;
}

async function fireStopFailureImpl(
  hookSystem: HookSystem,
  error: StopFailureErrorType,
  options?: StopFailureOptions,
  signal?: AbortSignal,
  model?: string,
): Promise<void> {
  await hookSystem.fireStopFailureEvent(error, options, signal, model);
}

interface PromptHookState {
  hasFiredBefore: boolean;
  cumulativeResponse: string;
}

export class DefaultHookCoordinator implements HookCoordinatorAdapter {
  private readonly stateMap = new Map<string, PromptHookState>();
  private readonly config: Config | undefined;

  constructor(private readonly hookSystem: HookSystem) {
    this.config = (
      hookSystem as HookSystem & {
        getConfig?: () => Config;
      }
    ).getConfig?.();
  }

  async fireBefore(
    promptId: string,
    prompt: string,
    imageUrls?: readonly string[],
    requestSetId?: string,
    signal?: AbortSignal,
  ): Promise<HookBeforeResult | null> {
    return (async () => {
        let state = this.stateMap.get(promptId);
        if (!state) {
          state = { hasFiredBefore: false, cumulativeResponse: '' };
          this.stateMap.set(promptId, state);
        }

        if (state.hasFiredBefore) {

          return null;
        }
        state.hasFiredBefore = true;

        const aggregated = await this.hookSystem.fireUserPromptSubmitEvent(
          prompt,
          signal,
          imageUrls,
          requestSetId,
        );

        const hookOutput = aggregated?.finalOutput;
        const pendingAtts = aggregated?.pendingAttachments;

        if (!hookOutput) {
          return pendingAtts?.length
            ? { pendingAttachments: pendingAtts }
            : null;
        }

        if (hookOutput.shouldStopExecution()) {

          const stopResult: HookBeforeResult = {
            stopped: true,
            stopReason: hookOutput.stopReason,
            ...(pendingAtts?.length ? { pendingAttachments: pendingAtts } : {}),
          };

          return stopResult;
        }
        if (hookOutput.isBlockingDecision()) {

          const blockedResult: HookBeforeResult = {
            blocked: true,
            ...(pendingAtts?.length ? { pendingAttachments: pendingAtts } : {}),
          };

          return blockedResult;
        }

        const result: HookBeforeResult = {};

        const additionalContext = hookOutput.getAdditionalContext();
        if (additionalContext) {
          result.additionalContext = additionalContext;
        }

        const stdoutForModel = hookOutput.getStdoutForModel(
          HookEventName.UserPromptSubmit,
        );
        if (stdoutForModel) {
          result.stdoutForModel = stdoutForModel;
        }

        if (hookOutput instanceof UserPromptSubmitHookOutput) {
          const sessionTitle = hookOutput.getSessionTitle();
          if (sessionTitle) {
            result.sessionTitle = sessionTitle;
          }
        }

        if (hookOutput.systemMessage) {
          result.systemMessage = hookOutput.systemMessage;
        }
        if (hookOutput.suppressOutput) {
          result.suppressOutput = hookOutput.suppressOutput;
        }
        if (pendingAtts?.length) {
          result.pendingAttachments = pendingAtts;
        }

        if (
          !result.additionalContext &&
          !result.stdoutForModel &&
          !result.sessionTitle &&
          !result.systemMessage &&
          !result.suppressOutput &&
          !result.pendingAttachments
        ) {

          return null;
        }



        return result;
      })();
  }

  async fireAfter(
    promptId: string,
    prompt: string,
    response: string,
    options?: {
      requestId?: string;
      stopHookActive?: boolean;
      parentRequestSetId?: string;
      parentBusinessInfo?: Readonly<
        import('../qoder/business-info.js').BusinessInfo
      >;
      customContext?: Readonly<Record<string, string>>;
      model?: string;
    },
  ): Promise<HookAfterResult | null> {
    const customContext =
      options?.customContext === undefined
        ? undefined
        : Object.freeze({ ...options.customContext });
    return (async () => {
        const state = this.stateMap.get(promptId);
        if (state) {
          state.cumulativeResponse = state.cumulativeResponse
            ? `${state.cumulativeResponse}\n${response}`
            : response;
        }

        const finalResponse = state?.cumulativeResponse || response;

        const aggregated = await this.hookSystem.fireStopEvent(
          prompt,
          finalResponse,
          options?.stopHookActive ?? false,
          {
            requestId: options?.requestId,
            parentRequestSetId: options?.parentRequestSetId,
            parentBusinessInfo: options?.parentBusinessInfo,
            customContext,
          },
          undefined,
          options?.model,
        );

        this.stateMap.delete(promptId);
        if (this.config) {
          void executeAutoDream(this.config, {
            prompt,
            response: finalResponse,
            messages: [...this.config.getConversationMessages()],
            systemPrompt:
              this.config.getCacheSafeQuerySnapshot?.()?.systemPrompt,
            parentRequestSetId: options?.parentRequestSetId,
            parentBusinessInfo: options?.parentBusinessInfo,
            customContext,
          });
        }

        const hookOutput = aggregated?.finalOutput;
        const pendingAtts = aggregated?.pendingAttachments;
        if (!hookOutput) {
          return pendingAtts?.length
            ? { pendingAttachments: pendingAtts }
            : null;
        }
        return processAfterHookOutput(hookOutput, pendingAtts);
      })();
  }

  drainPendingAsyncContext(): string | undefined {
    return this.hookSystem.drainPendingAsyncContext();
  }

  async fireStopFailure(
    error: StopFailureErrorType,
    options?: StopFailureOptions,
    signal?: AbortSignal,
    model?: string,
  ): Promise<void> {
    await fireStopFailureImpl(this.hookSystem, error, options, signal, model);
  }

  dispose(): void {
    this.stateMap.clear();
  }
}

export class SubagentHookCoordinator implements HookCoordinatorAdapter {
  constructor(
    private readonly hookSystem: HookSystem,
    private readonly agentId: string,
    private readonly agentType: string,
    private readonly getTranscriptPath?: () => string | undefined,
    private readonly model?: string,
  ) {}

  async fireBefore(): Promise<HookBeforeResult | null> {
    return null;
  }

  async fireAfter(
    promptId: string,
    _prompt: string,
    response: string,
    options?: {
      requestId?: string;
      stopHookActive?: boolean;
      parentRequestSetId?: string;
      parentBusinessInfo?: Readonly<
        import('../qoder/business-info.js').BusinessInfo
      >;
      model?: string;
    },
  ): Promise<HookAfterResult | null> {
    return (async () => {
        const aggregated = await this.hookSystem.fireSubagentStopEvent(
          this.agentId,
          this.agentType,
          options?.stopHookActive ?? false,
          this.getTranscriptPath?.(),
          response,
          undefined,
          options?.model ?? this.model,
        );

        const hookOutput = aggregated?.finalOutput;
        const pendingAtts = aggregated?.pendingAttachments;
        if (!hookOutput) {
          return pendingAtts?.length
            ? { pendingAttachments: pendingAtts }
            : null;
        }
        return processAfterHookOutput(hookOutput, pendingAtts);
      })();
  }

  drainPendingAsyncContext(): string | undefined {
    return this.hookSystem.drainPendingAsyncContext();
  }

  async fireStopFailure(
    error: StopFailureErrorType,
    options?: StopFailureOptions,
    signal?: AbortSignal,
    model?: string,
  ): Promise<void> {
    await fireStopFailureImpl(this.hookSystem, error, options, signal, model);
  }

  dispose(): void {}
}
