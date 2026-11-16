// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  ActivityDateSessions,
  groupActivityDateSessions,
} from './ActivityDateSessions';
import type { ActivityEntry } from './activity-model';

const { t } = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }));
vi.mock('../../i18n', () => ({
  useI18n: () => ({ t, language: 'en-US' }),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

function localDay(offset: number, hour = 12): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString();
}

function localDayStart(iso: string): number {
  const date = new Date(iso);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

describe('groupActivityDateSessions', () => {
  it('merges workspaces into local activity days without row or age limits', () => {
    const today = localDay(0, 9);
    const yesterday = localDay(-1, 9);
    const older = localDay(-30, 9);
    const entries = [
      entry('a', '/one', today),
      entry('b', '/two', localDay(0, 10)),
      entry('c', '/one', yesterday),
      entry('old', '/two', older),
      ...Array.from({ length: 25 }, (_, index) =>
        entry(`extra-${index}`, '/three', older),
      ),
    ];
    const groups = groupActivityDateSessions(entries, 'updatedAt');
    expect(groups.map((group) => group.dayStart)).toEqual([
      localDayStart(today),
      localDayStart(yesterday),
      localDayStart(older),
    ]);
    expect(groups[0]!.entries.map((item) => item.session.sessionId)).toEqual([
      'b',
      'a',
    ]);
    expect(groups[2]!.entries).toHaveLength(26);
  });

  it('uses creation time when it is newer than the update time', () => {
    const createdToday = entry('created', '/one', localDay(-2), {
      createdAt: localDay(0),
    });
    const groups = groupActivityDateSessions([createdToday], 'updatedAt');
    expect(groups[0]!.dayStart).toBe(localDayStart(localDay(0)));
  });

  it('sorts by last question with missing values last and stable key ties', () => {
    const entries = [
      entry('a', '/one', localDay(0, 9), {
        lastUserPromptAt: localDay(0, 8),
      }),
      entry('b', '/two', localDay(0, 10), {
        lastUserPromptAt: localDay(0, 11),
      }),
      entry('missing', '/three', localDay(0, 12)),
      entry('a', '/two', localDay(0, 9), {
        lastUserPromptAt: localDay(0, 8),
      }),
    ];
    const groups = groupActivityDateSessions(entries, 'lastUserPromptAt');
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
    t.mockClear();
    onRetry = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render({
    entries = [entry('today', '/one', localDay(0))],
    loading = false,
    unavailable = false,
    hasMore = false,
    editingSessionIdentity = null,
    renderSession,
  }: {
    entries?: ActivityEntry[];
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
          sortBy="updatedAt"
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

  it('renders localized day sections, collapses them, and previews five rows', async () => {
    const entries = [
      ...Array.from({ length: 6 }, (_, index) =>
        entry(`today-${index}`, '/one', localDay(0, 12 - index)),
      ),
      entry('yesterday', '/two', localDay(-1)),
    ];
    const rendered: ActivityEntry[] = [];
    await render({
      entries,
      renderSession: (item) => {
        rendered.push(item);
        return (
          <div data-testid="activity-date-row">{item.session.sessionId}</div>
        );
      },
    });
    expect(rendered).toHaveLength(7);
    expect(visibleRows()).toHaveLength(6);
    expect(container.textContent).toContain('activity.today');
    expect(container.textContent).toContain('activity.yesterday');
    const todayToggle = container.querySelector<HTMLButtonElement>(
      'section[aria-label="activity.today"] button[aria-expanded]',
    )!;
    await act(async () => todayToggle.click());
    expect(todayToggle.getAttribute('aria-expanded')).toBe('false');
    expect(visibleRows().map((row) => row.textContent)).toEqual(['yesterday']);
    await act(async () => todayToggle.click());
    const showMore = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'sidebar.showMoreSessions')!;
    await act(async () => showMore.click());
    expect(visibleRows()).toHaveLength(7);
  });

  it('passes every parent, child, and older session to the full renderer', async () => {
    const entries = [
      ...Array.from({ length: 24 }, (_, index) =>
        entry(`session-${index}`, '/one', localDay(-index, 12)),
      ),
      entry('parent', '/two', localDay(-30)),
      entry('child', '/two', localDay(-31), {
        parentSessionId: 'parent',
      }),
    ];
    const rendered: ActivityEntry[] = [];
    await render({
      entries,
      renderSession: (item) => {
        rendered.push(item);
        return (
          <div data-testid="activity-date-row">{item.session.sessionId}</div>
        );
      },
    });
    expect(rendered).toHaveLength(26);
    expect(
      rendered.some((item) => item.session.parentSessionId === 'parent'),
    ).toBe(true);
    expect(
      rendered.some(
        (item) =>
          Date.parse(item.session.updatedAt ?? '') <
          Date.now() - 7 * 24 * 60 * 60 * 1000,
      ),
    ).toBe(true);
  });

  it('keeps the editing row visible when it falls beyond the preview', async () => {
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry(`session-${index}`, '/one', localDay(0, 12 - index)),
    );
    await render({
      entries,
      editingSessionIdentity: '/one\0session-5',
    });
    expect(visibleRows()).toHaveLength(6);
    expect(visibleRows().at(-1)?.textContent).toBe('session-5');
  });

  it('shows loading and progress without prematurely showing an empty state', async () => {
    await render({ entries: [], loading: true });
    expect(container.textContent).toContain('common.loading');
    await render({ entries: [], hasMore: true });
    expect(container.textContent).toContain('common.loading');
    expect(container.textContent).not.toContain('sidebar.noSessions');
    await render({ entries: [] });
    expect(container.textContent).toContain('sidebar.noSessions');
    await render({ hasMore: true });
    expect(container.textContent).toContain('common.loading');
  });

  it('shows retry without a stale loading indicator or hiding loaded rows', async () => {
    await render({ unavailable: true, hasMore: true });
    expect(visibleRows()).toHaveLength(1);
    expect(container.textContent).toContain('sidebar.loadFailed');
    expect(container.textContent).not.toContain('common.loading');
    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'sidebar.loadFailed')!;
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
