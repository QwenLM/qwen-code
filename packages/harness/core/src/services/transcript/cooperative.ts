/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Shared traversal steps keep synchronous readers and bounded resume identical. */
import { setImmediate } from 'node:timers/promises';
import type { ResumeReadAttempt } from './resume-read-budget.js';

export function drainTranscriptSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

export async function runTranscriptSteps<T>(
  steps: Generator<void, T>,
  attempt: ResumeReadAttempt,
): Promise<T> {
  try {
    for (;;) {
      attempt.check();
      for (let i = 0; i < 256; i++) {
        const next = steps.next();
        if (next.done) {
          attempt.check();
          return next.value;
        }
      }
      await setImmediate();
    }
  } finally {
    steps.return(undefined as T);
  }
}
