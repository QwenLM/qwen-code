/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges the streaming tool executor (STE) and the tool executor:
 * - adapts `ToolExecutor.execute` to STE's `executeTool`;
 * - wraps hook, policy and confirmation into STE's `preExecutionGate`;
 * - converts STE results back to scheduler `CompletedToolCall`;
 * - runs a full batch with STE.
 *
 * Model functionResponse formatting happens exactly once, in the converter.
 */

import { HookPermissionDecisionAttachment } from '../../attachments/models/hook-attachments.js';
import type { ToolExecutionResult } from './tool-execution-result.js';
import type { LocalToolCallExecutor } from './tool-call-runner.js';
import {
  buildToolStatusResult,
  isCodeModeDisplay,
  Kind,
} from '../../tools/tools.js';
import type {
  PreExecutionGateFn,
  PreExecutionOutcome,
} from '../../tools/tool-execution-lifecycle.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  ToolResult,
  ToolResultDisplay,
} from '../../tools/tools.js';
import { getFileDiffFromResultDisplay } from '../../utils/fileDiffUtils.js';
import { runLogger } from '../../utils/runLogger.js';
import { runWithToolCallContext } from '../../utils/toolCallContext.js';
import type {
  ToolCallRequestInfo,
  CompletedToolCall,
} from '../types.js';
import { CoreToolCallStatus } from '../types.js';
import { ToolErrorType } from '../../tools/tool-error.js';
import type { ToolCallStateManager } from '../state-manager.js';
import type { Config } from '../../config/config.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import { evaluatePreToolUseHook } from '../../hooks/preToolUseEvaluation.js';
import { createStopContinuationAttachment } from '../../hooks/hookAttachmentHelpers.js';
import { HookEventName, truncateHookOutput } from '../../hooks/types.js';
import { convertToFunctionResponse } from '../../utils/generateContentResponseUtilities.js';
import { partToString } from '../../utils/partUtils.js';
import {
  isDeniedCancellation,
  toToolStatusSummary,
} from '../../utils/tool-utils.js';
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../protocol/transcript/message-utils.js';
// Permission
import type {
  PermissionDecision,
  PermissionRules,
  PermissionRulesBySource,
} from '../../permissions/manager/decision/index.js';
import type { PermissionContext } from '../../permissions/manager/types.js';
import type {
  ToolPermissionExtra,
  ToolPermissionReason,
} from '../../tools/tool-checkers/checker-reasons.js';
import {
  logPermissionRequested,
  logPermissionResolved,
} from '../../permissions/permission-diagnostics.js';
import { firePermissionDeniedHookForAutoModeClassifierDeny } from '../../permissions/permission-denied-hook.js';
import type { ToolUseContext } from '../../tools/tool-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the STE bridge execution. */
export interface ToolGateOptions {
  readonly resultConsumption?: 'model' | 'programmatic';
  /** Resolved tool registry lookup. */
  readonly resolveTool: (name: string) => AnyDeclarativeTool | undefined;
  /** The existing ToolExecutor for actual tool invocation. */
  readonly toolExecutor: LocalToolCallExecutor;
  /** Scheduler state manager for UI event publishing. */
  readonly state: ToolCallStateManager;
  /** Global config. */
  readonly config: Config;
  /** Agent loop context (for permissions, hooks, etc.). */
  readonly context: AgentLoopContext;
  /** Scheduler ID for event correlation. */
  readonly toolCallScopeId: string;
  /** Parent call ID for subagent contexts. */
  readonly parentCallId?: string;
  /** Subagent identifier. */
  readonly subagent?: string;
  /** 当前批次是否已经退场；退场后禁止再发布共享状态。 */
  readonly isRetired?: () => boolean;
}

// ---------------------------------------------------------------------------
// Bridge Callbacks
// ---------------------------------------------------------------------------

/**
 * Creates the `executeTool` callback for STE that delegates to the
 * existing ToolExecutor infrastructure.
 *
 * ToolExecutor returns a thin `ToolExecutorOutput { result, outputFile? }`
 * wrapper. We return `result` directly to STE — `outputFile` is passed
 * through `result.data.outputFile` for downstream consumption.
 */
type HookPermissionVerdict = 'allow' | 'ask' | 'deny';

