/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `QueryEvent` → `SDKMessage` 的纯投影：只吃事件、会话 id 与 includePartialMessages，
 * 不碰会话状态。映射结果必须与 core 的 SDK 投影逐字段一致。
 * 例外：result 里的 credits 取自按 sessionId 分区的进程级快照。
 */

import { randomUUID } from 'node:crypto';
import {
  TASK_LIFECYCLE_SUBTYPES,
  cloneUsageForSdkResult,
  deriveOrigin,
  drainSubagentSdkEvents,
  maskModelUsageForSdkOutput,
  projectModelStreamEventForSdk,
  normalizeSdkErrorResult,
  parseTaskNotificationXml,
  projectModelMessageForSdk,
  projectCompactBoundaryForSdk,
  projectTaskSystemEventForSdk,
  splitAssistantForSdk,
  splitUserForSdk,
  getResultErrorCode,
  getResultErrorCodeFromMessages,
  getSessionCreditsSnapshot,
  type ContentBlockParam,
  type ModelUsage,
  type NonNullableUsage,
  type QueryEvent,
  type QueuedCommandAttachment,
  type SDKMessage,
  type SDKMessageOrigin,
  type SDKPermissionDenial,
  type SDKPermissionDeniedReasonType,
  type Terminal,
} from '@qwen-code/core';

/** 投影只需要两样会话事实：帧上的 `session_id`，以及要不要发流式增量。 */
export interface QueryProjectionContext {
  readonly sessionId: string;
  readonly includePartialMessages: boolean;
}

/**
 * 一次提交内的 `result` 帧精度字段累计器。
 *
 * 逐事件累计（见 `accumulateDurableEvent`），提交结束时交给 `buildResult*`。
 * 生命周期是**一次 submitMessage**，不是整个会话——跨提交累计的是
 * `SessionQueryRunner.cumulativeUsage`，两者不要混。
 */
export interface ResultAccumulator {
  /** 模型请求耗时之和，不含工具执行时间。 */
  apiDurationMs: number;
  /** 最后一条 ModelMessage 的模型级 stop reason（`end_turn` / `tool_use` …）。 */
  lastStopReason: string | null;
  /** 最近一次 `request_start` 的时间戳，用来算 API 耗时；null 表示不在请求中。 */
  lastRequestStartTime: number | null;
  /** 按模型名累计的 token 用量。 */
  modelUsage: Record<string, ModelUsageEntry>;
  /** 本次请求内被拒的工具调用。 */
  permissionDenials: SDKPermissionDenial[];
}

interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export function createResultAccumulator(
  lastStopReason: string | null = null,
): ResultAccumulator {
  return {
    apiDurationMs: 0,
    lastStopReason,
    lastRequestStartTime: null,
    modelUsage: {},
    permissionDenials: [],
  };
}

/**
 * 任务生命周期帧、API 重试与排队状态都是**瞬态** system 事件：要投影给宿主，但不进
 * 会话历史（否则下一轮的上下文里会混进一堆早已过期的重试提示）。
 */
export function isTransientSystemMessage(event: QueryEvent): boolean {
  return (
    event.type === 'system' &&
    (TASK_LIFECYCLE_SUBTYPES.has(event.subtype) ||
      event.subtype === 'api_retry' ||
      event.subtype === 'model_queue_status')
  );
}

/** 子 agent 的 assistant / user 事件带 `parent_tool_use_id`，只归子会话历史。 */
export function isChildScopedMessage(
  event: Extract<QueryEvent, { type: 'assistant' | 'user' }>,
): boolean {
  return (
    typeof event.parent_tool_use_id === 'string' &&
    event.parent_tool_use_id.length > 0
  );
}

/** `request_start` 打开 API 计时窗口。 */
export function noteRequestStart(acc: ResultAccumulator): void {
  acc.lastRequestStartTime = Date.now();
}

