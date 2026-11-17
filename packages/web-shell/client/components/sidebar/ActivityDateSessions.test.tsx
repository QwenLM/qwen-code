// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { SIDEBAR_SESSION_PREVIEW_LIMIT } from '../../constants/sessions';
import {
  ActivityDateSessions,
  groupActivityDateSessions,
} from './ActivityDateSessions';
import type { ActivityEntry } from './activity-model';
import type { SessionSort } from './SessionSortMenu';

const { t } = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../i18n', () => ({ useI18n: () => ({ t }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 0, 15, 12);

function on(dayOffset: number, hour = 12): string {
  const date = new Date(NOW);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function entry(
  sessionId: string,
  workspaceCwd: string,
  updatedAt: string,
  extra: Partial<DaemonSessionSummary> = {},
): ActivityEntry {
  return {
    key: JSON.stringify([workspaceCwd, sessionId]),
    session: {
      sessionId,
      workspaceCwd,
      displayName: sessionId,
      updatedAt,
      ...extra,
    },
  };
}

describe('groupActivityDateSessions', () => {
  it('partitions exclusive rolling ranges in a fixed order', () => {
    const groups = groupActivityDateSessions(
      [
        entry('older', '/two', on(-40)),
        entry('today', '/one', on(0, 9)),
        entry('this-week', '/two', on(-2)),
        entry('previous-sunday', '/three', on(-4)),
        entry('last-30-boundary', '/four', on(-29)),
        entry('today-other', '/two', on(0, 10)),
        entry('older-boundary', '/five', on(-30)),
        ...Array.from({ length: 25 }, (_, index) =>
          entry(`extra-${index}`, '/three', on(-40)),
        ),
      ],
      'updatedAt',
      NOW.getTime(),
    );
    expect(groups.map((group) => group.id)).toEqual([
      'today',
      'thisWeek',
      'last30Days',
      'older',
    ]);
    expect(groups[0]!.entries.map((item) => item.session.sessionId)).toEqual([
      'today-other',
      'today',
    ]);
    expect(groups[1]!.entries.map((item) => item.session.sessionId)).toEqual([
      'this-week',
    ]);
    expect(groups[2]!.entries.map((item) => item.session.sessionId)).toEqual([
      'previous-sunday',
      'last-30-boundary',
    ]);
    expect(groups[3]!.entries).toHaveLength(27);
  });

  it('keeps future activity timestamps in Today', () => {
    const groups = groupActivityDateSessions(
      [entry('future', '/one', on(2))],
      'updatedAt',
      NOW.getTime(),
    );
    expect(groups.map((group) => group.id)).toEqual(['today']);
  });

  it('uses creation time when it is newer than the update time', () => {
    const groups = groupActivityDateSessions(
      [entry('created', '/one', on(-40), { createdAt: on(0) })],
      'updatedAt',
      NOW.getTime(),
    );
    expect(groups.map((group) => group.id)).toEqual(['today']);
  });

  it('keeps bucket order independent of prompt order', () => {
    const groups = groupActivityDateSessions(
      [
        entry('older-activity', '/one', on(-40), {
          lastUserPromptAt: on(0, 11),
        }),
        entry('today', '/two', on(0), { lastUserPromptAt: on(-40) }),
      ],
      'lastUserPromptAt',
      NOW.getTime(),
    );
    expect(groups.map((group) => group.id)).toEqual(['today', 'older']);
    expect(groups[0]!.entries[0]!.session.sessionId).toBe('today');
  });

  it('sorts by last question with missing values last and stable key ties', () => {
    const groups = groupActivityDateSessions(
      [
        entry('a', '/two', on(0, 9), { lastUserPromptAt: on(0, 8) }),
        entry('b', '/two', on(0, 10), { lastUserPromptAt: on(0, 11) }),
        entry('missing', '/three', on(0, 12)),
        entry('a', '/one', on(0, 9), { lastUserPromptAt: on(0, 8) }),
      ],
      'lastUserPromptAt',
      NOW.getTime(),
    );
    expect(groups[0]!.entries.map((item) => item.key)).toEqual([
      JSON.stringify(['/two', 'b']),
      JSON.stringify(['/one', 'a']),
      JSON.stringify(['/two', 'a']),
      JSON.stringify(['/three', 'missing']),
    ]);
  });
});

describe('ActivityDateSessions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let onRetry: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    t.mockClear();
    onRetry = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render({
    entries = [entry('today', '/one', on(0))],
    sortBy = 'updatedAt',
    loading = false,
    unavailable = false,
    hasMore = false,
    editingSessionIdentity = null,
    renderSession,
  }: {
    entries?: ActivityEntry[];
    sortBy?: SessionSort;
    loading?: boolean;
    unavailable?: boolean;
    hasMore?: boolean;
    editingSessionIdentity?: string | null;
    renderSession?: (entry: ActivityEntry) => ReactNode;
  } = {}) {
    await act(async () =>
      root.render(
        <ActivityDateSessions
          entries={entries}
          sortBy={sortBy}
          loading={loading}
          unavailable={unavailable}
          hasMore={hasMore}
          onRetry={onRetry}
          editingSessionIdentity={editingSessionIdentity}
          sessionIdentity={(session) =>
            `${session.workspaceCwd ?? ''}\0${session.sessionId}`
          }
          renderSession={
            renderSession ??
            ((item) => (
              <div data-testid="activity-date-row">
                {item.session.displayName}
              </div>
            ))
          }
        />,
      ),
    );
  }

  function visibleRows(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="activity-date-row"]',
      ),
    );
  }

  it('renders all bucket labels, collapses groups, and previews five rows', async () => {
    const entries = [
      ...Array.from({ length: SIDEBAR_SESSION_PREVIEW_LIMIT + 1 }, (_, i) =>
        entry(`today-${i}`, '/one', on(0, 12 - i)),
      ),
      entry('this-week', '/two', on(-1)),
      entry('last-30', '/three', on(-20)),
      entry('older', '/four', on(-40)),
    ];
    await render({ entries });
    expect(visibleRows()).toHaveLength(SIDEBAR_SESSION_PREVIEW_LIMIT + 3);
    for (const label of [
      'activity.today',
      'sidebar.groupThisWeek',
      'sidebar.groupLast30Days',
      'sidebar.groupOlder',
    ])
      expect(container.textContent).toContain(label);
    const todayToggle = container.querySelector<HTMLButtonElement>(
      'section[aria-label="activity.today"] button[aria-expanded]',
    )!;
    await act(async () => todayToggle.click());
    expect(todayToggle.getAttribute('aria-expanded')).toBe('false');
    expect(visibleRows()).toHaveLength(3);
    await act(async () => todayToggle.click());
    const showMore = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'sidebar.showMoreSessions')!;
    await act(async () => showMore.click());
    expect(visibleRows()).toHaveLength(SIDEBAR_SESSION_PREVIEW_LIMIT + 4);
  });

  it('re-buckets the same entries when the local day rolls over', async () => {
    await render({ entries: [entry('today', '/one', on(0))] });
    expect(
      container.querySelector('section[aria-label="activity.today"]'),
    ).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000));
    expect(
      container.querySelector('section[aria-label="activity.today"]'),
    ).toBeNull();
    expect(
      container.querySelector('section[aria-label="sidebar.groupThisWeek"]'),
    ).not.toBeNull();
  });

  it('keeps buckets and rollover correct across a DST midnight', async () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = 'America/Santiago';
    try {
      const atDstMidnight = entry(
        'dst',
        '/one',
        new Date(2024, 8, 8, 0, 30).toISOString(),
      );
      expect(
        groupActivityDateSessions(
          [atDstMidnight],
          'updatedAt',
          new Date(2024, 8, 8, 12).getTime(),
        ).map((group) => group.id),
      ).toEqual(['today']);

      vi.setSystemTime(new Date(2024, 8, 8, 1, 30));
      await render({ entries: [atDstMidnight] });
      await act(async () => vi.advanceTimersByTimeAsync(22.5 * 60 * 60 * 1000));
      expect(
        container.querySelector('section[aria-label="activity.today"]'),
      ).toBeNull();
      expect(
        container.querySelector(
          'section[aria-label="sidebar.groupLast30Days"]',
        ),
      ).not.toBeNull();
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });

  it('builds only visible rows until every parent, child, and older session is revealed', async () => {
    const entries = [
      ...Array.from({ length: 24 }, (_, index) =>
        entry(`session-${index}`, '/one', on(-40 - index)),
      ),
      entry('parent', '/two', on(-35)),
      entry('child', '/two', on(-36), { parentSessionId: 'parent' }),
    ];
    const rendered = new Set<string>();
    await render({
      entries,
      renderSession: (item) => {
        rendered.add(item.key);
        return (
          <div data-testid="activity-date-row">{item.session.sessionId}</div>
        );
      },
    });
    expect(rendered.size).toBe(SIDEBAR_SESSION_PREVIEW_LIMIT);
    for (let index = 0; index < 3; index++) {
      const showMore = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent === 'sidebar.showMoreSessions')!;
      await act(async () => showMore.click());
    }
    expect(rendered.size).toBe(26);
    expect(
      entries
        .filter((item) => item.session.parentSessionId === 'parent')
        .every((item) => rendered.has(item.key)),
    ).toBe(true);
    expect(container.textContent).toContain('sidebar.groupOlder');
  });

  it('uses the selected sort prop inside a group', async () => {
    await render({
      sortBy: 'lastUserPromptAt',
      entries: [
        entry('newer-update', '/one', on(0, 11), {
          lastUserPromptAt: on(0, 8),
        }),
        entry('newer-question', '/two', on(0, 10), {
          lastUserPromptAt: on(0, 12),
        }),
      ],
    });
    expect(visibleRows().map((row) => row.textContent)).toEqual([
      'newer-question',
      'newer-update',
    ]);
  });

  it('lifts the preview only when the editing row is beyond the bound', async () => {
    const entries = Array.from(
      { length: SIDEBAR_SESSION_PREVIEW_LIMIT + 1 },
      (_, index) => entry(`session-${index}`, '/one', on(0, 12 - index)),
    );
    await render({ entries, editingSessionIdentity: '/one\0session-0' });
    expect(visibleRows()).toHaveLength(SIDEBAR_SESSION_PREVIEW_LIMIT);
    await render({
      entries: [...entries, entry('this-week', '/two', on(-1))],
      editingSessionIdentity: `/one\0session-${SIDEBAR_SESSION_PREVIEW_LIMIT}`,
    });
    expect(visibleRows()).toHaveLength(SIDEBAR_SESSION_PREVIEW_LIMIT + 2);
    expect(visibleRows().at(-1)?.textContent).toBe('this-week');
  });

  it('shows loading and progress without prematurely showing an empty state', async () => {
    await render({ entries: [], loading: true });
    expect(container.textContent).toContain('common.loading');
    expect(container.textContent).not.toContain('sidebar.noSessions');
    await render({ entries: [], hasMore: true });
    expect(container.textContent).toContain('common.loading');
    expect(container.textContent).not.toContain('sidebar.noSessions');
    await render({ entries: [] });
    expect(container.textContent).toContain('sidebar.noSessions');
    await render({ hasMore: true });
    expect(container.textContent).toContain('common.loading');
  });

  it('shows retry without a stale loading or empty indicator', async () => {
    await render({ unavailable: true });
    expect(visibleRows()).toHaveLength(1);
    expect(container.textContent).toContain('sidebar.loadFailed');
    expect(container.textContent).not.toContain('sidebar.noSessions');
    await render({ unavailable: true, hasMore: true });
    expect(container.textContent).not.toContain('common.loading');
    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'sidebar.loadFailed')!;
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
