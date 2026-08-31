// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionWorkflowTaskStatus } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  buildWorkflowGraphLayout,
  WORKFLOW_GRAPH_RENDER_LIMITS,
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
  it('shows a saved run as its final graph without replay controls', () => {
    const task = workflowTask({
      isHistorical: true,
      status: 'completed',
      endTime: 3_000,
      agentsCompleted: 3,
      dispatches: workflowTask().dispatches.map((dispatch) => ({
        ...dispatch,
        status: 'completed' as const,
        endedAt: dispatch.endedAt ?? 2_000,
      })),
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

    expect(container.querySelector('[data-run-replay]')).toBeNull();
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(container.textContent).not.toContain('Run replay');
    expect(
      container.querySelector('[data-workflow-summary]')?.textContent,
    ).toContain('3/3 agents');
    expect(
      container.querySelector('[data-workflow-edge="dispatch-1:dispatch-2"]'),
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

  it('keeps a large workflow graph bounded and reports omitted content', () => {
    const phaseVisits = Array.from({ length: 80 }, (_, index) => ({
      id: `large-phase-${index}`,
      index,
      title: `Phase ${index}`,
      startedAt: 1_000 + index,
      endedAt: 2_000 + index,
    }));
    const dispatches = Array.from({ length: 300 }, (_, index) => ({
      id: `large-dispatch-${index}`,
      phaseVisitId: `large-phase-${index % phaseVisits.length}`,
      label: `Agent ${index}`,
      prompt: `Prompt ${index}`,
      status: 'completed' as const,
      dependsOn: Array.from(
        { length: index },
        (_, dependencyIndex) => `large-dispatch-${dependencyIndex}`,
      ),
      queuedAt: 1_000 + index,
      startedAt: 1_100 + index,
      endedAt: 1_200 + index,
    }));
    const task = workflowTask({
      phaseVisits,
      dispatches,
      agentsDispatched: dispatches.length,
      agentsCompleted: dispatches.length,
    });

    const layout = buildWorkflowGraphLayout(task);

    expect(layout.lanes).toHaveLength(WORKFLOW_GRAPH_RENDER_LIMITS.lanes);
    expect(layout.nodes).toHaveLength(WORKFLOW_GRAPH_RENDER_LIMITS.nodes);
    expect(layout.edges).toHaveLength(WORKFLOW_GRAPH_RENDER_LIMITS.edges);
    expect(layout.omittedLanes).toBe(16);
    expect(layout.omittedNodes).toBe(60);
    expect(layout.omittedEdges).toBeGreaterThan(0);
    expect(layout.dispatchCountByLaneId.get('large-phase-0')).toBe(4);
    expect(layout.dispatchStatusById.get('large-dispatch-299')).toBe(
      'completed',
    );

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

    expect(container.querySelectorAll('[data-workflow-lane]')).toHaveLength(
      WORKFLOW_GRAPH_RENDER_LIMITS.lanes,
    );
    expect(container.querySelectorAll('[data-workflow-dispatch]')).toHaveLength(
      WORKFLOW_GRAPH_RENDER_LIMITS.nodes,
    );
    expect(container.querySelectorAll('[data-workflow-edge]')).toHaveLength(
      WORKFLOW_GRAPH_RENDER_LIMITS.edges,
    );
    const omission = container.querySelector('[data-workflow-graph-omission]');
    expect(omission?.textContent).toContain('16 phases');
    expect(omission?.textContent).toContain('60 agents');
    expect(omission?.textContent).toContain(
      `${layout.omittedEdges} connections`,
    );
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
    expect(container.querySelector('[data-workflow-prompt]')).not.toBeNull();
  });

  it('resets dispatch selection when a new run reuses dispatch ids', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const firstRun = workflowTask({ id: 'wf-first' });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={firstRun} />
        </I18nProvider>,
      );
    });
    const architecture = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Architecture'));
    act(() => architecture!.click());
    expect(
      container.querySelector('[data-selected-dispatch="dispatch-3"]'),
    ).not.toBeNull();

    const secondRun = workflowTask({
      id: 'wf-second',
      dispatches: [
        ...workflowTask().dispatches,
        {
          id: 'dispatch-4',
          phaseVisitId: 'phase-2',
          label: 'New failure',
          prompt: 'Inspect the new failure',
          status: 'failed',
          dependsOn: ['dispatch-3'],
          queuedAt: 1_300,
          startedAt: 1_310,
          endedAt: 1_320,
          error: 'new failure',
        },
      ],
      agentsDispatched: 4,
      agentsCompleted: 2,
    });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <WorkflowExecutionView task={secondRun} />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[data-selected-dispatch="dispatch-4"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Inspect the new failure');
  });

  it('focuses direct graph connections on hover and keyboard focus', () => {
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

    const correctness = container.querySelector<HTMLButtonElement>(
      '[data-workflow-dispatch="dispatch-2"]',
    )!;
    const architecture = container.querySelector<HTMLButtonElement>(
      '[data-workflow-dispatch="dispatch-3"]',
    )!;
    const correctnessEdge = container.querySelector(
      '[data-workflow-edge="dispatch-1:dispatch-2"]',
    )!;
    const architectureEdge = container.querySelector(
      '[data-workflow-edge="dispatch-1:dispatch-3"]',
    )!;

    act(() => {
      correctness.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(correctness.getAttribute('data-path-emphasis')).toBe('active');
    expect(
      container
        .querySelector('[data-workflow-dispatch="dispatch-1"]')
        ?.getAttribute('data-path-emphasis'),
    ).toBe('related');
    expect(architecture.getAttribute('data-path-emphasis')).toBe('dimmed');
    expect(correctnessEdge.getAttribute('data-path-emphasis')).toBe('related');
    expect(architectureEdge.getAttribute('data-path-emphasis')).toBe('dimmed');

    act(() => {
      correctness.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(correctnessEdge.hasAttribute('data-path-emphasis')).toBe(false);
    expect(architectureEdge.hasAttribute('data-path-emphasis')).toBe(false);

    act(() => {
      architecture.focus();
    });
    expect(architecture.getAttribute('data-path-emphasis')).toBe('active');
    expect(
      container.querySelector('[data-selected-dispatch="dispatch-3"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-workflow-prompt]')?.textContent).toBe(
      'Review ownership boundaries',
    );
    expect(correctnessEdge.getAttribute('data-path-emphasis')).toBe('dimmed');
    expect(architectureEdge.getAttribute('data-path-emphasis')).toBe('related');

    act(() => architecture.blur());
    expect(correctnessEdge.hasAttribute('data-path-emphasis')).toBe(false);
    expect(architectureEdge.hasAttribute('data-path-emphasis')).toBe(false);
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

    act(() => failedRun!.click());

    expect(container.querySelector('[data-run-comparison]')).toBeNull();
    expect(failedRun?.getAttribute('aria-pressed')).toBe('false');
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
      label: 'sensitive workflow label',
      description: 'sensitive workflow description',
      recentLogs: ['sensitive workflow log'],
      error: 'sensitive workflow error',
      pendingApprovalCount: 1,
      pendingApprovals: [
        {
          approvalId: 'wfap-sensitive',
          subagentId: 'sensitive-subagent',
          name: 'sensitive approval name',
          description: 'sensitive approval description',
          at: 1_400,
        },
      ],
      events: [
        {
          id: 'event-1',
          type: 'log',
          at: 1_400,
          message: 'sensitive event log',
        },
      ],
      dispatches: workflowTask().dispatches.map((dispatch) => ({
        ...dispatch,
        label: 'sensitive dispatch label',
        prompt: 'sensitive dispatch prompt',
        subagentId: 'sensitive-subagent',
        error: 'sensitive dispatch error',
      })),
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
      runs: Array<{
        id: string;
        dispatches: Array<Record<string, unknown>>;
      }>;
    };
    expect(exported.runs.map((run) => run.id)).toEqual(['wf-failed']);
    expect(exported.runs[0]?.dispatches[0]).toEqual({
      id: 'dispatch-1',
      phaseVisitId: 'phase-1',
      status: 'completed',
      dependsOn: [],
      queuedAt: 1_010,
      startedAt: 1_020,
      endedAt: 1_100,
    });
    expect(text).not.toMatch(
      /sensitive workflow|sensitive dispatch|sensitive approval|sensitive-subagent|sensitive event/,
    );

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
