/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarIcon,
  CheckCircle2Icon,
  CircleIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  TagIcon,
} from 'lucide-react';
import { useWorkspaceActions } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonTodoStatus,
  DaemonTodosSnapshot,
} from '../../daemon/workspace/types';
import { getDaemonToken } from '../../config/daemon';
import { buildSessionPathname } from '../../utils/sessionPath';
import { useI18n } from '../../i18n';
import styles from './TodosDialog.module.css';

type TodosView = 'kanban' | 'agenda' | 'project';
type AgendaBucket = 'today' | 'nextWeek' | 'nextMonth' | 'later' | 'none';

const STATUSES: readonly DaemonTodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
];

const BUCKETS: readonly AgendaBucket[] = [
  'today',
  'nextWeek',
  'nextMonth',
  'later',
  'none',
];

interface FlatTodo {
  key: string;
  sessionId: string;
  todoId: string;
  content: string;
  status: DaemonTodoStatus;
  dueDate: string | null;
  tags: string[];
  project: string;
  mtimeMs: number;
}

/** Local-time "today" as YYYY-MM-DD — agenda buckets are user-facing, so
 * they must use the user's timezone, not UTC (toISOString was off by a day
 * for any timezone east of UTC in the evening, west of UTC in the morning). */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function bucketOf(due: string | null, today: string): AgendaBucket {
  if (!due) return 'none';
  if (due <= today) return 'today';
  const diffDays = Math.round(
    (Date.parse(`${due}T00:00:00`) - Date.parse(`${today}T00:00:00`)) /
      86_400_000,
  );
  if (diffDays <= 7) return 'nextWeek';
  if (diffDays <= 31) return 'nextMonth';
  return 'later';
}

