/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import type { QueryEvent } from '../../core/query-event.js';
import type { SystemMessage } from '../../protocol/transcript/message.js';
import { TASK_LIFECYCLE_SUBTYPES } from '../../protocol/transcript/message-utils.js';
import {
  drainSubagentSdkEvents,
  waitForSubagentSdkEvent,
} from '../../agents/subagent-sdk-events.js';

function isTaskSystemEvent(event: QueryEvent): event is SystemMessage {
  return event.type === 'system' && TASK_LIFECYCLE_SUBTYPES.has(event.subtype);
}

function createSubagentEventMatcher(
  toolUseBlocks: ModelToolUseBlock[],
  includeSessionSnapshots: boolean,
): (event: QueryEvent) => boolean {
  const allowedToolUseIds = new Set(toolUseBlocks.map((block) => block.id));
  return (event: QueryEvent): boolean => {
    if (
      event.type === 'assistant' ||
      event.type === 'user' ||
      event.type === 'stream_event'
    ) {
      return (
        typeof event.parent_tool_use_id === 'string' &&
        allowedToolUseIds.has(event.parent_tool_use_id)
      );
    }

    if (isTaskSystemEvent(event)) {
      // Session-wide snapshots have no tool_use_id and belong to the root query.
      // Forward them alongside launches, without child queries taking them away.
      if (event.subtype === 'background_tasks_changed') {
        return includeSessionSnapshots;
      }
      return (
        typeof event.tool_use_id === 'string' &&
        allowedToolUseIds.has(event.tool_use_id)
      );
    }

    return false;
  };
}

export async function* waitForExecutionWithSubagentEvents<T>(
  sessionId: string,
  toolUseBlocks: ModelToolUseBlock[],
  execution: Promise<T>,
  signal: AbortSignal,
  includeSessionSnapshots: boolean,
): AsyncGenerator<QueryEvent, T> {
  const matches = createSubagentEventMatcher(
    toolUseBlocks,
    includeSessionSnapshots,
  );

  const settled = execution.then(
    (value) => ({ kind: 'result' as const, value }),
    (error) => ({ kind: 'error' as const, error }),
  );
  let abortObserved = signal.aborted;

  for (;;) {
    const waitController = new AbortController();
    let abortWait: (() => void) | undefined;
    if (!abortObserved && signal.aborted) {
      abortObserved = true;
    }
    if (!abortObserved) {
      abortWait = () => waitController.abort();
      signal.addEventListener('abort', abortWait, { once: true });
    }

    const pendingEvent = waitForSubagentSdkEvent(
      sessionId,
      matches,
      waitController.signal,
    );
    const next = await Promise.race([
      pendingEvent.then((event) =>
        event ? { kind: 'event' as const, event } : { kind: 'wait' as const },
      ),
      settled,
    ]);
    if (abortWait) {
      signal.removeEventListener('abort', abortWait);
    }
    waitController.abort();

    if (next.kind === 'event') {
      yield next.event;
      continue;
    }

    if (next.kind === 'wait') {
      // Signal was aborted. Keep draining the already-started tool executor so
      // completed tool results are preserved and only unfinished calls become
      // cancelled results. The parent turn still stops after those results.
      abortObserved = true;
      for (const pendingEvent of drainSubagentSdkEvents(sessionId, matches)) {
        yield pendingEvent;
      }
      continue;
    }

    // A background Agent can enqueue task_started and return its launch result
    // before this wait begins. waitForSubagentSdkEvent removes an immediately
    // available event from the queue. If the already-settled execution wins
    // Promise.race, recover that captured event before returning so it cannot
    // disappear between the queue and the SDK stream.
    const capturedEvent = await pendingEvent;
    if (capturedEvent) {
      yield capturedEvent;
    }

    for (const pendingEvent of drainSubagentSdkEvents(sessionId, matches)) {
      yield pendingEvent;
    }

    if (next.kind === 'error') {
      throw next.error;
    }

    return next.value;
  }
}