/**
 * 累计一条**将要写进会话历史**的持久事件对 `result` 帧的贡献。
 *
 * 调用点必须在「uuid 已知 → 只投影不累计」那条早退之后：同一条消息被重复投递时
 * （resume 后的回放、attachment 重放）不能再把它的 token 记第二遍。
 */
export function accumulateDurableEvent(
  acc: ResultAccumulator,
  event: QueryEvent,
  onToolResult: () => void,
): void {
  if (event.type === 'assistant') {
    if (acc.lastRequestStartTime !== null) {
      acc.apiDurationMs += Date.now() - acc.lastRequestStartTime;
      acc.lastRequestStartTime = null;
    }

    const msg = event.message;
    if (event.isContentFilteredMessage !== true) {
      acc.lastStopReason = msg.stop_reason;
    }

    const modelKey = msg.model || 'unknown';
    const entry = (acc.modelUsage[modelKey] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    });
    const usage = msg.usage;
    if (usage) {
      entry.inputTokens += usage.input_tokens;
      entry.outputTokens += usage.output_tokens;
      entry.cacheReadInputTokens += usage.cache_read_input_tokens;
      entry.cacheCreationInputTokens += usage.cache_creation_input_tokens;
    }
    entry.webSearchRequests +=
      usage?.server_tool_use.web_search_requests ?? 0;
    return;
  }

  if (
    event.type === 'user' &&
    Array.isArray(event.message.content) &&
    event.message.content.some((block) => block.type === 'tool_result')
  ) {
    onToolResult();
    return;
  }

  if (event.type === 'system' && event.subtype === 'permission_denied') {
    acc.permissionDenials.push({
      tool_name: event.tool_name ?? '',
      tool_use_id: event.tool_use_id ?? '',
      tool_input: event.tool_input ?? {},
      message: event.message ?? event.content,
      decision_reason_type: toSdkPermissionDeniedReasonType(
        event.decision_reason_type,
      ),
      decision_reason: event.decision_reason,
      ...(event.tool_denial_kind
        ? { tool_denial_kind: event.tool_denial_kind }
        : {}),
    });
  }
}

function toSdkPermissionDeniedReasonType(
  reasonType:
    | Extract<QueryEvent, { type: 'system' }>['decision_reason_type']
    | undefined,
): SDKPermissionDeniedReasonType | undefined {
  return reasonType;
}

/** 从裸 SSE 事件里取 `content_block_delta` 的文本增量，取不到回 null。 */
export function extractTextFromStreamEvent(
  event: Extract<QueryEvent, { type: 'stream_event' }>['event'],
): string | null {
  return event.type === 'content_block_delta' &&
    event.delta.type === 'text_delta'
    ? event.delta.text
    : null;
}

/**
 * 把单条 `QueryEvent` 投影成零或多条 `SDKMessage`。
 *
 * stream_event / assistant_block 受 includePartialMessages 控制；assistant、user 按
 * block 拆分；system 承载任务生命周期、重试、队列与压缩边界。
 * `onResponseText` 与是否发帧解耦：增量文本始终累计，供 result 与 after-hook 使用。
 */
