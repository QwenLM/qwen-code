import { describe, expect, it } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  activityNeedsAttention,
  activityState,
  clearReadActivitySnapshot,
  DEFAULT_ACTIVITY_PREFERENCES as defaults,
  isActivityEligible,
  isActivityUnread,
  openActivitySnapshot,
  selectActivitySections,
  updateActivitySnapshot,
  type ActivityEntry,
} from './activity-model';

const now = new Date(2026, 9, 31, 12).getTime();
const stamp = new Date(now).toISOString();
const entry = (
  key: string,
  patch: Partial<DaemonSessionSummary> = {},
  unread = false,
): ActivityEntry => ({
  key,
  unread,
  session: {
    sessionId: key,
    workspaceCwd: '/project',
    updatedAt: stamp,
    ...patch,
  },
});

describe('activity model', () => {
  it('uses the normal sidebar pin order: older pins first, invalid dates then session ID ties', () => {
    const entries = [
      entry('new', { isPinned: true, pinnedAt: '2026-10-31T12:00:00Z' }),
      entry('old', { isPinned: true, pinnedAt: '2026-10-01T12:00:00Z' }),
      entry('b', { isPinned: true, pinnedAt: 'invalid' }),
      entry('a', { isPinned: true }),
    ];
    const preferences = { ...defaults, pinned: true };
    const sections = selectActivitySections(
      openActivitySnapshot(entries, preferences, now),
      entries,
      preferences,
    );
    expect(sections.pinned.map((item) => item.key)).toEqual([
      'a',
      'b',
      'old',
      'new',
    ]);
  });

  it('ranks actionable states before newer unread and read running work', () => {
    const entries = [
      entry('running', { hasActivePrompt: true }),
      entry('unread', {}, true),
      entry('approval', {
        isWaitingForPermission: true,
        updatedAt: new Date(now - 86400000).toISOString(),
      }),
      entry('read'),
    ];
    expect(openActivitySnapshot(entries, defaults, now).priorityKeys).toEqual([
      'approval',
      'unread',
      'running',
    ]);
    expect(activityNeedsAttention(entries[0])).toBe(false);
    expect(activityNeedsAttention(entries[1])).toBe(true);
    expect(activityState(entry('both', { hasActivePrompt: true }, true))).toBe(
      'unread',
    );
    expect(activityState(entry('error', { hasTurnError: true }))).toBe('error');
  });

  it('uses only the shared in-memory completion flag, not historical timestamps', () => {
    expect(isActivityUnread(entry('history'))).toBe(false);
    expect(
      isActivityUnread(
        entry('newer', {
          updatedAt: new Date(now + 1).toISOString(),
        }),
      ),
    ).toBe(false);
    expect(isActivityUnread(entry('completed', {}, true))).toBe(true);
    expect(
      isActivityUnread(
        entry(
          'old-completed',
          {
            updatedAt: '2020-01-01T00:00:00Z',
          },
          true,
        ),
      ),
    ).toBe(true);
  });

  it('retains read entries and order until clearing or reopening', () => {
    const initial = [entry('a', {}, true), entry('b', {}, true)];
    const snapshot = openActivitySnapshot(initial, defaults, now);
    const changed = [
      entry('b', { isWaitingForPermission: true }),
      entry('a'),
      entry('new', { isWaitingForUserQuestion: true }),
    ];
    const next = updateActivitySnapshot(snapshot, changed, defaults);
    expect(next.priorityKeys).toEqual(['a', 'b', 'new']);
    expect(updateActivitySnapshot(next, changed, defaults)).toBe(next);
    expect(
      clearReadActivitySnapshot(next, changed, defaults).priorityKeys,
    ).toEqual(['b', 'new']);
    expect(openActivitySnapshot(changed, defaults, now).priorityKeys).toEqual([
      'b',
      'new',
    ]);
    expect(
      updateActivitySnapshot(next, changed.slice(0, 2), defaults).priorityKeys,
    ).toEqual(['a', 'b']);
    expect(
      clearReadActivitySnapshot(snapshot, [initial[0], changed[0]], defaults)
        .priorityKeys,
    ).toEqual(['a', 'b']);
  });

  it('filters scheduled sources, children, archived and voice sessions', () => {
    for (const patch of [
      { sourceType: 'scheduled_task' },
      { sourceType: 'default', sourceId: 'scheduled_task_run:job' },
      { parentSessionId: 'parent' },
      { isArchived: true },
      { sourceType: 'qwen-live' },
      { sourceId: 'realtime_voice:call' },
    ])
      expect(isActivityEligible(entry('hidden', patch), defaults)).toBe(false);
    expect(
      isActivityEligible(
        entry('child', { parentSessionId: 'parent', isPinned: true }),
        defaults,
      ),
    ).toBe(true);
    expect(
      isActivityEligible(entry('scheduled', { sourceType: 'scheduled_task' }), {
        ...defaults,
        scheduled: true,
      }),
    ).toBe(true);
  });

  it('uses seven calendar days only for recent and deduplicates sections', () => {
    const cutoff = new Date(2026, 9, 25).getTime();
    const entries = [
      entry('old-unread', { updatedAt: '2025-01-01T00:00:00Z' }, true),
      entry('pinned', { isPinned: true }),
      entry('boundary', {
        updatedAt: new Date(cutoff).toISOString(),
      }),
      entry('too-old', {
        updatedAt: new Date(cutoff - 1).toISOString(),
      }),
    ];
    const preferences = { ...defaults, pinned: true };
    const snapshot = openActivitySnapshot(entries, preferences, now);
    const sections = selectActivitySections(snapshot, entries, preferences);
    expect(sections.priority.map((item) => item.key)).toEqual(['old-unread']);
    expect(sections.pinned.map((item) => item.key)).toEqual(['pinned']);
    expect(
      sections.recent.flatMap((group) => group.entries.map((item) => item.key)),
    ).toEqual(['boundary']);
  });

  it('freezes recent ordering and preserves old priority with priority disabled', () => {
    const initial = [
      entry('older', {
        updatedAt: new Date(now - 1000).toISOString(),
      }),
      entry('newer'),
      entry('old-unread', { updatedAt: '2020-01-01T00:00:00Z' }, true),
    ];
    const snapshot = openActivitySnapshot(initial, defaults, now);
    const changed = [
      entry('older', {
        updatedAt: new Date(now + 1000).toISOString(),
      }),
      initial[1],
      initial[2],
    ];
    const next = updateActivitySnapshot(snapshot, changed, defaults);
    expect(
      selectActivitySections(next, changed, defaults).recent[0].entries.map(
        (item) => item.key,
      ),
    ).toEqual(['newer', 'older']);
    expect(
      selectActivitySections(next, changed, {
        ...defaults,
        priority: false,
      }).recent.flatMap((group) => group.entries.map((item) => item.key)),
    ).toEqual(['newer', 'older', 'old-unread']);
  });
});
