/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  StreamingToolExecutor,
  type ToolExecutionResult,
} from './streaming-tool-executor.js';
import { defineDeclarativeTool } from './define-tool.js';
import { Kind, type ToolResult } from './tools.js';

const result: ToolResult = { llmContent: 'done', returnDisplay: 'done' };
function deferred() {
  let resolve!: (value: ToolResult) => void;
  const promise = new Promise<ToolResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const Safe = defineDeclarativeTool({
  name: 'read',
  displayName: 'read',
  description: '',
  kind: Kind.Read,
  parameterSchema: { type: 'object' },
  isConcurrencySafe: () => true,
  execute: async () => result,
});
const Write = defineDeclarativeTool({
  name: 'write',
  displayName: 'write',
  description: '',
  kind: Kind.Edit,
  parameterSchema: { type: 'object' },
  isConcurrencySafe: () => false,
  execute: async () => result,
});
const read = new Safe(undefined);
const write = new Write(undefined);
const request = (name: string, callId: string) => ({
  name,
  callId,
  args: {},
  prompt_id: 'test',
});
async function collect(executor: StreamingToolExecutor) {
  const results: ToolExecutionResult[] = [];
  for await (const item of executor.getRemainingResults()) results.push(item);
  return results;
}

describe('STE execution admission', () => {
  it('bounds safe calls and keeps write barriers in FIFO order', async () => {
    const waits = Array.from({ length: 5 }, deferred);
    const starts: string[] = [];
    const executor = new StreamingToolExecutor({
      parentSignal: new AbortController().signal,
      maxConcurrency: 2,
      resolveTool: (name) => (name === 'read' ? read : write),
      executeTool: async (_invocation, req) => {
        starts.push(req.callId);
        return waits[Number(req.callId)].promise;
      },
    });
    ['read', 'read', 'read', 'write', 'read'].forEach((name, index) =>
      executor.addTool(request(name, String(index))),
    );
    executor.seal();
    await vi.waitFor(() => expect(starts).toEqual(['0', '1']));
    waits[1].resolve(result);
    await vi.waitFor(() => expect(starts).toEqual(['0', '1', '2']));
    waits[2].resolve(result);
    await Promise.resolve();
    expect(starts).toEqual(['0', '1', '2']);
    waits[0].resolve(result);
    await vi.waitFor(() => expect(starts).toEqual(['0', '1', '2', '3']));
    waits[3].resolve(result);
    await vi.waitFor(() => expect(starts).toEqual(['0', '1', '2', '3', '4']));
    waits[4].resolve(result);
    expect(await collect(executor)).toHaveLength(5);
  });
  it('closes admission before cancellation callbacks can free a slot', async () => {
    const waiting = deferred();
    const execute = vi.fn(async () => waiting.promise);
    const executor: StreamingToolExecutor = new StreamingToolExecutor({
      parentSignal: new AbortController().signal,
      resolveTool: () => read,
      maxConcurrency: 1,
      executeTool: execute,
      onToolCompleted: (completed) => {
        if (completed.request.callId === '0') executor.cancelAll('denied');
      },
    });
    for (let i = 0; i < 4; i++) executor.addTool(request('read', String(i)));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    waiting.resolve(result);
    executor.seal();
    const results = await collect(executor);
    expect(execute).toHaveBeenCalledOnce();
    expect(results.slice(1).map((item) => item.settlement)).toEqual([
      'not_started',
      'not_started',
      'not_started',
    ]);
  });
  it('does not start a queued tool when cancellation itself completes another queued tool', async () => {
    const execute = vi.fn(async () => result);
    const executor: StreamingToolExecutor = new StreamingToolExecutor({
      parentSignal: new AbortController().signal,
      resolveTool: () => read,
      executeTool: execute,
      onStatusChange: (_request, status) => {
        if (status === 'queued') executor.cancelAll();
      },
    });
    executor.addTool(request('read', 'cancel-before-start'));
    executor.seal();
    expect((await collect(executor))[0].settlement).toBe('not_started');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects new calls after cancellation and handles an already aborted parent', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => result);
    const executor = new StreamingToolExecutor({
      parentSignal: controller.signal,
      resolveTool: () => read,
      executeTool: execute,
    });
    executor.addTool(request('read', '0'));
    expect(() => executor.addTool(request('read', '1'))).toThrow(/cancelAll/);
    executor.seal();
    expect((await collect(executor))[0].cancelled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
