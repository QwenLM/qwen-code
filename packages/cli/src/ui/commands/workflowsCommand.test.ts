/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workflowsCommand, snapshotToTask } from './workflowsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type {
  WorkflowDispatchTrace,
  WorkflowTask,
  WorkflowSnapshot,
} from '@qwen-code/qwen-code-core';
import { buildWorkflowResultPreview } from '@qwen-code/qwen-code-core/agents/workflow-result-preview.js';

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
    isBackgrounded: true,
    abortController: new AbortController(),
    currentPhase: null,
    currentPhaseVisitId: null,
    phases: [],
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    recentLogs: [],
    events: [],
    tokensSpent: 0,
    tokenBudgetTotal: null,
    perPhaseTokens: new Map<string | null, number>(),
    pendingApprovals: [],
    script: '',
    ...overrides,
  };
}

function dispatch(
  id: string,
  status: WorkflowDispatchTrace['status'],
  error?: string,
): WorkflowDispatchTrace {
  return {
    id,
    phaseVisitId: null,
    label: id,
    prompt: 'p',
    status,
    dependsOn: [],
    queuedAt: 1,
    ...(error ? { error } : {}),
  };
}

async function content(
  ctx: CommandContext,
  args: string,
): Promise<{ messageType: string; content: string }> {
  const result = await workflowsCommand.action!(ctx, args);
  if (!result || result.type !== 'message') throw new Error('no result');
  return result;
}

