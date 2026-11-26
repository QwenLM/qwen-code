/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// A fixed-policy scheduler can run inside a tool, inside its media result
// processing, or outside any tool (user input and provider retries).
interface FixedPolicyHookStopOwner {
  report?: (reason: string) => boolean;
}

const storage = new AsyncLocalStorage<FixedPolicyHookStopOwner>();

export async function withFixedPolicyHookStop<T>(
  report: (reason: string) => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const scope: FixedPolicyHookStopOwner = { report };
  try {
    return await storage.run(scope, run);
  } finally {
    // Detached work must neither retain the scheduler nor stop a later call.
    delete scope.report;
  }
}

export function captureFixedPolicyHookStopReporter() {
  const owner = storage.getStore();
  return owner
    ? (reason: string) => owner.report?.(reason) ?? false
    : undefined;
}
