/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * query — one prompt and the tool calls, hooks and continuations it causes.
 *
 * Execution is event driven: a session event bus routes events between the
 * Conversation, Llm and Tool handlers (see ../event-bus/), and query() only
 * listens. It yields the durable messages and runtime events of the query and
 * returns its Terminal. Prediction forks take their own single-response path.
 */

import { readAgentSelectionDefaults } from '../agents/agentModelConfig.js';
import type { QueryEvent, Terminal } from './query-event.js';
import type { QueryParams } from './query-params.js';
import { createQueryStream } from '../event-bus/query-stream.js';

export { DEFAULT_MAX_TURNS, type QueryParams } from './query-params.js';
export type { TaskTrigger } from './task-trigger.js';
export {
  classifyTaskTerminal,
  PostCompactContextLimitError,
  type TaskTerminalClassification,
  type TaskTerminalReasonDetail,
} from './query-terminal.js';
export {
  createQueryEventBus,
  type QueryEventRuntime,
} from '../event-bus/runtime.js';

/**
 * Usage:
 *   for await (const event of query(options)) {
 *     switch (event.type) {
 *       case 'request_start': ...
 *       case 'stream_event': ...
 *       case 'assistant_block': ...
 *       case 'assistant':
 *       case 'user':
 *       case 'system':
 *       case 'progress':
 *       case 'attachment':
 *         ...
 *     }
 *   }
 */
export function query(
  options: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  if (options.compactSelection && options.modelPurpose !== 'compact') {
    throw new Error('compactSelection is only supported for compact queries');
  }
  const agentDefaults =
    options.config &&
    options.isSubagent &&
    (options.modelPurpose === undefined ||
      options.modelPurpose === 'task' ||
      options.modelPurpose === 'fork')
      ? readAgentSelectionDefaults(
          options.config,
          {
            agentId: options.agentId ?? options.promptId,
            agentType: options.agentType,
          },
          options.modelPurpose,
        )
      : undefined;
  // Before selection, use the existing request intent for attribution.
  // Inference and post-selection diagnostics use the Provider's final selection.
  const initialModel =
    (options.modelPurpose === 'fork' || options.modelPurpose === 'side_question'
      ? options.parentSelection?.model.key
      : undefined) ??
    options.compactSelection?.model.key ??
    options.querySelection?.key ??
    agentDefaults?.key ??
    options.parentSelection?.model.key ??
    options.config?.getModel() ??
    '';
  return createQueryStream(options, initialModel);
}