/**
 * A hook `deny` needs no permission check: nothing downstream is allowed to
 * grant what a hook refused, so the gate settles it on the spot.
 */
function isHookDenial(verdict: HookPermissionVerdict | undefined): boolean {
  return verdict === 'deny';
}

/** Union two additive overlays, bucket by bucket and source by source. */
function combineRuleOverlays(
  a: PermissionRules,
  b: PermissionRules,
): PermissionRules {
  return {
    allow: combineBySource(a.allow, b.allow),
    deny: combineBySource(a.deny, b.deny),
    ask: combineBySource(a.ask, b.ask),
  };
}

function mergeRuleOverlay(
  base: PermissionRules | undefined,
  overlay: PermissionRules,
): PermissionRules {
  return base ? combineRuleOverlays(base, overlay) : overlay;
}

function combineBySource(
  a: PermissionRulesBySource,
  b: PermissionRulesBySource,
): PermissionRulesBySource {
  const out: PermissionRulesBySource = { ...a };
  for (const [source, patterns] of Object.entries(b)) {
    if (!patterns || patterns.length === 0) continue;
    const key = source as keyof PermissionRulesBySource;
    const existing = out[key];
    out[key] = existing ? [...existing, ...patterns] : [...patterns];
  }
  return out;
}

/**
 * The gate's wording for a rejection that carried no message of its own.
 * `getCancellationProtocolContent` has to recognise this exact string, so it is
 * not spelled out twice.
 */
const USER_REJECTED_WITHOUT_FEEDBACK = 'User rejected tool use.';

/**
 * Translate a permission decision into the lifecycle outcome.
 *
 * Cancelled and denied are distinct. The decision does not carry who denied
 * (hook or human), so that attribution stays host-side. Denial text lives in
 * `toolCheck.extra.denialReason` for check-stage denials and in `reason` for
 * ask-stage denials.
 */
function decisionToPreExecutionOutcome(
  decision: PermissionDecision<ToolPermissionReason>,
  opts: {
    aborted?: boolean;
    /** The prompt was shown and explicitly rejected by whoever answered it. */
    userRejected?: boolean;
    modifiedArgs?: Record<string, unknown>;
    /** The PermissionDenied hook asked for a retry of this denial. */
    permissionDeniedHookRetry?: boolean;
  } = {},
): PreExecutionOutcome {
  if (decision.kind === 'allow') {
    return opts.modifiedArgs
      ? { status: 'proceed', modifiedArgs: opts.modifiedArgs }
      : { status: 'proceed' };
  }

  const reason = decision.reason ?? denialReasonOf(decision);
  const userFeedback = opts.userRejected
    ? decision.denialMessage?.trim() || undefined
    : undefined;
  // The refuser's own wording — carried on denialMessage when the ask stage
  // rejected with one — is the truest account of why the call did not run, so
  // prefer it over the ask wording being answered, then fall back to a default.
  const message = opts.userRejected
    ? (userFeedback ?? USER_REJECTED_WITHOUT_FEEDBACK)
    : (decision.denialMessage ??
      reason?.message ??
      'This tool call was not permitted.');

  if (opts.aborted) {
    return {
      status: 'cancelled',
      error: new Error(message),
      toolDenialKind: reason?.denialKind,
    };
  }

  return {
    status: 'denied',
    error: new Error(message),
    errorType: ToolErrorType.PERMISSION_DENIED,
    ...(opts.permissionDeniedHookRetry
      ? { permissionDeniedHookRetry: true }
      : {}),
    toolDenialKind: opts.userRejected ? 'user-rejected' : reason?.denialKind,
    ...(userFeedback ? { userFeedback } : {}),
    decisionReasonType: opts.userRejected
      ? 'permissionPromptTool'
      : decisionReasonTypeOf(reason),
    decisionReason: message,
  };
}

function denialReasonOf(
  decision: PermissionDecision<ToolPermissionReason>,
): ToolPermissionReason | undefined {
  const extra = decision.toolCheck.extra as ToolPermissionExtra | undefined;
  return extra?.denialReason;
}

