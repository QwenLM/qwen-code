import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { SIDEBAR_SESSION_PREVIEW_LIMIT } from '../../constants/sessions';
import { useI18n } from '../../i18n';
import { activityRecency, type ActivityEntry } from './activity-model';
import { SessionGroupSection } from './SessionGroupSection';
import type { SessionSort } from './SessionSortMenu';
import styles from './WebShellSidebar.module.css';

export type ActivityDateGroupId = 'today' | 'thisWeek' | 'last30Days' | 'older';

const GROUP_IDS: readonly ActivityDateGroupId[] = [
  'today',
  'thisWeek',
  'last30Days',
  'older',
];

function sortTime(entry: ActivityEntry, sortBy: SessionSort): number {
  if (sortBy === 'updatedAt') return activityRecency(entry);
  const value = Date.parse(entry.session.lastUserPromptAt ?? '');
  return Number.isFinite(value) ? value : Number.MIN_SAFE_INTEGER;
}

function localDayStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDateKey(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function groupActivityDateSessions(
  entries: readonly ActivityEntry[],
  sortBy: SessionSort,
  now = Date.now(),
): Array<{ id: ActivityDateGroupId; entries: ActivityEntry[] }> {
  const todayKey = localDateKey(new Date(now));
  const weekStart = new Date(localDayStart(now));
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekStartKey = localDateKey(weekStart);
  const last30Start = new Date(localDayStart(now));
  last30Start.setDate(last30Start.getDate() - 29);
  last30Start.setHours(0, 0, 0, 0);
  const last30StartKey = localDateKey(last30Start);
  const groups = new Map<ActivityDateGroupId, ActivityEntry[]>();
  const sorted = [...entries].sort(
    (a, b) =>
      sortTime(b, sortBy) - sortTime(a, sortBy) || a.key.localeCompare(b.key),
  );
  for (const entry of sorted) {
    const activityKey = localDateKey(new Date(activityRecency(entry)));
    const id =
      activityKey >= todayKey
        ? 'today'
        : activityKey >= weekStartKey
          ? 'thisWeek'
          : activityKey >= last30StartKey
            ? 'last30Days'
            : 'older';
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  return GROUP_IDS.flatMap((id) => {
    const group = groups.get(id);
    return group ? [{ id, entries: group }] : [];
  });
}

interface ActivityDateSessionsProps {
  entries: readonly ActivityEntry[];
  sortBy: SessionSort;
  loading: boolean;
  unavailable: boolean;
  hasMore: boolean;
  onRetry: () => void;
  renderSession: (entry: ActivityEntry) => ReactNode;
  editingSessionIdentity?: string | null;
  sessionIdentity: (session: DaemonSessionSummary) => string;
}

export function ActivityDateSessions({
  entries,
  sortBy,
  loading,
  unavailable,
  hasMore,
  onRetry,
  renderSession,
  editingSessionIdentity = null,
  sessionIdentity,
}: ActivityDateSessionsProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dayStart, setDayStart] = useState(() => localDayStart(Date.now()));
  useEffect(() => {
    const nextDay = new Date(dayStart);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 0, 0);
    const timer = setTimeout(
      () => setDayStart(localDayStart(Date.now())),
      Math.max(0, nextDay.getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dayStart]);
  const groups = useMemo(
    () => groupActivityDateSessions(entries, sortBy, dayStart),
    [dayStart, entries, sortBy],
  );

  return (
    <div className="flex flex-col">
      {unavailable && (
        <button className={styles.retry} type="button" onClick={onRetry}>
          {t('sidebar.loadFailed')}
        </button>
      )}
      {loading && (
        <div className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {t('common.loading')}
        </div>
      )}
      {!loading && !unavailable && !hasMore && groups.length === 0 && (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          {t('sidebar.noSessions')}
        </div>
      )}
      {groups.map((group) => {
        const label =
          group.id === 'today'
            ? t('activity.today')
            : group.id === 'thisWeek'
              ? t('sidebar.groupThisWeek')
              : group.id === 'last30Days'
                ? t('sidebar.groupLast30Days')
                : t('sidebar.groupOlder');
        const expanded = !collapsed.has(group.id);
        const editingIndex =
          editingSessionIdentity === null
            ? -1
            : group.entries.findIndex(
                (entry) =>
                  sessionIdentity(entry.session) === editingSessionIdentity,
              );
        return (
          <SessionGroupSection
            key={group.id}
            id={group.id}
            label={label}
            count={group.entries.length}
            expanded={expanded}
            itemCount={group.entries.length}
            renderChildren={(visibleCount) =>
              group.entries
                .slice(0, visibleCount)
                .map((entry) => (
                  <Fragment key={entry.key}>{renderSession(entry)}</Fragment>
                ))
            }
            limitSessions={editingIndex < SIDEBAR_SESSION_PREVIEW_LIMIT}
            onToggle={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group.id)) next.delete(group.id);
                else next.add(group.id);
                return next;
              })
            }
          />
        );
      })}
      {hasMore && !loading && !unavailable && (
        <div className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {t('common.loading')}
        </div>
      )}
    </div>
  );
}
