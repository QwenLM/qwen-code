/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonGitWorktree,
  DaemonGitWorktreeStatus,
  DaemonGitWorktreesResult,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import styles from './GitWorktreesDialog.module.css';

const STATUS_CONCURRENCY = 3;
const SESSION_PAGE_SIZE = 100;
const BLOCKING_CODES = new Set([
  'worktree_dirty',
  'worktree_in_use',
  'worktree_status_unknown',
]);

interface RemoveState {
  path: string;
  /** Daemon refused without `force`; the code and its count. */
  blocked?: { code: string; count: number };
  error?: string;
  busy: boolean;
}

function errorBody(error: unknown): Record<string, unknown> | null {
  const body =
    error && typeof error === 'object'
      ? (error as { body?: unknown }).body
      : undefined;
  return body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : null;
}

function baseName(target: string): string {
  return target.split(/[/\\]/).filter(Boolean).at(-1) ?? target;
}

function changeCount(status: DaemonGitWorktreeStatus): number {
  return (
    (status.staged ?? 0) +
    (status.unstaged ?? 0) +
    (status.untracked ?? 0) +
    (status.conflicted ?? 0)
  );
}

function WorktreeRow({
  worktree,
  status,
  sessions,
  removal,
  onOpenSession,
  onRemove,
  onCancelRemove,
}: {
  worktree: DaemonGitWorktree;
  status: DaemonGitWorktreeStatus | null | undefined;
  sessions: DaemonSessionSummary[];
  removal: RemoveState | null;
  onOpenSession?: (sessionId: string) => void;
  onRemove: (path: string, force: boolean) => void;
  onCancelRemove: () => void;
}) {
  const { t } = useI18n();
  const removable = !worktree.isMain && !worktree.bare && !worktree.isWorkspace;
  const skipStatus = worktree.prunable !== undefined || worktree.bare;

  let statusNode: ReactNode = null;
  if (!skipStatus) {
    if (status === undefined) {
      statusNode = (
        <span className={styles.status}>
          <Loader2Icon size={11} className={styles.spin} />
        </span>
      );
    } else if (status === null || !status.available) {
      statusNode = (
        <span className={styles.status}>{t('gitWorktrees.statusError')}</span>
      );
    } else {
      const changes = changeCount(status);
      statusNode = (
        <span
          className={`${styles.status}${changes > 0 ? ` ${styles.statusDirty}` : ''}`}
        >
          {changes > 0
            ? t('gitWorktrees.dirty', { count: changes })
            : t('gitWorktrees.clean')}
        </span>
      );
    }
  }

  let confirmNode: ReactNode = null;
  if (removal) {
    let text: string;
    if (removal.error) {
      text = removal.error;
    } else if (removal.blocked?.code === 'worktree_dirty') {
      text = t('gitWorktrees.blockedDirty', { count: removal.blocked.count });
    } else if (removal.blocked?.code === 'worktree_in_use') {
      text = t('gitWorktrees.blockedInUse', { count: removal.blocked.count });
    } else if (removal.blocked) {
      text = t('gitWorktrees.blockedUnknown');
    } else {
      text = t('gitWorktrees.confirm');
    }
    confirmNode = (
      <div className={styles.confirm} role="alert">
        <span
          className={`${styles.confirmText}${removal.error ? ` ${styles.error}` : ''}`}
        >
          {text}
        </span>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.btn}
            disabled={removal.busy}
            onClick={onCancelRemove}
          >
            {t('gitWorktrees.cancel')}
          </button>
          {!removal.error && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={removal.busy}
              onClick={() =>
                onRemove(worktree.path, removal.blocked !== undefined)
              }
            >
              {removal.busy && (
                <Loader2Icon size={12} className={styles.spin} />
              )}
              {removal.busy
                ? t('gitWorktrees.removing')
                : removal.blocked
                  ? t('gitWorktrees.removeAnyway')
                  : t('gitWorktrees.remove')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row} data-testid="git-worktree-row">
      <div className={styles.rowMain}>
        <span className={styles.name} title={worktree.path}>
          {worktree.slug ?? baseName(worktree.path)}
        </span>
        {worktree.isMain && (
          <span className={`${styles.badge} ${styles.badgeMain}`}>
            {t('gitWorktrees.main')}
          </span>
        )}
        {worktree.isWorkspace && (
          <span className={`${styles.badge} ${styles.badgeMain}`}>
            {t('gitWorktrees.current')}
          </span>
        )}
        {worktree.locked !== undefined && (
          <span
            className={`${styles.badge} ${styles.badgeWarn}`}
            title={worktree.locked || undefined}
          >
            {t('gitWorktrees.locked')}
          </span>
        )}
        {worktree.prunable !== undefined && (
          <span
            className={`${styles.badge} ${styles.badgeWarn}`}
            title={worktree.prunable || undefined}
          >
            {t('gitWorktrees.prunable')}
          </span>
        )}
        <span className={styles.branch}>
          <GitBranchIcon size={11} />
          {worktree.branch ??
            (worktree.detached
              ? t('gitWorktrees.detached')
              : t('gitWorktrees.bare'))}
        </span>
        {worktree.head && (
          <span className={styles.meta} title={worktree.head}>
            {worktree.head.slice(0, 7)}
          </span>
        )}
        {statusNode}
        <span className={styles.spacer} />
        {removable && !removal && (
          <button
            type="button"
            className={styles.removeBtn}
            onClick={() => onRemove(worktree.path, false)}
            aria-label={t('gitWorktrees.removeLabel', {
              name: worktree.slug ?? baseName(worktree.path),
            })}
          >
            <Trash2Icon size={13} />
          </button>
        )}
      </div>
      <div className={styles.path}>{worktree.path}</div>
      {sessions.length > 0 && (
        <div className={styles.sessions}>
          {sessions.map((session) => {
            const live =
              (session.clientCount ?? 0) > 0 ||
              session.hasActivePrompt === true;
            const label = session.displayName || session.sessionId.slice(0, 8);
            return (
              <button
                key={session.sessionId}
                type="button"
                className={`${styles.sessionChip}${live ? ` ${styles.sessionLive}` : ''}`}
                title={label}
                disabled={!onOpenSession}
                onClick={() => onOpenSession?.(session.sessionId)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {confirmNode}
    </div>
  );
}

export function GitWorktreesContent({
  workspaceCwd,
  onOpenSession,
  onNewWorktreeSession,
  onSubtitleChange,
}: {
  workspaceCwd: string;
  onOpenSession?: (sessionId: string) => void;
  onNewWorktreeSession?: () => void;
  onSubtitleChange?: (subtitle: string | undefined) => void;
}) {
  const { client } = useWorkspace();
  const { t } = useI18n();
  const [list, setList] = useState<DaemonGitWorktreesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, DaemonGitWorktreeStatus | null>
  >({});
  const [filter, setFilter] = useState('');
  const [removal, setRemoval] = useState<RemoveState | null>(null);
  const [generation, setGeneration] = useState(0);
  // Paths whose status has been fetched; a refresh after a removal only
  // fetches the entries it has not seen.
  const fetchedRef = useRef(new Set<string>());

  useEffect(() => {
    fetchedRef.current = new Set();
    setStatuses({});
  }, [client, workspaceCwd]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    const ws = client.workspaceByCwd(workspaceCwd);
    void Promise.all([
      ws.workspaceGitWorktrees(),
      ws
        .listWorkspaceSessions({ pageSize: SESSION_PAGE_SIZE })
        .catch(() => [] as DaemonSessionSummary[]),
    ])
      .then(([result, sessionList]) => {
        if (cancelled) return;
        setList(result);
        setSessions(sessionList);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd, generation]);

  // Working-tree state is one git process per worktree; fetch it after the
  // list renders, a few at a time, so a repository with hundreds of
  // worktrees still lists instantly.
  useEffect(() => {
    if (!list?.available) return;
    let cancelled = false;
    const ws = client.workspaceByCwd(workspaceCwd);
    const queue = list.worktrees
      .filter(
        (w) =>
          w.prunable === undefined &&
          !w.bare &&
          !fetchedRef.current.has(w.path),
      )
      .map((w) => w.path);
    const worker = async () => {
      while (!cancelled) {
        const next = queue.shift();
        if (next === undefined) return;
        let status: DaemonGitWorktreeStatus | null;
        try {
          status = await ws.workspaceGitWorktreeStatus(next);
        } catch {
          status = null;
        }
        if (cancelled) return;
        fetchedRef.current.add(next);
        setStatuses((prev) => ({ ...prev, [next]: status }));
      }
    };
    void Promise.all(
      Array.from({ length: STATUS_CONCURRENCY }, () => worker()),
    );
    return () => {
      cancelled = true;
    };
  }, [client, workspaceCwd, list]);

  const subtitle = list?.available
    ? t('gitWorktrees.subtitle', { count: list.worktrees.length })
    : undefined;
  useEffect(() => {
    onSubtitleChange?.(subtitle);
  }, [onSubtitleChange, subtitle]);

  const remove = useCallback(
    (path: string, force: boolean) => {
      setRemoval((prev) => {
        if (!prev || prev.path !== path) return { path, busy: false };
        return { ...prev, busy: true };
      });
      if (!removal || removal.path !== path) return;
      client
        .workspaceByCwd(workspaceCwd)
        .workspaceGitRemoveWorktree(path, { force })
        .then(() => {
          setRemoval(null);
          setGeneration((g) => g + 1);
        })
        .catch((err: unknown) => {
          const body = errorBody(err);
          const code = typeof body?.['code'] === 'string' ? body['code'] : '';
          if (BLOCKING_CODES.has(code)) {
            const count =
              typeof body?.['changes'] === 'number'
                ? body['changes']
                : typeof body?.['sessions'] === 'number'
                  ? body['sessions']
                  : 0;
            setRemoval({ path, blocked: { code, count }, busy: false });
            return;
          }
          const message =
            typeof body?.['error'] === 'string'
              ? body['error']
              : t('gitWorktrees.removeFailed');
          setRemoval({ path, error: message, busy: false });
        });
    },
    [client, workspaceCwd, removal, t],
  );

  const q = filter.trim().toLowerCase();
  const visible =
    list?.worktrees.filter(
      (w) =>
        !q ||
        w.path.toLowerCase().includes(q) ||
        (w.branch ?? '').toLowerCase().includes(q) ||
        (w.slug ?? '').toLowerCase().includes(q),
    ) ?? [];

  let body: ReactNode;
  if (loading && !list) {
    body = (
      <div className={styles.placeholder}>{t('gitWorktrees.loading')}</div>
    );
  } else if (error) {
    body = <div className={styles.placeholder}>{t('gitWorktrees.error')}</div>;
  } else if (!list || !list.available) {
    body = (
      <div className={styles.placeholder}>{t('gitWorktrees.unavailable')}</div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className={styles.placeholder}>
        {t(q ? 'gitWorktrees.noMatches' : 'gitWorktrees.empty')}
      </div>
    );
  } else {
    body = (
      <div className={styles.list}>
        {visible.map((worktree) => (
          <WorktreeRow
            key={worktree.path}
            worktree={worktree}
            status={statuses[worktree.path]}
            sessions={sessions.filter(
              (session) => session.worktree?.path === worktree.path,
            )}
            removal={removal?.path === worktree.path ? removal : null}
            onOpenSession={onOpenSession}
            onRemove={remove}
            onCancelRemove={() => setRemoval(null)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.content}>
      <div className={styles.toolbar}>
        <label className={styles.filter}>
          <SearchIcon size={13} />
          <input
            className={styles.filterInput}
            type="search"
            placeholder={t('gitWorktrees.filter')}
            aria-label={t('gitWorktrees.filter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {onNewWorktreeSession && (
          <button
            type="button"
            className={styles.newButton}
            onClick={onNewWorktreeSession}
          >
            <PlusIcon size={13} />
            {t('gitWorktrees.newSession')}
          </button>
        )}
      </div>
      {body}
    </div>
  );
}
