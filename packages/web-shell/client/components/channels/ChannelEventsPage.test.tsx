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

type TauriWindow = { __TAURI__?: { core?: { invoke?: unknown } } };

// jsdom lacks PointerEvent and pointer capture; radix Select needs both to
// open from a pointerdown (mirrors the sidebar and overview panel tests).
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

const {
  eventsState,
  eventsMock,
  useChannelsMock,
  channelsState,
  workspaceState,
} = vi.hoisted(() => ({
  eventsState: {
    current: {
      data: undefined as
        | {
            events: Array<Record<string, unknown>>;
            truncated: boolean;
            channelLinkMeta?: Record<
              string,
              { type?: string; baseUrl?: string }
            >;
          }
        | undefined,
      loading: false,
      error: undefined as Error | undefined,
      reload: vi.fn(),
    },
  },
  eventsMock: vi.fn(),
  useChannelsMock: vi.fn(),
  channelsState: {
    current: {} as Record<string, { config?: Record<string, unknown> }>,
  },
  workspaceState: {
    current: {
      workspaceCwd: '/workspace/demo',
      capabilities: {
        features: ['channel_management'] as string[],
        workspaces: undefined as
          | Array<{
              id: string;
              cwd: string;
              primary: boolean;
              trusted: boolean;
            }>
          | undefined,
      },
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useChannelEvents: (options: unknown) => {
    eventsMock(options);
    return eventsState.current;
  },
  useChannels: (options: unknown) => {
    useChannelsMock(options);
    return { channels: channelsState.current };
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
  channelsState.current = { bot: {}, 'ci-reporter': {} };
  workspaceState.current.capabilities.features = ['channel_management'];
  workspaceState.current.capabilities.workspaces = undefined;
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

// Radix Select opens on pointerdown and commits on click; a native click alone
// is not enough in jsdom (mirrors the overview panel's test helper).
function pointerClick(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  it('links GitHub PR and Issue targets to their web URL', async () => {
    channelsState.current = {
      'gh-bot': { config: { type: 'github' } },
    };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'gh-bot',
          type: 'outbound',
          outcome: 'posted',
          repository: 'owner/repo',
          thread: 'issue:7',
          number: 7,
        },
      ],
    };

    await renderPage();

    // Rows render newest first.
    const links = container.querySelectorAll<HTMLAnchorElement>(
      'a[href^="https://github.com/"]',
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe(
      'https://github.com/owner/repo/issues/7',
    );
    expect(links[1]?.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/42',
    );
    expect(links[1]?.textContent).toBe('owner/repo#42');
    expect(links[1]?.getAttribute('target')).toBe('_blank');
    expect(links[1]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1]?.getAttribute('aria-label')).toBe(
      'Open owner/repo#42 on GitHub',
    );
  });

  it('links GitHub Enterprise targets using the configured API root', async () => {
    channelsState.current = {
      'gh-bot': {
        config: { type: 'github', baseUrl: 'https://ghe.example.com/api/v3' },
      },
    };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };

    await renderPage();

    const link = container.querySelector<HTMLAnchorElement>('li a');
    expect(link?.getAttribute('href')).toBe(
      'https://ghe.example.com/owner/repo/pull/42',
    );
  });

  it('does not linkify a target whose configured base URL is not http(s)', async () => {
    channelsState.current = {
      'gh-bot': {
        config: { type: 'github', baseUrl: 'javascript:alert(1)' },
      },
    };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };

    await renderPage();

    expect(container.querySelectorAll('li a')).toHaveLength(0);
    expect(container.textContent).toContain('owner/repo#42');
  });

  it('keeps targets of non-GitHub or unknown channels as plain text', async () => {
    channelsState.current = {
      'ding-bot': { config: { type: 'dingtalk' } },
    };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'ding-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          number: 42,
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'removed-channel',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          number: 43,
        },
      ],
    };

    await renderPage();

    expect(container.querySelectorAll('li a')).toHaveLength(0);
    expect(container.textContent).toContain('owner/repo#42');
    expect(container.textContent).toContain('owner/repo#43');
  });

  it('links a user-scope channel missing from the listing via journal link metadata', async () => {
    // The documented GitHub setup: the channel lives in user settings, so
    // the scope-local management listing has no entry for it.
    channelsState.current = {};
    eventsState.current.data = {
      truncated: false,
      channelLinkMeta: {
        'my-github': {
          type: 'github',
          baseUrl: 'https://ghe.example.com/api/v3',
        },
      },
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'my-github',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };

    await renderPage();

    const link = container.querySelector<HTMLAnchorElement>('li a');
    expect(link?.getAttribute('href')).toBe(
      'https://ghe.example.com/owner/repo/pull/42',
    );
    expect(link?.textContent).toBe('owner/repo#42');
  });

  it('prefers journal metadata over the listing when system settings override', async () => {
    // mergeSettings applies system settings last, so the effective baseUrl
    // can differ from the scope-local listing; the merged metadata wins.
    channelsState.current = {
      'gh-bot': {
        config: { type: 'github', baseUrl: 'https://workspace.example/api/v3' },
      },
    };
    eventsState.current.data = {
      truncated: false,
      channelLinkMeta: {
        'gh-bot': { type: 'github', baseUrl: 'https://system.example/api/v3' },
      },
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };

    await renderPage();

    const link = container.querySelector<HTMLAnchorElement>('li a');
    expect(link?.getAttribute('href')).toBe(
      'https://system.example/owner/repo/pull/42',
    );
  });

  it('falls back to the listing when the daemon sends no journal metadata', async () => {
    channelsState.current = {
      'gh-bot': {
        config: { type: 'github', baseUrl: 'https://ghe.local/api/v3' },
      },
    };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };

    await renderPage();

    const link = container.querySelector<HTMLAnchorElement>('li a');
    expect(link?.getAttribute('href')).toBe(
      'https://ghe.local/owner/repo/pull/42',
    );
  });

  it('shows the thread-derived number on rows journaled without one', async () => {
    // ChannelBase.processPreflightedInbound writes thread but no number.
    channelsState.current = { 'gh-bot': { config: { type: 'github' } } };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          actor: 'alice',
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:43',
          actor: 'bob',
        },
      ],
    };

    await renderPage();

    const links = container.querySelectorAll<HTMLAnchorElement>('li a');
    expect(links).toHaveLength(2);
    expect(links[0]?.textContent).toBe('owner/repo#43');
    expect(links[0]?.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/43',
    );
    expect(links[0]?.getAttribute('aria-label')).toBe(
      'Open owner/repo#43 on GitHub',
    );
    expect(links[1]?.textContent).toBe('owner/repo#42');
    expect(links[1]?.getAttribute('href')).toBe(
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('does not linkify journal link metadata of a non-GitHub channel', async () => {
    channelsState.current = {};
    eventsState.current.data = {
      truncated: false,
      channelLinkMeta: { 'ding-bot': { type: 'dingtalk' } },
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'ding-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          number: 42,
        },
      ],
    };

    await renderPage();

    expect(container.querySelectorAll('li a')).toHaveLength(0);
    expect(container.textContent).toContain('owner/repo#42');
  });

  it('opens the target through the desktop opener when clicked in the desktop shell', async () => {
    channelsState.current = { 'gh-bot': { config: { type: 'github' } } };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    try {
      await renderPage();
      const link = container.querySelector<HTMLAnchorElement>('li a');
      expect(link).toBeTruthy();
      let event: MouseEvent | undefined;
      await act(async () => {
        event = new MouseEvent('click', { bubbles: true, cancelable: true });
        link?.dispatchEvent(event);
      });
      expect(event?.defaultPrevented).toBe(true);
      expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
        url: 'https://github.com/owner/repo/pull/42',
      });
    } finally {
      delete (window as TauriWindow).__TAURI__;
    }
  });

  it('keeps the target a native link in plain browsers', async () => {
    channelsState.current = { 'gh-bot': { config: { type: 'github' } } };
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'inbound',
          outcome: 'accepted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
        },
      ],
    };
    await renderPage();
    const link = container.querySelector<HTMLAnchorElement>('li a');
    expect(link?.href).toBe('https://github.com/owner/repo/pull/42');
    expect(link?.target).toBe('_blank');
    let event: MouseEvent | undefined;
    await act(async () => {
      event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
    });
    expect(event?.defaultPrevented).toBe(false);
  });

  it('shows how many further notifications a collapsed skip stands for', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'inbound',
          outcome: 'skipped',
          reason: 'reason_filter',
          detail: { filtered: 280 },
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('reason_filter');
    expect(rows[0]?.textContent).toContain('280 more filtered this poll');
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

  it('reads the selected workspace, not only the primary one', async () => {
    workspaceState.current.capabilities.workspaces = [
      { id: 'primary', cwd: '/work/alpha', primary: true, trusted: true },
      { id: 'secondary', cwd: '/work/beta', primary: false, trusted: true },
    ];
    await renderPage();

    expect(eventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/alpha' }),
    );

    const trigger = container.querySelector<HTMLElement>(
      'button[aria-label="Workspace"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      pointerClick(trigger!);
    });
    const option = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'beta');
    expect(option).toBeDefined();
    await act(async () => {
      pointerClick(option!);
    });

    expect(eventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/beta' }),
    );
    expect(useChannelsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/beta' }),
    );
  });
});
