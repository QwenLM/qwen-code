import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EllipsisVerticalIcon, RotateCcwIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { DialogShell } from '../dialogs/DialogShell';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  activityRecency,
  clearReadActivitySnapshot,
  DEFAULT_ACTIVITY_PREFERENCES,
  isActivityUnread,
  openActivitySnapshot,
  selectActivitySections,
  updateActivitySnapshot,
  type ActivityEntry,
  type ActivityPreferences,
} from './activity-model';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import sidebarStyles from './WebShellSidebar.module.css';

const PREFERENCES_KEY = 'qwen-code-activity-options-v1';
export const ACTIVITY_PREFERENCES_EVENT =
  'qwen-code-activity-preferences-changed';

export function readActivityPreferences(): ActivityPreferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(PREFERENCES_KEY) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      'priority' in value &&
      typeof value.priority === 'boolean' &&
      'pinned' in value &&
      typeof value.pinned === 'boolean' &&
      'scheduled' in value &&
      typeof value.scheduled === 'boolean'
    )
      return {
        priority: value.priority,
        pinned: value.pinned,
        scheduled: value.scheduled,
      };
  } catch {
    /* Storage is optional in embedded hosts. */
  }
  return { ...DEFAULT_ACTIVITY_PREFERENCES };
}

export interface ActivityViewProps {
  entries: ActivityEntry[];
  loading: boolean;
  unavailable: boolean;
  hasMore: boolean;
  onLoadMore: () => void | Promise<void>;
  onRetry: () => void;
  renderSession: (entry: ActivityEntry, preview?: string) => ReactNode;
  onMarkRead: (entries: ActivityEntry[]) => Promise<void>;
  onArchive: (
    entries: ActivityEntry[],
  ) => Promise<{ succeeded: ActivityEntry[]; failed: number }>;
  onUndo: (
    entries: ActivityEntry[],
  ) => Promise<{ succeeded: ActivityEntry[]; failed: number }>;
  loadPreview: (entry: ActivityEntry) => Promise<string | undefined>;
  canArchive: boolean;
  pinnedExpanded: boolean;
  onPinnedExpandedChange: (expanded: boolean) => void;
}

function ActivityRow({
  entry,
  renderSession,
  loadPreview,
}: {
  entry: ActivityEntry;
  renderSession: ActivityViewProps['renderSession'];
  loadPreview: ActivityViewProps['loadPreview'];
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const stamp = activityRecency(entry);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setPreview(undefined);
    void loadPreview(entryRef.current)
      .then((text) => {
        if (!cancelled)
          setPreview(text ? [...text].slice(0, 600).join('') : undefined);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.key, stamp, loadPreview, retry]);
  return (
    <div className="contents" data-activity-key={entry.key}>
      {renderSession(entry, preview)}
      {failed && (
        <button
          type="button"
          className={sidebarStyles.retry}
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('activity.previewFailed')} · {t('activity.previewRetry')}
        </button>
      )}
    </div>
  );
}