describe('workflowsCommand', () => {
  let context: CommandContext;
  let listMock: ReturnType<typeof vi.fn>;
  let getMock: ReturnType<typeof vi.fn>;
  let pauseMock: ReturnType<typeof vi.fn>;
  let resumeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listMock = vi.fn().mockReturnValue([] as WorkflowTask[]);
    getMock = vi.fn().mockReturnValue(undefined);
    pauseMock = vi.fn().mockReturnValue(true);
    resumeMock = vi.fn().mockReturnValue(true);
    context = createMockCommandContext({
      services: {
        config: {
          getWorkflowRunRegistry: () => ({
            list: listMock,
            get: getMock,
            pause: pauseMock,
            resume: resumeMock,
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

  it('lists active + recent buckets with active runs first', async () => {
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
    expect(result.content).toContain('Workflow runs (2 total · 1 active)');
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

  it('treats pausing and paused workflows as active and explains cooperative controls', async () => {
    listMock.mockReturnValue([
      entry({ runId: 'wf_pausing', status: 'pausing', startTime: 2 }),
      entry({ runId: 'wf_paused', status: 'paused', startTime: 1 }),
      entry({
        runId: 'wf_done',
        status: 'completed',
        startTime: 3,
        endTime: 4,
      }),
    ]);

    const result = await workflowsCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');

    expect(result.content).toContain('Workflow runs (3 total · 2 active)');
    expect(result.content.indexOf('wf_pausing')).toBeLessThan(
      result.content.indexOf('Recent'),
    );
    expect(result.content.indexOf('wf_paused')).toBeLessThan(
      result.content.indexOf('Recent'),
    );
    // Oldest startTime first inside the Active bucket — the entries
    // above are registered in exactly the inverse order, so a dropped
    // or flipped sort would still keep both rows before 'Recent'.
    expect(result.content.indexOf('wf_paused')).toBeLessThan(
      result.content.indexOf('wf_pausing'),
    );
    expect(result.content).toContain('Background tasks');
    expect(result.content).toContain('Background tasks + p');
    expect(result.content).toContain('cooperative');
  });

  it('omits the Active section header when there are zero active runs', async () => {
    listMock.mockReturnValue([
      entry({
        runId: 'wf_done',
        status: 'completed',
        endTime: 1_700_000_010_000,
      }),
    ]);

    const result = await workflowsCommand.action!(context, '');

    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('Workflow runs (1 total · 0 active)');
    expect(result.content).not.toContain('Active');
    expect(result.content).toContain('Recent');
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

  it('pauses a live running workflow with p <runId>', async () => {
    getMock.mockReturnValue(entry({ runId: 'wf_running', status: 'running' }));

    const result = await workflowsCommand.action!(context, 'p wf_running');

    expect(pauseMock).toHaveBeenCalledWith('wf_running');
    expect(resumeMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('Cooperative pause requested');
  });

  it('reports the terminal status for a retained terminal foreground run', async () => {
    // The terminal gate runs before the foreground gate: a completed
    // foreground run gets the same wording as a snapshot-only hit,
    // never the foreground wording (which implies backgrounding would
    // help — impossible once settled).
    getMock.mockReturnValue(
      entry({
        runId: 'wf_fore_done',
        status: 'completed',
        isBackgrounded: false,
        endTime: 1_700_000_010_000,
      }),
    );

    const result = await workflowsCommand.action!(context, 'p wf_fore_done');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content:
        'Workflow wf_fore_done is completed and cannot be paused or resumed.',
    });
    expect(pauseMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('explains that foreground workflows cannot be paused', async () => {
    getMock.mockReturnValue(
      entry({
        runId: 'wf_foreground',
        status: 'running',
        isBackgrounded: false,
      }),
    );

    const result = await workflowsCommand.action!(context, 'p wf_foreground');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content:
        'Foreground workflow runs cannot be paused or resumed; only background runs support cooperative pause.',
    });
    expect(pauseMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('resumes a live paused workflow with p <runId>', async () => {
    getMock.mockReturnValue(entry({ runId: 'wf_paused', status: 'paused' }));

    const result = await workflowsCommand.action!(context, 'p wf_paused');

    expect(resumeMock).toHaveBeenCalledWith('wf_paused');
    expect(pauseMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('Resume requested');
  });

  it.each([
    ['running', 'paused', 'pause'],
    ['paused', 'resumed', 'resume'],
  ] as const)(
    'reports a state race when a %s workflow cannot be %s',
    async (status, operation, registryOperation) => {
      const operationMock =
        registryOperation === 'pause' ? pauseMock : resumeMock;
      operationMock.mockReturnValue(false);
      getMock.mockReturnValue(
        entry({ runId: 'wf_racing', status, isBackgrounded: true }),
      );

      const result = await workflowsCommand.action!(context, 'p wf_racing');

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: `Workflow wf_racing could not be ${operation} because its state changed.`,
      });
    },
  );

  it.each([
    ['pausing', 'still pausing', 'warning'],
    ['completed', 'cannot be paused or resumed', 'error'],
  ] as const)(
    'rejects p for a %s workflow',
    async (status, message, messageType) => {
      getMock.mockReturnValue(entry({ runId: 'wf_target', status }));

      const result = await workflowsCommand.action!(context, 'p wf_target');

      expect(pauseMock).not.toHaveBeenCalled();
      expect(resumeMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ type: 'message', messageType });
      if (!result || result.type !== 'message') throw new Error('no result');
      expect(result.content).toContain(message);
    },
  );

  it('rejects p for targets unknown to both registry and snapshots', async () => {
    const unknown = await workflowsCommand.action!(context, 'p wf_missing');
    const malformed = await workflowsCommand.action!(context, 'p');
    // The >2-token shape must hit the same usage guard — a loosened
    // `!== 2` check would silently act on the first runId and ignore
    // the trailing argument.
    const trailing = await workflowsCommand.action!(context, 'p wf_x extra');

    expect(unknown).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: 'Unknown live workflow runId: wf_missing',
    });
    expect(malformed).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /workflows p <runId>',
    });
    expect(trailing).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /workflows p <runId>',
    });
    expect(pauseMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('proceeds past the usage guard for a well-formed p <runId> command', async () => {
    getMock.mockReturnValue(entry({ runId: 'wf_guard', status: 'running' }));

    const result = await workflowsCommand.action!(context, 'p wf_guard');

    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).not.toContain('Usage:');
    expect(pauseMock).toHaveBeenCalledWith('wf_guard');
  });

  it.each(['non_interactive', 'acp'] as const)(
    'does not expose pause control in %s mode',
    async (executionMode) => {
      const ctx = createMockCommandContext({
        services: {
          config: {
            getWorkflowRunRegistry: () => ({
              list: listMock,
              get: getMock,
              pause: pauseMock,
              resume: resumeMock,
            }),
          },
        },
        executionMode,
      } as unknown as Parameters<typeof createMockCommandContext>[0]);
      getMock.mockReturnValue(
        entry({ runId: 'wf_running', status: 'running' }),
      );

      const result = await workflowsCommand.action!(ctx, 'p wf_running');

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content:
          'Workflow pause controls are available only in the interactive TUI.',
      });
      expect(pauseMock).not.toHaveBeenCalled();
      expect(resumeMock).not.toHaveBeenCalled();
    },
  );

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

  describe('detail view: results and failures', () => {
    function live(overrides: Partial<WorkflowTask>) {
      const target = entry({ runId: 'wf_live', ...overrides });
      getMock.mockImplementation((id) =>
        id === 'wf_live' ? target : undefined,
      );
      return target;
    }

    it('shows a completed result, failed agents, and reported failures apart', async () => {
      const target = live({
        status: 'completed',
        result: {
          marker: 'RESULT_MARKER',
          failed: ['REPORTED'],
          errors: [new Error('SCRIPT_ERR')],
        },
        dispatches: [
          dispatch('ok', 'completed'),
          dispatch('hit', 'cached'),
          dispatch('stopped', 'cancelled', 'cancelled error'),
          dispatch('lost-1', 'failed', 'HTTP 400'),
          dispatch('lost-2', 'failed'),
        ],
      });
      const result = await content(context, 'wf_live');

      // A completed run that reports failures is still a completed run, and
      // asking about it is a successful query.
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('status      : completed');
      expect(result.content).toContain(
        [
          '  Failed agents (2)',
          '    [lost-1] HTTP 400',
          '    [lost-2] dispatch failed',
          '',
          '  Reported failures',
          '    Reported failed: ["REPORTED"]',
          '    Reported errors: ["Error: SCRIPT_ERR"]',
          '',
          '  Result',
          '    {',
          '      "marker": "RESULT_MARKER",',
        ].join('\n'),
      );
      expect(result.content).not.toContain('cancelled error');
      expect(result.content).not.toContain('snapshotFile');
      expect(target.result).toEqual(
        expect.objectContaining({ marker: 'RESULT_MARKER' }),
      );
      expect(target.status).toBe('completed');
    });

    it('names how many failed agents were left out past the cap', async () => {
      live({
        status: 'completed',
        dispatches: Array.from({ length: 12 }, (_, i) =>
          dispatch(`lost-${i}`, 'failed', `E${i}`),
        ),
      });
      const result = await content(context, 'wf_live');
      expect(result.content).toContain('  Failed agents (12)');
      expect(result.content).toContain('    [lost-9] E9');
      expect(result.content).not.toContain('[lost-10]');
      expect(result.content).toContain('    … and 2 more failures omitted');
    });

    it.each([
      [undefined, '(workflow returned no value)'],
      [null, 'null'],
      [false, 'false'],
      [0, '0'],
      ['', '""'],
    ])('keeps a %j result distinct', async (value, text) => {
      live({ status: 'completed', result: value });
      const result = await content(context, 'wf_live');
      expect(result.content.endsWith(`  Result\n    ${text}`)).toBe(true);
    });

    it.each(['running', 'pausing', 'paused'] as const)(
      'shows no result while the run is %s',
      async (status) => {
        live({ status, result: 'not yet' });
        const result = await content(context, 'wf_live');
        expect(result.content).not.toContain('Result');
        expect(result.content).not.toContain('not yet');
      },
    );

    it.each(['failed', 'cancelled'] as const)(
      'keeps a %s run without a result, as a successful query',
      async (status) => {
        live({ status, error: 'RUN_ERR' });
        const result = await content(context, 'wf_live');
        expect(result.messageType).toBe('info');
        expect(result.content).toContain(`status      : ${status}`);
        expect(result.content).toContain('error       : RUN_ERR');
        expect(result.content).not.toContain('Result');
      },
    );

    it('cleans and bounds the run error', async () => {
      live({
        status: 'failed',
        error: `\x1b[31mRED\x1b[0m\u202e\tline1\nline2${'e'.repeat(5000)}`,
      });
      const result = await content(context, 'wf_live');
      const error = result.content.slice(result.content.indexOf('error'));
      expect(error).toContain('error       : RED  line1\n    line2');
      expect(error).not.toContain('\x1b');
      expect(error).not.toContain('\u202e');
      expect(error).toContain('… (truncated)');
      expect(error.length).toBeLessThan(4_200);
    });

    it('bounds a long result and says the preview was truncated', async () => {
      live({ status: 'completed', result: 'x'.repeat(30_000) });
      const result = await content(context, 'wf_live');
      expect(result.content).toContain('x… (truncated)');
      expect(result.content).toContain(
        '    (preview truncated to 25000 characters)',
      );
    });

    it('renders the same detail in every execution mode', async () => {
      live({
        status: 'completed',
        result: { failed: ['F'] },
        dispatches: [dispatch('lost', 'failed', 'E')],
        endTime: 1_700_000_005_000,
      });
      const outputs = [];
      for (const executionMode of [
        'interactive',
        'non_interactive',
        'acp',
      ] as const) {
        outputs.push(await content({ ...context, executionMode }, 'wf_live'));
      }
      expect(outputs[1]).toEqual(outputs[0]);
      expect(outputs[2]).toEqual(outputs[0]);
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

  it('P5: list row chips tokens/cap when capped (R1 #7: uses formatTokenCount)', async () => {
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
    // R1 #7: `formatTokenCount` renders 1500 as `1.5k` and 10000 as `10k`.
    expect(result.content).toContain('1.5k/10kt');
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
    // < 1000 renders as the raw integer.
    expect(result.content).toContain('500t');
    // No slash → no cap rendered.
    expect(result.content).not.toMatch(/500\/\d+t/);
  });

  it('P5: detail view renders tokens, cap, and per-phase chips (R1 #7: formatTokenCount)', async () => {
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
    // R1 #7: per-phase counts render via `formatTokenCount` (< 1000 = raw).
    expect(result.content).toContain('tokens      : 450');
    expect(result.content).toContain('cap         : 1.0k');
    expect(result.content).toContain('· Find · 300t');
    expect(result.content).toContain('· Verify · 150t');
  });

  it('P5 R1 #6: detail view surfaces null-sentinel as "(no phase)" row', async () => {
    const perPhase = new Map<string | null, number>([
      [null, 75], // pre-phase spend
      ['Plan', 200],
    ]);
    const detail = entry({
      runId: 'wf_pre',
      status: 'completed',
      phases: ['Plan'],
      tokensSpent: 275,
      tokenBudgetTotal: null,
      perPhaseTokens: perPhase,
      endTime: 1_700_000_010_000,
    });
    getMock.mockImplementation((id) => (id === 'wf_pre' ? detail : undefined));
    const result = await workflowsCommand.action!(context, 'wf_pre');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('· Plan · 200t');
    // R1 #6 fix: the null-sentinel attribution is no longer hidden.
    expect(result.content).toContain('· (no phase) · 75t');
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

  // ── P7b: persisted snapshots merged into the listing + detail view ─────
  describe('P7b: persisted snapshots', () => {
    const tmpDirs: string[] = [];

    function snapshot(
      overrides: Partial<WorkflowSnapshot> = {},
    ): WorkflowSnapshot {
      return {
        runId: 'wf_snap',
        meta: null,
        status: 'completed',
        script: '',
        phases: [],
        agentsDispatched: 0,
        agentsCompleted: 0,
        tokensSpent: 0,
        tokenBudgetTotal: null,
        perPhaseTokens: [],
        recentLogs: [],
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_005_000,
        ...overrides,
      };
    }

    // Write snapshot JSON files into a fresh temp dir and return a context
    // whose `config.storage.getWorkflowRunsDir()` points at it. This drives
    // the real `listWorkflowSnapshots` (no module mocking).
    async function ctxWithSnapshots(
      snaps: Array<Partial<WorkflowSnapshot>>,
      mode: 'interactive' | 'non_interactive' = 'interactive',
    ): Promise<CommandContext> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-snap-'));
      tmpDirs.push(dir);
      for (const s of snaps) {
        const snap = snapshot(s);
        await fs.writeFile(
          path.join(dir, `${snap.runId}.json`),
          JSON.stringify(snap),
          'utf8',
        );
      }
      return createMockCommandContext({
        services: {
          config: {
            getWorkflowRunRegistry: () => ({ list: listMock, get: getMock }),
            storage: {
              getWorkflowRunsDir: () => dir,
              getWorkflowRunSnapshotPath: (runId: string) =>
                path.join(dir, `${runId}.json`),
            },
          },
        },
        executionMode: mode,
      } as unknown as Parameters<typeof createMockCommandContext>[0]);
    }

    afterEach(async () => {
      await Promise.all(
        tmpDirs
          .splice(0)
          .map((d) =>
            fs.rm(d, { recursive: true, force: true }).catch(() => {}),
          ),
      );
    });

    it('surfaces a persisted run in Recent when the live registry is empty', async () => {
      listMock.mockReturnValue([]);
      const ctx = await ctxWithSnapshots([
        { runId: 'wf_persisted', meta: { name: 'oldrun', description: 'd' } },
      ]);
      const result = await workflowsCommand.action!(ctx, '');
      if (!result || result.type !== 'message') throw new Error('no result');
      expect(result.content).toContain('Workflow runs (1 total · 0 active)');
      expect(result.content).toContain('Recent');
      expect(result.content).toContain('wf_persisted');
      expect(result.content).toContain('oldrun');
    });

    it('live registry entry shadows a same-runId snapshot (no duplicate row)', async () => {
      listMock.mockReturnValue([
        entry({
          runId: 'wf_dup',
          meta: { name: 'live-name', description: 'd' },
          status: 'completed',
          endTime: 1_700_000_010_000,
        }),
      ]);
      const ctx = await ctxWithSnapshots([
        { runId: 'wf_dup', meta: { name: 'disk-name', description: 'd' } },
      ]);
      const result = await workflowsCommand.action!(ctx, '');
      if (!result || result.type !== 'message') throw new Error('no result');
      // Exactly one entry total; the live entry's meta wins, disk is dropped.
      expect(result.content).toContain('Workflow runs (1 total · 0 active)');
      expect(result.content).toContain('live-name');
      expect(result.content).not.toContain('disk-name');
      expect(result.content.match(/wf_dup/g)?.length).toBe(1);
    });

    it('detail view falls back to a persisted snapshot on registry miss', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        {
          runId: 'wf_old',
          meta: { name: 'demo', description: 'd' },
          phases: ['A', 'B'],
          agentsDispatched: 2,
          agentsCompleted: 2,
          recentLogs: ['log-from-disk'],
          perPhaseTokens: [['A', 300]],
          tokensSpent: 300,
        },
      ]);
      const result = await workflowsCommand.action!(ctx, 'wf_old');
      if (!result || result.type !== 'message') throw new Error('no result');
      expect(result.messageType).toBe('info');
      expect(result.content).toContain('Workflow wf_old');
      expect(result.content).toContain('· A · 300t');
      expect(result.content).toContain('· B');
      expect(result.content).toContain('log-from-disk');
    });

    it('detail view errors when neither registry nor snapshots have the runId', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([{ runId: 'wf_other' }]);
      const result = await workflowsCommand.action!(ctx, 'wf_ghost');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: 'Unknown workflow runId: wf_ghost',
      });
    });

    it('p falls back to a persisted snapshot and reports the terminal status', async () => {
      // The listing merges snapshots into Recent and the detail view
      // resolves them, so /workflows p for a snapshot-only runId must
      // give the same terminal wording a still-retained run gets —
      // not contradict the listing with "Unknown live workflow runId".
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        { runId: 'wf_old', status: 'completed' },
      ]);
      const result = await workflowsCommand.action!(ctx, 'p wf_old');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content:
          'Workflow wf_old is completed and cannot be paused or resumed.',
      });
    });

    it('shows the stored preview and the confirmed snapshot file after a restart', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        {
          runId: 'wf_0a',
          // What plain JSON kept of the result; the preview kept more.
          result: { errors: [{}] },
          resultPreview: buildWorkflowResultPreview({
            errors: [new Error('KEPT')],
          }),
          dispatches: [dispatch('lost', 'failed', 'HTTP 400')],
        },
      ]);
      const result = await content(ctx, 'wf_0a');
      expect(result.content).toMatch(/snapshotFile: .*wf_0a\.json/);
      expect(result.content).toContain('    [lost] HTTP 400');
      expect(result.content).toContain('    Reported errors: ["Error: KEPT"]');
      expect(result.content).toContain('"Error: KEPT"');
      expect(result.content).not.toContain('older snapshot');
    });

    it('tells an undefined result from one an older snapshot never recorded', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        {
          runId: 'wf_0b',
          resultPreview: buildWorkflowResultPreview(undefined),
        },
        { runId: 'wf_0c' },
      ]);
      expect((await content(ctx, 'wf_0b')).content).toContain(
        '  Result\n    (workflow returned no value)',
      );
      const legacy = (await content(ctx, 'wf_0c')).content;
      expect(legacy).toContain(
        '  Result\n    (this snapshot did not record a result)',
      );
      expect(legacy).toContain('older snapshot');
      expect(legacy).not.toContain('returned no value');
    });

    it('renders what an older snapshot kept, and says it may be incomplete', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        { runId: 'wf_0d', result: { err: {}, failed: ['F'] } },
      ]);
      const result = (await content(ctx, 'wf_0d')).content;
      expect(result).toContain('    Reported failed: ["F"]');
      expect(result).toContain('"err": {}');
      expect(result).toContain(
        '(older snapshot: result details such as Error, Map, and Set values may be incomplete)',
      );
      // No dispatch record is not the same as no failures.
      expect(result).toContain(
        '  Failed agents: not recorded in this snapshot',
      );
    });

    it('cleans a hand-edited preview before showing it', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([
        {
          runId: 'wf_0e',
          resultPreview: {
            text: '\x1b[31mRED\x1b[0m\u202e\nnext',
            truncated: false,
            reportedFailures: ['Reported failed: \x1b[2Jboom'],
          },
        },
      ]);
      const result = (await content(ctx, 'wf_0e')).content;
      expect(result).toContain('    RED\n    next');
      expect(result).toContain('    Reported failed: boom');
      expect(result).not.toContain('\x1b');
      expect(result).not.toContain('\u202e');
    });

    it('prefers the live entry over a same-runId snapshot', async () => {
      getMock.mockImplementation((id) =>
        id === 'wf_0f'
          ? entry({ runId: 'wf_0f', status: 'running' })
          : undefined,
      );
      const ctx = await ctxWithSnapshots([
        {
          runId: 'wf_0f',
          result: 'OLD',
          resultPreview: buildWorkflowResultPreview('OLD'),
        },
      ]);
      const result = (await content(ctx, 'wf_0f')).content;
      expect(result).toContain('status      : running');
      expect(result).not.toContain('OLD');
      expect(result).not.toContain('snapshotFile');
    });

    it('omits the snapshot file when it cannot be confirmed', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([{ runId: 'not_a_run' }]);
      const dir = tmpDirs.at(-1)!;
      // Listed under another file name than the run's own.
      await fs.writeFile(
        path.join(dir, 'copy.json'),
        JSON.stringify(snapshot({ runId: 'wf_10' })),
      );
      expect((await content(ctx, 'not_a_run')).content).not.toContain(
        'snapshotFile',
      );
      expect((await content(ctx, 'wf_10')).content).not.toContain(
        'snapshotFile',
      );
    });

    it('p still reports unknown for a runId absent from registry and snapshots', async () => {
      getMock.mockReturnValue(undefined);
      const ctx = await ctxWithSnapshots([{ runId: 'wf_other' }]);
      const result = await workflowsCommand.action!(ctx, 'p wf_ghost');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: 'Unknown live workflow runId: wf_ghost',
      });
    });
  });
});

describe('snapshotToTask', () => {
  it('preserves persisted lineage fields across the restart boundary', () => {
    const task = snapshotToTask({
      runId: 'wf_lineage',
      sourceRunId: 'wf_origin',
      startMode: 'retry',
      meta: null,
      status: 'completed',
      script: '',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_005_000,
    });

    expect(task.sourceRunId).toBe('wf_origin');
    expect(task.startMode).toBe('retry');
  });
});
