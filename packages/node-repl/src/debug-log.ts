/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { format } from 'node:util';

/**
 * Minimal env-gated debug logger, a standalone replacement for qwen-code core's
 * `createDebugLogger`. Enabled when `QWEN_NODE_REPL_DEBUG` is set to a truthy
 * value (anything other than '', '0', 'false', 'off', 'no'). Output goes to
 * stderr so it never pollutes the MCP stdio protocol channel on stdout.
 */
export interface DebugLogger {
  isEnabled: () => boolean;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function debugEnabled(): boolean {
  const value = process.env['QWEN_NODE_REPL_DEBUG'];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return !['', '0', 'false', 'off', 'no'].includes(normalized);
}

export function createDebugLogger(namespace: string): DebugLogger {
  const prefix = `[${namespace}]`;
  const emit = (...args: unknown[]) => {
    if (!debugEnabled()) return;
    // stderr only — stdout carries the MCP JSON-RPC stream. Written directly
    // rather than via console.* so nothing can be redirected onto stdout.
    process.stderr.write(`${format(prefix, ...args)}\n`);
  };
  return {
    isEnabled: debugEnabled,
    debug: emit,
    info: emit,
    warn: emit,
    error: emit,
  };
}
