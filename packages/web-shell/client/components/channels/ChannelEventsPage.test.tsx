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

const { ChannelEventsPage, KNOWN_OUTCOMES } = await import(
  './ChannelEventsPage'
);
const { CHANNEL_EVENTS_MESSAGES_EN, CHANNEL_EVENTS_MESSAGES_ZH } = await import(
  './channel-events-messages'
);
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

async function renderPage(language: 'en' | 'zh-CN' = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
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
    // Absence coverage for the new counters. The catalogs format a missing
    // count as zero, so dropping a `typeof … === 'number'` guard would not
    // leave a blank — it would print a confident wrong number on every poll
    // row, including this healthy one.
    expect(rows[0]?.textContent).not.toContain('0 binding scans');
    expect(rows[0]?.textContent).not.toContain('binding scan');
    expect(rows[0]?.textContent).not.toContain('sessions listed');
    expect(rows[1]?.textContent).not.toContain('session ');
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

  it('opens the associated session in the workspace the event names', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'task',
          outcome: 'running',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
          sessionId: 'session-bound',
          sessionWorkspaceCwd: '/work/other',
        },
      ],
    };
    await renderPage();

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open session"]',
    );
    expect(button).toBeTruthy();
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener('qwen:open-session', listener);
    try {
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } finally {
      window.removeEventListener('qwen:open-session', listener);
    }
    expect(detail).toEqual({
      sessionId: 'session-bound',
      workspaceCwd: '/work/other',
    });
  });

  it('falls back to the selected workspace for records without an owner', async () => {
    // Outbound rows written before sessionWorkspaceCwd existed carry only
    // the sessionId; the reply session lives in the journal's workspace.
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'gh-bot',
          type: 'outbound',
          outcome: 'posted',
          repository: 'owner/repo',
          thread: 'pr:42',
          number: 42,
          sessionId: 'session-reply',
        },
      ],
    };
    await renderPage();

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open session"]',
    );
    expect(button).toBeTruthy();
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener('qwen:open-session', listener);
    try {
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } finally {
      window.removeEventListener('qwen:open-session', listener);
    }
    expect(detail).toEqual({
      sessionId: 'session-reply',
      workspaceCwd: '/workspace/demo',
    });
  });

  it('does not offer a session jump for events without a session', async () => {
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

    expect(
      container.querySelector('button[aria-label="Open session"]'),
    ).toBeNull();
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

  it('labels an ambiguous publication failure instead of showing the token', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'outbound',
          outcome: 'failed_ambiguous',
          repository: 'owner/repo',
          number: 42,
          error: '502 Bad Gateway',
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Failed (may have posted)');
    expect(rows[0]?.textContent).not.toContain('failed_ambiguous');
    expect(rows[0]?.textContent).toContain('502 Bad Gateway');
  });

  it('labels the ambiguous failure in Chinese too', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'outbound',
          outcome: 'failed_ambiguous',
        },
      ],
    };

    await renderPage('zh-CN');

    expect(container.textContent).toContain('失败（可能已发表）');
    expect(container.textContent).not.toContain('failed_ambiguous');
  });

  it('labels the private delivery and degraded scan outcomes', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'task',
          outcome: 'delivered',
          repository: 'owner/repo',
          number: 42,
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'bot',
          type: 'task',
          outcome: 'retired',
          reason: 'dead_letter',
        },
        {
          at: '2026-11-02T02:02:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'bindings_unreachable',
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(3);
    // Newest first, like every other row on the page.
    expect(rows[0]?.textContent).toContain('Degraded');
    expect(rows[0]?.textContent).toContain('bindings_unreachable');
    expect(rows[1]?.textContent).toContain('Retired');
    expect(rows[1]?.textContent).toContain('dead_letter');
    expect(rows[2]?.textContent).toContain('Delivered');
  });

  it('labels the watch-guard recovery edge as recovered, not degraded', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'watch_reconcile_recovered',
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    // The wire outcome stays `degraded`; the recovery reason names the label,
    // so the row cannot read as an ongoing failure.
    expect(rows[0]?.textContent).toContain('Recovered');
    expect(rows[0]?.textContent).not.toContain('Degraded');
    expect(rows[0]?.textContent).toContain('watch_reconcile_recovered');
  });

  it('shows which session a private delivery reached', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'task',
          outcome: 'delivered',
          repository: 'owner/repo',
          number: 42,
          sessionId: '3f2b8c1e-9d4a-4b7e-8c1f-2a5d9e0b7c31',
        },
      ],
    };

    await renderPage();

    const chip = container.querySelector('li code[title]');
    expect(chip).not.toBeNull();
    // Truncated for the row, full identity on hover: a UUID would otherwise
    // push the reason and the counters out of the column.
    expect(chip?.textContent).toBe('session 3f2b8c1e');
    expect(chip?.getAttribute('title')).toBe(
      '3f2b8c1e-9d4a-4b7e-8c1f-2a5d9e0b7c31',
    );
  });

  it('shows the degraded binding scan counters', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'bindings_partial',
          detail: { streak: 10, sessions: 1 },
        },
      ],
    };

    await renderPage();

    const rows = container.querySelectorAll('li');
    expect(rows[0]?.textContent).toContain('bindings_partial');
    expect(rows[0]?.textContent).toContain('10 consecutive binding scans');
    expect(rows[0]?.textContent).toContain('1 session listed');
  });

  it('has an English and a Chinese label for every known outcome', async () => {
    // The translator falls back to English and then to the key, so a missing
    // Chinese label renders English rather than failing loudly. Check the
    // catalogs directly.
    expect(KNOWN_OUTCOMES.size).toBeGreaterThan(0);
    const enKeys = Object.keys(CHANNEL_EVENTS_MESSAGES_EN);
    const zhKeys = Object.keys(CHANNEL_EVENTS_MESSAGES_ZH);
    for (const outcome of KNOWN_OUTCOMES) {
      const key = `channelEvents.outcome.${outcome}`;
      expect(enKeys).toContain(key);
      expect(zhKeys).toContain(key);
    }
    expect(enKeys.sort()).toEqual(zhKeys.sort());
  });

  it('keeps the interpolating labels as functions in both catalogs', async () => {
    // The translator ignores vars for a plain string, so turning one of these
    // into a string — or keeping the arrow but dropping the interpolation —
    // renders a bare "列出" / "连续 次绑定扫描" / "会话 " on every row. A key
    // comparison cannot see that; the shape can.
    const interpolating = [
      'channelEvents.session',
      'channelEvents.streak',
      'channelEvents.sessions',
      'channelEvents.notifications',
      'channelEvents.moreFiltered',
      'channelEvents.duration',
      'channelEvents.openTarget',
    ];
    // Collected rather than asserted per key so the failure names the offenders.
    const notFunctions = interpolating.filter(
      (key) =>
        typeof CHANNEL_EVENTS_MESSAGES_EN[key] !== 'function' ||
        typeof CHANNEL_EVENTS_MESSAGES_ZH[key] !== 'function',
    );
    expect(notFunctions).toEqual([]);
  });

  it('renders the Chinese counters and session chip with their values', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'task',
          outcome: 'delivered',
          repository: 'owner/repo',
          number: 42,
          sessionId: '3f2b8c1e-9d4a-4b7e-8c1f-2a5d9e0b7c31',
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'bindings_partial',
          detail: { streak: 10, sessions: 1 },
        },
      ],
    };

    await renderPage('zh-CN');

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    // Newest first: the degraded poll, then the delivery.
    expect(rows[0]?.textContent).toContain('连续 10 次绑定扫描');
    expect(rows[0]?.textContent).toContain('列出 1 个会话');
    expect(rows[1]?.textContent).toContain('已投递');
    expect(rows[1]?.textContent).toContain('会话 3f2b8c1e');
    // A dropped interpolation leaves the counter's frame with a hole in it.
    // The shape test alone would not catch that, and the render alone would
    // not catch a plain-string label until a row happens to carry the var.
    expect(rows[0]?.textContent).not.toContain('连续  次');
    expect(rows[0]?.textContent).not.toContain('列出  个');
  });

  it('renders the Chinese degraded, retired and recovered outcome labels', async () => {
    eventsState.current.data = {
      truncated: false,
      events: [
        {
          at: '2026-11-02T02:00:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'bindings_partial',
          detail: { streak: 10, sessions: 1 },
        },
        {
          at: '2026-11-02T02:01:00.000Z',
          channel: 'bot',
          type: 'task',
          outcome: 'retired',
          reason: 'dead_letter',
        },
        {
          at: '2026-11-02T02:02:00.000Z',
          channel: 'bot',
          type: 'poll',
          outcome: 'degraded',
          reason: 'watch_reconcile_recovered',
        },
      ],
    };

    await renderPage('zh-CN');

    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(3);
    // Newest first: recovered, retired, degraded. A translator round that set
    // any of these back to the English word would otherwise ship green — the
    // parity test only checks key presence, not the rendered value.
    expect(rows[0]?.textContent).toContain('已恢复');
    expect(rows[0]?.textContent).not.toContain('Recovered');
    expect(rows[1]?.textContent).toContain('已终止');
    expect(rows[1]?.textContent).not.toContain('Retired');
    expect(rows[2]?.textContent).toContain('降级');
    expect(rows[2]?.textContent).not.toContain('Degraded');
  });

  it('renders the Chinese open-target label with its repository and number', async () => {
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
      ],
    };

    await renderPage('zh-CN');

    // The shape guard catches a plain-string openTarget, but only a render
    // assertion catches a function that dropped its interpolation: every ZH
    // row would otherwise read "在 GitHub 上打开" with no target.
    const link = container.querySelector('li a[target="_blank"]');
    expect(link?.getAttribute('aria-label')).toBe(
      '在 GitHub 上打开 owner/repo#42',
    );
  });
});
