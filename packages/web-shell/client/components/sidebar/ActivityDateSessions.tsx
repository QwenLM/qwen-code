import { Fragment, useState, type ReactNode } from 'react';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { activityRecency, type ActivityEntry } from './activity-model';
import { SessionGroupSection } from './SessionGroupSection';
import type { SessionSort } from './SessionSortMenu';
import styles from './WebShellSidebar.module.css';

function sortTime(entry: ActivityEntry, sortBy: SessionSort): number {
  if (sortBy === 'updatedAt') return activityRecency(entry);
  const value = Date.parse(entry.session.lastUserPromptAt ?? '');
  return Number.isFinite(value) ? value : Number.MIN_SAFE_INTEGER;
}

export function groupActivityDateSessions(
  entries: readonly ActivityEntry[],
  sortBy: SessionSort,
): Array<{ dayStart: number; entries: ActivityEntry[] }> {
  const groups = new Map<number, ActivityEntry[]>();
  const sorted = [...entries].sort(
    (a, b) =>
      sortTime(b, sortBy) - sortTime(a, sortBy) || a.key.localeCompare(b.key),
  );
  for (const entry of sorted) {
    const date = new Date(activityRecency(entry));
    date.setHours(0, 0, 0, 0);
    const dayStart = date.getTime();
    const group = groups.get(dayStart) ?? [];
    group.push(entry);
    groups.set(dayStart, group);
  }
  return Array.from(groups, ([dayStart, groupEntries]) => ({
    dayStart,
    entries: groupEntries,
  })).sort((a, b) => b.dayStart - a.dayStart);
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
  const { t, language } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groups = groupActivityDateSessions(entries, sortBy);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

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
        const id = String(group.dayStart);
        const label =
          group.dayStart === today.getTime()
            ? t('activity.today')
            : group.dayStart === yesterday.getTime()
              ? t('activity.yesterday')
              : new Date(group.dayStart).toLocaleDateString(language, {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                });
        const expanded = !collapsed.has(id);
        const hostsEditor =
          editingSessionIdentity !== null &&
          group.entries.some(
            (entry) =>
              sessionIdentity(entry.session) === editingSessionIdentity,
          );
        return (
          <SessionGroupSection
            key={id}
            id={id}
            label={label}
            count={group.entries.length}
            expanded={expanded}
            limitSessions={!hostsEditor}
            onToggle={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          >
            {group.entries.map((entry) => (
              <Fragment key={entry.key}>{renderSession(entry)}</Fragment>
            ))}
          </SessionGroupSection>
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
