/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { markFileStateResultPartial } from '../../utils/fileStateCache.js';


import {
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  resolveToolName,
} from '../../tools/tool-names.js';
import { ToolErrorType } from '../../tools/tool-error.js';
import {
  buildToolStatusResult,
  type ToolLiveOutput,
  type ToolResult,
} from '../../tools/tools.js';


import { REJECT_MESSAGE } from '../../protocol/transcript/message-utils.js';
import type { Config } from '../../config/config.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import { isAbortError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import { executeToolWithHooks } from '../../core/coreToolHookTriggers.js';
import { createToolUseContext } from '../../tools/tool-use-context-factory.js';
import {
  appendHookNotice,
} from '../../tools/tool-result-utils.js';
import type { InternalExecutionOwner } from '../../tools/tool-types.js';
import {
  attachIsHardFailure,
  isHardToolFailure,
} from '../../tools/tool-result-hard-failure.js';
import {
  getRequestSetIdFromContext,
  getBusinessInfoFromContext,
  getSessionIdFromContext,
} from '../../utils/sessionIdContext.js';
import {
  saveTruncatedToolOutput,
  buildPersistedOutputMessage,
  formatUnpersistedToolOutput,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
} from '../../utils/fileUtils.js';
import {
  CoreToolCallStatus,
  type ToolCall,
  type ExecutingToolCall,
} from '../types.js';
import type { PartListUnion } from '@google/genai';

import { toToolStatusSummary } from '../../utils/tool-utils.js';

interface LocalToolCallContext {
  queryLifecycle?: import('../../tools/tool-types.js').QueryLifecycle;
  resultConsumption?: 'model' | 'programmatic';
  call: ToolCall;
  signal: AbortSignal;
  outputUpdateHandler?: (callId: string, output: ToolLiveOutput) => void;
  onUpdateToolCall: (updatedCall: ToolCall) => void;
  /** Tool call identifier for tracing — threaded into ToolUseContext. */
  callId?: string;
  /** Scheduler identifier — threaded into ToolUseContext. */
  toolCallScopeId?: string;
  /** Root session id threaded from the loop-level ToolUseContext. */
  sessionId?: string;
  fileReadState?: import('../../utils/fileStateCache.js').FileStateCache;
  skillPermissionOverlay?: import('../../tools/tool-types.js').SkillPermissionOverlay;
  /** Opaque SDK context inherited by explicit child Agent tool calls. */
  customContext?: Readonly<Record<string, string>>;
  /** Hook output queue from the parent toolUseContext. */
  pendingHookOutputs?: Array<import('../../hooks/types.js').PendingHookOutput>;
  /** Structured hook attachment queue from the parent toolUseContext. */
  pendingHookAttachments?: Array<
    import('../../attachments/types.js').HookAttachment
  >;
  /** Display name of the model that initiated this tool call. */
  modelDisplayName?: string;
  /** Model key (ASCII-safe fallback). */
  modelKey?: string;
  /** Exact model selected for the triggering request; do not re-resolve in tools. */
  modelEntry?: import('../../provider/model/model.js').Model;
  /** Internal owner metadata for nested tool executions. */
  internalExecutionOwner?: InternalExecutionOwner;
}

/**
 * LocalToolCallExecutor's return value.
 *
 * Only carries two things: the tool result (truncated, original format)
 * and the truncation byproduct. Three-state distinction (success/error/
 * cancelled) is determined by STE via signal.aborted and result.error.
 */
interface LocalToolCallExecutorOutput {
  /** Tool execution result (truncated content, original llmContent format). */
  result: ToolResult;
  /** Full output file path generated when truncation occurred (if any). */
  outputFile?: string;
}

export class LocalToolCallExecutor {
  constructor(
    private readonly context: AgentLoopContext,
    private readonly subagent?: string,
  ) {}

  private get config(): Config {
    return this.context.config;
  }

  async execute(
    context: LocalToolCallContext,
  ): Promise<LocalToolCallExecutorOutput> {
    return this.executeObserved(context);
  }

