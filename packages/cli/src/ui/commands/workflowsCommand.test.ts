/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { workflowsCommand } from './workflowsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { WorkflowTask } from '@qwen-code/qwen-code-core';

function entry(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: 'wf_aaaaaaaa',
    kind: 'workflow',
    runId: 'wf_aaaaaaaa',
    description: 'demo',
    meta: null,
    status: 'running',
    startTime: 1_700_000_000_000,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    abortController: new AbortController(),
    currentPhase: null,
    phases: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    recentLogs: [],
    ...overrides,
  };
}

describe('workflowsCommand', () => {
  let context: CommandContext;
  let listMock: ReturnType<typeof vi.fn>;
  let getMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listMock = vi.fn().mockReturnValue([] as WorkflowTask[]);
    getMock = vi.fn().mockReturnValue(undefined);
    context = createMockCommandContext({
      services: {
        config: {
          getWorkflowRunRegistry: () => ({
            list: listMock,
            get: getMock,
          }),
        },
      },
      executionMode: 'interactive',
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
  });

  it('returns info message when there are no runs', async () => {
    const result = await workflowsCommand.action!(context, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'No workflow runs recorded yet.',
    });
  });

  it('lists active + recent buckets with running first', async () => {
    listMock.mockReturnValue([
      entry({
        runId: 'wf_done',
        status: 'completed',
        endTime: 1_700_000_010_000,
      }),
      entry({
        runId: 'wf_running',
        meta: { name: 'capitals', description: 'd' },
        status: 'running',
        currentPhase: 'Plan',
        phases: ['Plan'],
        agentsDispatched: 2,
        agentsCompleted: 1,
      }),
    ]);
    const result = await workflowsCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('Workflow runs (2 total · 1 running)');
    const activeIdx = result.content.indexOf('Active');
    const recentIdx = result.content.indexOf('Recent');
    // Active section comes before Recent in the output.
    expect(activeIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeGreaterThan(activeIdx);
    expect(result.content).toContain('wf_running');
    expect(result.content).toContain('Plan');
    expect(result.content).toContain('1/2 agents');
    expect(result.content).toContain('wf_done');
    expect(result.content).toContain('capitals');
  });

  it('omits the interactive tip in non_interactive / acp modes', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: {
          getWorkflowRunRegistry: () => ({ list: listMock, get: getMock }),
        },
      },
      executionMode: 'non_interactive',
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
    listMock.mockReturnValue([entry()]);
    const result = await workflowsCommand.action!(ctx, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).not.toMatch(/Tip:/);
  });

  it('detail view: known runId returns full per-field dump', async () => {
    const detail = entry({
      runId: 'wf_target',
      meta: {
        name: 'demo',
        description: 'd',
        whenToUse: 'when stuff',
      },
      status: 'completed',
      phases: ['A', 'B'],
      agentsDispatched: 3,
      agentsCompleted: 3,
      recentLogs: ['log1', 'log2'],
      endTime: 1_700_000_010_000,
    });
    getMock.mockImplementation((id) =>
      id === 'wf_target' ? detail : undefined,
    );
    const result = await workflowsCommand.action!(context, 'wf_target');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('Workflow wf_target');
    expect(result.content).toContain('name        : demo');
    expect(result.content).toContain('whenToUse   : when stuff');
    expect(result.content).toContain('agents      : 3/3');
    expect(result.content).toContain('· A');
    expect(result.content).toContain('· B');
    expect(result.content).toContain('log1');
    expect(result.content).toContain('log2');
  });

  it('detail view: unknown runId returns clear error', async () => {
    getMock.mockReturnValue(undefined);
    const result = await workflowsCommand.action!(context, 'wf_missing');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: 'Unknown workflow runId: wf_missing',
    });
  });

  it('argument is trimmed before lookup', async () => {
    const target = entry({ runId: 'wf_t' });
    getMock.mockImplementation((id) => (id === 'wf_t' ? target : undefined));
    const result = await workflowsCommand.action!(context, '  wf_t  ');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('Workflow wf_t');
  });
});
