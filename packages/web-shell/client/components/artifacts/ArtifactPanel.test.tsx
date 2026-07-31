// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { DaemonSessionActions } from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

const { mockActions } = vi.hoisted(() => ({
  mockActions: {
    cancelTask: vi.fn(),
    getTasks: vi.fn(),
  },
}));

vi.mock(
  '@qwen-code/webui/daemon-react-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    useActions: () => mockActions,
    useWorkspaceActions: () => ({}),
  }),
);

const { ArtifactPanel } = await import('./ArtifactPanel');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function monitorPanel(
  task: DaemonSessionMonitorTaskStatus,
  sessionActions?: DaemonSessionActions,
) {
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          {
            id: 'monitor:monitor-1',
            kind: 'monitor',
            title: task.description,
            task,
            sessionActions,
          },
        ]}
        activeTabId="monitor:monitor-1"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

function shellPanel(task: DaemonSessionShellTaskStatus) {
  return (
    <I18nProvider language="en">
      <ArtifactPanel
        artifacts={[]}
        tabs={[
          {
            id: 'shell:shell-1',
            kind: 'shell',
            title: task.command,
            task,
          },
        ]}
        activeTabId="shell:shell-1"
        reviewChanges={[]}
        selectedReviewPath={null}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onOpenFilePreview={() => {}}
        onClose={() => {}}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  mockActions.cancelTask.mockReset();
  mockActions.getTasks.mockReset();
});

function openAddMenu(container: HTMLElement) {
  const add = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add panel"]',
  );
  act(() => {
    add?.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
    );
  });
  return add;
}

describe('ArtifactPanel add menu', () => {
  it('keeps the disabled review action on the empty page and hides the add button', () => {
    const onClose = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={onClose}
          />
        </I18nProvider>,
      );
    });

    const review = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Review'));
    expect(review?.disabled).toBe(true);
    expect(review?.textContent).toContain('View recent file changes');
    expect(container.textContent).not.toContain('⌘');
    expect(
      container.querySelector('button[aria-label="Add panel"]'),
    ).toBeNull();

    const panelToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle right panel"]',
    );
    expect(panelToggle).not.toBeNull();
    act(() => panelToggle?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('filters empty-page actions through right-panel items', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            items={['sideTask']}
            sideTaskAvailable
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const emptyText = container.querySelector(
      '[data-testid="right-panel-empty-actions"]',
    )?.textContent;
    expect(emptyText).toContain('Side task');
    expect(emptyText).not.toContain('Review');
    expect(
      container.querySelector('button[aria-label="Add panel"]'),
    ).toBeNull();
  });

  it('supports opening an existing side task or creating one', () => {
    const onCreateSideTask = vi.fn();
    const onOpenSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            sideTasks={[
              {
                sessionId: 'side-1',
                title: 'Investigate flaky tests',
                workspaceCwd: '/work/project',
              },
            ]}
            onCreateSideTask={onCreateSideTask}
            onOpenSideTask={onOpenSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    act(() => {
      sideTask?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
      );
    });

    const existing = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'Investigate flaky tests');
    const create = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'New');
    expect(existing).not.toBeUndefined();
    expect(create).not.toBeUndefined();

    act(() => existing?.click());
    expect(onOpenSideTask).toHaveBeenCalledWith({
      sessionId: 'side-1',
      title: 'Investigate flaky tests',
      workspaceCwd: '/work/project',
    });

    act(() => {
      sideTask?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, cancelable: true }),
      );
    });
    const reopenedCreate = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === 'New');
    act(() => reopenedCreate?.click());
    expect(onCreateSideTask).toHaveBeenCalledOnce();
  });

  it('creates a side task directly from the empty page when there is no history', () => {
    const onCreateSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            onCreateSideTask={onCreateSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    act(() => sideTask?.click());
    expect(onCreateSideTask).toHaveBeenCalledOnce();
  });

  it('does not create a side task before its history finishes loading', () => {
    const onCreateSideTask = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            sideTaskAvailable
            sideTasksLoading
            onCreateSideTask={onCreateSideTask}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const sideTask = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Side task'));
    expect(sideTask?.disabled).toBe(true);
    act(() => sideTask?.click());
    expect(onCreateSideTask).not.toHaveBeenCalled();
  });

  it('opens the latest review from the empty page', () => {
    const onOpenLatestReview = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[]}
            activeTabId={null}
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            onOpenLatestReview={onOpenLatestReview}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    const review = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="right-panel-empty-actions"] button',
      ),
    ).find((button) => button.textContent?.includes('Review'));
    expect(review?.disabled).toBe(false);
    act(() => review?.click());
    expect(onOpenLatestReview).toHaveBeenCalledOnce();
  });

  it('hides review from the add menu when a review tab is already open', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[{ id: 'review', kind: 'review', title: 'Review' }]}
            activeTabId="review"
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            sideTaskAvailable
            onOpenLatestReview={vi.fn()}
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    openAddMenu(container);
    const menuText = document.body.querySelector('[role="menu"]')?.textContent;
    expect(menuText).not.toContain('Review');
    expect(menuText).toContain('New side task');
  });

  it('shows review and side-task actions in the add menu for a non-empty panel', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(
        <I18nProvider language="en">
          <ArtifactPanel
            artifacts={[]}
            tabs={[
              {
                id: 'artifact',
                kind: 'artifact',
                title: 'Report',
                artifactId: 'report',
              },
            ]}
            activeTabId="artifact"
            reviewChanges={[]}
            selectedReviewPath={null}
            latestReviewAvailable
            sideTaskAvailable
            sideTasks={[
              {
                sessionId: 'side-1',
                title: 'Existing side task',
                workspaceCwd: '/work/project',
              },
            ]}
            onOpenLatestReview={vi.fn()}
            onCreateSideTask={vi.fn()}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
            onOpenFilePreview={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });

    openAddMenu(container);
    const menuText = document.body.querySelector('[role="menu"]')?.textContent;
    expect(menuText).toContain('Review');
    expect(menuText).toContain('New side task');
    expect(menuText).not.toContain('Existing side task');
  });
});

