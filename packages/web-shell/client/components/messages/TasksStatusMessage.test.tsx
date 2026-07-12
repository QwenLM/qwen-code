// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTasksStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

// The panel only needs getTasks/cancelTask from the daemon SDK; mock the
// hook so the unit test doesn't pull the whole connection graph. Hoisted
// so tests can assert on / reprogram the mocks across renders.
const { getTasksMock, cancelTaskMock } = vi.hoisted(() => ({
  getTasksMock: vi.fn(),
  cancelTaskMock: vi.fn(),
}));
vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useActions: () => ({
    getTasks: getTasksMock,
    cancelTask: cancelTaskMock,
  }),
}));

const { TasksStatusMessage } = await import('./TasksStatusMessage');

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
  getTasksMock.mockReset();
  cancelTaskMock.mockReset();
});

function agentTask(
  id: string,
  overrides: Partial<DaemonSessionAgentTaskStatus> = {},
): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id,
    label: `label-${id}`,
    description: `desc-${id}`,
    status: 'running',
    startTime: 1_000,
    runtimeMs: 5_000,
    isBackgrounded: true,
    subagentType: 'general-purpose',
    ...overrides,
  };
}

function renderPanel(tasks: DaemonSessionAgentTaskStatus[]): HTMLElement {
  const snapshot: DaemonSessionTasksStatus = {
    v: 1,
    sessionId: 'session-1',
    now: 10_000,
    tasks,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TasksStatusMessage message={{ snapshot }} manageActiveEvent={false} />
      </I18nProvider>,
    );
  });
  return container;
}

describe('TasksStatusMessage nested-agent tree', () => {
  it('groups a child directly beneath its parent across the sort order', () => {
    // Active sort alone renders newest-first: child(3000), other(2000),
    // parent(1000). The tree post-pass must pull the child up under its
    // parent without disturbing the other root's earned position.
    const container = renderPanel([
      agentTask('parent', { startTime: 1_000 }),
      agentTask('other', { startTime: 2_000 }),
      agentTask('child', {
        startTime: 3_000,
        parentAgentId: 'parent',
        parentName: 'general-purpose',
        depth: 1,
      }),
    ]);
    const text = container.textContent ?? '';
    const posOther = text.indexOf('label-other');
    const posParent = text.indexOf('label-parent');
    const posChild = text.indexOf('label-child');
    expect(posOther).toBeGreaterThanOrEqual(0);
    expect(posParent).toBeGreaterThan(posOther);
    expect(posChild).toBeGreaterThan(posParent);
  });

  it('marks nested rows with the ↳ marker and indents by visible depth', () => {
    const container = renderPanel([
      agentTask('parent'),
      agentTask('child', { parentAgentId: 'parent', depth: 1 }),
    ]);
    expect(container.textContent).toContain('↳');
    const indented = container.querySelector(
      'span[style*="padding-left"]',
    ) as HTMLElement | null;
    expect(indented).not.toBeNull();
    expect(indented!.style.paddingLeft).toBe('16px');
    expect(indented!.textContent).toContain('label-child');
  });

  it('annotates an orphaned row with its departed parent instead of indenting', () => {
    const container = renderPanel([
      agentTask('orphan', {
        parentAgentId: 'gone',
        parentName: 'editor',
        depth: 2,
      }),
    ]);
    const text = container.textContent ?? '';
    expect(text).toContain('↳');
    expect(text).toContain('from editor');
    expect(container.querySelector('span[style*="padding-left"]')).toBeNull();
  });

  it('cancels a foreground child of a background parent on the first press', async () => {
    // The two-step confirm exists to warn "cancelling ends your turn".
    // A foreground child awaited by a background parent unblocks that
    // parent, not the user — first press must cancel immediately, same
    // as the TUI dialog's chain-aware gate.
    getTasksMock.mockResolvedValue({ tasks: [] });
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    renderPanel([
      agentTask('bg-parent', { isBackgrounded: true, startTime: 2_000 }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'bg-parent',
        depth: 1,
        startTime: 1_000,
      }),
    ]);
    // The global keydown listener attaches after a 50 ms guard delay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        // Each state change re-arms the delayed listener (50 ms guard);
        // wait it out so the next press isn't swallowed mid-re-attach.
        await new Promise((r) => setTimeout(r, 80));
      });
    await press('ArrowDown'); // select the child (row 2)
    await press('x');
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock).toHaveBeenCalledWith('fg-child', 'agent');
  });

  it('requires a second press to cancel a user-blocking agent', async () => {
    getTasksMock.mockResolvedValue({ tasks: [] });
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    renderPanel([
      agentTask('fg-root', { isBackgrounded: false, startTime: 2_000 }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'fg-root',
        depth: 1,
        startTime: 1_000,
      }),
    ]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        // Each state change re-arms the delayed listener (50 ms guard);
        // wait it out so the next press isn't swallowed mid-re-attach.
        await new Promise((r) => setTimeout(r, 80));
      });
    await press('x'); // fully-foreground chain → arms the confirm instead
    expect(cancelTaskMock).not.toHaveBeenCalled();
    await press('x'); // second press confirms
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock).toHaveBeenCalledWith('fg-root', 'agent');
  });

  it('tags [blocking] only on a fully-foreground chain', () => {
    const container = renderPanel([
      agentTask('bg-parent', { isBackgrounded: true }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'bg-parent',
        depth: 1,
      }),
      agentTask('fg-root', { isBackgrounded: false }),
    ]);
    const text = container.textContent ?? '';
    // fg-root's whole chain (itself) is foreground → tagged.
    expect(text).toContain('[blocking] label-fg-root');
    // fg-child is awaited by a background parent → blocks that parent,
    // not the user; must NOT be tagged.
    expect(text).not.toContain('[blocking] label-fg-child');
    expect(text).not.toContain('[blocking] label-bg-parent');
  });

  it('caps the detail progress list at the newest MAX_DISPLAYED_ACTIVITIES rows', async () => {
    const recentActivities = Array.from({ length: 8 }, (_, i) => ({
      name: 'read_file',
      description: `activity-${i}.ts`,
      at: i,
    }));
    const tasks = [agentTask('solo', { recentActivities })];
    // The 3 s poll would otherwise replace state; return the same task.
    getTasksMock.mockResolvedValue({ tasks });
    const container = renderPanel(tasks);
    // Global keydown listener attaches after a 50 ms guard delay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    // Enter opens the detail view for the selected (only) task.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((r) => setTimeout(r, 80));
    });
    const text = container.textContent ?? '';
    // Only the newest five (activity-3 … activity-7) render; older drop.
    expect(text).not.toContain('activity-2.ts');
    expect(text).toContain('activity-3.ts');
    expect(text).toContain('activity-7.ts');
  });
});