  private async executeObserved(
    context: LocalToolCallContext,
  ): Promise<LocalToolCallExecutorOutput> {
    const { call, signal, outputUpdateHandler, onUpdateToolCall } = context;
    const { request } = call;
    const toolName = request.name;
    const callId = request.callId;
    for (const guard of context.queryLifecycle?.admissionGuards ?? []) {
      const message = guard(request);
      if (message)
        return {
          result: {
            llmContent: message,
            returnDisplay: message,
            isError: true,
          },
        };
    }

    if (
      !('tool' in call) ||
      !call.tool ||
      !('invocation' in call) ||
      !call.invocation
    ) {
      throw new Error(
        `Cannot execute tool call ${callId}: Tool or Invocation missing.`,
      );
    }
    const { tool, invocation } = call;
    const sessionId =
      context.sessionId ??
      getSessionIdFromContext() ??
      this.config.getSessionId?.();

    // Setup live output handling
    const liveOutputCallback =
      tool.canUpdateOutput && outputUpdateHandler
        ? (outputChunk: ToolLiveOutput) => {
            outputUpdateHandler(callId, outputChunk);
          }
        : undefined;

    const shellExecutionConfig = {
      ...this.config.getShellExecutionConfig(),
      // Subagent shell commands should not update the main session CWD
      ...(this.subagent ? { preventCwdChanges: true } : undefined),
      modelDisplayName: context.modelDisplayName,
      modelKey: context.modelKey,
    };

    return (async () => {


        let output: LocalToolCallExecutorOutput;

        try {
          const setExecutionIdCallback = (executionId: number) => {
            const executingCall: ExecutingToolCall = {
              ...call,
              status: CoreToolCallStatus.Executing,
              tool,
              invocation,
              pid: executionId,
              startTime: 'startTime' in call ? call.startTime : undefined,
            };
            onUpdateToolCall(executingCall);
          };

          const toolUseCtx = createToolUseContext({
            resultConsumption: context.resultConsumption,
            signal,
            queryLifecycle: context.queryLifecycle,
            updateOutput: liveOutputCallback,
            options: {
              shellExecutionConfig: {
                ...shellExecutionConfig,
                turnId: request.prompt_id,
                toolCallId: context.callId ?? callId,
              },
              setExecutionIdCallback,
            },
            config: this.config,
            agentLoopContext: new Proxy(this.context, {
              get: (owner, property) => {
                if (property === 'fileReadState')
                  return context.fileReadState ?? owner.fileReadState;
                const value = owner[property as keyof AgentLoopContext];
                return typeof value === 'function' ? value.bind(owner) : value;
              },
            }),
            fileReadState: context.fileReadState ?? this.context.fileReadState,
            skillPermissionOverlay: context.skillPermissionOverlay,
            callId: context.callId ?? callId,
            toolCallScopeId: context.toolCallScopeId,
            agentId: this.context.agentId,
            promptId: request.prompt_id,
            isWorkflowAgent: request.isWorkflowAgent,
            messageId: request.message_id,
            sessionId,
            customContext: context.customContext,
            fileHistory: this.config.getFileHistoryManager(),
            parentRequestSetId: getRequestSetIdFromContext(),
            parentBusinessInfo: getBusinessInfoFromContext(),
            pendingHookOutputs: context.pendingHookOutputs,
            pendingHookAttachments: context.pendingHookAttachments,
            modelDisplayName: context.modelDisplayName,
            modelKey: context.modelKey,
            modelEntry: context.modelEntry,
            internalExecutionOwner:
              context.internalExecutionOwner ??
              this.context.internalExecutionOwner,
            inputModifiedByHook: request.inputModifiedByHook,
            hostImageRead: request.hostImageRead,
          });

          const promise = executeToolWithHooks(
            invocation,
            toolName,
            toolUseCtx,
            tool,
            this.config,
            request.originalRequestName,
            request.callId,
          );

          const toolResult: ToolResult = await promise;

          if (call.request.inputModifiedByHook) {
            const notice =
              'Tool input parameters were modified by a hook before execution.';
            appendHookNotice(toolResult, notice, `\n\n[System] ${notice}`);
          }

          if (context.resultConsumption === 'programmatic') {
            // Preserve raw post-hook facts (including WeakMap file baselines),
            // errors and control fields. The scope owns JSON delivery budgets.
            output = { result: toolResult };
          } else if (signal.aborted) {
            output = await this.createCancelledResult(
              call,
              'User cancelled tool execution.',
              toolResult,
            );
          } else if (toolResult.error === undefined) {
            output = await this.createSuccessResult(call, toolResult);
          } else if (
            resolveToolName(call.request.name) === POWERSHELL_TOOL_NAME &&
            toolResult.error.type === ToolErrorType.SHELL_EXECUTE_ERROR
          ) {
            // Preserve execution diagnostics without changing failure status or
            // bypassing the existing output budget/persistence mechanism.
            const { truncatedContent, outputFile } =
              await this.truncateOutputIfNeeded(
                call,
                isEmptyContent(toolResult.llmContent)
                  ? toolResult.error.message
                  : toolResult.llmContent,
              );
            output = {
              ...this.createErrorResult(
                call,
                new Error(contentToString(truncatedContent)),
                toolResult.error.type,
                toolResult.toolUseResult,
                outputFile
                  ? { ...toolResult.data, outputFile }
                  : toolResult.data,
              ),
              outputFile,
            };
          } else {
            output = this.createErrorResult(
              call,
              new Error(toolResult.error.message),
              toolResult.error.type,
              toolResult.toolUseResult,
              toolResult.data,
            );
          }
        } catch (executionError: unknown) {
          const abortedByError =
            isAbortError(executionError) ||
            (executionError instanceof Error &&
              executionError.message.includes('Operation cancelled by user'));

          if (signal.aborted || abortedByError) {
            output = await this.createCancelledResult(
              call,
              isAbortError(executionError)
                ? 'Operation cancelled.'
                : 'User cancelled tool execution.',
            );
          } else {
            const error =
              executionError instanceof Error
                ? executionError
                : new Error(String(executionError));
            output = this.createErrorResult(
              call,
              error,
              ToolErrorType.UNHANDLED_EXCEPTION,
            );
          }
        }




        return output;
      })();
  }

