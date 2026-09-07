/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  upsertRunUsage,
} from './thread-actions.js';
import {
  runWithMeshRunContext,
  type MeshRunContext,
} from './run-context.js';

export async function runMeshTurn<T>(input: {
  projectRoot: string;
  context: MeshRunContext;
  emitter: AgentEventEmitter;
  metaPath: string;
  body: () => Promise<T>;
}): Promise<T> {
  let writes: Promise<unknown> = Promise.resolve();
  let writeError: unknown;
  const enqueue = (write: () => Promise<unknown>) => {
    writes = writes.then(write).catch((error: unknown) => {
      writeError ??= error;
    });
  };
  const onExternalMessage = (event: AgentExternalMessageEvent) => {
    if (event.deliveryId === input.context.runId) {
      enqueue(() => consumeRunDelivery(input.projectRoot, input.context));
    }
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
  try {
    return await runWithMeshRunContext(input.context, input.body);
  } finally {
    input.emitter.off(AgentEventType.EXTERNAL_MESSAGE, onExternalMessage);
    input.emitter.off(AgentEventType.USAGE_METADATA, onUsage);
    await writes;

    const meta = readAgentMeta(input.metaPath);
    let outcome: Parameters<typeof finishRun>[3];
    if (writeError) {
      outcome = {
        status: 'failed',
        error:
          writeError instanceof Error ? writeError.message : String(writeError),
        failureStage: 'runtime_event',
      };
    } else if (meta?.status === 'completed') {
      outcome = { status: 'completed' };
    } else if (meta?.status === 'cancelled') {
      outcome = {
        status: 'cancelled',
        ...(meta.lastError ? { error: meta.lastError } : {}),
      };
    } else {
      outcome = {
        status: 'failed',
        error:
          meta?.lastError ??
          'Background agent turn ended without a terminal status.',
        failureStage: 'runtime',
      };
    }
    await finishRun(
      input.projectRoot,
      input.context.threadId,
      input.context.runId,
      outcome,
    );
    if (writeError) throw writeError;
  }
}
