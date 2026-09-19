/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentEventType } from './agent-events.js';
import type {
  AgentEventEmitter,
  AgentApprovalRequestEvent,
  AgentRoundEvent,
  AgentToolCallEvent,
  AgentToolProgressEvent,
  AgentToolResultEvent,
} from './agent-events.js';

const MODEL_CONTROL_PROGRESS_TIMEOUT_MS = 15 * 60_000;
const TOOL_PROGRESS_TIMEOUT_MS = 10 * 60_000;
const UNRESPONSIVE_ABORT_GRACE_MS = 5_000;
const MAX_RETRY_DEADLINE_EXTENSION_MS = 6 * 60 * 60_000;

export class AgentProgressTimeoutError extends Error {
  constructor(
    readonly phase: 'model/control' | 'tool',
    readonly timeoutMs: number,
    readonly toolName?: string,
  ) {
    super(
      phase === 'tool'
        ? `Background agent tool "${toolName ?? 'unknown'}" made no progress for ${timeoutMs}ms.`
        : `Background agent made no model/control progress for ${timeoutMs}ms.`,
    );
    this.name = 'AgentProgressTimeoutError';
  }
}

export function getAgentProgressTimeout(
  signal: AbortSignal,
): AgentProgressTimeoutError | undefined {
  return signal.reason instanceof AgentProgressTimeoutError
    ? signal.reason
    : undefined;
}

interface ToolDeadline {
  name: string;
  state: 'queued' | 'approval' | 'executing';
  /** Nested run parked on Monitor-owned external input: suppresses the
      model deadline like a top-level external-input wait does. */
  parkedOnInput?: true;
  timer?: ReturnType<typeof setTimeout>;
}