  private async truncateOutputIfNeeded(
    call: ToolCall,
    content: PartListUnion,
  ): Promise<{ truncatedContent: PartListUnion; outputFile?: string }> {
    const toolName = call.request.name;
    const callId = call.request.callId;

    // 1. Empty output fallback
    if (isEmptyContent(content)) {
      return {
        truncatedContent: `(${toolName} completed with no output)`,
        outputFile: undefined,
      };
    }

    // 2. Per-tool truncation + persistence (always runs)
    const threshold = this.getEffectiveMaxResultSizeChars(call);
    if (threshold !== Infinity) {
      // Fast path: for plain strings, check length directly without materialization
      if (typeof content === 'string') {
        if (content.length <= threshold) {
          return { truncatedContent: content, outputFile: undefined };
        }
      }
      const contentStr = contentToString(content);
      if (contentStr.length > threshold) {
        let outputFile: string | undefined;
        let persistError: unknown;
        try {
          ({ outputFile } = await saveTruncatedToolOutput(
            contentStr,
            toolName,
            callId,
            this.config.storage.getProjectTempDir(),
            this.context.promptId,
          ));
        } catch (error) {
          // Persisting oversized output is best-effort: an unwritable temp
          // directory must not replace a successful tool result with the
          // filesystem error.
          persistError = error;
          runLogger.warn(
            `[ToolExecutor] Unable to persist oversized output for ${toolName}; returning inline preview instead.`,
            error,
          );
        }

        const truncatedContent = outputFile
          ? buildPersistedOutputMessage(contentStr, outputFile)
          : formatUnpersistedToolOutput(contentStr, threshold, persistError);



        return { truncatedContent, outputFile };
      }
    }

    return { truncatedContent: content, outputFile: undefined };
  }

