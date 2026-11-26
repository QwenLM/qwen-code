/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createChildAbortController } from '../tools/abort-utils.js';
import type { ToolResult } from '../tools/tools.js';
import { raceWithAbortSignal } from './abort-race.js';
import { emitReadFileDiagnostic } from './diagnosticInterceptors.js';
import { getAgentContext } from './agentContext.js';
import { getToolCallContext } from './toolCallContext.js';
import { getSessionIdFromContext } from './sessionIdContext.js';
import { promptIdContext } from './promptIdContext.js';

export const READ_FILE_TIMEOUT_MS = 60_000;
export type ReadFilePhase =
  | 'stat'
  | 'read_file'
  | 'content_processing'
  | 'context_discovery'
  | 'path_suggestion';

export class ReadFileTimeoutError extends Error {
  constructor() {
    super(
      'Read timed out after 60 seconds. Check that the file is accessible before trying again.',
    );
    this.name = 'ReadFileTimeoutError';
  }
}

type Execution = {
  signal: AbortSignal;
  phases: Map<object, ReadFilePhase>;
  log: (data: Parameters<typeof emitReadFileDiagnostic>[0]['data']) => void;
};
const executionContext = new AsyncLocalStorage<Execution>();

// 仅对 Read invocation 生效，共享文件工具的其他消费者不继承超时策略。
export async function runReadFileExecution(
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<ToolResult>,
  sessionId?: string,
): Promise<ToolResult> {
  parentSignal.throwIfAborted();
  const { controller, cleanup } = createChildAbortController(parentSignal);
  const { signal } = controller;
  const tool = getToolCallContext();
  const started = performance.now();
  const execution: Execution = {
    signal,
    phases: new Map(),
    log(data) {
      try {
        emitReadFileDiagnostic({
          sessionId: getSessionIdFromContext() ?? sessionId,
          turnId: promptIdContext.getStore(),
          toolCallId: tool?.callId,
          agentId: getAgentContext()?.agentId,
          data,
        });
      } catch {
        // 诊断失败不能改变工具结果。
      }
    },
  };
  const timer = setTimeout(
    () => controller.abort(new ReadFileTimeoutError()),
    READ_FILE_TIMEOUT_MS,
  );
  timer.unref();
  let settled = false;
  let returned = false;
  const pending = executionContext.run(execution, async () => {
    try {
      const result = await operation(signal);
      signal.throwIfAborted();
      return result;
    } finally {
      settled = true;
      if (returned)
        execution.log({ event: 'late_settlement', status: 'discarded' });
    }
  });
  try {
    const result = await raceWithAbortSignal(pending, signal);
    execution.log({
      event: 'finished',
      status: result.error ? 'failed' : 'success',
      duration_ms: performance.now() - started,
    });
    return result;
  } catch (error) {
    execution.log({
      event: 'finished',
      status:
        signal.reason instanceof ReadFileTimeoutError
          ? 'timeout'
          : signal.aborted
            ? 'cancelled'
            : 'failed',
      phases: [...new Set(execution.phases.values())],
      duration_ms: performance.now() - started,
      timeout_ms: READ_FILE_TIMEOUT_MS,
      operation_pending: !settled,
    });
    throw signal.aborted ? signal.reason : error;
  } finally {
    returned = true;
    clearTimeout(timer);
    cleanup();
  }
}

// 复用原有 I/O API；readFile 的内部 open/read/close 不伪装成独立观测阶段。
export async function readFileStage<T>(
  phase: ReadFilePhase,
  operation: () => Promise<T>,
): Promise<T> {
  const execution = executionContext.getStore();
  if (!execution) return operation();
  execution.signal.throwIfAborted();
  const started = performance.now();
  const phaseKey = {};
  execution.phases.set(phaseKey, phase);
  execution.log({ event: 'phase_started', phase });
  try {
    const value = await operation();
    execution.signal.throwIfAborted();
    execution.log({
      event: 'phase_finished',
      phase,
      status: 'success',
      duration_ms: performance.now() - started,
    });
    return value;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    execution.log({
      event: 'phase_finished',
      phase,
      status: execution.signal.aborted ? 'cancelled' : 'failed',
      duration_ms: performance.now() - started,
      error_code:
        typeof code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(code)
          ? code
          : undefined,
    });
    throw error;
  } finally {
    execution.phases.delete(phaseKey);
  }
}
