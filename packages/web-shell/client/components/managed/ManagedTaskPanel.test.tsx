// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedTaskPanel } from './ManagedTaskPanel';
import { task, taskEvent } from './managed-task.test-fixtures';
import type { ManagedTask } from './managed-agent-provider';
import type { useManagedTasks } from './use-managed-tasks';
import type { useManagedTaskCancel } from './use-managed-task-cancel';
import type { ManagedToolResultReader } from './managed-tool-result-types';
import { artifact } from './managed-tool-result.test-fixtures';

describe('ManagedTaskPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  let tasks: ReturnType<typeof useManagedTasks>;
  let cancel: ReturnType<typeof useManagedTaskCancel>;
  let onClose: ReturnType<typeof vi.fn>;
  let restore: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onClose = vi.fn();
    restore = vi.fn();
    tasks = {
      page: { data: [task], hasMore: false },
      events: [],
      loading: false,
      moreEvents: false,
      historyGap: false,
      hasPrevious: false,
      refresh: vi.fn(),
      apply: vi.fn(),
      select: vi.fn(),
      next: vi.fn(),
      previous: vi.fn(),
      loadMoreEvents: vi.fn(),
      error: undefined,
      selectedId: undefined,
      task: undefined,
    };
    cancel = {
      states: {},
      pendingTaskIds: [],
      submit: vi.fn(),
      resume: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  async function render(
    wide = true,
    canCancel = true,
    reader?: ManagedToolResultReader,
    language: 'en' | 'zh-CN' = 'en',
  ) {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <ManagedTaskPanel
            wide={wide}
            tasks={tasks}
            cancel={cancel}
            canCancel={canCancel}
            clientId="client"
            sessionId="s1"
            onClose={onClose}
            restoreFocus={restore}
            reader={reader}
          />
        </I18nProvider>,
      ),
    );
  }
  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    );
    expect(found).toBeDefined();
    return found!;
  }

  it('lists every task kind with its label and offers cancel only where the task advertises it', async () => {
    tasks.page = {
      data: [
        {
          ...task,
          kind: 'automation_run',
          taskId: 'task_automation',
          actionCapabilities: [],
        },
        { ...task, kind: 'background_shell', taskId: 'task_shell' },
        {
          ...task,
          kind: 'future_kind' as ManagedTask['kind'],
          taskId: 'task_future',
          actionCapabilities: [],
        },
      ],
      hasMore: true,
      nextCursor: 'next',
    };
    await render();
    expect(container.textContent).toContain('Automation run · automati');
    expect(container.textContent).toContain('Background Shell · shell');
    expect(container.textContent).toContain('Task · future');
    expect(
      [...document.querySelectorAll('button')].filter(
        (item) => item.textContent === 'Request cancellation',
      ),
    ).toHaveLength(1);
    await act(async () => button('Request cancellation').click());
    await act(async () => button('Confirm cancellation').click());
    expect(cancel.submit).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task_shell' }),
    );
    await act(async () => button('Next page').click());
    expect(tasks.next).toHaveBeenCalledOnce();
    expect(button('Previous page').disabled).toBe(true);
  });

  it('keeps navigation on an empty page', async () => {
    tasks.page = { data: [], hasMore: true, nextCursor: 'next' };
    await render();
    expect(container.textContent).toContain('No tasks on this page');
    await act(async () => button('Next page').click());
    expect(tasks.next).toHaveBeenCalledOnce();
  });

  it('requires inline confirmation and keeps accepted cancellation distinct from task settlement', async () => {
    await render();
    await act(async () => button('Request cancellation').click());
    expect(cancel.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Stopping takes time');
    await act(async () => button('Confirm cancellation').click());
    expect(cancel.submit).toHaveBeenCalledWith(task);
    cancel = {
      ...cancel,
      pendingTaskIds: [task.taskId],
      states: { [task.taskId]: { status: 'stopping', busy: false } },
    };
    await render();
    expect(container.textContent).toContain(
      'Stop requested. Waiting for the task to end.',
    );
    expect(container.textContent).toContain('Running');
    expect(container.textContent).not.toContain('Cancelled');
    expect(
      [...document.querySelectorAll('button')].some(
        (item) => item.textContent === 'Request cancellation',
      ),
    ).toBe(false);
  });

  it('shows authoritative state, history gap and missing artifacts without rendering unknown event payloads', async () => {
    tasks = {
      ...tasks,
      selectedId: task.taskId,
      task: {
        ...task,
        state: 'completed',
        settledAt: 5,
        actionCapabilities: [],
      },
      historyGap: true,
      events: [
        taskEvent('e1'),
        { ...taskEvent('e2', 'future'), text: 'opaque future payload' },
      ],
      moreEvents: true,
    };
    await render();
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('earlier events expired');
    expect(container.textContent).toContain(
      'has not provided viewable Artifacts',
    );
    expect(container.textContent).not.toContain('opaque future payload');
    await act(async () => button('Load more').click());
    expect(tasks.loadMoreEvents).toHaveBeenCalledOnce();
  });

  it('retains list scroll when returning from detail', async () => {
    await render();
    const list = container.querySelector(
      '[data-managed-task-panel] .overflow-y-auto',
    ) as HTMLDivElement;
    list.scrollTop = 144;
    await act(async () =>
      list.dispatchEvent(new Event('scroll', { bubbles: true })),
    );
    tasks = { ...tasks, selectedId: task.taskId, task };
    await render();
    await act(async () => button('Back to tasks').click());
    expect(tasks.select).toHaveBeenCalledWith();
    tasks = { ...tasks, selectedId: undefined, task: undefined };
    await render();
    expect(
      (
        container.querySelector(
          '[data-managed-task-panel] .overflow-y-auto',
        ) as HTMLDivElement
      ).scrollTop,
    ).toBe(144);
  });

  it('requires the task cancel action even when the host supports cancellation', async () => {
    tasks.page.data = [{ ...task, actionCapabilities: [] }];
    await render();
    expect(container.textContent).not.toContain('Request cancellation');
    expect(cancel.submit).not.toHaveBeenCalled();
  });

  it('formats timestamps in the panel language', async () => {
    await render(true, true, undefined, 'zh-CN');
    expect(container.textContent).toContain(
      new Date(task.createdAt).toLocaleString('zh-CN'),
    );
    expect(container.textContent).not.toContain(
      new Date(task.createdAt).toLocaleString('en'),
    );
  });

  it('offers reads without cancellation in an identity-less host', async () => {
    await render(true, false);
    expect(container.textContent).toContain('Child Agent');
    expect(container.textContent).not.toContain('Request cancellation');
    await act(async () => button('Close tasks').click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'reads only the selected public task Artifact and rejects cross-Session metadata=%s',
    async (wrongSession) => {
      tasks = {
        ...tasks,
        selectedId: task.taskId,
        task: { ...task, artifactRefs: [artifact.id] },
      };
      const reader: ManagedToolResultReader = {
        canDownload: false,
        listArtifacts: vi.fn(),
        getResult: vi.fn(),
        downloadArtifact: vi.fn(),
        getArtifact: vi.fn().mockResolvedValue({
          artifact: {
            ...artifact,
            session_id: wrongSession ? 'other-session' : 's1',
          },
          access: { can_read_content: true },
        }),
        readRange: vi.fn().mockResolvedValue(new TextEncoder().encode('hello')),
      };
      await render(true, true, reader);
      await act(async () => button(artifact.id).click());
      expect(reader.getArtifact).toHaveBeenCalledWith(
        's1',
        artifact.id,
        expect.objectContaining({ clientId: 'client' }),
      );
      if (wrongSession) {
        expect(reader.readRange).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain('hello');
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
      } else expect(container.textContent).toContain('hello');
      expect(reader.listArtifacts).not.toHaveBeenCalled();
    },
  );

  it('uses the shared Dialog and restores focus when its narrow panel closes', async () => {
    await render(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[data-managed-task-panel="dialog"]'),
    ).not.toBeNull();
    await act(async () => root.unmount());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    root = createRoot(container);
    expect(restore).toHaveBeenCalledOnce();
  });
});