function decisionReasonTypeOf(reason: ToolPermissionReason | undefined) {
  // Managed rules retain host provenance; the existing wire category stays rule.
  if (reason?.attribution?.type === 'managedRule') return 'rule' as const;
  return reason?.attribution?.type === 'interaction'
    ? ('permissionPromptTool' as const)
    : reason?.attribution?.type;
}

type ToolExecuteCallback = (
  invocation: AnyToolInvocation,
  request: ToolCallRequestInfo,
  tool: AnyDeclarativeTool,
  signal: AbortSignal,
  toolUseContext?: ToolUseContext,
) => Promise<ToolResult>;

/** Wraps LocalToolCallExecutor execution for the programmatic script path. */
export function createToolExecuteCallback(
  options: ToolGateOptions,
): ToolExecuteCallback {
  const { toolExecutor, state, toolCallScopeId, parentCallId, subagent } = options;

  return async (
    invocation,
    request,
    tool,
    signal,
    toolUseContext,
  ): Promise<ToolResult> => {
    if (!options.isRetired?.()) {
      state.updateArgs(request.callId, request.args, invocation);
      state.updateStatus(request.callId, CoreToolCallStatus.Executing);
    }

    const output = await runWithToolCallContext(
      {
        callId: request.callId,
        toolCallScopeId,
        parentCallId,
        subagent,
      },
      () =>
        toolExecutor.execute({
          resultConsumption: options.resultConsumption,
          call: {
            status: CoreToolCallStatus.Executing,
            request,
            tool,
            invocation,
            startTime: Date.now(),
          },
          signal,
          queryLifecycle: toolUseContext?.queryLifecycle,
          sessionId: toolUseContext?.sessionId,
          fileReadState: toolUseContext?.fileReadState,
          skillPermissionOverlay: toolUseContext?.skillPermissionOverlay,
          customContext: toolUseContext?.customContext,
          pendingHookOutputs: toolUseContext?.pendingHookOutputs,
          pendingHookAttachments: toolUseContext?.pendingHookAttachments,
          modelDisplayName: toolUseContext?.modelDisplayName,
          modelKey: toolUseContext?.modelKey,
          modelEntry: toolUseContext?.modelEntry,
          internalExecutionOwner: toolUseContext?.internalExecutionOwner,
          outputUpdateHandler: (id, out) => {
            if (options.isRetired?.()) return;
            state.updateStatus(id, CoreToolCallStatus.Executing, {
              liveOutput: out,
            });
          },
          onUpdateToolCall: (updated) => {
            if (
              updated.status === CoreToolCallStatus.Executing &&
              'pid' in updated &&
              updated.pid &&
              !options.isRetired?.()
            ) {
              state.updateStatus(request.callId, CoreToolCallStatus.Executing, {
                pid: updated.pid,
              });
            }
          },
          callId: request.callId,
          toolCallScopeId,
        }),
    );

    return output.result;
  };
}

/**
 * Creates the `preExecutionGate` callback for the tool-execution-lifecycle
 * pipeline. Uses the Permission Pipeline (rule-based) for all decisions.
 *
 * When `context.toolPermissionContext` is not set (e.g., headless/SDK mode),
 * a default context is built that asks for all tools, ensuring safe
 * always-ask behavior.
 */
