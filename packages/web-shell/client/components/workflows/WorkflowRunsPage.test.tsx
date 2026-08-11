// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTasksStatus,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const {
  actionsMock,
  connectionMock,
  getTasksMock,
  refreshCommandsMock,
  runSavedWorkflowMock,
} = vi.hoisted(() => {
  const getTasks = vi.fn();
  const refreshCommands = vi.fn();
  const runSavedWorkflow = vi.fn();
  return {
    getTasksMock: getTasks,
    refreshCommandsMock: refreshCommands,
    runSavedWorkflowMock: runSavedWorkflow,
    actionsMock: {
      getTasks,
      refreshCommands,
      runSavedWorkflow,
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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useActions: () => actionsMock,
  useConnection: () => connectionMock,
}));

const { WorkflowRunsPage } = await import('./WorkflowRunsPage');

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

async function renderPage(snapshot: DaemonSessionTasksStatus) {
  getTasksMock.mockResolvedValue(snapshot);
  refreshCommandsMock.mockResolvedValue(undefined);
  runSavedWorkflowMock.mockResolvedValue({ started: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <WorkflowRunsPage />
      </I18nProvider>,
    );
  });

  return container;
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
    const runningTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Running'));
    expect(runningTab?.getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain('deep-review');
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
