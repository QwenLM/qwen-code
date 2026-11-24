/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowRunRegistry } from '@qwen-code/qwen-code-core/agents/workflow-run-registry.js';

const WORKFLOW_CANCEL_SETTLE_MS = 2_000;
const shutdownWindows = new WeakMap<Promise<unknown>, Promise<void>>();

function waitWithinShutdownWindow(completion: Promise<unknown>): Promise<void> {
  const existing = shutdownWindows.get(completion);
  if (existing) return existing;

  let timer: NodeJS.Timeout | undefined;
  const window = Promise.race([
    completion.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WORKFLOW_CANCEL_SETTLE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  shutdownWindows.set(completion, window);
  return window;
}

/** Let cancelled runners persist their status and remove their checkpoints. */
export async function cancelAndSettleWorkflowRuns(
  workflows: WorkflowRunRegistry,
): Promise<void> {
  const settling = workflows
    .list()
    .flatMap((entry) => workflows.getHandle(entry.runId)?.completion ?? []);
  workflows.abortAll();
  // A fatal SDK turn can reach both the error handler and session teardown.
  await Promise.all(settling.map(waitWithinShutdownWindow));
}
