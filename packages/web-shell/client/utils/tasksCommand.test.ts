import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionTasksStatus } from '@qwen-code/sdk/daemon';
import { formatTasksSnapshot, handleTasksSlashCommand } from './tasksCommand';

function makeSnapshot(
  tasks: DaemonSessionTasksStatus['tasks'],
): DaemonSessionTasksStatus {
  return {
    v: 1,
    sessionId: 's-1',
    now: 2_000,
    tasks,
  };
}

describe('formatTasksSnapshot', () => {
  it('renders an empty task snapshot', () => {
    expect(formatTasksSnapshot(makeSnapshot([]))).toBe('No background tasks.');
  });

  it('renders task status without unsafe control characters', () => {
    const text = formatTasksSnapshot(
      makeSnapshot([
        {
          kind: 'shell',
          id: 'sh-1',
          label: 'npm test\u001b[31m',
          description: 'npm test',
          status: 'running',
          startTime: 1_000,
          runtimeMs: 1_000,
          outputFile: '/tmp/out.log',
          command: 'npm test',
          cwd: '/work',
          pid: 123,
        },
      ]),
    );

    expect(text).toContain('Background tasks (1 total)');
    expect(text).toContain('[sh-1] running  1s pid=123  npm test[31m');
    expect(text).toContain('output: /tmp/out.log');
    expect(text).not.toContain('\u001b');
  });

  it('can include the CLI interactive dialog hint', () => {
    const text = formatTasksSnapshot(
      makeSnapshot([
        {
          kind: 'shell',
          id: 'sh-1',
          label: 'npm test',
          description: 'npm test',
          status: 'running',
          startTime: 1_000,
          runtimeMs: 1_000,
          command: 'npm test',
          cwd: '/work',
        },
      ]),
      { interactiveHint: true },
    );

    expect(text).toContain('use ↓ from an empty composer');
    expect(text).toContain('Background tasks (1 total)');
  });

  it('uses localized labels when provided', () => {
    const text = formatTasksSnapshot(
      makeSnapshot([
        {
          kind: 'shell',
          id: 'sh-1',
          label: 'npm test',
          description: 'npm test',
          status: 'running',
          startTime: 1_000,
          runtimeMs: 1_000,
          command: 'npm test',
          cwd: '/work',
        },
      ]),
      {
        interactiveHint: true,
        labels: {
          empty: '当前没有运行中的任务',
          title: '后台任务',
          count: (count) => `共 ${count} 个`,
          defaultHint: '使用空输入框的 ↓ 查看详情',
        },
      },
    );

    expect(text).toContain('使用空输入框的 ↓ 查看详情');
    expect(text).toContain('后台任务 (共 1 个)');
  });
});

describe('handleTasksSlashCommand', () => {
  it('loads tasks locally without forwarding or enqueueing', async () => {
    const snapshot = makeSnapshot([]);
    const getTasks = vi.fn().mockResolvedValue(snapshot);
    const dispatch = vi.fn();
    const reportError = vi.fn();
    const sendPrompt = vi.fn();
    const enqueue = vi.fn();

    const handled = handleTasksSlashCommand({
      cmd: 'tasks',
      promptBlocked: true,
      getTasks,
      dispatch,
      reportError,
    });

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith([
      { type: 'status', text: 'No background tasks.' },
    ]);
    expect(reportError).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not claim non-tasks commands', () => {
    const handled = handleTasksSlashCommand({
      cmd: 'help',
      promptBlocked: true,
      getTasks: vi.fn(),
      dispatch: vi.fn(),
      reportError: vi.fn(),
    });

    expect(handled).toBe(false);
  });
});