export function attachAgentProgressWatchdog(
  emitter: AgentEventEmitter,
  controller: AbortController,
  isWaitingForExternalInput: () => boolean,
  onUnresponsive: (error: AgentProgressTimeoutError) => void,
): () => void {
  let disposed = false;
  let waitingForExternalInput = false;
  let roundHadToolCalls = false;
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<string, ToolDeadline>();

  const abort = (error: AgentProgressTimeoutError) => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(error);
    const armEscalation = () => {
      escalationTimer = schedule(
        UNRESPONSIVE_ABORT_GRACE_MS,
        () => onUnresponsive(error),
        armEscalation,
      );
    };
    armEscalation();
  };
  const schedule = (
    timeoutMs: number,
    callback: () => void,
    rearm: () => void,
  ): ReturnType<typeof setTimeout> => {
    const expectedAt = performance.now() + timeoutMs;
    const timer = setTimeout(() => {
      if (performance.now() - expectedAt > 1_000) {
        rearm();
        return;
      }
      callback();
    }, timeoutMs);
    timer.unref?.();
    return timer;
  };
  const clearModel = () => {
    if (modelTimer) clearTimeout(modelTimer);
    modelTimer = undefined;
  };
  const armModel = (retryDelayMs = 0) => {
    clearModel();
    if (
      disposed ||
      waitingForExternalInput ||
      [...tools.values()].some(
        (tool) =>
          tool.state === 'executing' ||
          tool.state === 'approval' ||
          tool.parkedOnInput === true,
      )
    )
      return;
    modelTimer = schedule(
      MODEL_CONTROL_PROGRESS_TIMEOUT_MS +
        Math.min(retryDelayMs, MAX_RETRY_DEADLINE_EXTENSION_MS),
      () =>
        abort(
          new AgentProgressTimeoutError(
            'model/control',
            MODEL_CONTROL_PROGRESS_TIMEOUT_MS,
          ),
        ),
      // Re-arm through a closure so the granted extension survives the
      // clock-drift re-arm: passing the bare reference would drop the
      // argument and collapse the deadline back to the base timeout.
      () => armModel(retryDelayMs),
    );
  };
  const armTool = (callId: string) => {
    const tool = tools.get(callId);
    if (!tool || tool.state !== 'executing' || disposed) return;
    if (tool.timer) clearTimeout(tool.timer);
    tool.timer = schedule(
      TOOL_PROGRESS_TIMEOUT_MS,
      () =>
        abort(
          new AgentProgressTimeoutError(
            'tool',
            TOOL_PROGRESS_TIMEOUT_MS,
            tool.name,
          ),
        ),
      () => armTool(callId),
    );
  };
  const onActivity = () => {
    armModel();
  };
  const onRoundStart = () => {
    waitingForExternalInput = false;
    roundHadToolCalls = false;
    armModel();
  };
  const onRoundEnd = (event: AgentRoundEvent) => {
    waitingForExternalInput =
      event.waitingForExternalInput === true &&
      !roundHadToolCalls &&
      isWaitingForExternalInput();
    armModel();
  };
  const onModelRetry = (event: AgentRoundEvent) => {
    armModel(event.retryDelayMs);
  };
  const onExternalInput = () => {
    waitingForExternalInput = false;
    armModel();
  };
  const onToolCall = (event: AgentToolCallEvent) => {
    roundHadToolCalls = true;
    tools.set(event.callId, { name: event.name, state: 'queued' });
    armModel();
  };
  const onToolHeartbeat = (event: AgentToolProgressEvent) => {
    const tool = tools.get(event.callId);
    if (!tool) return;
    if (event.settled) {
      if (tool.timer) clearTimeout(tool.timer);
      tools.delete(event.callId);
      armModel();
      return;
    }
    if (event.awaitingApproval) {
      // Nested run parked on a user approval: no deadline, matching direct
      // approvals (approval waits must not cause false watchdog failures).
      tool.state = 'approval';
      delete tool.parkedOnInput;
      clearTimeout(tool.timer);
      tool.timer = undefined;
      armModel();
      return;
    }
    if (event.waitingForExternalInput) {
      // Nested run parked on Monitor-owned external input: no deadline, same
      // as a top-level external-input wait.
      tool.state = 'approval';
      tool.parkedOnInput = true;
      clearTimeout(tool.timer);
      tool.timer = undefined;
      clearModel();
      return;
    }
    tool.state = 'executing';
    delete tool.parkedOnInput;
    armTool(event.callId);
    clearModel();
  };
  const onApproval = (event: AgentApprovalRequestEvent) => {
    const tool = tools.get(event.callId);
    if (!tool) return;
    tool.state = 'approval';
    delete tool.parkedOnInput;
    clearTimeout(tool.timer);
    tool.timer = undefined;
    armModel();
  };
  const onToolResult = (event: AgentToolResultEvent) => {
    const tool = tools.get(event.callId);
    if (tool?.timer) clearTimeout(tool.timer);
    tools.delete(event.callId);
    armModel();
  };

  emitter.on(AgentEventType.START, onActivity);
  emitter.on(AgentEventType.ROUND_START, onRoundStart);
  emitter.on(AgentEventType.ROUND_END, onRoundEnd);
  emitter.on(AgentEventType.STREAM_TEXT, onActivity);
  emitter.on(AgentEventType.USAGE_METADATA, onActivity);
  emitter.on(AgentEventType.MODEL_RETRY, onModelRetry);
  emitter.on(AgentEventType.EXTERNAL_MESSAGE, onExternalInput);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_PROGRESS, onToolHeartbeat);
  emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
  armModel();

  return () => {
    if (disposed) return;
    disposed = true;
    clearModel();
    if (escalationTimer) clearTimeout(escalationTimer);
    for (const tool of tools.values()) {
      if (tool.timer) clearTimeout(tool.timer);
    }
    tools.clear();
    emitter.off(AgentEventType.START, onActivity);
    emitter.off(AgentEventType.ROUND_START, onRoundStart);
    emitter.off(AgentEventType.ROUND_END, onRoundEnd);
    emitter.off(AgentEventType.STREAM_TEXT, onActivity);
    emitter.off(AgentEventType.USAGE_METADATA, onActivity);
    emitter.off(AgentEventType.MODEL_RETRY, onModelRetry);
    emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalInput);
    emitter.off(AgentEventType.TOOL_CALL, onToolCall);
    emitter.off(AgentEventType.TOOL_PROGRESS, onToolHeartbeat);
    emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
  };
}
