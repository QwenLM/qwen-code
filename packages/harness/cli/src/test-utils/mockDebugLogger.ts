/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { format } from 'node:util';

export function createMockDebugLogger(options: { stripAnsi?: boolean } = {}) {
  const emitConsoleLog = vi.fn();
  const runLogger = {
    log: vi.fn((message: unknown, ...args: unknown[]) => {
      let formatted =
        typeof message === 'string' ? format(message, ...args) : message;
      if (options.stripAnsi && typeof formatted === 'string') {
        formatted = stripAnsi(formatted);
      }
      emitConsoleLog('log', formatted);
    }),
    error: vi.fn((message: unknown, ...args: unknown[]) => {
      let formatted =
        typeof message === 'string' ? format(message, ...args) : message;
      if (options.stripAnsi && typeof formatted === 'string') {
        formatted = stripAnsi(formatted);
      }
      emitConsoleLog('error', formatted);
    }),
    warn: vi.fn((message: unknown, ...args: unknown[]) => {
      let formatted =
        typeof message === 'string' ? format(message, ...args) : message;
      if (options.stripAnsi && typeof formatted === 'string') {
        formatted = stripAnsi(formatted);
      }
      emitConsoleLog('warn', formatted);
    }),
    debug: vi.fn(),
    info: vi.fn(),
  };

  return { emitConsoleLog, runLogger };
}

/**
 * A helper specifically designed for `vi.mock('@qwen-code/core', ...)` to easily
 * mock both `runLogger` and `coreEvents.emitConsoleLog`.
 *
 * Example:
 * ```typescript
 * vi.mock('@qwen-code/core', async (importOriginal) => {
 *   const { mockCoreDebugLogger } = await import('../../test-utils/mockDebugLogger.js');
 *   return mockCoreDebugLogger(
 *     await importOriginal<typeof import('@qwen-code/core')>(),
 *     { stripAnsi: true }
 *   );
 * });
 * ```
 */
export function mockCoreDebugLogger<T extends Record<string, unknown>>(
  actual: T,
  options?: { stripAnsi?: boolean },
): T {
  const { emitConsoleLog, runLogger } = createMockDebugLogger(options);
  return {
    ...actual,
    coreEvents: {
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      ...(typeof actual['coreEvents'] === 'object' &&
      actual['coreEvents'] !== null
        ? actual['coreEvents']
        : {}),
      emitConsoleLog,
    },
    runLogger,
  } as T;
}
