/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared utility functions for serve-bridge tool handlers.
 */

import type { BridgeState } from './types.js';

/**
 * Resolve the session ID from explicit arg or default state.
 * Returns the session ID or throws a descriptive error.
 */
export function resolveSessionId(
  state: BridgeState,
  explicitSessionId?: string,
): string {
  const sessionId = explicitSessionId ?? state.defaultSessionId;
  if (!sessionId) {
    throw new Error(
      'No session active. Call session_create first, or pass an explicit session_id.',
    );
  }
  return sessionId;
}

/**
 * Create an MCP tool handler that catches errors and returns them as
 * isError responses. Logs error details to stderr for debugging.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function handler<T>(
  fn: (args: T) => Promise<any>,
): (args: T, extra: unknown) => Promise<any> {
  return async (args: T, _extra: unknown) => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log full error with stack for debugging
      if (err instanceof Error && err.stack) {
        process.stderr.write(`[serve-bridge] Tool error: ${err.stack}\n`);
      } else {
        process.stderr.write(`[serve-bridge] Tool error: ${message}\n`);
      }
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      };
    }
  };
}