export function* projectQueryEvent(
  event: QueryEvent,
  ctx: QueryProjectionContext,
  onResponseText: (text: string) => void,
): Generator<SDKMessage> {
  switch (event.type) {
    case 'request_start':
    case 'result_text_reset':
      break;

    case 'stream_event': {
      // 不按 parent_tool_use_id 门禁：core 的参照投影会把子工具作用域的 stream 帧一并外发
      // （帧上带 parent_tool_use_id，由消费方自己归属），buildPartialAssistant 也已经原样
      // 透传该字段。这里再加门禁会与参照侧分叉，queryProjectionParity 直接报帧数不一致。
      if (ctx.includePartialMessages) {
        yield buildPartialAssistant(event, ctx);
      }
      const text = extractTextFromStreamEvent(event.event);
      if (text) onResponseText(text);
      break;
    }

    case 'assistant_block':
      if (ctx.includePartialMessages) {
        yield buildAssistantBlock(event, ctx);
      }
      break;

    case 'command_lifecycle':
      yield {
        type: 'command_lifecycle',
        command_uuid: event.uuid,
        state: event.state,
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      };
      break;

    case 'assistant':
      yield* splitAssistantForSdk(event, ctx.sessionId);
      break;

    case 'user':
      yield* splitUserForSdk(event, ctx.sessionId);
      break;

    case 'attachment': {
      // queued_command 附件要投成 SDK user 帧，宿主才看得见 turn 中途插入的指令。
      const att = event.attachment;
      const queuedCommand =
        att?.type === 'queued_command'
          ? (att as unknown as QueuedCommandAttachment)
          : undefined;
      const isTaskNotification =
        queuedCommand !== undefined &&
        deriveOrigin(queuedCommand)?.kind === 'task-notification';
      if (queuedCommand && (!queuedCommand.isMeta || isTaskNotification)) {
        const text = extractQueuedCommandText(queuedCommand.prompt);
        if (text) {
          if (isTaskNotification) {
            const notification = projectQueuedTaskNotification(
              text,
              ctx.sessionId,
            );
            if (notification) yield notification;
          }
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text }],
            },
            parent_tool_use_id: null,
            uuid: queuedCommand.source_uuid ?? event.uuid ?? randomUUID(),
            session_id: ctx.sessionId,
            timestamp: event.timestamp,
            isReplay: true,
            ...(isTaskNotification
              ? {
                  isSynthetic: true,
                  origin: { kind: 'task-notification' },
                }
              : {}),
          } as unknown as SDKMessage;
        }
      }
      break;
    }

    case 'system':
      if (TASK_LIFECYCLE_SUBTYPES.has(event.subtype)) {
        yield projectTaskSystemEventForSdk(event, ctx.sessionId);
      } else if (event.subtype === 'api_retry') {
        yield projectApiRetrySystemEvent(event, ctx);
      } else if (event.subtype === 'model_queue_status') {
        yield projectModelQueueStatusSystemEvent(event, ctx);
      } else if (event.subtype === 'compact_boundary') {
        yield projectCompactBoundaryForSdk(event, ctx.sessionId, 'auto');
      }
      break;

    default:
      break;
  }
}

function extractQueuedCommandText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  return (prompt as ContentBlockParam[])
    .filter(
      (b): b is Extract<ContentBlockParam, { type: 'text' }> =>
        (b as { type?: string })?.type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('');
}

function projectApiRetrySystemEvent(
  event: Extract<QueryEvent, { type: 'system' }>,
  ctx: QueryProjectionContext,
): SDKMessage {
  const retryEvent = event as typeof event & {
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error: string;
  };
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: retryEvent.attempt,
    max_retries: retryEvent.max_retries,
    retry_delay_ms: retryEvent.retry_delay_ms,
    error_status: retryEvent.error_status,
    error: retryEvent.error,
    uuid: retryEvent.uuid,
    session_id: retryEvent.sessionId ?? ctx.sessionId,
  } as SDKMessage;
}

function projectModelQueueStatusSystemEvent(
  event: Extract<QueryEvent, { type: 'system' }>,
  ctx: QueryProjectionContext,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'model_queue_status',
    status: event.status,
    request_id: event.request_id,
    request_set_id: event.request_set_id,
    model_key: event.model_key,
    queue_type: event.queue_type,
    queue_count: event.queue_count,
    wait_time_ms: event.wait_time_ms,
    queue_wait_elapsed_ms: event.queue_wait_elapsed_ms,
    queue_max_wait_ms: event.queue_max_wait_ms,
    service_available: event.service_available,
    uuid: event.uuid,
    session_id: event.sessionId ?? ctx.sessionId,
  } as unknown as SDKMessage;
}

