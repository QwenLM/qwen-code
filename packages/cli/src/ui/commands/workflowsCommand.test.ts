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
    tokensSpent: 0,
    tokenBudgetTotal: null,
    perPhaseTokens: new Map<string | null, number>(),
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

  // ── P5: budget surfacing in list + detail ──────────────────────────────

  it('P5: list row chips tokens/cap when capped', async () => {
    listMock.mockReturnValue([
      entry({
        runId: 'wf_capped',
        status: 'running',
        tokensSpent: 1500,
        tokenBudgetTotal: 10_000,
      }),
    ]);
    const result = await workflowsCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('1500/10000t');
  });

  it('P5: list row chips plain spent when uncapped', async () => {
    listMock.mockReturnValue([
      entry({
        runId: 'wf_uncapped',
        status: 'running',
        tokensSpent: 500,
        tokenBudgetTotal: null,
      }),
    ]);
    const result = await workflowsCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('500t');
    // No slash → no cap rendered.
    expect(result.content).not.toMatch(/500\/\d+t/);
  });

  it('P5: detail view renders tokens, cap, and per-phase chips', async () => {
    const perPhase = new Map<string | null, number>([
      ['Find', 300],
      ['Verify', 150],
    ]);
    const detail = entry({
      runId: 'wf_detail',
      status: 'completed',
      phases: ['Find', 'Verify'],
      tokensSpent: 450,
      tokenBudgetTotal: 1000,
      perPhaseTokens: perPhase,
      endTime: 1_700_000_010_000,
    });
    getMock.mockImplementation((id) =>
      id === 'wf_detail' ? detail : undefined,
    );
    const result = await workflowsCommand.action!(context, 'wf_detail');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('tokens      : 450');
    expect(result.content).toContain('cap         : 1000');
    expect(result.content).toContain('· Find · 300t');
    expect(result.content).toContain('· Verify · 150t');
  });

  it('P5: detail view renders "(no cap)" when uncapped', async () => {
    const detail = entry({
      runId: 'wf_uncapped',
      status: 'completed',
      tokensSpent: 0,
      tokenBudgetTotal: null,
    });
    getMock.mockImplementation((id) =>
      id === 'wf_uncapped' ? detail : undefined,
    );
    const result = await workflowsCommand.action!(context, 'wf_uncapped');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('tokens      : 0');
    expect(result.content).toContain('cap         : (no cap)');
  });
});