describe('ArtifactPanel monitor tab', () => {
  it('uses the source pane actions for monitor controls', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch pane logs',
      status: 'running',
      startTime: 1,
      runtimeMs: 10,
      command: 'tail -f pane.log',
      eventCount: 1,
      droppedLines: 0,
    };
    const paneActions = {
      cancelTask: vi.fn().mockResolvedValue({ cancelled: true }),
      getTasks: vi.fn().mockResolvedValue({
        v: 1,
        sessionId: 'pane-session',
        now: 11,
        tasks: [{ ...task, status: 'cancelled' }],
      }),
    } as unknown as DaemonSessionActions;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task, paneActions));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(paneActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(mockActions.cancelTask).not.toHaveBeenCalled();
  });

  it('shows the monitor snapshot in a dedicated right-panel tab', () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      pid: 42,
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 2,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });

    expect(
      container.querySelector('svg.lucide-square-activity'),
    ).not.toBeNull();
    expect(container.textContent).toContain('watch server log');
    expect(
      container.querySelector('[data-status="running"]')?.textContent,
    ).toBe('Running');
    expect(container.textContent).toContain('PID');
    expect(container.textContent).toContain('42');
    expect(container.textContent).toContain('Events');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Dropped');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('tail -f server.log');
  });

  it('stops a running monitor from its detail tab', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: true });
    mockActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [{ ...task }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });

    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    expect(stopButton).toBeDefined();
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(mockActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(container.textContent).toContain('Stopped');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);

    act(() => {
      root.render(monitorPanel({ ...task }));
    });

    expect(container.textContent).toContain('Stopped');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Stop',
      ),
    ).toBe(false);
  });

  it('stays stopped when the post-cancel refresh fails', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: true });
    mockActions.getTasks.mockRejectedValue(new Error('refresh failed'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Stopped');
    expect(container.textContent).not.toContain('Failed to cancel task');
  });

  it('keeps an in-flight stop response scoped to its monitor tab', async () => {
    const firstTask: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'first-monitor',
      description: 'watch first log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f first.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    const secondTask: DaemonSessionMonitorTaskStatus = {
      ...firstTask,
      id: 'monitor-2',
      label: 'second-monitor',
      description: 'watch second log',
      status: 'running',
      command: 'tail -f second.log',
    };
    let resolveCancel: ((value: { cancelled: boolean }) => void) | undefined;
    mockActions.cancelTask.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    mockActions.getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 6_000,
      tasks: [{ ...firstTask, status: 'cancelled' }],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderPanel = (activeTabId: string) => (
      <I18nProvider language="en">
        <ArtifactPanel
          artifacts={[]}
          tabs={[
            {
              id: 'monitor:monitor-1',
              kind: 'monitor',
              title: firstTask.description,
              task: firstTask,
            },
            {
              id: 'monitor:monitor-2',
              kind: 'monitor',
              title: secondTask.description,
              task: secondTask,
            },
          ]}
          activeTabId={activeTabId}
          reviewChanges={[]}
          selectedReviewPath={null}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onOpenFilePreview={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>
    );

    act(() => {
      root.render(renderPanel('monitor:monitor-1'));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    act(() => {
      stopButton?.click();
      root.render(renderPanel('monitor:monitor-2'));
    });
    const secondStopButton = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(secondStopButton).toBeDefined();
    expect(secondStopButton?.disabled).toBe(false);

    await act(async () => {
      resolveCancel?.({ cancelled: true });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('watch second log');
    expect(container.textContent).toContain('tail -f second.log');
    expect(container.textContent).not.toContain('tail -f first.log');
    expect(
      container.querySelector('[data-status="running"]')?.textContent,
    ).toBe('Running');
  });

  it('keeps a stop error across running snapshot refreshes', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockResolvedValue({ cancelled: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Task already stopped');

    act(() => {
      root.render(monitorPanel({ ...task, runtimeMs: 8_000 }));
    });

    expect(container.textContent).toContain('Task already stopped');
    expect(container.textContent).toContain('8s');
  });

  it('shows a cancel error when the stop request throws', async () => {
    const task: DaemonSessionMonitorTaskStatus = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch server log',
      status: 'running',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'tail -f server.log',
      eventCount: 3,
      lastEventTime: 5_000,
      droppedLines: 0,
    };
    mockActions.cancelTask.mockRejectedValue(new Error('network'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(monitorPanel(task));
    });
    const stopButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(mockActions.cancelTask).toHaveBeenCalledWith('monitor-1', 'monitor');
    expect(container.textContent).toContain('Failed to cancel task');
    const stopButtonAfter = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(stopButtonAfter).toBeDefined();
    expect(stopButtonAfter?.disabled).toBe(false);
  });
});

describe('ArtifactPanel shell tab', () => {
  it('shows shell task details in a dedicated right-panel tab', () => {
    const task: DaemonSessionShellTaskStatus = {
      kind: 'shell',
      id: 'shell-1',
      label: 'Development server',
      description: 'Run the development server',
      status: 'failed',
      startTime: 1_000,
      runtimeMs: 5_000,
      command: 'npm run dev',
      cwd: '/work/project',
      pid: 42,
      exitCode: 1,
      error: 'Command failed',
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    act(() => {
      root.render(shellPanel(task));
    });

    expect(
      container.querySelector('svg.lucide-square-terminal'),
    ).not.toBeNull();
    expect(container.querySelector('[data-status="failed"]')?.textContent).toBe(
      'Failed',
    );
    expect(container.querySelector('pre')?.textContent).toBe('npm run dev');
    expect(container.textContent).toContain('npm run dev');
    expect(container.textContent).toContain('/work/project');
    expect(container.textContent).toContain('Exit code');
    expect(container.textContent).toContain('Command failed');
  });
});
