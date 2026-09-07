/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stat } from 'node:fs/promises';

import { readAgentMeta } from '../agent-transcript.js';
import {
  AgentEventType,
  type AgentEventEmitter,
  type AgentExternalMessageEvent,
  type AgentUsageEvent,
} from '../runtime/agent-events.js';
import {
  consumeRunDelivery,
  finishRun,
  requeueRun,
  upsertRunUsage,
} from './thread-actions.js';
import { runWithAgentRunContext, type AgentRunContext } from './run-context.js';
import { isNodeError } from '../../utils/errors.js';
import {
  attachStallWatchdog,
  DEFAULT_STALL_MS,
} from '../runtime/workflow-stall.js';

async function transcriptSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function runAgentTurn<T>(input: {
  projectRoot: string;
  context: AgentRunContext;
  emitter: AgentEventEmitter;
  abortController?: AbortController;
  metaPath: string;
  transcriptPath: string;
  body: () => Promise<T>;
}): Promise<T> {
  const watchdog = attachStallWatchdog(
    input.emitter,
    input.abortController ?? new AbortController(),
    DEFAULT_STALL_MS,
  );
  let writes: Promise<unknown> = Promise.resolve();
  let writeError: unknown;
  const enqueue = (write: () => Promise<unknown>) => {
    writes = writes.then(write).catch((error: unknown) => {
      writeError ??= error;
    });
  };
  const onExternalMessage = (event: AgentExternalMessageEvent) => {
    if (!event.deliveryId) return;
    enqueue(() =>
      consumeRunDelivery(input.projectRoot, input.context, event.deliveryId),
    );
  };
  const onUsage = (event: AgentUsageEvent) => {
    const tokens = Number(event.usage.totalTokenCount ?? 0);
    if (!Number.isFinite(tokens) || tokens < 0) return;
    enqueue(() =>
      upsertRunUsage(
        input.projectRoot,
        input.context.threadId,
        input.context.runId,
        {
          attempt: input.context.attempt,
          round: event.round,
          tokens,
        },
      ),
    );
  };

  input.emitter.on(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);
  input.emitter.on(AgentEventType.USAGE_METADATA, onUsage);
  // The bookkeeping below must run whether the turn returned or threw. It used
  // to end with `throw writeError` inside the `finally`, which swallows the
  // turn's own error: a run that crashed *and* failed to write its bookkeeping
  // reported only the write failure, and the crash — the thing a person needs
  // — was lost. The turn's outcome is captured instead, and the two errors are
  // rethrown in the order that keeps the more informative one.
  let settled: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    settled = {
      ok: true,
      value: await runWithAgentRunContext(input.context, input.body),
    };
  } catch (error) {
    settled = { ok: false, error };
  } finally {
    const stalled = watchdog.stalled();
    watchdog.dispose();
    input.emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);
    input.emitter.off(AgentEventType.USAGE_METADATA, onUsage);
    await writes;

    const requeued =
      stalled &&
      !writeError &&
      input.context.attempt < 2 &&
      (await requeueRun(input.projectRoot, {
        threadId: input.context.threadId,
        runId: input.context.runId,
        attempt: input.context.attempt,
      }));
    if (!requeued) {
      const meta = readAgentMeta(input.metaPath);
      let outcome: Parameters<typeof finishRun>[3];
      if (writeError) {
        outcome = {
          status: 'failed',
          attempt: input.context.attempt,
          error:
            writeError instanceof Error
              ? writeError.message
              : String(writeError),
          failureStage: 'runtime_event',
        };
      } else if (stalled) {
        outcome = {
          status: 'failed',
          attempt: input.context.attempt,
          error: `Agent produced no activity for ${DEFAULT_STALL_MS}ms.`,
          failureStage: 'stall',
        };
      } else if (meta?.status === 'completed') {
        outcome = { status: 'completed', attempt: input.context.attempt };
      } else if (meta?.status === 'cancelled') {
        outcome = {
          status: 'cancelled',
          attempt: input.context.attempt,
          ...(meta.lastError ? { error: meta.lastError } : {}),
        };
      } else {
        outcome = {
          status: 'failed',
          attempt: input.context.attempt,
          error:
            meta?.lastError ??
            'Background agent turn ended without a terminal status.',
          failureStage: 'runtime',
        };
      }
      try {
        outcome.transcriptEndOffset = await transcriptSize(
          input.transcriptPath,
        );
      } catch (error) {
        outcome = {
          status: 'failed',
          attempt: input.context.attempt,
          error: error instanceof Error ? error.message : String(error),
          failureStage: 'transcript',
        };
      }
      await finishRun(
        input.projectRoot,
        input.context.threadId,
        input.context.runId,
        outcome,
      );
    }
  }
  // The turn's own failure wins: a write failure is already recorded on the run
  // as `failureStage: 'runtime_event'`, while a crash exists nowhere else.
  if (!settled.ok) throw settled.error;
  if (writeError) throw writeError;
  return settled.value;
}
