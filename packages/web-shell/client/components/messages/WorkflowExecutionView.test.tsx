// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  buildWorkflowReplayEvents,
  buildWorkflowGraphLayout,
  projectWorkflowReplay,
  WorkflowExecutionView,
} from './WorkflowExecutionView';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function workflowTask(
  overrides: Partial<DaemonSessionWorkflowTaskStatus> = {},
): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: 'wf-1',
    label: 'review-and-fix',
    description: 'Review and fix',
    status: 'running',
    startTime: 1_000,
    runtimeMs: 2_000,
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [
      {
        id: 'phase-1',
        index: 0,
        title: 'Inspect',
        startedAt: 1_000,
        endedAt: 1_200,
      },
      { id: 'phase-2', index: 1, title: 'Review', startedAt: 1_200 },
    ],
    dispatches: [
      {
        id: 'dispatch-1',
        phaseVisitId: 'phase-1',
        label: 'Scope mapper',
        prompt: 'Inspect repository boundaries',
        status: 'completed',
        dependsOn: [],
        queuedAt: 1_010,
        startedAt: 1_020,
        endedAt: 1_100,
      },
      {
        id: 'dispatch-2',
        phaseVisitId: 'phase-2',
        label: 'Correctness',
        prompt: 'Review behavior regressions',
        subagentId: 'correctness-agent-1',
        status: 'running',
        dependsOn: ['dispatch-1'],
        queuedAt: 1_210,
        startedAt: 1_220,
      },
      {
        id: 'dispatch-3',
        phaseVisitId: 'phase-2',
        label: 'Architecture',
        prompt: 'Review ownership boundaries',
        status: 'queued',
        dependsOn: ['dispatch-1'],
        queuedAt: 1_210,
      },
    ],
    agentsDispatched: 3,
    agentsCompleted: 1,
    tokensSpent: 1_200,
    tokenBudgetTotal: 8_000,
    recentLogs: [],
    pendingApprovalCount: 0,
    pendingApprovals: [],
    ...overrides,
  };
}