export function createToolPreExecutionGate(
  options: ToolGateOptions,
): PreExecutionGateFn {
  const { config, context, state } = options;

  return async (
    invocation: AnyToolInvocation,
    request: ToolCallRequestInfo,
    tool: AnyDeclarativeTool,
    signal: AbortSignal,
    toolUseContext?: ToolUseContext,
  ): Promise<PreExecutionOutcome> =>
    (async () => {
        const evaluate = async (): Promise<PreExecutionOutcome> => {
          if (!options.isRetired?.()) {
            state.updateArgs(request.callId, request.args, invocation);
          }

          // 1. PreToolUse Hook
          const hookResult = await evaluatePreToolUseHook(
            config,
            tool,
            request,
            invocation,
            signal,
            toolUseContext?.modelKey,
            toolUseContext,
          );

          // Guard: if the request was cancelled while the hook was running,
          // bail out immediately to avoid rendering stale permission UI.
          if (signal.aborted) {
            return {
              status: 'denied',
              error: new Error('Request cancelled during pre-tool-use hook'),
            };
          }

          if (hookResult.status === 'error') {
            if (
              hookResult.errorType === ToolErrorType.STOP_EXECUTION &&
              toolUseContext?.pendingHookAttachments
            ) {
              toolUseContext.pendingHookAttachments.push(
                createStopContinuationAttachment(
                  hookResult.error.message,
                  'PreToolUse',
                  tool.name,
                  request.callId,
                ),
              );
            }
            return { status: 'denied', error: hookResult.error };
          }

          const {
            hookDecision,
            hookSystemMessage,
            modifiedArgs,
            newInvocation,
            additionalContext,
          } = hookResult;

          request.preHookContextChars =
            additionalContext && toolUseContext?.pendingHookOutputs
              ? truncateHookOutput(additionalContext).length
              : 0;
          if (additionalContext && toolUseContext?.pendingHookOutputs) {
            toolUseContext.pendingHookOutputs.push({
              hookEventName: HookEventName.PreToolUse,
              output: truncateHookOutput(additionalContext),
              sourceType: 'additionalContext',
              toolName: tool.name,
            });
          }

          if (
            hookResult.status === 'continue' &&
            hookResult.pendingAttachments?.length &&
            toolUseContext?.pendingHookAttachments
          ) {
            toolUseContext.pendingHookAttachments.push(
              ...hookResult.pendingAttachments,
            );
          }

          if (modifiedArgs && newInvocation) {
            request.args = modifiedArgs;
            request.inputModifiedByHook = true;
          }

          // 2. Judge the call.
          //
          // A hook deny settles here: nothing downstream may grant what a hook
          // refused. Its other two verdicts are expressed as overrides, so the
          // tool still analyses its own input either way.
          const hookVerdict =
            hookDecision === 'allow' ||
            hookDecision === 'ask' ||
            hookDecision === 'deny'
              ? (hookDecision as HookPermissionVerdict)
              : undefined;

          if (isHookDenial(hookVerdict)) {
            return {
              status: 'denied',
              error: new Error(
                hookSystemMessage ?? 'A PreToolUse hook denied this call.',
              ),
              decisionReason: hookSystemMessage,
            };
          }

          const permission = context.permission;
          if (!permission) {
            // Fail closed: with no permission object nothing can judge this
            // call, and running it unjudged is the one outcome never wanted.
            return {
              status: 'denied',
              error: new Error(
                'No permission object is available, so this tool call cannot be authorized.',
              ),
            };
          }

          const declared = context.permissionContext?.();
          const grants =
            toolUseContext?.skillPermissionOverlay?.allowedToolPatterns;
          const permissionContext: PermissionContext = {
            ...declared,
            agentId: context.agentId ?? declared?.agentId,
            scene: declared?.scene ?? 'main',
            ...(grants && grants.length > 0
              ? {
                  skillRules: {
                    ...declared?.skillRules,
                    grants,
                  },
                }
              : undefined),
            ...(hookVerdict === 'allow'
              ? {
                  additionalRules: mergeRuleOverlay(declared?.additionalRules, {
                    allow: { session: [tool.name] },
                    deny: {},
                    ask: {},
                  }),
                }
              : undefined),
          };
          // 展开会求值 live getter；把 run-subagent 的 mode getter 原样挂回，
          // 让弹窗挂起期间的重跑仍按父会话实时模式计算。
          const modeDescriptor = declared
            ? Object.getOwnPropertyDescriptor(declared, 'mode')
            : undefined;
          if (modeDescriptor?.get) {
            Object.defineProperty(permissionContext, 'mode', modeDescriptor);
          }

          // The complete context this check runs under, as proof of what each
          // context (main session, subagent, fork) actually supplies.
          try {
            runLogger.log(
              `[permission-check] context tool=${tool.name} callId=${request.callId} ` +
                `agentId=${context.agentId ?? '-'} context=${JSON.stringify(
                  permissionContext,
                  (_key, value) => {
                    if (value instanceof Map) {
                      return `[Map:${[...value.keys()].join(',')}]`;
                    }
                    if (typeof value === 'function') {
                      return '[function]';
                    }
                    if (value instanceof AbortSignal) {
                      return '[AbortSignal]';
                    }
                    return value;
                  },
                )}`,
            );
          } catch {
            // Logging never blocks a decision.
          }

          // The object the component checks against; kept so an amended input
          // can be told from the original by identity below.
          const checkInput = request.args ?? {};
          const permCheckStartedAt = Date.now();
          // The breaker popup is a plain gate: approving it allows this action
          // and rejecting it denies this action. Neither changes the permission
          // mode — a rejection is about the one call, not a request to leave
          // Auto for the rest of the session.
          let decision = await permission.check(
            {
              toolName: tool.name,
              input: checkInput,
              toolUseId: request.callId,
              agentId: context.agentId,
              signal,
              ...(hookVerdict !== undefined
                ? {
                    preToolUseHookVerdict: {
                      behavior: hookVerdict,
                      ...(hookSystemMessage !== undefined
                        ? { message: hookSystemMessage }
                        : {}),
                    },
                  }
                : undefined),
            },
            permissionContext,
          );

          // Capture the presenter-owned attribution before the decision event
          // consumes it. The component says how the ask landed (`settlement`);
          // only the host knows which of its own racers answered it — the prompt,
          // a PermissionRequest hook, or a recheck.
          const askMetrics =
            decision.decidedBy === 'ask'
              ? config.permissionTelemetry.askMetrics.peek(request.callId)
              : undefined;

          if (
            decision.kind === 'deny' &&
            decision.decidedBy === 'ask' &&
            decision.settlement !== 'aborted' &&
            !askMetrics?.winnerParty
          ) {
            const denialReason = denialReasonOf(decision);
            if (denialReason) {
              decision = { ...decision, reason: denialReason };
            }
          }

          // Session diagnostics (permission.requested / permission.resolved).
          // Runs before the decision event because that one consumes the ask
          // stats this peeks. Same guard as the diagnostics: never breaks a check.
          try {
            const diagContext = {
              sessionId: config.getSessionId(),
              promptId: request.prompt_id,
              toolCallId: request.callId,
              toolName: tool.name,
              input: request.args ?? {},
            };
            const diagDurationMs = Date.now() - permCheckStartedAt;
            if (decision.decidedBy === 'ask') {
              logPermissionRequested(
                diagContext,
                decision.reason?.message,
                decision.suggestions?.length,
                decision.suggestions,
              );
              const winner = askMetrics?.winnerParty;
              logPermissionResolved({
                context: diagContext,
                source:
                  winner === 'hook'
                    ? 'hook'
                    : winner !== undefined
                      ? 'user'
                      : 'system',
                decision,
                outcome: winner,
                durationMs: diagDurationMs,
              });
            } else {
              logPermissionResolved({
                context: diagContext,
                source: 'policy',
                decision,
                durationMs: diagDurationMs,
              });
            }
          } catch {
            // Swallowed: a diagnostic failure is never a reason to deny a tool.
          }

          // When the PermissionRequest hook decides the ask, the transcript
          // carries a hook_permission_decision attachment either way.
          if (
            decision.decidedBy === 'ask' &&
            (decision.kind === 'allow' || decision.kind === 'deny') &&
            askMetrics?.winnerParty === 'hook' &&
            toolUseContext?.pendingHookAttachments
          ) {
            toolUseContext.pendingHookAttachments.push(
              new HookPermissionDecisionAttachment({
                type: 'hook_permission_decision',
                decision: decision.kind === 'allow' ? 'allow' : 'deny',
                toolUseID: request.callId,
                hookEvent: HookEventName.PermissionRequest,
              }),
            );
          }

          // The decision is settled: consume this check's ask facts so a later
          // check of the same tool call cannot read a stale winner.
          if (decision.decidedBy === 'ask') {
            config.permissionTelemetry.askMetrics.consume(request.callId);
          }

          // An approving settlement can amend the call — the question tool's
          // answers ride here. The component hands the amended input back on
          // the decision, but the execution lifecycle only rebuilds the
          // invocation from modifiedArgs, so the amendment must travel as one.
          // Reference identity tells an amended input from the original: the
          // component only replaces it when a settlement supplied one.
          const settledInput =
            decision.kind === 'allow' && decision.input !== checkInput
              ? decision.input
              : undefined;

          // The PermissionDenied hook speaks only on auto-mode classifier
          // denials and may request a retry; the flag must ride the denying
          // outcome. Interrupted turns are cancellations, not denials.
          const permissionDeniedHookRetry =
            decision.kind === 'deny' &&
            decision.settlement !== 'aborted' &&
            !signal.aborted &&
            askMetrics?.winnerParty !== 'prompt' &&
            askMetrics?.winnerParty !== 'hook'
              ? await firePermissionDeniedHookForAutoModeClassifierDeny({
                  hookSystem: config.getHookSystem(),
                  reason: decision.reason ?? denialReasonOf(decision),
                  toolName: tool.name,
                  toolInput: request.args ?? {},
                  toolUseId: request.callId,
                  signal,
                  model: toolUseContext?.modelKey,
                })
              : false;

          return decisionToPreExecutionOutcome(decision, {
            // A refusal stays a denial even when the same action also aborts the
            // rest of the turn; only an abort that lands before any answer is a
            // cancellation.
            aborted: signal.aborted && decision.settlement !== 'rejected',
            // Who answered is the one thing the component cannot say: a hook deny
            // reaches it as the same `rejected` a human No does. Each of the
            // host's racers records itself as the winner, so a rejection counts
            // as the user's only when the prompt won — one nobody can be
            // attributed to is not claimed as theirs.
            userRejected:
              decision.settlement === 'rejected' &&
              askMetrics?.winnerParty === 'prompt',
            modifiedArgs: settledInput ?? modifiedArgs,
            ...(permissionDeniedHookRetry
              ? { permissionDeniedHookRetry: true }
              : {}),
          });
        };

        return await evaluate();
    })();
}

