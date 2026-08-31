// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionWorkflowTasksStatus,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

type DaemonSessionTasksStatus = DaemonSessionWorkflowTasksStatus;

const {
  actionsMock,
  connectionMock,
  getTasksMock,
  refreshCommandsMock,
  runSavedWorkflowMock,
  readSavedWorkflowMock,
} = vi.hoisted(() => {
  const getTasks = vi.fn();
  const refreshCommands = vi.fn();
  const runSavedWorkflow = vi.fn();
  const readSavedWorkflow = vi.fn();
  return {
    getTasksMock: getTasks,
    refreshCommandsMock: refreshCommands,
    runSavedWorkflowMock: runSavedWorkflow,
    readSavedWorkflowMock: readSavedWorkflow,
    actionsMock: {
      getTasks,
      getWorkflowTasks: getTasks,
      refreshCommands,
      runSavedWorkflow,
      readSavedWorkflow,
      cancelTask: vi.fn(),
      controlWorkflowTask: vi.fn(),
    },
    connectionMock: {
      sessionId: 'session-1' as string | undefined,
      supportedCommands: {
        v: 1 as const,
        sessionId: 'session-1',
        availableCommands: [],
        availableSkills: [],
        savedWorkflows: [] as Array<{
          name: string;
          source: 'project' | 'user';
        }>,
      },
    },
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => actionsMock,
  useConnection: () => connectionMock,
}));

const { WorkflowRunsPage } = await import('./WorkflowRunsPage');
const createViaChatMock = vi.fn();
const workflowRunStartedMock = vi.fn();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  connectionMock.sessionId = 'session-1';
  connectionMock.supportedCommands.savedWorkflows = [];
  getTasksMock.mockReset();
  refreshCommandsMock.mockReset();
  runSavedWorkflowMock.mockReset();
  readSavedWorkflowMock.mockReset();
  createViaChatMock.mockReset();
  workflowRunStartedMock.mockReset();
  refreshCommandsMock.mockResolvedValue(undefined);
  runSavedWorkflowMock.mockResolvedValue({ started: true });
});

function workflowTask(
  id: string,
  label: string,
  overrides: Partial<DaemonSessionWorkflowTaskStatus> = {},
): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id,
    workflowName: label,
    label,
    description: label,
    status: 'running',
    startTime: 1_000,
    runtimeMs: 5_000,
    isBackgrounded: true,
    currentPhase: 'Inspect',
    phaseVisits: [
      {
        id: `${id}-phase`,
        index: 0,
        title: 'Inspect',
        startedAt: 1_000,
      },
    ],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
    pendingApprovals: [],
    ...overrides,
  };
}

function agentTask(): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: 'agent-1',
    label: 'ordinary-agent',
    description: 'Not a workflow',
    status: 'running',
    startTime: 2_000,
    runtimeMs: 2_000,
    isBackgrounded: true,
    subagentType: 'general-purpose',
  };
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <WorkflowRunsPage
          onCreateViaChat={createViaChatMock}
          onWorkflowRunStarted={workflowRunStartedMock}
        />
      </I18nProvider>,
    );
  });

  return container;
}

async function renderPage(snapshot: DaemonSessionWorkflowTasksStatus) {
  getTasksMock.mockResolvedValue(snapshot);
  refreshCommandsMock.mockResolvedValue(undefined);
  runSavedWorkflowMock.mockResolvedValue({ started: true });
  return mountPage();
}

async function selectTab(container: HTMLElement, label: string) {
  const tab = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.includes(label));
  expect(tab).toBeDefined();
  await act(async () => {
    tab!.focus();
    tab!.click();
    await Promise.resolve();
  });
}

