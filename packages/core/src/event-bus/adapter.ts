/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
// Runtime cycle: agent-loop.ts imports runAgentLoopOnBus from this module, and
// this module (plus llm.ts/tool.ts) imports values back from agent-loop.ts. It
// is safe only because every cross-module use sits inside a function body, so
// ESM live bindings resolve lazily after both modules evaluate. Keep it that
// way — no module-scope use of an agent-loop value here, or the cycle becomes a
// TDZ error. (import/no-cycle is not configured to guard this.)
import {
  createSchedulerExecutor,
  type AgentLoopOptions,
  type AgentLoopResult,
} from '../core/agent-loop.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { createBusEvent } from './bus.js';
import { createLoopEventRuntime } from './runtime.js';

const debugLogger = createDebugLogger('EVENT_BUS');

/**
 * The event-driven implementation of `runAgentLoop`. It creates the run
 * state, submits `loop.started`, and resolves with the run's result when
 * Conversation publishes `loop.finished` (or rejects when a handler fails,
 * matching the procedural loop's thrown errors). The host callbacks fire
 * from the handlers at the same points as the procedural loop, so surfaces
 * observe no difference.
 */
export async function runAgentLoopOnBus(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const { config, client } = options;
  const duplicates = options.duplicates ?? {
    handled: new Map(client.getHistoryToolCallFingerprints()),
    responded: new Set<string>(),
  };
  const executor =
    options.executor ??
    createSchedulerExecutor(config, options.scheduler, options.runtimeView);
  const runId = randomUUID();
  // Execution marker: with QWEN_DEBUG_LOG_FILE on, this line proves a run
  // took the bus path rather than the procedural loop.
  debugLogger.debug('runAgentLoopOnBus started', runId);
  const runtime = createLoopEventRuntime();
  const state = runtime.store.create({
    runId,
    promptId: options.first.promptId,
    input: options,
    duplicates,
    executor,
    current: options.first,
  });

  let resolve!: (result: AgentLoopResult) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<AgentLoopResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const off = runtime.bus.subscribe(
    'loop',
    ['loop.finished', 'handler.failed'],
    (event) => {
      if (event.type === 'loop.finished') {
        resolve(event.data.result);
      } else if (event.type === 'handler.failed') {
        // Reject with the original value, as the procedural loop throws it.
        // Wrapping it (e.g. new Error(String(error))) can itself throw for a
        // null-prototype or non-stringifiable value and leave the run pending.
        reject(event.data.error);
      }
    },
    { runId },
  );

  try {
    runtime.bus.publish(
      createBusEvent('loop.started', state, { promptId: state.promptId }),
    );
    return await result;
  } finally {
    off();
    runtime.store.delete(runId);
    runtime.dispose();
  }
}
