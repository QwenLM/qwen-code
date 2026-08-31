/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CodeModeToolResult {
  callId: string;
  name: string;
  status: 'success';
  output: string;
  content?: unknown;
}

export interface ToolCallRuntimeContext {
  parentCallId: string;
  allowedToolNames?: readonly string[];
  dispatch(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CodeModeToolResult>;
}

const context = new AsyncLocalStorage<ToolCallRuntimeContext>();

export function runWithToolCallRuntime<T>(
  runtime: ToolCallRuntimeContext,
  fn: () => T,
): T {
  return context.run(runtime, fn);
}

export function runWithoutToolCallRuntime<T>(fn: () => T): T {
  return context.exit(fn);
}

export function getToolCallRuntime(): ToolCallRuntimeContext | undefined {
  return context.getStore();
}
