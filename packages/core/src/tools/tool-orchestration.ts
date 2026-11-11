/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool call batching and orchestration utilities.
 *
 * The primary export is {@link partitionToolCalls}, which groups an array of
 * tool call requests into sequential batches based on concurrency safety:
 *
 * - **Concurrent batch**: consecutive concurrency-safe tool calls that can
 *   execute in parallel (e.g. read-only tools like Glob, Grep, ReadFile).
 * - **Serial batch**: a single tool call that must execute alone because it
 *   may have side effects (e.g. Shell, WriteFile, Edit).
 *
 * This mirrors the sliding-window concurrency model of {@link all} from
 * `utils/generators.ts` — the executor runs concurrent batches through `all()`
 * with a cap and serial batches sequentially.
 */

import type { ToolCallRequestInfo } from '../tool-executor/types.js';
import type { AnyDeclarativeTool } from './tools.js';

/**
 * A batch of tool call requests that share the same concurrency disposition.
 */
export interface ToolCallBatch {
  /** Whether every request in this batch is concurrency-safe. */
  readonly isConcurrent: boolean;
  /** The tool call requests in this batch. */
  readonly requests: readonly ToolCallRequestInfo[];
}

/**
 * A function that resolves a tool name to its declarative tool definition.
 * Typically backed by `ToolRegistry.getTool()`.
 */
export type ToolResolver = (name: string) => AnyDeclarativeTool | undefined;

/**
 * Partition tool calls into sequential batches.
 *
 * Consecutive concurrency-safe calls share one concurrent batch; any unsafe
 * call becomes its own serial batch. Unknown tools are treated as unsafe.
 *
 * @param requests Calls from one model turn.
 * @param resolveTool Resolves a name to its tool definition.
 */
export function partitionToolCalls(
  requests: readonly ToolCallRequestInfo[],
  resolveTool: ToolResolver,
): ToolCallBatch[] {
  if (requests.length === 0) {
    return [];
  }

  const batches: ToolCallBatch[] = [];
  let currentConcurrent: ToolCallRequestInfo[] | null = null;

  for (const request of requests) {
    const tool = resolveTool(request.name);

    // Determine concurrency safety.
    // Unknown tools default to non-safe so they run in isolation and the
    // executor can produce a clear "tool not found" error.
    const isSafe = tool
      ? tool.isConcurrencySafe(
          request.args as Parameters<typeof tool.isConcurrencySafe>[0],
        )
      : false;

    if (isSafe) {
      // Accumulate into the current concurrent batch, or start a new one.
      if (currentConcurrent) {
        currentConcurrent.push(request);
      } else {
        currentConcurrent = [request];
      }
    } else {
      // Flush any accumulated concurrent batch first.
      if (currentConcurrent) {
        batches.push({
          isConcurrent: true,
          requests: currentConcurrent,
        });
        currentConcurrent = null;
      }
      // Non-safe tool gets its own serial batch.
      batches.push({
        isConcurrent: false,
        requests: [request],
      });
    }
  }

  // Flush trailing concurrent batch.
  if (currentConcurrent) {
    batches.push({
      isConcurrent: true,
      requests: currentConcurrent,
    });
  }

  return batches;
}