function buildPartialAssistant(
  event: Extract<QueryEvent, { type: 'stream_event' }>,
  ctx: QueryProjectionContext,
): SDKMessage {
  return {
    type: 'stream_event',
    event: projectModelStreamEventForSdk(event.event, event.requestId),
    parent_tool_use_id: event.parent_tool_use_id ?? null,
    uuid: randomUUID(),
    session_id: event.session_id ?? ctx.sessionId,
  } as SDKMessage;
}

function buildAssistantBlock(
  event: Extract<QueryEvent, { type: 'assistant_block' }>,
  ctx: QueryProjectionContext,
): SDKMessage {
  return {
    type: 'assistant',
    ...projectModelMessageForSdk(
      event.message,
      event.requestId,
      event.mcpToolIdentities,
    ),
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  } as SDKMessage;
}

/**
 * 排干子 agent 攒下的任务生命周期事件。
 *
 * 提交开始与结束各调一次：结束时那一次兜住「turn 收尾期间后台任务才报状态」的窗口。
 */
export function* drainPendingTaskSystemEvents(
  sessionId: string,
): Generator<SDKMessage> {
  for (const event of drainSubagentSdkEvents(
    sessionId,
    isTransientSystemMessage,
  )) {
    yield projectTaskSystemEventForSdk(
      event as Extract<QueryEvent, { type: 'system' }>,
      sessionId,
    );
  }
}

/**
 * prompt 本体是一条任务通知 XML 时，先投一条 `task_notification` system 帧。
 * 非任务通知回 null。
 */
export function projectQueuedTaskNotification(
  promptText: string,
  sessionId: string,
): SDKMessage | null {
  const parsed = parseTaskNotificationXml(promptText);
  if (!parsed || !parsed.status) return null;
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: parsed.taskId,
    tool_use_id: parsed.toolUseId,
    status: parsed.status === 'killed' ? 'stopped' : parsed.status,
    output_file: parsed.outputFile,
    summary: parsed.summary,
    uuid: randomUUID(),
    session_id: sessionId,
  } as SDKMessage;
}

export function buildSessionStateChanged(
  state: 'idle' | 'running' | 'requires_action',
  sessionId: string,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: randomUUID(),
    session_id: sessionId,
  } as SDKMessage;
}

/** 把累计器的按模型用量补上 credits，并填 SDKResultMessage 需要的两个占位字段。 */
function buildModelUsageOutput(
  modelUsage: Record<string, ModelUsageEntry>,
  credits: ReturnType<typeof getSessionCreditsSnapshot>,
): Record<string, ModelUsage> {
  const result: Record<string, ModelUsage> = {};
  const models = new Set([
    ...Object.keys(modelUsage),
    ...Object.keys(credits.byModel),
  ]);
  for (const model of models) {
    const usage = modelUsage[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    };
    const modelCredits = credits.byModel[model]?.credits;
    result[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
      contextWindow: 0,
      maxOutputTokens: 0,
      ...(modelCredits !== undefined && !credits.historyIncomplete
        ? { credits: modelCredits }
        : {}),
    };
  }
  return result;
}

export function buildResultSuccess(
  result: string,
  terminal: Terminal | null,
  acc: ResultAccumulator,
  sessionId: string,
  isError = false,
  origin?: SDKMessageOrigin,
): SDKMessage {
  const credits = getSessionCreditsSnapshot(sessionId);
  const terminalReason = terminal ? terminalResultReason(terminal) : undefined;
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: terminal?.durationMs ?? 0,
    duration_api_ms: acc.apiDurationMs,
    is_error: isError,
    num_turns: terminal?.numTurns ?? 0,
    result,
    stop_reason: acc.lastStopReason,
    ...(terminalReason ? { terminal_reason: terminalReason } : {}),
    total_cost_usd: 0,
    total_credits: credits.totalCredits,
    ...(credits.historyIncomplete ? { credits_history_incomplete: true } : {}),
    usage: cloneUsageForSdkResult(terminal?.usage),
    modelUsage: maskModelUsageForSdkOutput(
      buildModelUsageOutput(acc.modelUsage, credits),
    ),
    permission_denials: acc.permissionDenials,
    fast_mode_state: 'off',
    ...(origin ? { origin } : {}),
    uuid: randomUUID(),
    session_id: sessionId,
  } as SDKMessage;
}

