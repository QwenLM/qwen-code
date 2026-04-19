/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SwarmTool, type SwarmParams } from './swarm.js';
import type { Config } from '../config/config.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import { AgentTerminateMode } from '../agents/runtime/agent-types.js';

const hoisted = vi.hoisted(() => ({
  createAgent: vi.fn(),
}));

vi.mock('../agents/runtime/agent-headless.js', () => {
  class MockContextState {
    private readonly values = new Map<string, unknown>();

    set(key: string, value: unknown): void {
      this.values.set(key, value);
    }

    get(key: string): unknown {
      return this.values.get(key);
    }
  }

  return {
    AgentHeadless: {
      create: hoisted.createAgent,
    },
    ContextState: MockContextState,
  };
});

type SwarmToolInvocation = {
  execute: (
    signal?: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ) => Promise<ToolResult>;
  getDescription: () => string;
};

type SwarmToolWithProtectedMethods = SwarmTool & {
  createInvocation: (params: SwarmParams) => SwarmToolInvocation;
};

type MockWorker = {
  execute: ReturnType<typeof vi.fn>;
  getTerminateMode: ReturnType<typeof vi.fn>;
  getFinalText: ReturnType<typeof vi.fn>;
  getExecutionSummary: ReturnType<typeof vi.fn>;
};

const summary = {
  rounds: 1,
  totalDurationMs: 10,
  totalToolCalls: 0,
  successfulToolCalls: 0,
  failedToolCalls: 0,
  successRate: 0,
  inputTokens: 1,
  outputTokens: 1,
  thoughtTokens: 0,
  cachedTokens: 0,
  totalTokens: 2,
  toolUsage: [],
};

function createWorker(
  text: string,
  terminateMode = AgentTerminateMode.GOAL,
  execute?: () => Promise<void>,
): MockWorker {
  return {
    execute: vi.fn(execute ?? (async () => undefined)),
    getTerminateMode: vi.fn(() => terminateMode),
    getFinalText: vi.fn(() => text),
    getExecutionSummary: vi.fn(() => summary),
  };
}

function getInvocation(params: SwarmParams): SwarmToolInvocation {
  const tool = new SwarmTool({} as Config) as SwarmToolWithProtectedMethods;
  return tool.createInvocation(params);
}

function getJsonResult(result: ToolResult) {
  const content = result.llmContent as Array<{ text: string }>;
  return JSON.parse(content[0]!.text) as {
    summary: {
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      notStarted: number;
    };
    results: Array<{ taskId: string; status: string; output?: string }>;
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SwarmTool', () => {
  beforeEach(() => {
    hoisted.createAgent.mockReset();
  });

  it('validates required swarm parameters', () => {
    const tool = new SwarmTool({} as Config);

    expect(
      tool.validateToolParams({
        description: '',
        tasks: [{ description: 'A', prompt: 'Do A' }],
      }),
    ).toBe('Parameter "description" must be a non-empty string.');

    expect(
      tool.validateToolParams({
        description: 'Batch',
        tasks: [],
      }),
    ).toBe('Parameter "tasks" must be a non-empty array.');

    expect(
      tool.validateToolParams({
        description: 'Batch',
        tasks: [{ description: 'A', prompt: 'Do A' }],
        max_concurrency: 0,
      }),
    ).toBe('Parameter "max_concurrency" must be a positive integer.');
  });

  it('runs all workers and aggregates successes and failures', async () => {
    hoisted.createAgent
      .mockResolvedValueOnce(createWorker('Functions: foo, bar'))
      .mockResolvedValueOnce(
        createWorker('Could not parse file', AgentTerminateMode.ERROR),
      );

    const invocation = getInvocation({
      description: 'Extract functions',
      tasks: [
        { id: 'a.ts', description: 'Analyze a.ts', prompt: 'Read a.ts' },
        { id: 'b.ts', description: 'Analyze b.ts', prompt: 'Read b.ts' },
      ],
    });

    const result = await invocation.execute(new AbortController().signal);
    const aggregate = getJsonResult(result);

    expect(hoisted.createAgent).toHaveBeenCalledTimes(2);
    expect(aggregate.summary).toEqual({
      total: 2,
      completed: 1,
      failed: 1,
      cancelled: 0,
      notStarted: 0,
    });
    expect(aggregate.results[0]).toMatchObject({
      taskId: 'a.ts',
      status: 'success',
      output: 'Functions: foo, bar',
    });
    expect(aggregate.results[1]).toMatchObject({
      taskId: 'b.ts',
      status: 'failed',
    });
  });

  it('honors max_concurrency while draining queued tasks', async () => {
    const releases: Array<() => void> = [];
    let running = 0;
    let maxObserved = 0;

    const makeControlledWorker = (text: string) =>
      createWorker(text, AgentTerminateMode.GOAL, async () => {
        running++;
        maxObserved = Math.max(maxObserved, running);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            running--;
            resolve();
          });
        });
      });

    hoisted.createAgent
      .mockResolvedValueOnce(makeControlledWorker('one'))
      .mockResolvedValueOnce(makeControlledWorker('two'))
      .mockResolvedValueOnce(makeControlledWorker('three'));

    const promise = getInvocation({
      description: 'Limited batch',
      max_concurrency: 2,
      tasks: [
        { description: 'One', prompt: 'Do one' },
        { description: 'Two', prompt: 'Do two' },
        { description: 'Three', prompt: 'Do three' },
      ],
    }).execute(new AbortController().signal);

    await flushPromises();
    expect(releases).toHaveLength(2);
    expect(hoisted.createAgent).toHaveBeenCalledTimes(2);

    releases.shift()!();
    await flushPromises();
    expect(hoisted.createAgent).toHaveBeenCalledTimes(3);

    while (releases.length > 0) {
      releases.shift()!();
      await flushPromises();
    }

    const result = await promise;
    expect(maxObserved).toBe(2);
    expect(getJsonResult(result).summary.completed).toBe(3);
  });

  it('supports first_success by stopping before queued workers start', async () => {
    hoisted.createAgent.mockResolvedValueOnce(createWorker('winner'));

    const result = await getInvocation({
      description: 'Find answer',
      mode: 'first_success',
      max_concurrency: 1,
      tasks: [
        { description: 'Try A', prompt: 'Try A' },
        { description: 'Try B', prompt: 'Try B' },
        { description: 'Try C', prompt: 'Try C' },
      ],
    }).execute(new AbortController().signal);

    const aggregate = getJsonResult(result);
    expect(hoisted.createAgent).toHaveBeenCalledTimes(1);
    expect(aggregate.summary).toEqual({
      total: 3,
      completed: 1,
      failed: 0,
      cancelled: 0,
      notStarted: 2,
    });
  });
});
