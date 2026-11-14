/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from '@testing-library/react';
import { TodosDialog } from './TodosDialog';
import { getDaemonToken } from '../../config/daemon';

// Hoisted so individual tests can override listTodos per render and
// assert on updateTodo calls — the module factory recreates the inner
// vi.fn()s on every render otherwise, leaving nothing to assert against.
const mockActions = vi.hoisted(() => ({
  listTodos: vi.fn(),
  updateTodo: vi.fn().mockResolvedValue(undefined),
}));

const defaultSnapshot = {
  v: 2,
  generatedAt: Date.now(),
  totals: {
    projects: 1,
    sessions: 1,
    open: 1,
    pending: 1,
    in_progress: 0,
    completed: 0,
  },
  groups: [
    {
      project: '/home/user/project-a',
      open: 1,
      done: 0,
      sessions: [
        {
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          cwd: '/home/user/project-a',
          mtimeMs: Date.now(),
          todos: [
            {
              id: '1',
              content: 'Write the deployment guide',
              status: 'pending',
              dueDate: null,
              tags: ['urgent'],
            },
          ],
        },
      ],
    },
  ],
  tagDefinitions: { urgent: { color: '#ff0000' } },
};

// This package has no RTL auto-cleanup (vitest.config.ts sets no globals,
// client/test/setup.ts registers no afterEach), so renders accumulate in
// document.body without this — the second test's getByTestId finds multiple
// boards and the third fails on "Found multiple elements" [R5-1].
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mockActions.listTodos.mockResolvedValue(defaultSnapshot);
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => mockActions,
}));

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../config/daemon', () => ({
  getDaemonToken: vi.fn(),
}));

vi.mock('../../utils/sessionPath', () => ({
  buildSessionPathname: (pathname: string, sessionId: string) =>
    `/session/${sessionId}`,
}));

describe('TodosDialog', () => {
  it('renders the board with project groups, todo cards, and kanban columns', async () => {
    render(<TodosDialog />);
    // Wait for the async data load to settle, then assert everything in one
    // pass — the columns are siblings of the card content in the same board.
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    expect(screen.getByText('/home/user/project-a')).toBeDefined();
    expect(screen.getByTestId('todos-column-pending')).toBeDefined();
    expect(screen.getByTestId('todos-column-in_progress')).toBeDefined();
    expect(screen.getByTestId('todos-column-completed')).toBeDefined();
  });

  it('shows view-conversation buttons on each card', async () => {
    render(<TodosDialog />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    const buttons = screen.getAllByTitle('todos.viewConversation');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('ignores transient empty changes from the due-date editor', async () => {
    render(<TodosDialog />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    // Open the inline due-date editor.
    fireEvent.click(screen.getAllByTitle('todos.setDueDate')[0]);
    const input = containerQueryDateInput();
    expect(input).not.toBeNull();
    // A native date input fires change with '' for every partial value
    // (segment edits, backspace) — committing it as null would DELETE the
    // stored date. The editor must ignore it and stay open.
    fireEvent.change(input as HTMLInputElement, { target: { value: '' } });
    expect(containerQueryDateInput()).not.toBeNull();
  });

  function containerQueryDateInput(): HTMLInputElement | null {
    return document.querySelector('input[type="date"]');
  }

  it('passes the daemon token in the URL hash, never the query string', async () => {
    vi.mocked(getDaemonToken).mockReturnValue('sekrit');
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    render(<TodosDialog />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    fireEvent.click(screen.getAllByTitle('todos.viewConversation')[0]);
    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = new URL(openSpy.mock.calls[0][0] as string);
    // A query token would hit the server (and proxy/ingress request-URI
    // logs) on the document GET; the hash never leaves the browser.
    expect(url.searchParams.get('token')).toBeNull();
    expect(new URLSearchParams(url.hash.slice(1)).get('token')).toBe('sekrit');
    vi.unstubAllGlobals();
    vi.mocked(getDaemonToken).mockReset();
  });

  it('commits the due date on blur, never an intermediate segment value', async () => {
    render(<TodosDialog />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    fireEvent.click(screen.getAllByTitle('todos.setDueDate')[0]);
    const input = document.querySelector('input[type="date"]');
    expect(input).not.toBeNull();
    mockActions.updateTodo.mockClear();
    // Typing a year segment emits syntactically valid intermediates —
    // none of them may be committed.
    fireEvent.change(input as Element, { target: { value: '0002-11-15' } });
    fireEvent.change(input as Element, { target: { value: '2027-11-15' } });
    expect(mockActions.updateTodo).not.toHaveBeenCalled();
    fireEvent.blur(input as Element);
    expect(mockActions.updateTodo).toHaveBeenCalledTimes(1);
    expect(mockActions.updateTodo).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '1',
      { dueDate: '2027-11-15' },
    );
  });

  it('does not send a tagDefinition for an already-defined tag name', async () => {
    render(<TodosDialog />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    fireEvent.click(screen.getAllByTitle('todos.editTags')[0]);
    fireEvent.change(screen.getByPlaceholderText('todos.newTagName'), {
      target: { value: 'urgent' },
    });
    fireEvent.click(screen.getByText('todos.addTag'));
    expect(mockActions.updateTodo).toHaveBeenCalledTimes(1);
    // 'urgent' already exists with a colour — re-adding it must not carry
    // a definition that would repaint every card using the tag.
    expect(mockActions.updateTodo).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '1',
      expect.not.objectContaining({ tagDefinition: expect.anything() }),
    );
  });

  it('scopes the aggregate to the locked workspace when set', async () => {
    mockActions.listTodos.mockResolvedValue({
      ...defaultSnapshot,
      groups: [
        ...defaultSnapshot.groups,
        {
          project: '/home/user/project-b',
          open: 1,
          done: 0,
          sessions: [
            {
              sessionId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
              cwd: '/home/user/project-b',
              mtimeMs: Date.now(),
              todos: [
                {
                  id: '1',
                  content: 'Task from another workspace',
                  status: 'pending',
                  dueDate: null,
                  tags: [],
                },
              ],
            },
          ],
        },
      ],
    });
    render(<TodosDialog lockedWorkspaceCwd="/home/user/project-a" />);
    await waitFor(() => {
      expect(screen.getByText('Write the deployment guide')).toBeDefined();
    });
    // A host that locked the shell to project-a must not see project-b's
    // todos through the daemon-wide aggregate.
    expect(screen.queryByText('Task from another workspace')).toBeNull();
  });

  it('applies the newest load, dropping a stale response that resolves late', async () => {
    const snapshotWith = (content: string) => ({
      ...defaultSnapshot,
      groups: [
        {
          ...defaultSnapshot.groups[0],
          sessions: [
            {
              ...defaultSnapshot.groups[0].sessions[0],
              todos: [
                {
                  id: '1',
                  content,
                  status: 'pending',
                  dueDate: null,
                  tags: [],
                },
              ],
            },
          ],
        },
      ],
    });
    let resolveStale!: (value: unknown) => void;
    mockActions.listTodos
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
      )
      .mockResolvedValue(snapshotWith('Fresh from the second load'));
    render(<TodosDialog />);
    // A second load starts while the first is still pending.
    fireEvent.click(screen.getByTitle('todos.refresh'));
    await waitFor(() => {
      expect(screen.getByText('Fresh from the second load')).toBeDefined();
    });
    // The stale first response resolves AFTER the fresh one — it must be
    // dropped instead of reverting the newer snapshot.
    resolveStale(snapshotWith('Stale from the first load'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('Stale from the first load')).toBeNull();
    expect(screen.getByText('Fresh from the second load')).toBeDefined();
  });
});