describe('WorkflowRunsPage', () => {
  it('starts workflow creation from the toolbar', async () => {
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [],
    });

    const createButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('New'));
    expect(createButton).toBeDefined();

    await act(async () => createButton!.click());

    expect(createViaChatMock).toHaveBeenCalledTimes(1);
  });

  it('opens directly on compact workflow navigation', async () => {
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [],
    });

    expect(container.textContent).not.toContain('Dynamic workflow traces');
    expect(container.textContent).not.toContain('replay completed runs');
    expect(
      container.querySelector('button[aria-label="Refresh"]'),
    ).not.toBeNull();
  });

  it('separates active runs from saved and terminal history', async () => {
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [
        workflowTask('workflow-live', 'live-review'),
        workflowTask('workflow-history', 'saved-review', {
          status: 'failed',
          endTime: 8_000,
          isHistorical: true,
        }),
        agentTask(),
      ],
    });

    await selectTab(container, 'Running');

    expect(container.textContent).toContain('live-review');
    expect(container.textContent).not.toContain('saved-review');
    expect(container.textContent).not.toContain('ordinary-agent');

    await selectTab(container, 'History');

    expect(container.textContent).toContain('saved-review');
    expect(container.textContent).not.toContain('live-review');
    expect(container.textContent).not.toContain('ordinary-agent');
  });

  it('lists reusable project and user workflows and starts a new run', async () => {
    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deep-review', source: 'project' },
      { name: 'release-check', source: 'user' },
    ];
    runSavedWorkflowMock.mockResolvedValue({
      started: true,
      taskId: 'workflow-started',
      status: 'running',
    });
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [workflowTask('workflow-started', 'deep-review')],
    });

    expect(container.textContent).toContain('/deep-review');
    expect(container.textContent).toContain('Available in this project');
    expect(container.textContent).toContain('/release-check');
    expect(container.textContent).toContain('Available across projects');

    const runButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run deep-review"]',
    );
    expect(runButton).not.toBeNull();
    await act(async () => runButton!.click());

    expect(runSavedWorkflowMock).toHaveBeenCalledWith('deep-review');
    expect(workflowRunStartedMock).toHaveBeenCalledOnce();
    const runningTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Running'));
    expect(runningTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('deep-review');
  });

  it('expands a saved workflow into its definition, recent runs, and source', async () => {
    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deep-review', source: 'project' },
    ];
    const script = [
      'export const meta = {',
      "  name: 'deep-review',",
      "  description: 'Review a branch in depth',",
      "  whenToUse: 'Before merging risky changes',",
      "  phases: [{ title: 'Scan', detail: 'collect files' }, { title: 'Verify' }],",
      '}',
      "return await agent('go')",
    ].join('\n');
    readSavedWorkflowMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      name: 'deep-review',
      source: 'project',
      scriptPath: '/repo/.qwen/workflows/deep-review.js',
      script,
      meta: {
        name: 'deep-review',
        description: 'Review a branch in depth',
        whenToUse: 'Before merging risky changes',
        phases: [
          { title: 'Scan', detail: 'collect files' },
          { title: 'Verify' },
        ],
      },
    });
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [
        workflowTask('workflow-done', 'Release readiness', {
          workflowName: 'deep-review',
          status: 'completed',
          endTime: 8_000,
          isHistorical: true,
        }),
        workflowTask('workflow-other', 'Release readiness', {
          workflowName: 'release-check',
        }),
      ],
    });

    expect(container.querySelector('[data-workflow-detail]')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details for deep-review"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    await act(async () => toggle!.click());

    expect(readSavedWorkflowMock).toHaveBeenCalledWith('deep-review');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    const detail = container.querySelector(
      '[data-workflow-detail="deep-review"]',
    );
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('Review a branch in depth');
    expect(detail!.textContent).toContain('Before merging risky changes');
    expect(detail!.textContent).toContain('Phases (2)');
    expect(detail!.textContent).toContain('collect files');
    expect(detail!.textContent).toContain(
      '/repo/.qwen/workflows/deep-review.js',
    );
    // Only runs of this definition count, and the source stays folded.
    expect(detail!.textContent).toContain('View 1 run in History');
    expect(detail!.textContent).not.toContain('release-check');
    expect(container.querySelector('[data-workflow-source]')).toBeNull();

    const showSource = Array.from(
      detail!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Show source'));
    expect(showSource).toBeDefined();
    await act(async () => showSource!.click());
    expect(
      container.querySelector('[data-workflow-source]')?.textContent,
    ).toContain("return await agent('go')");

    await act(async () => toggle!.click());
    expect(container.querySelector('[data-workflow-detail]')).toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
  });

  it('reports a definition that the daemon can no longer read', async () => {
    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deep-review', source: 'project' },
    ];
    readSavedWorkflowMock.mockResolvedValueOnce(null);
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [],
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details for deep-review"]',
    );
    await act(async () => toggle!.click());

    const detail = container.querySelector(
      '[data-workflow-detail="deep-review"]',
    );
    expect(detail?.textContent).toContain(
      'This workflow definition is no longer available.',
    );
    expect(detail?.querySelector('[data-workflow-source]')).toBeNull();
  });

  it('closes detail when the same name switches saved-workflow scope', async () => {
    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deploy', source: 'project' },
    ];
    readSavedWorkflowMock.mockResolvedValue(null);
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [],
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details for deploy"]',
    );
    await act(async () => toggle!.click());
    expect(
      container.querySelector('[data-workflow-detail="deploy"]'),
    ).not.toBeNull();

    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deploy', source: 'user' },
    ];
    const root = mounted.at(-1)!.root;
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkflowRunsPage
            onCreateViaChat={createViaChatMock}
            onWorkflowRunStarted={workflowRunStartedMock}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-workflow-detail="deploy"]'),
    ).toBeNull();
  });

  it('ignores a saved-workflow completion from the previous session', async () => {
    connectionMock.supportedCommands.savedWorkflows = [
      { name: 'deep-review', source: 'project' },
    ];
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [],
    });
    let resolveStart!: (value: { started: boolean }) => void;
    runSavedWorkflowMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const runButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run deep-review"]',
    );
    act(() => runButton?.click());

    connectionMock.sessionId = 'session-2';
    connectionMock.supportedCommands.sessionId = 'session-2';
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-2',
      now: 11_000,
      tasks: [],
    });
    const root = mounted.at(-1)!.root;
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkflowRunsPage
            onCreateViaChat={createViaChatMock}
            onWorkflowRunStarted={workflowRunStartedMock}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveStart({ started: true });
      await Promise.resolve();
    });

    const savedTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Saved'));
    expect(savedTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).not.toContain(
      'Workflow could not be started',
    );
  });

  it('asks for a session instead of reporting a load failure on the welcome page', async () => {
    connectionMock.sessionId = undefined;
    const container = await renderPage({
      v: 1,
      sessionId: 'unused',
      now: 10_000,
      tasks: [],
    });

    expect(container.textContent).toContain(
      'Open a session in this project to view its workflow runs.',
    );
    expect(container.textContent).not.toContain('Failed to load');
    expect(getTasksMock).not.toHaveBeenCalled();
  });

  it('replaces the visible run list after a manual refresh', async () => {
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [workflowTask('workflow-old', 'old-review')],
    });
    await selectTab(container, 'Running');

    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 11_000,
      tasks: [workflowTask('workflow-new', 'new-review')],
    });

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    );
    expect(refresh).not.toBeNull();
    await act(async () => refresh!.click());

    expect(container.textContent).toContain('new-review');
    expect(container.textContent).not.toContain('old-review');
  });

  it('ignores a stale workflow load after switching sessions', async () => {
    const sessionA: DaemonSessionTasksStatus = {
      v: 1,
      sessionId: 'session-a',
      now: 10_000,
      tasks: [workflowTask('workflow-a', 'session-a-review')],
    };
    const sessionB: DaemonSessionTasksStatus = {
      v: 1,
      sessionId: 'session-b',
      now: 11_000,
      tasks: [workflowTask('workflow-b', 'session-b-review')],
    };
    let resolveSessionA!: (snapshot: DaemonSessionTasksStatus) => void;
    const pendingSessionA = new Promise<DaemonSessionTasksStatus>((resolve) => {
      resolveSessionA = resolve;
    });
    connectionMock.sessionId = 'session-a';
    getTasksMock
      .mockReturnValueOnce(pendingSessionA)
      .mockResolvedValueOnce(sessionB);
    refreshCommandsMock.mockResolvedValue(undefined);
    const container = await mountPage();

    connectionMock.sessionId = 'session-b';
    const root = mounted.at(-1)!.root;
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkflowRunsPage
            onCreateViaChat={createViaChatMock}
            onWorkflowRunStarted={workflowRunStartedMock}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await selectTab(container, 'Running');
    expect(container.textContent).toContain('session-b-review');

    await act(async () => {
      resolveSessionA(sessionA);
      await pendingSessionA;
    });

    expect(container.textContent).toContain('session-b-review');
    expect(container.textContent).not.toContain('session-a-review');
  });

  it('keeps the page list visible when Escape is pressed', async () => {
    const container = await renderPage({
      v: 1,
      sessionId: 'session-1',
      now: 10_000,
      tasks: [workflowTask('workflow-live', 'live-review')],
    });
    await selectTab(container, 'Running');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(container.textContent).toContain('live-review');
  });
});
