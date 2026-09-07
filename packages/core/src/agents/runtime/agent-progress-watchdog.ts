/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentEventType } from './agent-events.js';
import type {
  AgentEventEmitter,
  AgentApprovalRequestEvent,
  AgentToolCallEvent,
  AgentToolOutputUpdateEvent,
  AgentToolProgressEvent,
  AgentToolResultEvent,
} from './agent-events.js';

const MODEL_CONTROL_PROGRESS_TIMEOUT_MS = 15 * 60_000;
const TOOL_PROGRESS_TIMEOUT_MS = 10 * 60_000;

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
  timer?: ReturnType<typeof setTimeout>;
}

export function attachAgentProgressWatchdog(
  emitter: AgentEventEmitter,
  controller: AbortController,
  isWaitingForExternalInput: () => boolean,
): () => void {
  let disposed = false;
  let waitingForExternalInput = false;
  let roundHadToolCalls = false;
  let modelTimer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<string, ToolDeadline>();

  const abort = (error: AgentProgressTimeoutError) => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(error);
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
  const armModel = () => {
    clearModel();
    if (
      disposed ||
      waitingForExternalInput ||
      [...tools.values()].some((tool) => tool.state !== 'queued')
    )
      return;
    modelTimer = schedule(
      MODEL_CONTROL_PROGRESS_TIMEOUT_MS,
      () =>
        abort(
          new AgentProgressTimeoutError(
            'model/control',
            MODEL_CONTROL_PROGRESS_TIMEOUT_MS,
          ),
        ),
      armModel,
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
  const onActivity = () => armModel();
  const onRoundStart = () => {
    waitingForExternalInput = false;
    roundHadToolCalls = false;
    armModel();
  };
  const onRoundEnd = () => {
    waitingForExternalInput = !roundHadToolCalls && isWaitingForExternalInput();
    armModel();
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
  const onToolProgress = (event: AgentToolOutputUpdateEvent) => {
    const tool = tools.get(event.callId);
    if (!tool) return;
    tool.state = 'executing';
    armTool(event.callId);
    clearModel();
  };
  const onToolHeartbeat = (event: AgentToolProgressEvent) => {
    const tool = tools.get(event.callId);
    if (!tool) return;
    tool.state = 'executing';
    armTool(event.callId);
    clearModel();
  };
  const onApproval = (event: AgentApprovalRequestEvent) => {
    const tool = tools.get(event.callId);
    if (!tool) return;
    tool.state = 'approval';
    if (tool.timer) clearTimeout(tool.timer);
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
  emitter.on(AgentEventType.EXTERNAL_MESSAGE, onExternalInput);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_OUTPUT_UPDATE, onToolProgress);
  emitter.on(AgentEventType.TOOL_PROGRESS, onToolHeartbeat);
  emitter.on(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
  armModel();

  return () => {
    if (disposed) return;
    disposed = true;
    clearModel();
    for (const tool of tools.values()) {
      if (tool.timer) clearTimeout(tool.timer);
    }
    tools.clear();
    emitter.off(AgentEventType.START, onActivity);
    emitter.off(AgentEventType.ROUND_START, onRoundStart);
    emitter.off(AgentEventType.ROUND_END, onRoundEnd);
    emitter.off(AgentEventType.STREAM_TEXT, onActivity);
    emitter.off(AgentEventType.USAGE_METADATA, onActivity);
    emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalInput);
    emitter.off(AgentEventType.TOOL_CALL, onToolCall);
    emitter.off(AgentEventType.TOOL_OUTPUT_UPDATE, onToolProgress);
    emitter.off(AgentEventType.TOOL_PROGRESS, onToolHeartbeat);
    emitter.off(AgentEventType.TOOL_WAITING_APPROVAL, onApproval);
    emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
  };
}