describe('WorkflowExecutionView', () => {
  it('builds a timestamped trace from recorded phase, agent, approval, and failure events', () => {
    const task = workflowTask({
      status: 'failed',
      endTime: 1_400,
      runtimeMs: 400,
      error: 'Workflow verification failed',
      phaseVisits: [
        workflowTask().phaseVisits[0]!,
        {
          ...workflowTask().phaseVisits[1]!,
          endedAt: 1_400,
        },
      ],
      dispatches: [
        workflowTask().dispatches[0]!,
        {
          ...workflowTask().dispatches[1]!,
          status: 'failed',
          endedAt: 1_350,
          error: 'Typecheck failed',
        },
        workflowTask().dispatches[2]!,
      ],
      pendingApprovalCount: 1,
      pendingApprovals: [
        {
          approvalId: 'approval-1',
          subagentId: 'correctness-agent-1',
          name: 'write_file',
          description: 'Apply the proposed fix',
          at: 1_300,
        },
      ],
    });

    const events = buildWorkflowReplayEvents(task);

    expect(
      events.find((event) => event.id === 'dispatch:dispatch-2:failed'),
    ).toMatchObject({
      time: 1_350,
      kind: 'dispatch-failed',
      dispatchId: 'dispatch-2',
      detail: 'Typecheck failed',
    });
    expect(
      events.find((event) => event.id === 'approval:approval-1:requested'),
    ).toMatchObject({
      time: 1_300,
      kind: 'approval-requested',
      dispatchId: 'dispatch-2',
      detail: 'Apply the proposed fix',
    });
    expect(
      events.filter((event) => event.time === 1_200).map((event) => event.kind),
    ).toEqual(['phase-completed', 'phase-started']);
    expect(events.at(-1)).toMatchObject({
      id: 'workflow:wf-1:failed',
      time: 1_400,
      kind: 'workflow-failed',
      detail: 'Workflow verification failed',
    });
  });

  it('uses the persisted event ledger for logs and the full approval lifecycle', () => {
    const task = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
      recentLogs: ['Review started'],
      events: [
        {
          id: 'event-1',
          type: 'phase-started',
          at: 1_000,
          phaseVisitId: 'phase-1',
          title: 'Inspect',
        },
        {
          id: 'event-2',
          type: 'log',
          at: 1_250,
          message: 'Review started',
        },
        {
          id: 'event-3',
          type: 'approval-requested',
          at: 1_300,
          name: 'write_file',
          dispatchId: 'dispatch-2',
        },
        {
          id: 'event-4',
          type: 'approval-settled',
          at: 1_350,
          name: 'write_file',
          dispatchId: 'dispatch-2',
        },
        {
          id: 'event-5',
          type: 'workflow-completed',
          at: 3_000,
        },
      ],
    });

    expect(buildWorkflowReplayEvents(task)).toEqual([
      {
        id: 'event-1',
        time: 1_000,
        kind: 'phase-started',
        phaseVisitId: 'phase-1',
      },
      {
        id: 'event-2',
        time: 1_250,
        kind: 'log',
        detail: 'Review started',
      },
      {
        id: 'event-3',
        time: 1_300,
        kind: 'approval-requested',
        dispatchId: 'dispatch-2',
        detail: 'write_file',
      },
      {
        id: 'event-4',
        time: 1_350,
        kind: 'approval-settled',
        dispatchId: 'dispatch-2',
        detail: 'write_file',
      },
      {
        id: 'event-5',
        time: 3_000,
        kind: 'workflow-completed',
      },
    ]);

    expect(projectWorkflowReplay(task, 1_325).task.pendingApprovalCount).toBe(
      1,
    );
    expect(projectWorkflowReplay(task, 1_375).task.pendingApprovalCount).toBe(
      0,
    );
  });

  it('keeps a legacy cached dispatch after its queued event', () => {
    const task = workflowTask({
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          status: 'cached',
          startedAt: undefined,
          endedAt: 1_010,
        },
      ],
    });

    expect(
      buildWorkflowReplayEvents(task)
        .filter((event) => event.dispatchId === 'dispatch-1')
        .map((event) => event.kind),
    ).toEqual(['dispatch-queued', 'dispatch-cached']);
  });

  it('projects recorded dispatch and phase state at a replay timestamp', () => {
    const task = workflowTask();

    const queued = projectWorkflowReplay(task, 1_015);
    expect(queued.task.dispatches.map(({ status }) => status)).toEqual([
      'queued',
      'queued',
      'queued',
    ]);
    expect([...queued.futureDispatchIds]).toEqual(['dispatch-2', 'dispatch-3']);
    expect(queued.task.dispatches[0]?.startedAt).toBeUndefined();
    expect(queued.task.dispatches[1]?.startedAt).toBeUndefined();
    expect(queued.activePhaseVisitId).toBe('phase-1');

    const running = projectWorkflowReplay(task, 1_050);
    expect(running.task.dispatches[0]?.status).toBe('running');
    expect(running.task.dispatches[0]?.endedAt).toBeUndefined();

    const completed = projectWorkflowReplay(task, 1_150);
    expect(completed.task.dispatches[0]?.status).toBe('completed');

    const review = projectWorkflowReplay(task, 1_230);
    expect(review.task.dispatches[1]?.status).toBe('running');
    expect(review.task.dispatches[2]?.status).toBe('queued');
    expect(review.activePhaseVisitId).toBe('phase-2');

    const final = projectWorkflowReplay(task, 3_000);
    expect(final.task.dispatches.map(({ status }) => status)).toEqual(
      task.dispatches.map(({ status }) => status),
    );
    expect(final.elapsedEventCount).toBe(final.totalEventCount);
  });

  it('scrubs a saved run while keeping live runs out of replay mode', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    const timeline = container.querySelector<HTMLInputElement>(
      '[aria-label="Replay timeline"]',
    );
    expect(timeline).not.toBeNull();
    expect(timeline?.value).toBe('3000');
    expect(container.querySelector('[data-replay-future]')).toBeNull();

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(timeline, '1015');
      timeline!.dispatchEvent(new Event('input', { bubbles: true }));
      timeline!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(
      container
        .querySelector('[data-workflow-dispatch="dispatch-1"]')
        ?.getAttribute('data-status'),
    ).toBe('queued');
    expect(
      container
        .querySelector('[data-workflow-dispatch="dispatch-2"]')
        ?.getAttribute('data-replay-future'),
    ).toBe('true');
    expect(container.textContent).toContain('00:00 / 00:02');
    expect(
      container.querySelector('[data-workflow-summary]')?.textContent,
    ).toContain('0/1 agents');

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={workflowTask()} />
        </I18nProvider>,
      );
    });
    expect(
      container.querySelector('[aria-label="Replay timeline"]'),
    ).toBeNull();
  });

  it('jumps to a recorded event, selects its agent, and keeps untimed logs at the endpoint', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
      recentLogs: ['Inspect complete', 'Verification passed'],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[data-replay-final-output]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Log timestamps were not recorded');

    const started = container.querySelector<HTMLButtonElement>(
      '[data-replay-event="dispatch:dispatch-1:started"]',
    );
    expect(started).not.toBeNull();
    act(() => started!.click());

    expect(
      container
        .querySelector('[data-run-replay]')
        ?.getAttribute('data-replay-at'),
    ).toBe('1020');
    expect(
      container
        .querySelector('[data-replay-current-event]')
        ?.getAttribute('data-replay-current-event'),
    ).toBe('dispatch:dispatch-1:started');
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Scope mapper');
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Agent started');
    expect(
      container.querySelector('[data-selected-dispatch="dispatch-1"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-replay-final-output]')).toBeNull();
  });

  it('jumps to persisted log and approval settlement events', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
      recentLogs: ['Review started'],
      events: [
        {
          id: 'event-1',
          type: 'log',
          at: 1_250,
          message: 'Review started',
        },
        {
          id: 'event-2',
          type: 'approval-settled',
          at: 1_350,
          name: 'write_file',
          dispatchId: 'dispatch-2',
        },
        {
          id: 'event-3',
          type: 'workflow-completed',
          at: 3_000,
        },
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain(
      'Log timestamps are shown in replay',
    );
    expect(container.textContent).not.toContain(
      'Log timestamps were not recorded',
    );

    const log = container.querySelector<HTMLButtonElement>(
      '[data-replay-event="event-1"]',
    );
    act(() => log?.click());
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Review started');
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Log');

    const settled = container.querySelector<HTMLButtonElement>(
      '[data-replay-event="event-2"]',
    );
    act(() => settled?.click());
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Approval settled');
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('write_file');
  });

  it('finds the latest elapsed event when recorded timestamps are out of order', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
      events: [
        { id: 'event-1', type: 'log', at: 1_500, message: 'Later event' },
        { id: 'event-2', type: 'log', at: 1_400, message: 'Elapsed event' },
        { id: 'event-3', type: 'workflow-completed', at: 3_000 },
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    const timeline = container.querySelector<HTMLInputElement>(
      '[aria-label="Replay timeline"]',
    );
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(timeline, '1450');
      timeline!.dispatchEvent(new Event('input', { bubbles: true }));
      timeline!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Elapsed event');
  });

  it('does not claim complete timestamp coverage for terminal-only logs', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'cancelled',
      endTime: 3_000,
      recentLogs: ['Before cancellation', 'After cancellation'],
      events: [
        {
          id: 'event-1',
          type: 'log',
          at: 1_250,
          message: 'Before cancellation',
        },
        {
          id: 'event-2',
          type: 'workflow-cancelled',
          at: 3_000,
        },
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Log timestamps were not recorded');
    expect(container.textContent).not.toContain(
      'Log timestamps are shown in replay',
    );
  });

  it('shows recorded agent and workflow errors at their event timestamps', () => {
    const historical = workflowTask({
      isHistorical: true,
      status: 'failed',
      endTime: 1_400,
      runtimeMs: 400,
      error: 'Workflow verification failed',
      phaseVisits: [
        workflowTask().phaseVisits[0]!,
        {
          ...workflowTask().phaseVisits[1]!,
          endedAt: 1_400,
        },
      ],
      dispatches: [
        workflowTask().dispatches[0]!,
        {
          ...workflowTask().dispatches[1]!,
          status: 'failed',
          endedAt: 1_350,
          error: 'Typecheck failed',
        },
        workflowTask().dispatches[2]!,
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={historical} />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Workflow verification failed');

    const failed = container.querySelector<HTMLButtonElement>(
      '[data-replay-event="dispatch:dispatch-2:failed"]',
    );
    expect(failed).not.toBeNull();
    act(() => failed!.click());

    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Agent failed');
    expect(
      container.querySelector('[data-replay-current-event]')?.textContent,
    ).toContain('Typecheck failed');
    expect(
      container.querySelector('[data-selected-dispatch="dispatch-2"]'),
    ).not.toBeNull();
  });

  it('builds edges only from recorded dispatch dependencies', () => {
    const task = workflowTask();
    task.dispatches[2]!.dependsOn = ['dispatch-1', 'missing'];

    const layout = buildWorkflowGraphLayout(task);

    expect(layout.lanes.map((lane) => lane.title)).toEqual([
      'Inspect',
      'Review',
    ]);
    expect(layout.edges.map(({ from, to }) => [from, to])).toEqual([
      ['dispatch-1', 'dispatch-2'],
      ['dispatch-1', 'dispatch-3'],
    ]);
  });

  it('shows the selected dispatch prompt when a node is chosen', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={workflowTask()} />
        </I18nProvider>,
      );
    });

    const architecture = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Architecture'));
    expect(architecture).toBeDefined();
    act(() => architecture!.click());

    expect(container.textContent).toContain('Review ownership boundaries');
    expect(
      container.querySelector('[data-selected-dispatch="dispatch-3"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-workflow-edge]')).toHaveLength(2);
    expect(
      container.querySelector('[data-active="true"] strong')?.textContent,
    ).toBe('Review');
  });

  it('locates a pending permission on its dispatch without duplicating approval controls', () => {
    const task = workflowTask();
    task.pendingApprovalCount = 1;
    task.pendingApprovals = [
      {
        approvalId: 'wfap-1',
        subagentId: 'correctness-agent-1',
        name: 'write_file',
        description: 'Update the implementation',
        at: 1_300,
      },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={task} />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[data-workflow-approval="wfap-1"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Approval needed');
    expect(container.textContent).toContain('Update the implementation');
    expect(container.textContent).toContain('Respond in chat');
    expect(container.querySelectorAll('button')).toHaveLength(3);
  });

  it('shows how many dispatches were restored from a retry journal', () => {
    const task = workflowTask({
      sourceRunId: 'wf-1',
      startMode: 'retry',
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          status: 'cached',
        },
        ...workflowTask().dispatches.slice(1),
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={task} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Retried from wf-1');
    expect(container.textContent).toContain('1 cached');
  });

  it('expands a source and current run comparison for a full rerun', () => {
    const sourceTask = workflowTask({
      id: 'wf-source',
      status: 'failed',
      runtimeMs: 5_000,
      agentsDispatched: 4,
      agentsCompleted: 3,
      tokensSpent: 4_000,
    });
    const task = workflowTask({
      id: 'wf-current',
      sourceRunId: sourceTask.id,
      startMode: 'rerun',
      runtimeMs: 2_000,
      agentsDispatched: 3,
      agentsCompleted: 1,
      tokensSpent: 1_200,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={task} sourceTask={sourceTask} />
        </I18nProvider>,
      );
    });

    const compare = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Compare runs');
    expect(compare).toBeDefined();
    expect(compare?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-run-comparison]')).toBeNull();

    act(() => compare!.click());

    const comparison = container.querySelector('[data-run-comparison]');
    expect(compare?.getAttribute('aria-expanded')).toBe('true');
    expect(comparison).not.toBeNull();
    expect(comparison?.textContent).toContain('wf-source');
    expect(comparison?.textContent).toContain('wf-current');
    expect(comparison?.textContent).toContain('3/4');
    expect(comparison?.textContent).toContain('1/3');
    expect(comparison?.textContent).toContain('4.0k');
    expect(comparison?.textContent).toContain('1.2k');
  });

  it('opens saved run history and compares a selected historical run', () => {
    const older = workflowTask({
      id: 'wf-older',
      isHistorical: true,
      status: 'completed',
      startTime: 500,
      runtimeMs: 4_000,
      agentsDispatched: 2,
      agentsCompleted: 2,
      tokensSpent: 700,
    });
    const failed = workflowTask({
      id: 'wf-failed',
      isHistorical: true,
      status: 'failed',
      startTime: 1_000,
      runtimeMs: 5_000,
      agentsDispatched: 4,
      agentsCompleted: 3,
      tokensSpent: 4_000,
    });
    const current = workflowTask({ id: 'wf-current', startTime: 2_000 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView
            task={current}
            historyTasks={[older, failed]}
          />
        </I18nProvider>,
      );
    });

    const history = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Run history (2)');
    expect(history).toBeDefined();
    act(() => history!.click());

    expect(
      container.querySelector('[data-run-history]')?.textContent,
    ).toContain('wf-failed');
    const failedRun = container.querySelector<HTMLButtonElement>(
      '[data-history-run="wf-failed"]',
    );
    expect(failedRun).not.toBeNull();
    act(() => failedRun!.click());

    const comparison = container.querySelector('[data-run-comparison]');
    expect(comparison?.textContent).toContain('wf-failed');
    expect(comparison?.textContent).toContain('wf-current');
    expect(comparison?.textContent).toContain('3/4');
    expect(comparison?.textContent).toContain('4.0k');
  });

  it('filters saved runs and exports only the visible history', async () => {
    const completed = workflowTask({
      id: 'wf-completed',
      isHistorical: true,
      status: 'completed',
      startTime: 2_000,
      endTime: 3_000,
    });
    const failed = workflowTask({
      id: 'wf-failed',
      isHistorical: true,
      status: 'failed',
      startTime: 1_000,
      endTime: 1_500,
      events: [
        {
          id: 'event-1',
          type: 'workflow-failed',
          at: 1_500,
          error: 'Verification failed',
        },
      ],
    });
    const createObjectURL = vi.fn(() => 'blob:workflow-history');
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView
            task={workflowTask({ id: 'wf-current' })}
            historyTasks={[completed, failed]}
          />
        </I18nProvider>,
      );
    });
    const history = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run history (2)',
    );
    act(() => history?.click());
    const filter = container.querySelector<HTMLSelectElement>(
      '[aria-label="Filter runs"]',
    );
    expect(filter).not.toBeNull();
    act(() => {
      filter!.value = 'failed';
      filter!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-history-run="wf-failed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-history-run="wf-completed"]'),
    ).toBeNull();
    const exportButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Export visible',
    );
    act(() => exportButton?.click());

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const exported = JSON.parse(text) as {
      runs: Array<{ id: string; events?: unknown[] }>;
    };
    expect(exported.runs.map((run) => run.id)).toEqual(['wf-failed']);
    expect(exported.runs[0]?.events).toEqual(failed.events);

    act(() => {
      filter!.value = 'cancelled';
      filter!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('No saved runs match this filter.');
    expect(exportButton?.disabled).toBe(true);
  });

  it('requires confirmation before deleting an individual saved run', () => {
    const onDeleteHistory = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView
            task={workflowTask({ id: 'wf-current' })}
            historyTasks={[
              workflowTask({
                id: 'wf-abcd',
                isHistorical: true,
                status: 'failed',
              }),
            ]}
            onDeleteHistory={onDeleteHistory}
          />
        </I18nProvider>,
      );
    });
    const history = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run history (1)',
    );
    act(() => history?.click());
    const remove = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete',
    );
    act(() => remove?.click());
    expect(onDeleteHistory).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm delete',
    );
    act(() => confirm?.click());

    expect(onDeleteHistory).toHaveBeenCalledWith('wf-abcd');
  });
});
