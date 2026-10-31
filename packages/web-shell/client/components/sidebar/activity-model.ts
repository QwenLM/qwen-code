import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { getScheduledTaskSessionGroup } from './scheduled-task-session-groups';
import { comparePinnedSectionSessions } from './pinned-session-order';

export interface ActivityEntry {
  key: string;
  session: DaemonSessionSummary;
  unread?: boolean;
}

export type ActivityState =
  | 'input'
  | 'approval'
  | 'error'
  | 'unread'
  | 'active'
  | 'idle';

export interface ActivityPreferences {
  priority: boolean;
  pinned: boolean;
  scheduled: boolean;
}

export const DEFAULT_ACTIVITY_PREFERENCES: ActivityPreferences = {
  priority: true,
  pinned: false,
  scheduled: false,
};

export interface ActivitySnapshot {
  activatedAt: number;
  priorityKeys: string[];
  recentTimes: ReadonlyMap<string, number>;
}

export function activityRecency({ session }: ActivityEntry): number {
  return Math.max(
    Date.parse(session.updatedAt ?? '') || 0,
    Date.parse(session.createdAt ?? '') || 0,
  );
}

export function isActivityUnread(entry: ActivityEntry): boolean {
  return entry.unread === true;
}

export function activityState(entry: ActivityEntry): ActivityState {
  const { session } = entry;
  if (session.isWaitingForUserQuestion) return 'input';
  if (session.isWaitingForPermission) return 'approval';
  if (session.hasTurnError) return 'error';
  if (isActivityUnread(entry)) return 'unread';
  if (
    session.hasActivePrompt ||
    session.activeWorkState === 'active' ||
    session.hasRunningBackgroundTasks
  )
    return 'active';
  return 'idle';
}

export function activityNeedsAttention(entry: ActivityEntry): boolean {
  return ['input', 'approval', 'error', 'unread'].includes(
    activityState(entry),
  );
}

export function isActivityEligible(
  entry: ActivityEntry,
  preferences: ActivityPreferences,
): boolean {
  const { session } = entry;
  return (
    !session.isArchived &&
    session.sourceType !== 'qwen-live' &&
    !session.sourceId?.startsWith('realtime_voice:') &&
    (!session.parentSessionId || session.isPinned === true) &&
    (preferences.scheduled ||
      (session.sourceType !== 'scheduled_task' &&
        !getScheduledTaskSessionGroup(session)))
  );
}

const rank: Record<ActivityState, number> = {
  input: 0,
  approval: 0,
  error: 0,
  unread: 1,
  active: 2,
  idle: 3,
};

function candidates(
  entries: ActivityEntry[],
  preferences: ActivityPreferences,
): ActivityEntry[] {
  return [
    ...new Map(
      entries
        .filter((entry) => isActivityEligible(entry, preferences))
        .map((entry) => [entry.key, entry]),
    ).values(),
  ];
}

export function openActivitySnapshot(
  entries: ActivityEntry[],
  preferences: ActivityPreferences,
  now = Date.now(),
): ActivitySnapshot {
  const eligible = candidates(entries, preferences);
  return {
    activatedAt: now,
    priorityKeys: eligible
      .filter((entry) => activityState(entry) !== 'idle')
      .sort(
        (a, b) =>
          rank[activityState(a)] - rank[activityState(b)] ||
          activityRecency(b) - activityRecency(a) ||
          a.key.localeCompare(b.key),
      )
      .map((entry) => entry.key),
    recentTimes: new Map(
      eligible.map((entry) => [entry.key, activityRecency(entry)]),
    ),
  };
}

export function updateActivitySnapshot(
  snapshot: ActivitySnapshot,
  entries: ActivityEntry[],
  preferences: ActivityPreferences,
): ActivitySnapshot {
  const next = openActivitySnapshot(entries, preferences, snapshot.activatedAt);
  const available = new Set(
    candidates(entries, preferences).map((entry) => entry.key),
  );
  const retained = snapshot.priorityKeys.filter((key) => available.has(key));
  const keys = new Set(retained);
  const priorityKeys = [
    ...retained,
    ...next.priorityKeys.filter((key) => !keys.has(key)),
  ];
  const recentTimes = new Map(next.recentTimes);
  for (const [key, time] of snapshot.recentTimes)
    if (available.has(key)) recentTimes.set(key, time);
  if (
    priorityKeys.length === snapshot.priorityKeys.length &&
    priorityKeys.every((key, i) => key === snapshot.priorityKeys[i]) &&
    recentTimes.size === snapshot.recentTimes.size &&
    [...recentTimes].every(
      ([key, time]) => snapshot.recentTimes.get(key) === time,
    )
  )
    return snapshot;
  return { ...snapshot, priorityKeys, recentTimes };
}

export function clearReadActivitySnapshot(
  snapshot: ActivitySnapshot,
  entries: ActivityEntry[],
  preferences: ActivityPreferences,
): ActivitySnapshot {
  const fresh = openActivitySnapshot(
    entries,
    preferences,
    snapshot.activatedAt,
  );
  const eligible = new Set(fresh.priorityKeys);
  const retained = snapshot.priorityKeys.filter((key) => eligible.has(key));
  const retainedKeys = new Set(retained);
  return {
    ...fresh,
    priorityKeys: [
      ...retained,
      ...fresh.priorityKeys.filter((key) => !retainedKeys.has(key)),
    ],
  };
}

export function selectActivitySections(
  snapshot: ActivitySnapshot,
  entries: ActivityEntry[],
  preferences: ActivityPreferences,
) {
  const eligible = candidates(entries, preferences);
  const byKey = new Map(eligible.map((entry) => [entry.key, entry]));
  const pinned = preferences.pinned
    ? eligible
        .filter((entry) => entry.session.isPinned)
        .sort((a, b) => comparePinnedSectionSessions(a.session, b.session))
    : [];
  const pinnedKeys = new Set(pinned.map((entry) => entry.key));
  const priority = preferences.priority
    ? snapshot.priorityKeys.flatMap((key) => {
        const entry = byKey.get(key);
        return entry && !pinnedKeys.has(key) ? [entry] : [];
      })
    : [];
  const shown = new Set([...priority, ...pinned].map((entry) => entry.key));
  const cutoff = new Date(snapshot.activatedAt);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  const time = (entry: ActivityEntry) =>
    snapshot.recentTimes.get(entry.key) ?? activityRecency(entry);
  const recent: Array<{ dayStart: number; entries: ActivityEntry[] }> = [];
  for (const entry of eligible
    .filter(
      (entry) =>
        !shown.has(entry.key) &&
        (time(entry) >= cutoff.getTime() ||
          (!preferences.priority && snapshot.priorityKeys.includes(entry.key))),
    )
    .sort((a, b) => time(b) - time(a) || a.key.localeCompare(b.key))) {
    const date = new Date(time(entry));
    date.setHours(0, 0, 0, 0);
    const dayStart = date.getTime();
    const group = recent.at(-1);
    if (group?.dayStart === dayStart) group.entries.push(entry);
    else recent.push({ dayStart, entries: [entry] });
  }
  return { priority, pinned, recent };
}