export function buildMaxTurnsErrorInfo(
  numTurns: number,
  maxTurns: number | undefined,
): { errors: string[]; terminalReason: 'max_turns' } {
  // 循环只有在配了上限时才会以 `max_turns` 终止，所以 numTurns 只是那个不可达分支的兜底。
  return {
    errors: [`Reached maximum number of turns (${maxTurns ?? numTurns})`],
    terminalReason: 'max_turns',
  };
}

export function buildResultError(
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries',
  info: {
    errors: string[];
    error?: unknown;
    durationMs: number;
    numTurns: number;
    usage?: NonNullableUsage;
    resultAcc?: ResultAccumulator;
    origin?: SDKMessageOrigin;
    terminalReason?: string;
    errorCode?: number | string;
  },
  sessionId: string,
): SDKMessage {
  const errorCode =
    info.errorCode ??
    (info.error !== undefined
      ? getResultErrorCode(info.error)
      : getResultErrorCodeFromMessages(info.errors));
  const credits = getSessionCreditsSnapshot(sessionId);
  return normalizeSdkErrorResult(
    {
      type: 'result',
      subtype,
      duration_ms: info.durationMs,
      duration_api_ms: info.resultAcc?.apiDurationMs ?? 0,
      is_error: true,
      num_turns: info.numTurns,
      stop_reason: info.resultAcc?.lastStopReason ?? null,
      total_cost_usd: 0,
      total_credits: credits.totalCredits,
      ...(credits.historyIncomplete
        ? { credits_history_incomplete: true }
        : {}),
      usage: cloneUsageForSdkResult(info.usage),
      modelUsage: maskModelUsageForSdkOutput(
        buildModelUsageOutput(info.resultAcc?.modelUsage ?? {}, credits),
      ),
      permission_denials: info.resultAcc?.permissionDenials ?? [],
      errors: info.errors,
      ...(info.terminalReason ? { terminal_reason: info.terminalReason } : {}),
      ...(errorCode !== undefined ? { error_code: errorCode } : {}),
      fast_mode_state: 'off',
      ...(info.origin ? { origin: info.origin } : {}),
      uuid: randomUUID(),
      session_id: sessionId,
    },
    info.error,
  ) as SDKMessage;
}

/**
 * `Terminal` 里那几个要直接变成错误 result 文案的原因。
 *
 * hook 在模型调用前（`continue:false`）结束本轮时没有产生任何回答，不能按空回答的
 * success 上报；把 hook 的 stopReason 写进 errors，调用方才能区分「策略阻断」与
 * 「模型返回空」。
 */
export function terminalResultErrorMessage(
  terminal: Terminal,
): string | null {
  if (terminal.terminalDetail === 'hook_stopped' && terminal.numTurns === 0) {
    return terminal.hookStopReason
      ? `Operation stopped by hook: ${terminal.hookStopReason}`
      : 'Operation stopped by hook';
  }
  switch (terminal.reason) {
    case 'abort':
      return 'Operation aborted';
    case 'repeated_tool_call_denied':
      return 'Repeated tool execution was stopped. Change your prompt and continue.';
    default:
      return null;
  }
}

/**
 * SDK result 的 `terminal_reason`。`repeated_tool_call_denied` 走的是自己的
 * `Terminal.reason`，没有 `abortKind`；只读 abortKind 会把这个终止原因整个丢掉，
 * 宿主只能按通用执行错误兜底（与 core query-engine 的 terminalResultReason 同式）。
 * `terminalDetail` 同理：hook 结束本轮时只有它能表达终止原因。
 */
export function terminalResultReason(terminal: Terminal): string | undefined {
  if (terminal.reason === 'repeated_tool_call_denied') {
    return terminal.reason;
  }
  return terminal.abortKind ?? terminal.terminalDetail;
}