export function TodosDialog() {
  const actions = useWorkspaceActions();
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DaemonTodosSnapshot | null>(null);
  const [view, setView] = useState<TodosView>('kanban');
  const [project, setProject] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagKey, setTagKey] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6d44e8');

  const statusLabel = useMemo(
    () =>
      ({
        pending: t('todos.filter.pending'),
        in_progress: t('todos.filter.inProgress'),
        completed: t('todos.filter.completed'),
      }) as Record<DaemonTodoStatus, string>,
    [t],
  );

  const bucketLabel = useMemo(
    () =>
      ({
        today: t('todos.today'),
        nextWeek: t('todos.nextWeek'),
        nextMonth: t('todos.nextMonth'),
        later: t('todos.later'),
        none: t('todos.noDueDate'),
      }) as Record<AgendaBucket, string>,
    [t],
  );

  // Flattened items — computed early so the bulk callback can reference it
  // in its dependency array without a temporal-dead-zone error.
  const items: FlatTodo[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const flat: FlatTodo[] = [];
    for (const group of snapshot?.groups ?? []) {
      for (const session of group.sessions) {
        for (const todo of session.todos) {
          if (
            q &&
            !todo.content.toLowerCase().includes(q) &&
            !group.project.toLowerCase().includes(q)
          ) {
            continue;
          }
          if (tagFilter && !(todo.tags ?? []).includes(tagFilter)) {
            continue;
          }
          flat.push({
            key: `${session.sessionId}:${todo.id}`,
            sessionId: session.sessionId,
            todoId: todo.id,
            content: todo.content,
            status: todo.status,
            dueDate: todo.dueDate ?? null,
            tags: todo.tags ?? [],
            project: group.project,
            mtimeMs: session.mtimeMs,
          });
        }
      }
    }
    return flat;
  }, [snapshot, query, tagFilter]);

  // Bulk actions may only touch todos currently on screen. `items` applies
  // the search and tag filters, but the render narrows further per view
  // (agenda hides completed todos, the project view scopes to one project)
  // — this memo mirrors that narrowing so a stale selection can never bulk
  // mutate a todo that is rendered nowhere.
  const visibleKeys = useMemo(() => {
    const narrowed =
      view === 'agenda'
        ? items.filter((i) => i.status !== 'completed')
        : view === 'project' && project
          ? items.filter((i) => i.project === project)
          : items;
    return new Set(narrowed.map((i) => i.key));
  }, [items, view, project]);

  // Kanban needs the completed column, so the page always loads the full
  // snapshot — relevance is handled by the views, not by the aggregate.
  const load = useCallback(async () => {
    try {
      setError(null);
      setSnapshot(await actions.listTodos(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [actions]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (
      key: string,
      patch: {
        status?: DaemonTodoStatus;
        dueDate?: string | null;
        tags?: string[];
        tagDefinition?: { name: string; color: string };
      },
    ) => {
      const sep = key.indexOf(':');
      const sessionId = key.substring(0, sep);
      const todoId = key.substring(sep + 1);
      setBusyKey(key);
      try {
        await actions.updateTodo(sessionId, todoId, patch);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [actions, load],
  );

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const setColumnSelected = useCallback((keys: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  }, []);

  const bulk = useCallback(
    async (patch: { status?: DaemonTodoStatus; dueDate?: string | null }) => {
      setBusyKey('bulk');
      try {
        // Only operate on todos visible in the current view — a stale
        // selection key (view or project switch, filter change, reload)
        // must never mutate a todo rendered nowhere.
        for (const key of selected) {
          if (!visibleKeys.has(key)) continue;
          const sep = key.indexOf(':');
          const sessionId = key.substring(0, sep);
          const todoId = key.substring(sep + 1);
          await actions.updateTodo(sessionId, todoId, patch);
        }
        setSelected(new Set());
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [actions, visibleKeys, load, selected],
  );

  const today = todayIso();

  const projects = useMemo(
    () => (snapshot?.groups ?? []).map((g) => g.project),
    [snapshot],
  );

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags) tags.add(tag);
    }
    for (const name of Object.keys(snapshot?.tagDefinitions ?? {})) {
      tags.add(name);
    }
    return [...tags].sort();
  }, [items, snapshot?.tagDefinitions]);

  const selectToggle = (on: boolean, onClick: () => void, label: string) => (
    <button
      type="button"
      className={on ? styles.selectOn : styles.selectOff}
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={label}
    >
      {on ? <CheckCircle2Icon size={16} /> : <CircleIcon size={16} />}
    </button>
  );

  /**
   * Opens the session's conversation in a new browser tab at the Web Shell's
   * `/session/<id>` route. The pathname goes through `buildSessionPathname`
   * so any deployment base path is preserved, and the daemon token is
   * re-attached from the client's token store (it is stripped from the URL
   * at boot) so the new tab authenticates on token-auth deployments. The
   * token rides in the URL *hash* — like `buildSplitUrl` — because a query
   * parameter is sent to the server on the document GET and can land in
   * proxy/ingress request-URI logs; the fragment never leaves the browser.
   * `readTokenFromLocation()` reads the hash first, and
   * `removeDaemonTokenFromUrl()` scrubs both transports at boot.
   */
  const openConversation = (sessionId: string) => {
    const url = new URL(window.location.href);
    url.pathname = buildSessionPathname(window.location.pathname, sessionId);
    const token = getDaemonToken();
    if (token) url.hash = new URLSearchParams({ token }).toString();
    window.open(url.toString(), '_blank', 'noopener');
  };

  const card = (todo: FlatTodo) => {
    const isSel = selected.has(todo.key);
    const overdue =
      todo.dueDate !== null &&
      todo.dueDate < today &&
      todo.status !== 'completed';
    const dueToday = todo.dueDate === today && todo.status !== 'completed';
    return (
      <div
        key={todo.key}
        className={`${styles.card} ${isSel ? styles.cardSelected : ''}`}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', todo.key)}
      >
        <div className={styles.cardTop}>
          {selectToggle(isSel, () => toggleSelect(todo.key), todo.content)}
          <span
            className={
              todo.status === 'completed'
                ? styles.cardContentDone
                : styles.cardContent
            }
          >
            {todo.content}
          </span>
        </div>
        <div className={styles.cardMeta}>
          {todo.status === 'in_progress' && (
            <span className={styles.pillProgress}>
              {t('todos.filter.inProgress')}
            </span>
          )}
          {todo.tags.map((tag) => {
            const def = snapshot?.tagDefinitions?.[tag];
            return (
              <span
                key={tag}
                className={styles.tagChip}
                style={
                  def
                    ? { backgroundColor: def.color, color: '#fff' }
                    : undefined
                }
              >
                {tag}
              </span>
            );
          })}
          <span className={styles.cardProject}>{todo.project}</span>
          {todo.dueDate && (
            <span
              className={`${styles.dueChip} ${
                overdue
                  ? styles.dueOverdue
                  : dueToday
                    ? styles.dueToday
                    : styles.dueFuture
              }`}
            >
              <CalendarIcon size={10} /> {todo.dueDate}
              {overdue ? ` · ${t('todos.overdue')}` : ''}
            </span>
          )}
          <span className={styles.cardSession}>
            {todo.sessionId.slice(0, 8)}
          </span>
        </div>
        <div className={styles.cardActions}>
          {todo.status !== 'completed' && (
            <button
              type="button"
              className={styles.miniButton}
              disabled={busyKey === todo.key}
              title={t('todos.markDone')}
              onClick={() => void update(todo.key, { status: 'completed' })}
            >
              ✓
            </button>
          )}
          {todo.status === 'pending' && (
            <button
              type="button"
              className={styles.miniButton}
              disabled={busyKey === todo.key}
              title={t('todos.filter.inProgress')}
              onClick={() => void update(todo.key, { status: 'in_progress' })}
            >
              ▶
            </button>
          )}
          <button
            type="button"
            className={styles.miniButton}
            title={t('todos.setDueDate')}
            onClick={() => setDateKey(dateKey === todo.key ? null : todo.key)}
          >
            <CalendarIcon size={11} />
          </button>
          <button
            type="button"
            className={styles.miniButton}
            title={t('todos.editTags')}
            aria-label={t('todos.editTags')}
            onClick={() => {
              setTagKey(tagKey === todo.key ? null : todo.key);
              setNewTagName('');
              setNewTagColor('#6d44e8');
            }}
          >
            <TagIcon size={11} />
          </button>
          <button
            type="button"
            className={styles.miniButton}
            title={t('todos.viewConversation')}
            aria-label={t('todos.viewConversation')}
            onClick={() => openConversation(todo.sessionId)}
          >
            <MessagesSquareIcon size={11} />
          </button>
        </div>
        {dateKey === todo.key && (
          <div className={styles.dueEditor}>
            <input
              type="date"
              defaultValue={todo.dueDate ?? ''}
              onChange={(e) => {
                const value = e.target.value || null;
                void update(todo.key, { dueDate: value });
                setDateKey(null);
              }}
            />
            {todo.dueDate && (
              <button
                type="button"
                className={styles.miniButton}
                title={t('todos.clearDueDate')}
                onClick={() => {
                  void update(todo.key, { dueDate: null });
                  setDateKey(null);
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        {tagKey === todo.key && (
          <div className={styles.tagEditor}>
            <div className={styles.tagEditorRow}>
              {todo.tags.map((tag) => {
                const def = snapshot?.tagDefinitions?.[tag];
                return (
                  <button
                    key={tag}
                    type="button"
                    className={styles.tagChipRemovable}
                    style={
                      def
                        ? { backgroundColor: def.color, color: '#fff' }
                        : undefined
                    }
                    onClick={() => {
                      void update(todo.key, {
                        tags: todo.tags.filter((t) => t !== tag),
                      });
                    }}
                  >
                    {tag} ✕
                  </button>
                );
              })}
            </div>
            <div className={styles.tagEditorRow}>
              {Object.entries(snapshot?.tagDefinitions ?? {})
                .filter(([name]) => !todo.tags.includes(name))
                .map(([name, def]) => (
                  <button
                    key={name}
                    type="button"
                    className={styles.tagChipAdd}
                    style={{ backgroundColor: def.color, color: '#fff' }}
                    onClick={() => {
                      void update(todo.key, { tags: [...todo.tags, name] });
                    }}
                  >
                    + {name}
                  </button>
                ))}
            </div>
            <div className={styles.tagEditorRow}>
              <input
                type="text"
                className={styles.tagInput}
                placeholder={t('todos.newTagName')}
                value={newTagName}
                maxLength={24}
                onChange={(e) => setNewTagName(e.target.value)}
              />
              <input
                type="color"
                className={styles.tagColorInput}
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
              />
              <button
                type="button"
                className={styles.miniButton}
                disabled={!newTagName.trim() || busyKey === todo.key}
                onClick={() => {
                  const name = newTagName.trim();
                  if (!name) return;
                  void update(todo.key, {
                    tags: [...new Set([...todo.tags, name])],
                    tagDefinition: { name, color: newTagColor },
                  });
                  setNewTagName('');
                }}
              >
                {t('todos.addTag')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const board = (boardItems: FlatTodo[]) => (
    <div className={styles.board}>
      {STATUSES.map((status) => {
        const column = boardItems.filter((i) => i.status === status);
        const columnKeys = column.map((i) => i.key);
        const allSelected =
          columnKeys.length > 0 && columnKeys.every((key) => selected.has(key));
        return (
          <div
            key={status}
            className={styles.column}
            data-testid={`todos-column-${status}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add(styles.columnDragOver);
            }}
            onDragLeave={(e) => {
              e.currentTarget.classList.remove(styles.columnDragOver);
            }}
            onDrop={(e) => {
              e.currentTarget.classList.remove(styles.columnDragOver);
              const key = e.dataTransfer.getData('text/plain');
              if (key) void update(key, { status });
            }}
          >
            <div className={styles.columnHeader}>
              {selectToggle(
                allSelected,
                () => setColumnSelected(columnKeys, !allSelected),
                statusLabel[status],
              )}
              <span>{statusLabel[status]}</span>
              <span className={styles.columnCount}>{column.length}</span>
            </div>
            {column.map(card)}
          </div>
        );
      })}
    </div>
  );

  const agenda = () => {
    const open = items.filter((i) => i.status !== 'completed');
    return (
      <div className={styles.agenda}>
        {BUCKETS.map((bucket) => {
          const rows = open
            .filter((i) => bucketOf(i.dueDate, today) === bucket)
            .sort((a, b) =>
              a.dueDate && b.dueDate
                ? a.dueDate.localeCompare(b.dueDate)
                : a.dueDate
                  ? -1
                  : b.dueDate
                    ? 1
                    : a.content.localeCompare(b.content),
            );
          return (
            <section key={bucket} className={styles.bucket}>
              <header className={styles.bucketHeader}>
                <span>{bucketLabel[bucket]}</span>
                <span className={styles.columnCount}>{rows.length}</span>
              </header>
              <div className={styles.bucketBody}>{rows.map(card)}</div>
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        {(
          [
            ['kanban', t('todos.view.kanban')],
            ['agenda', t('todos.view.agenda')],
            ['project', t('todos.view.project')],
          ] as Array<[TodosView, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={id === view ? styles.filterActive : styles.filter}
            onClick={() => {
              setView(id);
              // Switching views changes which todos are on screen — drop
              // the selection instead of carrying it into the new view.
              setSelected(new Set());
            }}
          >
            {label}
          </button>
        ))}
        {view === 'project' && (
          <select
            className={styles.select}
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setSelected(new Set());
            }}
          >
            <option value="">{t('todos.allProjects')}</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <input
          className={styles.search}
          type="search"
          placeholder="…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={styles.filter}
          onClick={() => void load()}
          aria-label={t('todos.refresh')}
          title={t('todos.refresh')}
        >
          <RefreshCwIcon size={13} />
        </button>
      </div>

      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>
            {[...selected].filter((key) => visibleKeys.has(key)).length}{' '}
            {t('todos.selected')}
          </span>
          <button
            type="button"
            className={styles.miniButton}
            disabled={busyKey === 'bulk'}
            onClick={() => void bulk({ status: 'completed' })}
          >
            ✓ {t('todos.markDone')}
          </button>
          <input
            type="date"
            className={styles.bulkDate}
            onChange={(e) => {
              const value = e.target.value;
              if (value) void bulk({ dueDate: value });
            }}
            title={t('todos.setDueDate')}
          />
          <button
            type="button"
            className={styles.miniButton}
            onClick={() => setSelected(new Set())}
          >
            ✕
          </button>
        </div>
      )}

      {allTags.length > 0 && (
        <div className={styles.tagFilterRow}>
          {allTags.map((tag) => {
            const def = snapshot?.tagDefinitions?.[tag];
            const active = tagFilter === tag;
            return (
              <button
                key={tag}
                type="button"
                className={`${styles.tagFilterChip} ${active ? styles.tagFilterChipActive : ''}`}
                style={
                  !active && def
                    ? { borderColor: def.color }
                    : active && def
                      ? {
                          backgroundColor: def.color,
                          color: '#fff',
                          borderColor: def.color,
                        }
                      : undefined
                }
                onClick={() => setTagFilter(active ? null : tag)}
              >
                {tag}
              </button>
            );
          })}
          {tagFilter && (
            <button
              type="button"
              className={styles.miniButton}
              onClick={() => setTagFilter(null)}
            >
              ✕ {t('todos.clearTagFilter')}
            </button>
          )}
        </div>
      )}

      {snapshot && (
        <div className={styles.totals}>
          <span>
            <ListTodoIcon size={12} /> {snapshot.totals.projects}{' '}
            {t('todos.allProjects').toLowerCase()}
          </span>
          <span>
            {snapshot.totals.sessions} {t('todos.sessions')}
          </span>
          <span className={styles.totalOpen}>{snapshot.totals.open}</span>
          <span className={styles.totalDone}>{snapshot.totals.completed}</span>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
      {!error && items.length === 0 && (
        <div className={styles.empty}>{t('todos.empty')}</div>
      )}

      {view === 'kanban' && board(items)}
      {view === 'agenda' && agenda()}
      {view === 'project' &&
        board(project ? items.filter((i) => i.project === project) : items)}
    </div>
  );
}
