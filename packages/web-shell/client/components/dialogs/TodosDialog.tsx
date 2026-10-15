/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  ListTodoIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useWorkspaceActions } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonTodoStatus,
  DaemonTodosSnapshot,
} from '../../daemon/workspace/types';
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
  project: string;
  mtimeMs: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

function statusIcon(status: DaemonTodoStatus) {
  if (status === 'completed') {
    return <CheckCircle2Icon size={14} className={styles.iconDone} />;
  }
  if (status === 'in_progress') {
    return <CircleDotIcon size={14} className={styles.iconProgress} />;
  }
  return <CircleIcon size={14} className={styles.iconPending} />;
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
      patch: { status?: DaemonTodoStatus; dueDate?: string | null },
    ) => {
      const [sessionId, todoId] = key.split(':');
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

  const today = todayIso();

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
          flat.push({
            key: `${session.sessionId}:${todo.id}`,
            sessionId: session.sessionId,
            todoId: todo.id,
            content: todo.content,
            status: todo.status,
            dueDate: todo.dueDate ?? null,
            project: group.project,
            mtimeMs: session.mtimeMs,
          });
        }
      }
    }
    return flat;
  }, [snapshot, query]);

  const projects = useMemo(
    () => (snapshot?.groups ?? []).map((g) => g.project),
    [snapshot],
  );

  const card = (todo: FlatTodo) => {
    const overdue =
      todo.dueDate !== null &&
      todo.dueDate < today &&
      todo.status !== 'completed';
    const dueToday = todo.dueDate === today && todo.status !== 'completed';
    return (
      <div
        key={todo.key}
        className={styles.card}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', todo.key)}
      >
        <div className={styles.cardTop}>
          {statusIcon(todo.status)}
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
      </div>
    );
  };

  const board = (boardItems: FlatTodo[]) => (
    <div className={styles.board}>
      {STATUSES.map((status) => {
        const column = boardItems.filter((i) => i.status === status);
        return (
          <div
            key={status}
            className={styles.column}
            data-testid={`todos-column-${status}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const key = e.dataTransfer.getData('text/plain');
              if (key) void update(key, { status });
            }}
          >
            <div className={styles.columnHeader}>
              {statusIcon(status)}
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
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
        {view === 'project' && (
          <select
            className={styles.select}
            value={project}
            onChange={(e) => setProject(e.target.value)}
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
