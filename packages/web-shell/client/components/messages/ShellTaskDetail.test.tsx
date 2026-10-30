// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionShellTaskStatus,
  DaemonSessionTaskRuntimeStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const actions = vi.hoisted(() => ({
  getTaskRuntime: vi.fn<() => Promise<DaemonSessionTaskRuntimeStatus>>(),
  cancelTask: vi.fn(),
  getTasks: vi.fn(),
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => actions,
}));
const { ShellTaskDetail } = await import('./TasksStatusMessage');

const task: DaemonSessionShellTaskStatus = {
  kind: 'shell',
  id: 'bg_1',
  label: 'server',
  description: 'server',
  command: '/opt/bin/node server.js',
  cwd: '/project',
  status: 'running',
  startTime: 1000,
  runtimeMs: 2000,
  pid: 42,
};
const result = (outputTail: string): DaemonSessionTaskRuntimeStatus => ({
  v: 1,
  sessionId: 'session-1',
  taskId: task.id,
  runtime: { outputTail },
});
let root: Root | undefined;
let container: HTMLDivElement;

function render(next = task, strict = false, language: 'en' | 'zh-CN' = 'en') {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const panel = (
    <I18nProvider language={language}>
      <ShellTaskDetail task={next} />
    </I18nProvider>
  );
  act(() => root!.render(strict ? <StrictMode>{panel}</StrictMode> : panel));
}
async function settle() {
  await act(async () => {});
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  container?.remove();
  actions.getTaskRuntime.mockReset();
  actions.getTasks.mockReset();
  actions.cancelTask.mockReset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ShellTaskDetail runtime', () => {
  it.each(['completed', 'cancelled'] as const)(
    'reads final output when %s interrupts a pending sample',
    async (status) => {
      let finish!: (value: DaemonSessionTaskRuntimeStatus) => void;
      actions.getTaskRuntime
        .mockReturnValueOnce(
          new Promise((resolve) => {
            finish = resolve;
          }),
        )
        .mockResolvedValueOnce(result('FINAL OUTPUT'));
      render();
      render({ ...task, status, endTime: 3000 });
      await settle();
      expect(actions.getTaskRuntime).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('FINAL OUTPUT');
      await act(async () => finish(result('OLD OUTPUT')));
      expect(container.textContent).toContain('FINAL OUTPUT');
      expect(container.textContent).not.toContain('OLD OUTPUT');
    },
  );

  it.each(['cancelled', 'completed', 'failed'] as const)(
    'waits for the actual %s state after Stop before reading the final output',
    async (status) => {
      vi.useFakeTimers();
      let stopped = false;
      const terminalTask = { ...task, status, endTime: 4000, runtimeMs: 3000 };
      actions.cancelTask.mockResolvedValue({
        cancelled: true,
        status: 'running',
      });
      actions.getTasks.mockImplementation(async () => ({
        v: 1,
        sessionId: 'session-1',
        now: 4000,
        tasks: [stopped ? terminalTask : task],
      }));
      actions.getTaskRuntime.mockImplementation(async () =>
        result(stopped ? 'FINAL OUTPUT' : 'BEFORE STOP'),
      );
      render();
      await settle();
      const stop = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Stop',
      );
      await act(async () => stop!.click());
      expect(actions.cancelTask).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-status="running"]')).not.toBeNull();
      expect(stop!.disabled).toBe(true);
      expect(container.textContent).not.toContain('FINAL OUTPUT');
      // The restored panel's task prop can stay running; its owner read is authoritative.
      stopped = true;
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(
        container.querySelector(`[data-status="${status}"]`),
      ).not.toBeNull();
      expect(container.textContent).toContain('FINAL OUTPUT');
      expect(actions.getTasks).toHaveBeenCalledWith({ silent: true });
      expect(stop!.isConnected).toBe(false);
      const reads = actions.getTaskRuntime.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(30000);
      });
      expect(actions.getTaskRuntime).toHaveBeenCalledTimes(reads);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries a failed stopping-status read without losing the final output', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    actions.cancelTask.mockResolvedValue({
      cancelled: true,
      status: 'running',
    });
    actions.getTasks
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        tasks: [{ ...task, status: 'cancelled', endTime: 4000 }],
      });
    actions.getTaskRuntime
      .mockResolvedValueOnce(result('BEFORE STOP'))
      .mockResolvedValueOnce(result('BEFORE STOP'))
      .mockResolvedValue(result('FINAL OUTPUT'));
    render();
    await settle();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Stop')!
        .click(),
    );
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(actions.getTasks).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-status="cancelled"]')).not.toBeNull();
    expect(container.textContent).toContain('FINAL OUTPUT');
    warn.mockRestore();
  });

  it('ignores a stale stopping-status read after an authoritative completion', async () => {
    let finish!: (value: { tasks: DaemonSessionShellTaskStatus[] }) => void;
    actions.cancelTask.mockResolvedValue({
      cancelled: true,
      status: 'running',
    });
    actions.getTasks.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    actions.getTaskRuntime
      .mockResolvedValueOnce(result('BEFORE STOP'))
      .mockResolvedValue(result('FINAL OUTPUT'));
    render();
    await settle();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Stop')!
        .click(),
    );
    render({ ...task, status: 'completed', endTime: 4000 });
    await settle();
    await act(async () =>
      finish({ tasks: [{ ...task, status: 'cancelled', endTime: 3999 }] }),
    );
    expect(container.querySelector('[data-status="completed"]')).not.toBeNull();
    expect(container.textContent).toContain('FINAL OUTPUT');
  });

  it('loads a completed task through StrictMode replay', async () => {
    actions.getTaskRuntime.mockResolvedValue(result('STRICT OUTPUT'));
    render({ ...task, status: 'completed' }, true);
    await settle();
    expect(container.textContent).toContain('STRICT OUTPUT');
  });

  it('retries a failed terminal read and shows the recovered output', async () => {
    actions.getTaskRuntime
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(result('RECOVERED OUTPUT'));
    render({ ...task, status: 'completed' });
    await settle();
    expect(container.textContent).toContain('Output unavailable');
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(actions.getTaskRuntime).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('RECOVERED OUTPUT');
    expect(container.textContent).not.toContain('Try again');
  });

  it('polls without overlapping reads and stops on unmount', async () => {
    vi.useFakeTimers();
    let finish!: (value: DaemonSessionTaskRuntimeStatus) => void;
    actions.getTaskRuntime
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue(result('NEW OUTPUT'));
    render();
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(actions.getTaskRuntime).toHaveBeenCalledTimes(1);
    await act(async () => finish(result('FIRST OUTPUT')));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain('NEW OUTPUT');
    act(() => root!.unmount());
    root = undefined;
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(actions.getTaskRuntime).toHaveBeenCalledTimes(2);
  });

  it('keeps output visible when metadata fails, with size, tail and memory hints', async () => {
    actions.getTaskRuntime.mockResolvedValue({
      ...result('AVAILABLE OUTPUT'),
      runtime: {
        outputTail: 'AVAILABLE OUTPUT',
        outputError: 'stat failed',
        outputTailTruncated: true,
        outputBytes: 2048,
        memoryBytes: 1048576,
      },
    });
    render();
    await settle();
    expect(container.textContent).toContain('AVAILABLE OUTPUT');
    expect(container.textContent).toContain('file details could not be read');
    expect(container.textContent).toContain('Showing the end only');
    expect(container.textContent).toContain('2.0 KB');
    expect(container.textContent).toContain('1.0 MB');
    render({ ...task, status: 'completed' });
    await settle();
    expect(container.textContent).not.toContain('Resident memory');
  });

  it.each([
    { runtime: {}, status: 'running', text: 'No output yet' },
    { runtime: {}, status: 'completed', text: 'No output' },
    {
      runtime: null,
      status: 'completed',
      text: 'Task details are no longer available',
    },
    {
      runtime: { outputError: 'denied' },
      status: 'completed',
      text: 'Output unavailable',
    },
  ] as const)(
    'distinguishes $status / $text',
    async ({ runtime, status, text }) => {
      actions.getTaskRuntime.mockResolvedValue({ ...result(''), runtime });
      render({ ...task, status });
      await settle();
      expect(container.textContent).toContain(text);
      if (status === 'completed')
        expect(container.textContent).not.toContain('No output yet');
    },
  );

  it('uses the selected UI language for clock timestamps', async () => {
    const clock = vi
      .spyOn(Date.prototype, 'toLocaleTimeString')
      .mockReturnValue('CLOCK');
    actions.getTaskRuntime.mockResolvedValue(result(''));
    render({ ...task, startTime: Date.now() }, false, 'zh-CN');
    await settle();
    expect(clock).toHaveBeenCalledWith('zh-CN');
    expect(container.textContent).toContain('CLOCK');
    clock.mockRestore();
  });

  it('copies the full command and cleans up copy feedback on unmount', async () => {
    vi.useFakeTimers();
    actions.getTaskRuntime.mockResolvedValue(result(''));
    render({ ...task, status: 'completed' });
    await settle();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Copy Command"]')!
        .click(),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(task.command);
    expect(container.querySelector('svg.lucide-check')).not.toBeNull();
    act(() => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});
