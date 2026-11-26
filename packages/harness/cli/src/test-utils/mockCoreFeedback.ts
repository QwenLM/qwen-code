/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import stripAnsi from 'strip-ansi';

type Severity = 'info' | 'warning' | 'error';

/**
 * Creates a stand-in for `coreEvents.emitFeedback`, the sanctioned
 * user-facing output channel for standalone subcommands.
 *
 * The returned `emitFeedback` spy records `(severity, message)` pairs with ANSI
 * styling optionally stripped, so assertions can match plain text.
 */
export function createMockCoreFeedback(options: { stripAnsi?: boolean } = {}) {
  const emitFeedback = vi.fn();
  const coreEvents = {
    emitFeedback: (severity: Severity, message: unknown, ...rest: unknown[]) => {
      const normalized =
        options.stripAnsi && typeof message === 'string'
          ? stripAnsi(message)
          : message;
      emitFeedback(severity, normalized, ...rest);
    },
  };

  return { emitFeedback, coreEvents };
}

/**
 * Helper for `vi.mock('@qwen-code/core', ...)` when the test needs the
 * real module except for `coreEvents.emitFeedback`.
 *
 * Example:
 * ```typescript
 * const { emitFeedback, coreEvents } = await vi.hoisted(async () => {
 *   const { createMockCoreFeedback } = await import(
 *     '../../test-utils/mockCoreFeedback.js'
 *   );
 *   return createMockCoreFeedback({ stripAnsi: true });
 * });
 *
 * vi.mock('@qwen-code/core', async (importOriginal) => {
 *   const { withMockCoreFeedback } = await import(
 *     '../../test-utils/mockCoreFeedback.js'
 *   );
 *   return withMockCoreFeedback(
 *     await importOriginal<typeof import('@qwen-code/core')>(),
 *     coreEvents,
 *   );
 * });
 * ```
 */
export function withMockCoreFeedback<T extends Record<string, unknown>>(
  actual: T,
  mockCoreEvents: ReturnType<typeof createMockCoreFeedback>['coreEvents'],
): T {
  return {
    ...actual,
    coreEvents: {
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      ...(typeof actual['coreEvents'] === 'object' &&
      actual['coreEvents'] !== null
        ? actual['coreEvents']
        : {}),
      ...mockCoreEvents,
    },
  } as T;
}
