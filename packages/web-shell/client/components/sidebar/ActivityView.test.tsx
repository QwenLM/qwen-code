// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityView, type ActivityViewProps } from './ActivityView';
import { ACTIVITY_MESSAGES_EN } from './activity-messages';
import type { ActivityEntry } from './activity-model';
import { installSidebarDomShims } from '../../test/sidebarHarness';

vi.mock('../../i18n', () => ({
  useI18n: () => ({
    language: 'en',
    t: (key: string, vars?: Record<string, string | number>) => {
      const message = ACTIVITY_MESSAGES_EN[key];
      return typeof message === 'function' ? message(vars) : (message ?? key);
    },
  }),
}));

const stamp = '2026-10-31T12:00:00.000Z';
const makeEntry = (key: string): ActivityEntry => ({
  key,
  unread: true,
  session: {
    sessionId: key,
    workspaceCwd: '/project',
    displayName: `Chat ${key}`,
    updatedAt: stamp,
  },
});
let container: HTMLDivElement;
let root: Root;
let props: ActivityViewProps;
const openSession = vi.fn();
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent === text ||
      element.getAttribute('aria-label') === text,
  )!;
const click = async (text: string) => {
  await act(async () => {
    button(text).click();
  });
};
const menu = async () => {
  await act(async () => {
    button('Activity options').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
};
const menuClick = async (text: string) => {
  await menu();
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((element) => element.textContent === text)!;
  expect(item).toBeDefined();
  await act(async () => {
    item.click();
  });
};
const render = async () => {
  await act(async () => {
    root.render(<ActivityView {...props} />);
  });
};

beforeEach(() => {
  openSession.mockReset();
  installSidebarDomShims();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    entries: [makeEntry('a'), makeEntry('b')],
    loading: false,
    unavailable: false,
    hasMore: false,
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    renderSession: vi.fn((entry: ActivityEntry, preview?: string) => (
      <button
        type="button"
        data-shared-session
        onClick={() => openSession(entry)}
      >
        {entry.session.displayName}
        {preview && <span>{preview}</span>}
      </button>
    )),
    onMarkRead: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue({ succeeded: [], failed: 0 }),
    onUndo: vi.fn().mockResolvedValue({ succeeded: [], failed: 0 }),
    loadPreview: vi.fn().mockResolvedValue('Assistant preview'),
    canArchive: true,
    pinnedExpanded: true,
    onPinnedExpandedChange: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

describe('ActivityView', () => {
  it('anchors its only options menu to the first enabled section without a fixed title', async () => {
    props.entries = [
      makeEntry('priority'),
      {
        ...makeEntry('pin'),
        session: { ...makeEntry('pin').session, isPinned: true },
      },
      {
        ...makeEntry('recent'),
        unread: false,
        session: {
          ...makeEntry('recent').session,
          updatedAt: new Date().toISOString(),
        },
      },
    ];
    await render();
    const anchor = () =>
      button('Activity options')
        .closest('[data-activity-section]')
        ?.getAttribute('data-activity-section');
    expect(container.querySelector('h2')).toBeNull();
    expect(anchor()).toBe('priority');
    await menuClick('Pinned');
    await menuClick('Priority section');
    expect(anchor()).toBe('pinned');
    await menuClick('Pinned');
    expect(anchor()).toBe('recent');
    expect(
      container.querySelectorAll('button[aria-label="Activity options"]'),
    ).toHaveLength(1);
    props.entries = [];
    await render();
    expect(
      button('Activity options').closest('[data-activity-section]')
        ?.textContent,
    ).toContain('Today');
    await menu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('does not spend the row budget or load previews for collapsed pinned rows', async () => {
    localStorage.setItem(
      'qwen-code-activity-options-v1',
      JSON.stringify({ priority: false, pinned: true, scheduled: false }),
    );
    props.pinnedExpanded = false;
    props.entries = [
      ...Array.from({ length: 12 }, (_, i) => ({
        ...makeEntry(`pin-${i}`),
        unread: false,
        session: { ...makeEntry(`pin-${i}`).session, isPinned: true },
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        ...makeEntry(`recent-${i}`),
        unread: false,
        session: {
          ...makeEntry(`recent-${i}`).session,
          updatedAt: new Date().toISOString(),
        },
      })),
    ];
    await render();
    expect(button('Pinned').getAttribute('aria-expanded')).toBe('false');
    expect(
      container
        .querySelector('[data-activity-section="pinned"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(10);
    expect(props.loadPreview).toHaveBeenCalledTimes(10);
    expect(
      vi
        .mocked(props.loadPreview)
        .mock.calls.every(([entry]) => entry.key.startsWith('recent-')),
    ).toBe(true);
    await click('Show more');
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(12);
    expect(button('Show more')).toBeUndefined();
    await click('Pinned');
    expect(props.onPinnedExpandedChange).toHaveBeenCalledWith(true);
    props.pinnedExpanded = true;
    await render();
    expect(
      container
        .querySelector('[data-activity-section="pinned"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(12);
  });

  it('folds priority without hiding its menu or consuming recent rows budget', async () => {
    props.entries = [
      ...Array.from({ length: 12 }, (_, i) => makeEntry(`priority-${i}`)),
      ...Array.from({ length: 12 }, (_, i) => ({
        ...makeEntry(`recent-${i}`),
        unread: false,
        session: {
          ...makeEntry(`recent-${i}`).session,
          updatedAt: new Date().toISOString(),
        },
      })),
    ];
    await render();
    await click('Priority');
    expect(button('Priority').getAttribute('aria-expanded')).toBe('false');
    expect(
      button('Activity options')
        .closest('[data-activity-section]')
        ?.getAttribute('data-activity-section'),
    ).toBe('priority');
    expect(
      container
        .querySelector('[data-activity-section="priority"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(10);
    expect(
      vi
        .mocked(props.loadPreview)
        .mock.calls.slice(10)
        .every(([entry]) => entry.key.startsWith('recent-')),
    ).toBe(true);
    await click('Priority');
    expect(button('Priority').getAttribute('aria-expanded')).toBe('true');
    expect(
      container
        .querySelector('[data-activity-section="priority"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(10);
  });

  it('offers a keyboard-accessible icon reset in the Display header', async () => {
    await render();
    await menu();
    expect(
      document.querySelector('[aria-label="Reset display options"]'),
    ).toBeNull();
    await act(async () => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    await menuClick('Pinned');
    await menuClick('Scheduled tasks');
    await menuClick('Priority section');
    await menu();
    const reset = document.querySelector<HTMLElement>(
      '[role="menuitem"][aria-label="Reset display options"]',
    )!;
    expect(reset).not.toBeNull();
    expect(reset.textContent).toBe('');
    expect(reset.parentElement?.textContent).toContain('Display');
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === 'Reset display options',
      ),
    ).toBe(false);
    await act(async () => {
      reset.focus();
      reset.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const checks = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(checks[0]);
    expect(
      document.querySelector('[aria-label="Reset display options"]'),
    ).toBeNull();
    expect(
      checks.map((item) => [
        item.textContent,
        item.getAttribute('aria-checked'),
      ]),
    ).toEqual([
      ['Priority section', 'true'],
      ['Pinned', 'false'],
      ['Scheduled tasks', 'false'],
    ]);
  });

  it('loads only the shared visible budget and delegates rows and previews to the shared renderer', async () => {
    props.entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry(String(i).padStart(2, '0')),
    );
    await render();
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(10);
    expect(props.loadPreview).toHaveBeenCalledTimes(10);
    const row = container.querySelector<HTMLButtonElement>(
      '[data-activity-key="00"] button',
    )!;
    expect(row.type).toBe('button');
    await act(async () => row.click());
    expect(openSession).toHaveBeenCalledWith(props.entries[0]);
    expect(props.renderSession).toHaveBeenCalledWith(
      props.entries[0],
      'Assistant preview',
    );
    await click('Show more');
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(12);
    expect(props.loadPreview).toHaveBeenCalledTimes(12);
  });

  it('keeps read rows in the snapshot but clears them explicitly', async () => {
    await render();
    await menuClick('Mark all as read');
    expect(props.onMarkRead).toHaveBeenCalledWith(props.entries);
    props.entries = props.entries.map((entry) => ({
      ...entry,
      unread: false,
    }));
    await render();
    expect(
      container
        .querySelector('[data-activity-section="priority"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(2);
    await menuClick('Clear read chats');
    expect(
      container
        .querySelector('[data-activity-section="priority"]')
        ?.querySelectorAll('[data-activity-key]'),
    ).toHaveLength(0);
  });

  it('reports partial archive failure and undoes only successful entries', async () => {
    props.onArchive = vi
      .fn()
      .mockResolvedValue({ succeeded: [props.entries[0]], failed: 1 });
    props.onUndo = vi
      .fn()
      .mockResolvedValue({ succeeded: [props.entries[0]], failed: 0 });
    await render();
    await menuClick('Archive chats');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Recent and separately pinned conversations are not included.',
    );
    await click('Archive');
    expect(props.onArchive).toHaveBeenCalledWith(props.entries);
    expect(container.textContent).toContain('1 succeeded · 1 failed');
    expect(container.querySelector('[data-activity-key="a"]')).toBeNull();
    expect(container.querySelector('[data-activity-key="b"]')).not.toBeNull();
    await click('Undo');
    expect(props.onUndo).toHaveBeenCalledWith([props.entries[0]]);
    expect(
      [...container.querySelectorAll('[data-activity-key]')].map((row) =>
        row.getAttribute('data-activity-key'),
      ),
    ).toEqual(['a', 'b']);
  });

  it('excludes separate pinned and recent sections from bulk operations', async () => {
    const recentStamp = new Date().toISOString();
    props.entries = [
      makeEntry('priority'),
      {
        ...makeEntry('pin'),
        session: { ...makeEntry('pin').session, isPinned: true },
      },
      {
        ...makeEntry('recent'),
        unread: false,
        session: {
          ...makeEntry('recent').session,
          updatedAt: recentStamp,
        },
      },
    ];
    await render();
    await menuClick('Pinned');
    expect(
      container.querySelector('[data-activity-section="pinned"]')?.textContent,
    ).toContain('Chat pin');
    expect(
      container.querySelector('[data-activity-section="recent"]')?.textContent,
    ).toContain('Chat recent');
    await menuClick('Mark all as read');
    expect(props.onMarkRead).toHaveBeenCalledWith([props.entries[0]]);
    await menuClick('Archive chats');
    await click('Archive');
    expect(props.onArchive).toHaveBeenCalledWith([props.entries[0]]);
  });

  it('restores the original position before the catalog sees an undo', async () => {
    const original = props.entries;
    props.onArchive = vi.fn().mockResolvedValue({
      succeeded: [original[0]],
      failed: 1,
    });
    props.onUndo = vi.fn().mockResolvedValue({
      succeeded: [original[0]],
      failed: 0,
    });
    await render();
    await menuClick('Archive chats');
    await click('Archive');
    props.entries = [original[1]];
    await render();
    await click('Undo');
    expect(
      [...container.querySelectorAll('[data-activity-key]')].map((row) =>
        row.getAttribute('data-activity-key'),
      ),
    ).toEqual(['a', 'b']);
    props.entries = [...original];
    await render();
    props.entries = [original[1]];
    await render();
    expect(container.querySelector('[data-activity-key="a"]')).toBeNull();
  });

  it('preserves rows after rejected bulk actions and exposes retry for previews', async () => {
    props.onArchive = vi.fn().mockRejectedValue(new Error('offline'));
    props.loadPreview = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('Recovered');
    await render();
    expect(container.textContent).toContain('Preview unavailable');
    await click('Preview unavailable · Retry preview');
    expect(container.textContent).not.toContain('Preview unavailable');
    await menuClick('Archive chats');
    await click('Archive');
    expect(container.textContent).toContain('The action failed.');
    expect(container.querySelectorAll('[data-activity-key]')).toHaveLength(2);
  });

  it('distinguishes partial failure and loading from an empty queue', async () => {
    props.entries = [];
    props.unavailable = true;
    await render();
    expect(container.textContent).toContain(
      'Some conversations are unavailable.',
    );
    expect(container.textContent).not.toContain(
      'No conversations need attention.',
    );
    await click('Retry');
    expect(props.onRetry).toHaveBeenCalledOnce();
    props.unavailable = false;
    props.loading = true;
    await render();
    expect(container.textContent).toContain('Checking conversations');
    props.loading = false;
    await render();
    expect(container.textContent).toContain('No conversations need attention.');
  });

  it('does not apply a stale preview after the row changes', async () => {
    let finish: (value: string) => void = () => {};
    props.loadPreview = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue('New preview');
    props.entries = [makeEntry('a')];
    await render();
    props.entries = [
      {
        ...props.entries[0],
        session: {
          ...props.entries[0].session,
          updatedAt: '2026-11-01T00:00:00Z',
        },
      },
    ];
    await render();
    await act(async () => finish('Stale preview'));
    await settle();
    expect(container.textContent).toContain('New preview');
    expect(container.textContent).not.toContain('Stale preview');
  });
});
