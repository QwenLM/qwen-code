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

// jsdom lacks PointerEvent and pointer capture; radix Select needs both to
// open from a pointerdown (mirrors the sidebar and overview panel tests).
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

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
    expect(rows[0]?.textContent).toContain('10 binding scans');
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
});