export function ActivityView({
  entries,
  loading,
  unavailable,
  hasMore,
  onLoadMore,
  onRetry,
  renderSession,
  onMarkRead,
  onArchive,
  onUndo,
  loadPreview,
  canArchive,
  pinnedExpanded,
  onPinnedExpandedChange,
}: ActivityViewProps) {
  const { t, language } = useI18n();
  const [preferences, setPreferences] = useState(readActivityPreferences);
  const [snapshot, setSnapshot] = useState(() =>
    openActivitySnapshot(entries, preferences),
  );
  const [budget, setBudget] = useState(10);
  const [priorityExpanded, setPriorityExpanded] = useState(true);
  const [suppressed, setSuppressed] = useState<Set<string>>(() => new Set());
  const [restored, setRestored] = useState<ActivityEntry[]>([]);
  const effectiveEntries = useMemo(() => {
    const observed = new Set(entries.map((entry) => entry.key));
    return [
      ...entries,
      ...restored.filter((entry) => !observed.has(entry.key)),
    ];
  }, [entries, restored]);
  const [confirmation, setConfirmation] = useState<ActivityEntry[] | null>(
    null,
  );
  const [undo, setUndo] = useState<{
    entries: ActivityEntry[];
    priorityKeys: string[];
  }>();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setSnapshot((previous) =>
      updateActivitySnapshot(previous, effectiveEntries, preferences),
    );
  }, [effectiveEntries, preferences]);
  useEffect(() => {
    setRestored((previous) => {
      const observed = new Set(entries.map((entry) => entry.key));
      const next = previous.filter((entry) => !observed.has(entry.key));
      return next.length === previous.length ? previous : next;
    });
  }, [entries]);
  useEffect(() => {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      /* Storage is optional in embedded hosts. */
    }
    window.dispatchEvent(new Event(ACTIVITY_PREFERENCES_EVENT));
  }, [preferences]);
  const sections = useMemo(
    () =>
      selectActivitySections(
        snapshot,
        effectiveEntries.filter((entry) => !suppressed.has(entry.key)),
        preferences,
      ),
    [effectiveEntries, preferences, snapshot, suppressed],
  );
  let remaining = budget;
  const allGroups = [
    ...(preferences.priority
      ? [
          {
            id: 'priority',
            label: t('activity.priority'),
            entries: sections.priority,
            expanded: priorityExpanded,
            onToggle: () => setPriorityExpanded((expanded) => !expanded),
          },
        ]
      : []),
    ...(preferences.pinned
      ? [
          {
            id: 'pinned',
            label: t('activity.pinned'),
            entries: sections.pinned,
            expanded: pinnedExpanded,
            onToggle: () => onPinnedExpandedChange(!pinnedExpanded),
          },
        ]
      : []),
    ...sections.recent.map((group) => {
      const today = new Date(snapshot.activatedAt);
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
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
      return {
        id: String(group.dayStart),
        label,
        entries: group.entries,
        expanded: true,
        onToggle: undefined,
      };
    }),
  ];
  if (allGroups.length === 0)
    allGroups.push({
      id: 'recent',
      label: t('activity.today'),
      entries: [],
      expanded: true,
      onToggle: undefined,
    });
  const groups = allGroups.map((group) => {
    const visible = group.expanded ? group.entries.slice(0, remaining) : [];
    remaining -= visible.length;
    return { ...group, entries: visible };
  });
  const more =
    hasMore ||
    allGroups.reduce(
      (sum, group) => sum + (group.expanded ? group.entries.length : 0),
      0,
    ) > budget;
  const unread = sections.priority.filter(isActivityUnread);
  const execute = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setResult(undefined);
    try {
      await action();
    } catch {
      if (mounted.current) setResult(t('activity.actionFailed'));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const archive = () => {
    const targets = confirmation;
    if (!targets) return;
    const priorityKeys = snapshot.priorityKeys;
    setConfirmation(null);
    void execute(async () => {
      const response = await onArchive(targets);
      if (!mounted.current) return;
      setSuppressed(
        (previous) =>
          new Set([
            ...previous,
            ...response.succeeded.map((entry) => entry.key),
          ]),
      );
      setRestored((previous) =>
        previous.filter(
          (entry) => !response.succeeded.some((item) => item.key === entry.key),
        ),
      );
      if (response.succeeded.length)
        setUndo({ entries: response.succeeded, priorityKeys });
      setResult(
        t('activity.result', {
          succeeded: response.succeeded.length,
          failed: response.failed,
        }),
      );
    });
  };
  const notices = (
    <>
      {unavailable && (
        <div className={sidebarStyles.notice} role="alert">
          {t('activity.unavailable')}{' '}
          <button type="button" className="underline" onClick={onRetry}>
            {t('activity.retry')}
          </button>
        </div>
      )}
      {loading && (
        <p className={sidebarStyles.notice} role="status">
          {t('activity.loading')}
        </p>
      )}
      {result && (
        <p className={sidebarStyles.notice} role="status">
          {result}
        </p>
      )}
      {undo && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() =>
            void execute(async () => {
              const response = await onUndo(undo.entries);
              if (!mounted.current) return;
              const succeeded = new Set(
                response.succeeded.map((entry) => entry.key),
              );
              setRestored((previous) => [
                ...previous.filter((entry) => !succeeded.has(entry.key)),
                ...response.succeeded.map((entry) => ({
                  ...entry,
                  session: { ...entry.session, isArchived: false },
                })),
              ]);
              setSuppressed(
                (previous) =>
                  new Set([...previous].filter((key) => !succeeded.has(key))),
              );
              setSnapshot((previous) => ({
                ...previous,
                priorityKeys: [
                  ...new Set([
                    ...undo.priorityKeys.filter(
                      (key) =>
                        succeeded.has(key) ||
                        previous.priorityKeys.includes(key),
                    ),
                    ...previous.priorityKeys,
                  ]),
                ],
              }));
              const failed = undo.entries.filter(
                (entry) => !succeeded.has(entry.key),
              );
              setUndo(failed.length ? { ...undo, entries: failed } : undefined);
              setResult(
                t('activity.result', {
                  succeeded: response.succeeded.length,
                  failed: response.failed,
                }),
              );
            })
          }
        >
          {t('activity.undo')}
        </Button>
      )}
    </>
  );
  const optionsMenu = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className={sidebarStyles.workspaceHeaderAction}
        aria-label={t('activity.options')}
        title={t('activity.options')}
      >
        <EllipsisVerticalIcon size={16} strokeWidth={1.2} />
      </button>
    </DropdownMenuTrigger>
  );
  return (
    <DropdownMenu>
      <section
        className="contents"
        data-web-shell-activity
        aria-label={t('activity.title')}
      >
        {groups.map((group, index) =>
          group.entries.length > 0 ||
          group.id === 'priority' ||
          group.id === 'pinned' ||
          index === 0 ? (
            <section
              key={group.id}
              className="contents"
              aria-label={group.label}
              data-activity-section={
                group.id === 'priority' || group.id === 'pinned'
                  ? group.id
                  : 'recent'
              }
            >
              <SidebarSectionHeader
                label={group.label}
                expanded={group.onToggle ? group.expanded : undefined}
                onToggle={group.onToggle}
                action={index === 0 ? optionsMenu : undefined}
              />
              {index === 0 && notices}
              {group.expanded && (
                <div className={sidebarStyles.pinnedSessionList}>
                  {group.entries.map((entry) => (
                    <ActivityRow
                      key={entry.key}
                      entry={entry}
                      renderSession={renderSession}
                      loadPreview={loadPreview}
                    />
                  ))}
                  {group.id === 'priority' &&
                    group.entries.length === 0 &&
                    !loading &&
                    !unavailable && (
                      <p className={sidebarStyles.notice}>
                        {t('activity.empty')}
                      </p>
                    )}
                </div>
              )}
            </section>
          ) : null,
        )}
        {!preferences.priority &&
          allGroups.every((group) => group.entries.length === 0) &&
          !loading &&
          !unavailable && (
            <p className={sidebarStyles.notice}>{t('activity.recentEmpty')}</p>
          )}
        {more && (
          <button
            type="button"
            className={sidebarStyles.showAllSessions}
            disabled={loading}
            onClick={() => {
              setBudget((value) => value + 10);
              if (hasMore)
                void Promise.resolve(onLoadMore()).catch(() =>
                  setResult(t('activity.actionFailed')),
                );
            }}
          >
            {t('activity.more')}
          </button>
        )}
        {confirmation && (
          <DialogShell
            title={t('activity.archiveTitle')}
            size="sm"
            onClose={() => setConfirmation(null)}
          >
            <p>
              {t('activity.archiveDescription', { count: confirmation.length })}
            </p>
            {confirmation.some(
              (entry) =>
                entry.session.hasActivePrompt ||
                entry.session.activeWorkState === 'active' ||
                entry.session.hasRunningBackgroundTasks,
            ) && <p>{t('activity.archiveRunning')}</p>}
            <div className={sidebarStyles.confirmActions}>
              <Button variant="outline" onClick={() => setConfirmation(null)}>
                {t('activity.cancel')}
              </Button>
              <Button onClick={archive}>
                {t(
                  confirmation.some(
                    (entry) =>
                      entry.session.hasActivePrompt ||
                      entry.session.activeWorkState === 'active' ||
                      entry.session.hasRunningBackgroundTasks,
                  )
                    ? 'activity.confirmStopArchive'
                    : 'activity.confirmArchive',
                )}
              </Button>
            </div>
          </DialogShell>
        )}
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <div className="flex items-center justify-between">
            <DropdownMenuLabel>{t('activity.display')}</DropdownMenuLabel>
            {Object.keys(DEFAULT_ACTIVITY_PREFERENCES).some(
              (key) =>
                preferences[key as keyof ActivityPreferences] !==
                DEFAULT_ACTIVITY_PREFERENCES[key as keyof ActivityPreferences],
            ) && (
              <DropdownMenuItem
                className="ml-auto size-7 justify-center p-0"
                aria-label={t('activity.reset')}
                title={t('activity.reset')}
                onSelect={(event) => {
                  event.preventDefault();
                  setPreferences({ ...DEFAULT_ACTIVITY_PREFERENCES });
                  setSnapshot(
                    openActivitySnapshot(
                      effectiveEntries,
                      DEFAULT_ACTIVITY_PREFERENCES,
                      snapshot.activatedAt,
                    ),
                  );
                  if (event.target instanceof HTMLElement)
                    event.target
                      .closest('[role="menu"]')
                      ?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
                      ?.focus();
                }}
              >
                <RotateCcwIcon size={16} />
              </DropdownMenuItem>
            )}
          </div>
          {(['priority', 'pinned', 'scheduled'] as const).map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={preferences[key]}
              onCheckedChange={(checked) =>
                setPreferences((previous) => ({
                  ...previous,
                  [key]: checked === true,
                }))
              }
            >
              {t(
                key === 'priority'
                  ? 'activity.priorityOption'
                  : `activity.${key}`,
              )}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={pending || unread.length === 0}
            onSelect={() =>
              void execute(async () => {
                await onMarkRead(unread);
                if (mounted.current) setResult(t('activity.readDone'));
              })
            }
          >
            {t('activity.markRead')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              setSnapshot(
                clearReadActivitySnapshot(
                  snapshot,
                  effectiveEntries,
                  preferences,
                ),
              )
            }
          >
            {t('activity.clearRead')}
          </DropdownMenuItem>
          {canArchive && (
            <DropdownMenuItem
              disabled={pending || sections.priority.length === 0}
              onSelect={() => setConfirmation([...sections.priority])}
            >
              {t('activity.archive')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </section>
    </DropdownMenu>
  );
}
