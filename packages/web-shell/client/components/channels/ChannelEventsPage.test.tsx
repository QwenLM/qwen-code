/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { eventsState, eventsMock, useChannelsMock, workspaceState } = vi.hoisted(
  () => ({
    eventsState: {
      current: {
        data: undefined as
          | { events: Array<Record<string, unknown>>; truncated: boolean }
          | undefined,
        loading: false,
        error: undefined as Error | undefined,
        reload: vi.fn(),
      },
    },
    eventsMock: vi.fn(),
    useChannelsMock: vi.fn(),
    workspaceState: {
      current: {
        workspaceCwd: '/workspace/demo',
        capabilities: {
          features: ['channel_management'] as string[],
        },
      },
    },
  }),
);

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useChannelEvents: (options: unknown) => {
    eventsMock(options);
    return eventsState.current;
  },
  useChannels: (options: unknown) => {
    useChannelsMock(options);
    return { channels: { bot: {}, 'ci-reporter': {} } };
  },
  useWorkspace: () => workspaceState.current,
}));

const { ChannelEventsPage } = await import('./ChannelEventsPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  eventsState.current = {
    data: undefined,
    loading: false,
    error: undefined,
    reload: vi.fn(),
  };
  eventsMock.mockClear();
  useChannelsMock.mockClear();
  workspaceState.current.capabilities.features = ['channel_management'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ChannelEventsPage onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`No button labelled ${label}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ChannelEventsPage', () => {
  it('renders a row per event with its target and reason', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'inbound',
          outcome: 'skipped',
          reason: 'reason_filter',
          repository: 'owner/repo',
          number: 42,
          actor: 'alice',
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'ci-reporter',
          type: 'poll',
          outcome: 'ok',
          durationMs: 12,
          detail: { notifications: 3 },
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('ci-reporter');
    expect(rows[0]?.textContent).toContain('Poll');
    expect(rows[0]?.textContent).toContain('OK');
    expect(rows[0]?.textContent).toContain('3 notifications');
    expect(rows[0]?.textContent).toContain('12 ms');
    expect(rows[1]?.textContent).toContain('Skipped');
    expect(rows[1]?.textContent).toContain('owner/repo#42');
    expect(rows[1]?.textContent).toContain('@alice');
    expect(rows[1]?.textContent).toContain('reason_filter');
  });

  it('refetches with the selected event type', async () => {
    await renderPage();
    eventsMock.mockClear();

    await click('Outbound');

    expect(eventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ types: ['outbound'] }),
    );
  });

  it('shows the empty state before any event exists', async () => {
    eventsState.current.data = { truncated: false, events: [] };
    await renderPage();
    expect(container.textContent).toContain('No events yet');
  });

  it('shows the error detail when the journal cannot be read', async () => {
    eventsState.current.error = new Error('journal unavailable');
    await renderPage();
    expect(container.textContent).toContain('Could not load Channel events');
    expect(container.textContent).toContain('journal unavailable');
  });

  it('explains that the workspace has no Channel management', async () => {
    workspaceState.current.capabilities.features = [];
    await renderPage();
    expect(container.textContent).toContain(
      'Channel events need Channel management in this workspace.',
    );
    expect(eventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});
