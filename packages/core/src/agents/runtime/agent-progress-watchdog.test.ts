/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentApprovalRequestEvent,
  type AgentRoundEvent,
  type AgentToolCallEvent,
  type AgentToolProgressEvent,
  type AgentToolResultEvent,
} from './agent-events.js';
import {
  attachAgentProgressWatchdog,
  getAgentProgressTimeout,
} from './agent-progress-watchdog.js';

const TOOL_TIMEOUT_MS = 10 * 60_000;
const MODEL_TIMEOUT_MS = 15 * 60_000;

describe('attachAgentProgressWatchdog', () => {
  let emitter: AgentEventEmitter;
  let controller: AbortController;
  let onUnresponsive: ReturnType<typeof vi.fn>;
  let detach: () => void;

  const attach = (isWaitingForExternalInput: () => boolean = () => false) => {
    detach = attachAgentProgressWatchdog(
      emitter,
      controller,
      isWaitingForExternalInput,
      onUnresponsive,
    );
  };
  const toolCall = (callId: string, name = 'task') =>
    emitter.emit(AgentEventType.TOOL_CALL, {
      callId,
      name,
    } as AgentToolCallEvent);
  const toolProgress = (
    callId: string,
    flags: Partial<AgentToolProgressEvent> = {},
  ) =>
    emitter.emit(AgentEventType.TOOL_PROGRESS, {
      callId,
      timestamp: Date.now(),
      ...flags,
    } as AgentToolProgressEvent);
  const toolResult = (callId: string) =>
    emitter.emit(AgentEventType.TOOL_RESULT, {
      callId,
    } as AgentToolResultEvent);
  const abortPhase = () =>
    controller.signal.aborted
      ? getAgentProgressTimeout(controller.signal)?.phase
      : undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    emitter = new AgentEventEmitter();
    controller = new AbortController();
    onUnresponsive = vi.fn();
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('aborts a genuinely stalled tool after the tool deadline', () => {
    attach();
    toolCall('t1');
    toolProgress('t1');
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS - 1);
    expect(abortPhase()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(abortPhase()).toBe('tool');
  });

  it('replaces the tool deadline with the bounded model deadline while a direct approval is pending', () => {
    attach();
    toolCall('t1');
    toolProgress('t1');
    emitter.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
      callId: 't1',
    } as AgentApprovalRequestEvent);
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS + 1_000);
    expect(abortPhase()).toBeUndefined();
    vi.advanceTimersByTime(MODEL_TIMEOUT_MS - TOOL_TIMEOUT_MS);
    expect(abortPhase()).toBe('model/control');
  });

  it('keeps a nested external-input wait free of any deadline until progress resumes', () => {
    attach();
    toolCall('t1');
    toolProgress('t1');
    toolProgress('t1', { waitingForExternalInput: true });
    vi.advanceTimersByTime(2 * MODEL_TIMEOUT_MS);
    expect(abortPhase()).toBeUndefined();

    toolProgress('t1');
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS);
    expect(abortPhase()).toBe('tool');
  });

  it('bounds a nested approval wait by the model deadline, not the tool deadline', () => {
    attach();
    toolCall('t1');
    toolProgress('t1');
    toolProgress('t1', { awaitingApproval: true });
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS + 1_000);
    expect(abortPhase()).toBeUndefined();
    vi.advanceTimersByTime(MODEL_TIMEOUT_MS - TOOL_TIMEOUT_MS);
    expect(abortPhase()).toBe('model/control');
  });

  it('keeps the model deadline suspended while a nested input wait outlives sibling tools', () => {
    attach();
    toolCall('parked');
    toolProgress('parked');
    toolProgress('parked', { waitingForExternalInput: true });
    toolCall('sibling');
    toolProgress('sibling');
    toolResult('sibling');
    vi.advanceTimersByTime(2 * MODEL_TIMEOUT_MS);
    expect(abortPhase()).toBeUndefined();

    toolResult('parked');
    vi.advanceTimersByTime(MODEL_TIMEOUT_MS);
    expect(abortPhase()).toBe('model/control');
  });

  it('suspends the model deadline during a top-level external-input wait', () => {
    attach(() => true);
    emitter.emit(AgentEventType.ROUND_START, {} as AgentRoundEvent);
    emitter.emit(AgentEventType.ROUND_END, {
      waitingForExternalInput: true,
    } as AgentRoundEvent);
    vi.advanceTimersByTime(2 * MODEL_TIMEOUT_MS);
    expect(abortPhase()).toBeUndefined();

    emitter.emit(AgentEventType.EXTERNAL_MESSAGE, {} as never);
    vi.advanceTimersByTime(MODEL_TIMEOUT_MS);
    expect(abortPhase()).toBe('model/control');
  });
});
