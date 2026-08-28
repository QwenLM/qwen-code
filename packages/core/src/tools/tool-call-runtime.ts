/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolCallResponseInfo } from '../core/turn.js';
import { isToolCallConcurrencySafe } from '../core/coreToolScheduler.js';
import type { ToolRegistry } from './tool-registry.js';

export interface CodeModeToolCallSource {
  kind: 'code_mode';
  parentCallId: string;
  nestedCallId: string;
}

export interface ToolRuntimeDispatchRequest {
  name: string;
  args: Record<string, unknown>;
  source: CodeModeToolCallSource;
  signal: AbortSignal;
}

export interface ToolCallRuntime {
  dispatch(request: ToolRuntimeDispatchRequest): Promise<unknown>;
}

const runtimeStorage = new AsyncLocalStorage<ToolCallRuntime>();
const sourceStorage = new AsyncLocalStorage<CodeModeToolCallSource>();

export function runWithToolCallRuntime<T>(
  runtime: ToolCallRuntime,
  callback: () => T,
): T {
  return runtimeStorage.run(runtime, callback);
}

export function getCurrentToolCallRuntime(): ToolCallRuntime | undefined {
  return runtimeStorage.getStore();
}

export function runWithToolCallSource<T>(
  source: CodeModeToolCallSource,
  callback: () => T,
): T {
  return sourceStorage.run(source, callback);
}

export function getCurrentToolCallSource(): CodeModeToolCallSource | undefined {
  return sourceStorage.getStore();
}

export function toolCallResponseValue(response: ToolCallResponseInfo): unknown {
  const functionResponse = response.responseParts.find(
    (part) => part.functionResponse !== undefined,
  )?.functionResponse;
  const payload = functionResponse?.response ?? {};
  const error = payload['error'];
  if (response.executionStatus === 'cancelled') {
    throw new DOMException('Nested tool call was cancelled.', 'AbortError');
  }
  if (response.error || response.executionStatus === 'error' || error) {
    const nestedError =
      typeof error === 'string'
        ? error
        : error === undefined
          ? 'Nested tool call failed.'
          : (JSON.stringify(error) ?? 'Nested tool call failed.');
    throw new Error(response.error?.message ?? nestedError);
  }
  return functionResponse?.parts?.length
    ? { ...payload, parts: functionResponse.parts }
    : payload;
}

class ReadExclusiveGate {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: Array<{
    reader: boolean;
    resolve: (release: () => void) => void;
  }> = [];

  acquire(reader: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ reader, resolve });
      this.drain();
    });
  }

  private drain(): void {
    if (this.writerActive) return;
    const first = this.queue[0];
    if (!first) return;
    if (!first.reader) {
      if (this.activeReaders > 0) return;
      this.writerActive = true;
      this.queue.shift();
      first.resolve(() => {
        this.writerActive = false;
        this.drain();
      });
      return;
    }
    while (this.queue[0]?.reader && this.activeReaders < 8) {
      const next = this.queue.shift();
      if (!next) return;
      this.activeReaders++;
      next.resolve(() => {
        this.activeReaders--;
        this.drain();
      });
    }
  }
}

export function createGatedToolCallRuntime(
  runtime: ToolCallRuntime,
  registry: ToolRegistry,
): ToolCallRuntime {
  const gate = new ReadExclusiveGate();
  return {
    async dispatch(request) {
      const tool = registry.getTool(request.name);
      const reader = isToolCallConcurrencySafe(
        request.name,
        tool?.kind,
        request.args,
      );
      const release = await gate.acquire(reader);
      try {
        return await runtime.dispatch(request);
      } finally {
        release();
      }
    },
  };
}
