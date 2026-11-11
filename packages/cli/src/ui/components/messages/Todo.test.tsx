/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../../test-utils/render.js';
import { describe, it, expect, vi } from 'vitest';
import { Box } from 'ink';
import { act } from 'react';
import { TodoTray } from './Todo.js';
import {
  CoreToolCallStatus,
  runLogger,
  type Config,
  type TaskListItem,
  type Todo,
} from '@qwen-code/core';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import { type HistoryItem } from '../../types.js';

const createTodoHistoryItem = (todos: Todo[]): HistoryItem =>
  ({
    type: 'tool_group',
    id: '1',
    tools: [
      {
        name: 'TodoWrite',
        callId: 'tool-1',
        status: CoreToolCallStatus.Success,
        resultDisplay: {
          todos,
        },
      },
    ],
  }) as unknown as HistoryItem;

describe.each([true, false])(
  '<TodoTray /> (showFullTodos: %s)',
  async (showFullTodos: boolean) => {
    const renderWithUiState = async (uiState: Partial<UIState>) => {
      const result = await render(
        <UIStateContext.Provider value={uiState as UIState}>
          <TodoTray />
        </UIStateContext.Provider>,
      );
      return result;
    };

    it('renders null when no todos are in the history', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders null when todo list is empty', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [createTodoHistoryItem([])],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders when todos exist but none are in progress', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Pending Task', status: 'pending' },
            { description: 'In Progress Task', status: 'cancelled' },
            { description: 'Completed Task', status: 'completed' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders when todos exist and one is in progress', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Pending Task', status: 'pending' },
            { description: 'Task 2', status: 'in_progress' },
            { description: 'In Progress Task', status: 'cancelled' },
            { description: 'Completed Task', status: 'completed' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders a todo list with long descriptions that wrap when full view is on', async () => {
      const { lastFrame, unmount } = await render(
        <Box width="50">
          <UIStateContext.Provider
            value={
              {
                history: [
                  createTodoHistoryItem([
                    {
                      description:
                        'This is a very long description for a pending task that should wrap around multiple lines when the terminal width is constrained.',
                      status: 'in_progress',
                    },
                    {
                      description:
                        'Another completed task with an equally verbose description to test wrapping behavior.',
                      status: 'completed',
                    },
                  ]),
                ],
                showFullTodos,
              } as UIState
            }
          >
            <TodoTray />
          </UIStateContext.Provider>
        </Box>,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders the most recent todo list when multiple write_todos calls are in history', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Older Task 1', status: 'completed' },
            { description: 'Older Task 2', status: 'pending' },
          ]),
          createTodoHistoryItem([
            { description: 'Newer Task 1', status: 'pending' },
            { description: 'Newer Task 2', status: 'in_progress' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders full list when all todos are inactive', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Task 1', status: 'completed' },
            { description: 'Task 2', status: 'cancelled' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });
  },
);

describe('<TodoTray /> persistent tasks', () => {
  it('coalesces concurrent refreshes and does not render stale task state', async () => {
    let resolveFirstRefresh: ((tasks: TaskListItem[]) => void) | undefined;
    const firstRefresh = new Promise<TaskListItem[]>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    let notifyLocalChange: (() => void) | undefined;
    const store = {
      listTasks: vi
        .fn()
        .mockReturnValueOnce(firstRefresh)
        .mockResolvedValue([
          {
            id: '1',
            subject: 'Current task state',
            description: '',
            status: 'in_progress',
            blocks: [],
            blockedBy: [],
          },
        ]),
      onDidChange: vi.fn((listener: () => void) => {
        notifyLocalChange = listener;
        return () => {};
      }),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    const rendered = await render(
      <UIStateContext.Provider
        value={
          {
            history: [],
            showFullTodos: true,
          } as unknown as UIState
        }
      >
        <TodoTray config={config} />
      </UIStateContext.Provider>,
    );

    notifyLocalChange?.();
    notifyLocalChange?.();
    expect(store.listTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRefresh?.([
        {
          id: '1',
          subject: 'Stale task state',
          description: '',
          status: 'pending',
          blocks: [],
          blockedBy: [],
        },
      ]);
      await firstRefresh;
    });
    await rendered.waitUntilReady();

    expect(store.listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(rendered.lastFrame()).toContain('Current task state');
    expect(rendered.lastFrame()).not.toContain('Stale task state');
    rendered.unmount();
  });

  it('keeps multiple running tasks compact until the user expands the panel', async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        {
          id: '1',
          subject: 'Build strings',
          description: '',
          activeForm: 'Building strings',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        },
        {
          id: '2',
          subject: 'Build arrays',
          description: '',
          activeForm: 'Building arrays',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        },
        {
          id: '3',
          subject: 'Build math',
          description: '',
          activeForm: 'Building math',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
        },
      ]),
      onDidChange: vi.fn().mockReturnValue(() => {}),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    const { lastFrame, unmount, waitUntilReady } = await render(
      <UIStateContext.Provider
        value={
          {
            history: [],
            showFullTodos: false,
          } as unknown as UIState
        }
      >
        <TodoTray config={config} />
      </UIStateContext.Provider>,
    );
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).toContain('Tasks');
    expect(frame).toContain('0/3 completed');
    expect(frame).toContain('#1 Building strings');
    expect(frame).not.toContain('#2 Building arrays');
    expect(frame).not.toContain('#3 Building math');
    unmount();
  });

  it('renders persisted task fields independently of transcript history', async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        {
          id: '3',
          subject: 'Build report',
          description: '',
          activeForm: 'Building report',
          owner: 'worker-1',
          status: 'in_progress',
          blocks: [],
          blockedBy: ['2'],
        },
      ]),
      onDidChange: vi.fn().mockReturnValue(() => {}),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;
    const { lastFrame, unmount, waitUntilReady } = await render(
      <UIStateContext.Provider
        value={
          {
            history: [],
            showFullTodos: true,
          } as unknown as UIState
        }
      >
        <TodoTray config={config} />
      </UIStateContext.Provider>,
    );
    await waitUntilReady();

    expect(lastFrame()).toContain('Tasks');
    expect(lastFrame()).toContain(
      '#3 Building report · worker-1 · blocked by #2',
    );
    unmount();
  });

  it('refreshes after clearing completed tasks without continuous polling', async () => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...callArgs: Parameters<typeof setTimeout>) => {
        const [handler, timeout, ...args] = callArgs;
        return nativeSetTimeout(
          handler,
          timeout === 5_000 ? 50 : timeout,
          ...args,
        );
      });
    let persistedTasks: TaskListItem[] = [
      {
        id: '1',
        subject: 'Finished work',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      },
    ];
    const store = {
      listTasks: vi.fn(async () => persistedTasks),
      onDidChange: vi.fn().mockReturnValue(() => {}),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(async () => {
        persistedTasks = [];
        return 1;
      }),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    let unmount: (() => void) | undefined;
    try {
      const rendered = await render(
        <UIStateContext.Provider
          value={
            {
              history: [],
              showFullTodos: true,
            } as unknown as UIState
          }
        >
          <TodoTray config={config} />
        </UIStateContext.Provider>,
      );
      unmount = rendered.unmount;
      await rendered.waitUntilReady();

      await act(async () => {
        await new Promise((resolve) => nativeSetTimeout(resolve, 80));
      });

      expect(store.listTasks).toHaveBeenCalledTimes(2);
      expect(store.clearCompletedTasks).toHaveBeenCalledTimes(1);
    } finally {
      unmount?.();
      timeoutSpy.mockRestore();
    }
  });

  it('schedules cleanup when a hidden task completes', async () => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...callArgs: Parameters<typeof setTimeout>) => {
        const [handler, timeout, ...args] = callArgs;
        return nativeSetTimeout(
          handler,
          timeout === 5_000 ? 50 : timeout,
          ...args,
        );
      });
    let notifyLocalChange: (() => void) | undefined;
    let persistedTasks: TaskListItem[] = [
      {
        id: '1',
        subject: 'Visible completed task',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      },
      {
        id: '2',
        subject: 'Hidden running task',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        metadata: { _internal: true },
      },
    ];
    const store = {
      listTasks: vi.fn(async () => persistedTasks),
      onDidChange: vi.fn((listener: () => void) => {
        notifyLocalChange = listener;
        return () => {};
      }),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(async () => {
        persistedTasks = [];
        return 2;
      }),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    let unmount: (() => void) | undefined;
    try {
      const rendered = await render(
        <UIStateContext.Provider
          value={
            {
              history: [],
              showFullTodos: true,
            } as unknown as UIState
          }
        >
          <TodoTray config={config} />
        </UIStateContext.Provider>,
      );
      unmount = rendered.unmount;
      await rendered.waitUntilReady();

      await act(async () => {
        await new Promise((resolve) => nativeSetTimeout(resolve, 80));
      });
      expect(store.clearCompletedTasks).not.toHaveBeenCalled();

      persistedTasks = [
        {
          id: '1',
          subject: 'Visible completed task',
          description: '',
          status: 'completed',
          blocks: [],
          blockedBy: [],
        },
        {
          id: '2',
          subject: 'Hidden running task',
          description: '',
          status: 'completed',
          blocks: [],
          blockedBy: [],
          metadata: { _internal: true },
        },
      ];

      await act(async () => {
        notifyLocalChange?.();
        await new Promise((resolve) => nativeSetTimeout(resolve, 130));
      });

      expect(store.clearCompletedTasks).toHaveBeenCalledTimes(1);
    } finally {
      unmount?.();
      timeoutSpy.mockRestore();
    }
  });

  it('deduplicates repeated background refresh errors', async () => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...callArgs: Parameters<typeof setTimeout>) => {
        const [handler, timeout, ...args] = callArgs;
        return nativeSetTimeout(
          handler,
          timeout === 50 ? 5 : timeout,
          ...args,
        );
      });
    const warningSpy = vi
      .spyOn(runLogger, 'warn')
      .mockImplementation(() => {});
    let notifyLocalChange: (() => void) | undefined;
    const store = {
      listTasks: vi.fn().mockRejectedValue(new Error('read denied')),
      onDidChange: vi.fn((listener: () => void) => {
        notifyLocalChange = listener;
        return () => {};
      }),
      watch: vi.fn().mockResolvedValue(() => {}),
      clearCompletedTasks: vi.fn(),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    let unmount: (() => void) | undefined;
    try {
      const rendered = await render(
        <UIStateContext.Provider
          value={
            {
              history: [],
              showFullTodos: true,
            } as unknown as UIState
          }
        >
          <TodoTray config={config} />
        </UIStateContext.Provider>,
      );
      unmount = rendered.unmount;
      await rendered.waitUntilReady();
      notifyLocalChange?.();
      await new Promise((resolve) => nativeSetTimeout(resolve, 20));
      notifyLocalChange?.();
      await new Promise((resolve) => nativeSetTimeout(resolve, 20));

      expect(store.listTasks).toHaveBeenCalledTimes(3);
      const refreshWarnings = warningSpy.mock.calls.filter(([message]) =>
        String(message).includes('[TaskTray] refresh failed:'),
      );
      expect(refreshWarnings).toHaveLength(1);
    } finally {
      unmount?.();
      warningSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('records watcher and cleanup failures at their background boundaries', async () => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...callArgs: Parameters<typeof setTimeout>) => {
        const [handler, timeout, ...args] = callArgs;
        return nativeSetTimeout(
          handler,
          timeout === 5_000 ? 50 : timeout,
          ...args,
        );
      });
    const warningSpy = vi
      .spyOn(runLogger, 'warn')
      .mockImplementation(() => {});
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        {
          id: '1',
          subject: 'Finished task',
          description: '',
          status: 'completed',
          blocks: [],
          blockedBy: [],
        },
      ]),
      onDidChange: vi.fn().mockReturnValue(() => {}),
      watch: vi.fn().mockRejectedValue(new Error('watch denied')),
      clearCompletedTasks: vi.fn().mockRejectedValue(new Error('lock denied')),
    };
    const config = {
      isTasksEnabled: () => true,
      getTaskStore: () => store,
    } as unknown as Config;

    let unmount: (() => void) | undefined;
    try {
      const rendered = await render(
        <UIStateContext.Provider
          value={
            {
              history: [],
              showFullTodos: true,
            } as unknown as UIState
          }
        >
          <TodoTray config={config} />
        </UIStateContext.Provider>,
      );
      unmount = rendered.unmount;
      await rendered.waitUntilReady();
      await new Promise((resolve) => nativeSetTimeout(resolve, 80));

      const taskTrayWarnings = warningSpy.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith('[TaskTray]'));
      expect(taskTrayWarnings).toContain(
        '[TaskTray] watch failed: Error: watch denied',
      );
      expect(taskTrayWarnings).toContain(
        '[TaskTray] cleanup failed: Error: lock denied',
      );
    } finally {
      unmount?.();
      warningSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });
});