// ---------------------------------------------------------------------------
// Result Conversion
// ---------------------------------------------------------------------------

/**
 * Build a single functionResponse Part for error/cancel responses.
 */
function buildErrorResponsePart(
  request: ToolCallRequestInfo,
  payload: Record<string, string>,
): Array<import('@google/genai').Part> {
  return [
    {
      functionResponse: {
        id: request.callId,
        name: request.originalRequestName ?? request.name,
        response: payload,
      },
    },
  ];
}

/**
 * Convert STE's ToolExecutionResult to Scheduler's CompletedToolCall.
 *
 * This is the single place where raw tool output (string/Part[]) is
 * converted to model functionResponse Part[].
 */
export function convertToolResultToCompletedToolCall(
  steResult: ToolExecutionResult,
  toolCallScopeId: string,
  model: import('../../provider/model/model.js').Model | undefined,
): CompletedToolCall {
  const completed = convertToolResultToCompletedToolCallImpl(
    steResult,
    toolCallScopeId,
    model,
  );
  completed.settlement = steResult.settlement;
  return completed;
}

function convertToolResultToCompletedToolCallImpl(
  steResult: ToolExecutionResult,
  toolCallScopeId: string,
  model: import('../../provider/model/model.js').Model | undefined,
): CompletedToolCall {
  const { request, tool, invocation, result, error, cancelled, durationMs } =
    steResult;

  const effectiveName = request.originalRequestName ?? request.name;
  const rawOutputFile = result?.data?.['outputFile'];
  const outputFile =
    typeof rawOutputFile === 'string' ? rawOutputFile : undefined;

  if (cancelled) {
    const errorMessage = error?.message ?? 'Operation cancelled';
    const responseParts = buildErrorResponsePart(request, {
      output: getCancellationProtocolContent(errorMessage),
    });

    return {
      status: CoreToolCallStatus.Cancelled,
      request,
      tool: tool!,
      invocation: invocation!,
      response: {
        callId: request.callId,
        responseParts,
        resultDisplay: resolveAgentResultDisplay(tool, result),
        error: new Error(errorMessage),
        errorType: undefined,
        outputFile,
        contentLength: errorMessage.length,
        toolUseResult:
          result?.toolUseResult ??
          buildToolStatusResult(
            isDeniedCancellation(errorMessage) ? 'denied' : 'cancelled',
            toToolStatusSummary(errorMessage),
          ),
        mcpMeta: result?.mcpMeta,
        readOutputReplacement: result?.readOutputReplacement,
        toolDenialKind: steResult.toolDenialKind ?? 'cancelled',
        userFeedback: steResult.userFeedback,
        decisionReasonType: steResult.decisionReasonType,
        decisionReason: steResult.decisionReason,
      },
      durationMs,
      outcome: undefined,
      toolCallScopeId,
      resultMessages: steResult.resultMessages,
    };
  }

  if (error && !result) {
    return {
      status: CoreToolCallStatus.Error,
      request,
      tool,
      response: {
        callId: request.callId,
        responseParts: buildErrorResponsePart(request, {
          error: error.message,
        }),
        resultDisplay: undefined,
        error,
        errorType: invocation
          ? ToolErrorType.UNHANDLED_EXCEPTION
          : ToolErrorType.INVALID_TOOL_PARAMS,
        contentLength: error.message.length,
      },
      durationMs,
      toolCallScopeId,
      resultMessages: steResult.resultMessages,
    };
  }

  if (result?.error) {
    return {
      status: CoreToolCallStatus.Error,
      request,
      tool,
      response: {
        callId: request.callId,
        responseParts: buildErrorResponsePart(request, {
          error: result.error.message,
        }),
        resultDisplay: resolveAgentResultDisplay(tool, result),
        error: new Error(result.error.message),
        errorType: result.error.type,
        contentLength: result.error.message.length,
        data: result.data,
        toolUseResult: result.toolUseResult,
        mcpMeta: result.mcpMeta,
        readOutputReplacement: result.readOutputReplacement,
        toolDenialKind: steResult.toolDenialKind,
        userFeedback: steResult.userFeedback,
        decisionReasonType: steResult.decisionReasonType,
        decisionReason: steResult.decisionReason,
      },
      durationMs,
      toolCallScopeId,
      resultMessages: steResult.resultMessages,
    };
  }

  // Success — convert raw llmContent to model functionResponse Part[]
  const llmContent = result?.llmContent ?? '';
  const responseParts = convertToFunctionResponse(
    effectiveName,
    request.callId,
    llmContent,
    model,
  );

  return {
    status: CoreToolCallStatus.Success,
    request,
    tool: tool!,
    invocation: invocation!,
    response: {
      callId: request.callId,
      responseParts,
      resultDisplay: resolveAgentResultDisplay(tool, result),
      error: undefined,
      errorType: undefined,
      contentLength: partToString(llmContent, { verbose: true }).length,
      data: result?.data,
      toolUseResult: result?.toolUseResult,
      mcpMeta: result?.mcpMeta,
      readOutputReplacement: result?.readOutputReplacement,
      repeatNeutral:
        result?.repeatNeutral === true && !result.isError ? true : undefined,
      // See `ToolCallResponseInfo.diffStat`: `resultDisplay` below is
      // Agent-only, so the deltas ride on a display-neutral field.
      diffStat: getFileDiffFromResultDisplay(result?.returnDisplay)?.diffStat,
      outputFile,
      isError: result?.isError === true ? true : undefined,
    },
    durationMs,
    toolCallScopeId,
    resultMessages: steResult.resultMessages,
  };
}

/** Only displays that carry nested progress reach the UI; others project from toolUseResult. */
function resolveAgentResultDisplay(
  tool: AnyDeclarativeTool | undefined,
  result: ToolResult | undefined,
): ToolResultDisplay | undefined {
  return tool?.kind === Kind.Agent || isCodeModeDisplay(result?.returnDisplay)
    ? result?.returnDisplay
    : undefined;
}

/**
 * What the model sees when a call ended by cancellation instead of running.
 *
 * A message that is itself a cancellation phrase only says the call did not run,
 * so it must not be dressed up as something the user said. Anything else reached
 * here as a denial's own wording — a hook's, a rule's — and is carried through as
 * the account of why.
 */
function getCancellationProtocolContent(message: string): string {
  const trimmed = message.trim();

  if (
    !trimmed ||
    trimmed === USER_REJECTED_WITHOUT_FEEDBACK ||
    /^user cancelled/i.test(trimmed) ||
    /^operation cancelled/i.test(trimmed) ||
    /^request cancelled/i.test(trimmed)
  ) {
    return REJECT_MESSAGE;
  }

  return `${REJECT_MESSAGE_WITH_REASON_PREFIX}${trimmed}`;
}