  /**
   * Resolves the effective max result size for a tool.
   * Tools can declare their own maxResultSizeChars; 0 means use the global default.
   * Infinity means the tool is exempt from truncation (e.g., read_file).
   */
  private getEffectiveMaxResultSizeChars(call: ToolCall): number {
    const declared =
      'tool' in call && call.tool ? call.tool.maxResultSizeChars : 0;
    if (declared === Infinity) return Infinity;
    if (declared > 0) {
      return Math.min(declared, DEFAULT_MAX_RESULT_SIZE_CHARS);
    }
    return DEFAULT_MAX_RESULT_SIZE_CHARS;
  }

  /**
   * Build a LocalToolCallExecutorOutput for a cancelled execution.
   * If partial output exists, it is truncated and preserved in llmContent.
   */
  private async createCancelledResult(
    call: ToolCall,
    reason: string,
    toolResult?: ToolResult,
  ): Promise<LocalToolCallExecutorOutput> {
    const errorMessage = reason;

    if (toolResult?.llmContent) {
      const { truncatedContent, outputFile } =
        await this.truncateOutputIfNeeded(call, toolResult.llmContent);

      return {
        result: {
          ...toolResult,
          llmContent: truncatedContent,
          toolUseResult: attachIsHardFailure(toolResult.toolUseResult, false),
          error: {
            type: ToolErrorType.EXECUTION_FAILED,
            message: errorMessage,
          },
          data: {
            ...toolResult.data,
            ...(outputFile && { outputFile }),
          },
        },
        outputFile,
      };
    }

    return {
      result: {
        llmContent: REJECT_MESSAGE,
        returnDisplay: 'Operation cancelled',
        toolUseResult: attachIsHardFailure(
          buildToolStatusResult('cancelled', toToolStatusSummary(reason)),
          false,
        ),
        error: {
          type: ToolErrorType.EXECUTION_FAILED,
          message: errorMessage,
        },
      },
    };
  }

  /**
   * Build a LocalToolCallExecutorOutput for a successful execution.
   * Truncates content but does NOT convert to model API format — that
   * happens later in convertSTEResultToCompletedToolCall.
   */
  private async createSuccessResult(
    call: ToolCall,
    toolResult: ToolResult,
  ): Promise<LocalToolCallExecutorOutput> {
    const { truncatedContent, outputFile } = await this.truncateOutputIfNeeded(
      call,
      toolResult.llmContent,
    );

    if (outputFile) {
      const name = resolveToolName(call.request.name);
      if (name === READ_FILE_TOOL_NAME || name === SHELL_TOOL_NAME)
        markFileStateResultPartial(toolResult, name === READ_FILE_TOOL_NAME);
    }
    return {
      result: {
        ...toolResult,
        llmContent: truncatedContent,
        data: {
          ...toolResult.data,
          ...(outputFile && { outputFile }),
        },
      },
      outputFile,
    };
  }

  /**
   * Build a LocalToolCallExecutorOutput for an errored execution.
   */
  private createErrorResult(
    _call: ToolCall,
    error: Error,
    errorType?: ToolErrorType,
    toolUseResult?: unknown,
    data?: ToolResult['data'],
  ): LocalToolCallExecutorOutput {
    const isHardFailure = isHardToolFailure(errorType, error.message);
    return {
      result: {
        llmContent: error.message,
        returnDisplay: error.message,
        toolUseResult: attachIsHardFailure(toolUseResult, isHardFailure),
        data,
        error: {
          type: errorType ?? ToolErrorType.UNHANDLED_EXCEPTION,
          message: error.message,
        },
      },
    };
  }
}

function isEmptyContent(content: PartListUnion): boolean {
  if (typeof content === 'string') return content.trim().length === 0;
  if (Array.isArray(content)) {
    return (
      content.length === 0 ||
      content.every((p) => {
        if (typeof p === 'string') return p.trim().length === 0;
        return typeof p.text === 'string' && p.text.trim().length === 0;
      })
    );
  }
  // Single Part (non-string, non-array)
  return typeof content.text === 'string' && content.text.trim().length === 0;
}

function contentToString(content: PartListUnion): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        return typeof p.text === 'string' ? p.text : '';
      })
      .join('\n');
  }
  return typeof content.text === 'string' ? content.text : '';
}
