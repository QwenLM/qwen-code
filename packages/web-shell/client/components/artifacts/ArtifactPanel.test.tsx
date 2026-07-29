// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionMonitorTaskStatus } from '@qwen-code/sdk/daemon';
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

function monitorPanel(task: DaemonSessionMonitorTaskStatus) {
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

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  mockActions.cancelTask.mockReset();
  mockActions.getTasks.mockReset();
});

describe('ArtifactPanel monitor tab', () => {
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
