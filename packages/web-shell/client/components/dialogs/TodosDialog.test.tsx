/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { TodosDialog } from './TodosDialog';

// This package has no RTL auto-cleanup (vitest.config.ts sets no globals,
// client/test/setup.ts registers no afterEach), so renders accumulate in
// document.body without this — the second test's getByTestId finds multiple
// boards and the third fails on "Found multiple elements" [R5-1].
afterEach(() => {
  cleanup();
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => ({
    listTodos: vi.fn().mockResolvedValue({
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
                },
              ],
            },
          ],
        },
      ],
    }),
    updateTodo: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../config/daemon', () => ({
  getDaemonToken: () => undefined,
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
});
