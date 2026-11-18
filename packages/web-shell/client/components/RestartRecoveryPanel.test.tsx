// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonRestartRecoveryBatchResult } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { formatTimestamp } from './MessageTimestamp';
import { RestartRecoveryPanel } from './RestartRecoveryPanel';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

const client = {
  getRestartRecoveries: vi.fn(),
  continueRestartRecoveries: vi.fn(),
};

function recoveryResult(
  items: Array<{ sessionId: string; interruption: string }>,
): DaemonRestartRecoveryBatchResult {
  return {
    workspaces: [
      {
        workspace: '/ws',
        workspaceId: 'workspace-1',
        cwd: '/ws',
        v: 1,
        items: items.map((item) => ({
          sessionId: item.sessionId,
          lastActivityAt: '2026-11-17T09:12:31.000Z',
          interruption: item.interruption,
        })),
        truncated: false,
      },
    ],
  };
}

describe('RestartRecoveryPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    client.getRestartRecoveries.mockReset();
    client.continueRestartRecoveries.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    options: {
      available?: boolean;
      supported?: boolean;
      workspaceCwds?: string[];
      language?: 'en' | 'zh-CN';
    } = {},
  ) {
    const {
      available = true,
      supported = true,
      workspaceCwds = ['/ws'],
      language = 'en',
    } = options;
    act(() => {
      root.render(
        <I18nProvider language={language}>
          <RestartRecoveryPanel
            client={client}
            available={available}
            supported={supported}
            workspaceCwds={workspaceCwds}
            workspaceLabels={new Map([['/ws', 'workspace-one']])}
          />
        </I18nProvider>,
      );
    });
  }

  async function waitFor(check: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await Promise.resolve();
      });
      try {
        check();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === text,
    );
    expect(button, `button "${text}"`).toBeTruthy();
    return button as HTMLButtonElement;
  }

  it('lists interrupted tasks and continues one without opening the session', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([
        { sessionId: SESSION_A, interruption: 'daemon_shutdown' },
      ]),
    );
    client.continueRestartRecoveries.mockResolvedValue({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'accepted',
          kind: 'interrupted_prompt',
        },
      ],
    });

    render();
    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    expect(container.textContent).toContain('workspace-one');
    expect(container.textContent).toContain('11111111');
    expect(container.textContent).toContain('Daemon restarted');
    expect(container.textContent).toContain(
      formatTimestamp(Date.parse('2026-11-17T09:12:31.000Z')),
    );

    act(() => buttonByText('Continue').click());
    await waitFor(() =>
      expect(client.continueRestartRecoveries).toHaveBeenCalledWith({
        sessions: [{ workspace: '/ws', sessionId: SESSION_A }],
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="restart-recovery-panel"]'),
      ).toBeNull(),
    );
  });

  it('requires a second confirmation before continuing a tool turn', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([{ sessionId: SESSION_A, interruption: 'in_flight' }]),
    );
    client.continueRestartRecoveries.mockResolvedValueOnce({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'confirmation_required',
          kind: 'interrupted_turn',
          code: 'tool_turn',
        },
      ],
    });
    client.continueRestartRecoveries.mockResolvedValueOnce({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'accepted',
          kind: 'interrupted_turn',
        },
      ],
    });

    render();
    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    expect(container.textContent).toContain('Process interrupted');

    act(() => buttonByText('Continue').click());
    await waitFor(() =>
      expect(container.textContent).toContain(
        'This task stopped during a tool call.',
      ),
    );
    act(() => buttonByText('Confirm and continue').click());
    await waitFor(() =>
      expect(client.continueRestartRecoveries).toHaveBeenLastCalledWith({
        sessions: [{ workspace: '/ws', sessionId: SESSION_A }],
        confirmToolTurn: true,
      }),
    );
  });

  it('continues all eligible rows in one batch', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([
        { sessionId: SESSION_A, interruption: 'daemon_shutdown' },
        { sessionId: SESSION_B, interruption: 'in_flight' },
      ]),
    );
    client.continueRestartRecoveries.mockResolvedValue({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'accepted',
          kind: 'interrupted_prompt',
        },
        {
          workspace: '/ws',
          sessionId: SESSION_B,
          status: 'accepted',
          kind: 'interrupted_prompt',
        },
      ],
    });

    render();
    await waitFor(() =>
      expect(container.textContent).toContain(
        '2 tasks interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue all').click());

    await waitFor(() =>
      expect(client.continueRestartRecoveries).toHaveBeenCalledWith({
        sessions: [
          { workspace: '/ws', sessionId: SESSION_A },
          { workspace: '/ws', sessionId: SESSION_B },
        ],
      }),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="restart-recovery-panel"]'),
      ).toBeNull(),
    );
  });

  it('splits more than 20 workspaces into separate scan requests', async () => {
    client.getRestartRecoveries.mockResolvedValue({ workspaces: [] });
    render({
      workspaceCwds: Array.from({ length: 21 }, (_, index) => `/ws-${index}`),
    });

    await waitFor(() =>
      expect(client.getRestartRecoveries).toHaveBeenCalledTimes(2),
    );
    expect(
      client.getRestartRecoveries.mock.calls[0]![0].workspaces,
    ).toHaveLength(20);
    expect(
      client.getRestartRecoveries.mock.calls[1]![0].workspaces,
    ).toHaveLength(1);
  });

  it('keeps a workspace path containing a newline intact', async () => {
    client.getRestartRecoveries.mockResolvedValue({ workspaces: [] });
    render({ workspaceCwds: ['/ws\nline'] });

    await waitFor(() =>
      expect(client.getRestartRecoveries).toHaveBeenCalledWith({
        workspaces: ['/ws\nline'],
      }),
    );
  });

  it('shows a rejected continue request', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([
        { sessionId: SESSION_A, interruption: 'daemon_shutdown' },
      ]),
    );
    client.continueRestartRecoveries.mockRejectedValue(new Error('offline'));
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue').click());

    await waitFor(() =>
      expect(container.textContent).toContain('Could not continue'),
    );
  });

  it('shows a per-row continuation error', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([
        { sessionId: SESSION_A, interruption: 'daemon_shutdown' },
      ]),
    );
    client.continueRestartRecoveries.mockResolvedValue({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'error',
          code: 'workspace_runtime_unavailable',
        },
      ],
    });
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue').click());

    await waitFor(() =>
      expect(container.textContent).toContain('workspace_runtime_unavailable'),
    );
  });

  it('leaves cancellation confirmation in the conversation', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([{ sessionId: SESSION_A, interruption: 'in_flight' }]),
    );
    client.continueRestartRecoveries.mockResolvedValue({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'confirmation_required',
          code: 'cancellation_confirmation',
        },
      ],
    });
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue').click());

    await waitFor(() =>
      expect(container.textContent).toContain(
        'Open the conversation to confirm this cancellation.',
      ),
    );
    expect(buttonByText('Continue').disabled).toBe(true);
  });

  it('drops a session the daemon says is no longer continuable', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([{ sessionId: SESSION_A, interruption: 'in_flight' }]),
    );
    client.continueRestartRecoveries.mockResolvedValue({
      results: [
        {
          workspace: '/ws',
          sessionId: SESSION_A,
          status: 'not_continuable',
          kind: 'degraded_history',
        },
      ],
    });
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        '1 task interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue').click());

    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="restart-recovery-panel"]'),
      ).toBeNull(),
    );
  });

  it('falls back to a translated label for unknown interruption codes', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([{ sessionId: SESSION_A, interruption: 'daemon_lost' }]),
    );
    render({ language: 'zh-CN' });

    await waitFor(() =>
      expect(container.textContent).toContain('上次重启中断了 1 个任务'),
    );
    act(() => buttonByText('查看').click());
    await waitFor(() =>
      expect(container.textContent).toContain('已中断 (daemon_lost)'),
    );
  });

  it('splits continue-all into ten-session requests', async () => {
    const items = Array.from({ length: 11 }, (_, index) => ({
      sessionId: `session-${index}`,
      interruption: 'daemon_shutdown',
    }));
    client.getRestartRecoveries.mockResolvedValue(recoveryResult(items));
    client.continueRestartRecoveries.mockImplementation(
      async (request: {
        sessions: Array<{ workspace: string; sessionId: string }>;
      }) => ({
        results: request.sessions.map((session) => ({
          workspace: session.workspace,
          sessionId: session.sessionId,
          status: 'accepted' as const,
          kind: 'interrupted_prompt' as const,
        })),
      }),
    );
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        '11 tasks interrupted by a restart',
      ),
    );
    act(() => buttonByText('Review').click());
    act(() => buttonByText('Continue all').click());

    await waitFor(() =>
      expect(client.continueRestartRecoveries).toHaveBeenCalledTimes(2),
    );
    expect(
      client.continueRestartRecoveries.mock.calls[0]![0].sessions,
    ).toHaveLength(10);
    expect(
      client.continueRestartRecoveries.mock.calls[1]![0].sessions,
    ).toHaveLength(1);
  });

  it('lets the user dismiss a failed scan', async () => {
    client.getRestartRecoveries.mockRejectedValue(new Error('scan failed'));
    render();

    await waitFor(() =>
      expect(container.textContent).toContain(
        'Could not read interrupted tasks',
      ),
    );
    act(() => buttonByText('Hide').click());
    expect(
      container.querySelector('[data-testid="restart-recovery-panel"]'),
    ).toBeNull();
  });

  it('surfaces a failed workspace member instead of hiding it', async () => {
    client.getRestartRecoveries
      .mockResolvedValueOnce({
        workspaces: [
          {
            workspace: '/ws',
            workspaceId: 'workspace-1',
            cwd: '/ws',
            v: 1 as const,
            items: [],
            truncated: false,
          },
          {
            workspace: '/other',
            error: {
              code: 'workspace_runtime_unavailable',
              message: 'Workspace runtime is not active.',
              status: 503,
            },
          },
        ],
      })
      .mockResolvedValue({ workspaces: [] });
    render({ workspaceCwds: ['/ws', '/other'] });

    await waitFor(() =>
      expect(container.textContent).toContain('Could not scan: /other'),
    );
    act(() => buttonByText('Retry').click());
    await waitFor(() =>
      expect(client.getRestartRecoveries).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="restart-recovery-panel"]'),
      ).toBeNull(),
    );
  });

  it('does not request when the daemon lacks the capability', async () => {
    render({ supported: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getRestartRecoveries).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="restart-recovery-panel"]'),
    ).toBeNull();
  });

  it('does not request while the daemon is unavailable', async () => {
    render({ available: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getRestartRecoveries).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="restart-recovery-panel"]'),
    ).toBeNull();
  });

  it('localizes the banner', async () => {
    client.getRestartRecoveries.mockResolvedValue(
      recoveryResult([
        { sessionId: SESSION_A, interruption: 'daemon_shutdown' },
      ]),
    );

    render({ language: 'zh-CN' });
    await waitFor(() =>
      expect(container.textContent).toContain('上次重启中断了 1 个任务'),
    );
  });
});
