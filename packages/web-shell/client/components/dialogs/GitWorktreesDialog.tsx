/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
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
/** One identity for "no sessions", so a row's props stay equal. */
const NO_SESSIONS: DaemonSessionSummary[] = [];
const SESSION_PAGE_SIZE = 100;
// Refusals a second, explicit click can override. `worktree_remove_refused`
// is git's own refusal of a removal that changed nothing, which is forceable
// far more often than not — see the route.
const BLOCKING_CODES = new Set([
  'worktree_dirty',
  'worktree_in_use',
  'worktree_locked',
  'worktree_nested_repository',
  'worktree_operation_in_progress',
  'worktree_remove_refused',
  'worktree_unmerged_commits',
  'worktree_status_unknown',
]);

interface RemoveState {
  path: string;
  /**
   * Daemon refused without `force`: the code, its own count, git's words,
   * and the uncommitted change count when the same click would discard that
   * too without the refusal above mentioning it.
   */
  blocked?: {
    code: string;
    count: number;
    detail?: string;
    /** Uncommitted work the same click would discard, whatever it refused on. */
    changes?: number;
    /** That work could not be counted, which is its own warning. */
    statusUnknown?: boolean;
    /** A halted rebase, merge, cherry-pick, revert or bisect. */
    operation?: string;
    /** HEAD of a detached worktree that no ref contains. */
    unmergedHead?: string;
    /** The checkout holds an initialised submodule with its own repository. */
    submodules?: boolean;
  };
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

/**
 * How a refusal or a failure explains itself, or `null` when the removal is
 * neither and the wording depends on the row instead.
 *
 * Lifted out of the row because the same answer has to be said in two places:
 * in the row's panel, and — when that row is not on screen to carry it — in
 * the notice above the list. A refusal reported without its reason is the
 * one thing a refusal exists to avoid.
 */
function refusalSentence(
  t: (key: string, vars?: Record<string, string | number>) => string,
  removal: RemoveState,
): string | null {
  if (removal.error) return removal.error;
  const blocked = removal.blocked;
  if (!blocked) return null;
  if (blocked.code === 'worktree_dirty') {
    return t('gitWorktrees.blockedDirty', { count: blocked.count });
  }
  if (blocked.code === 'worktree_in_use') {
    return t('gitWorktrees.blockedInUse', { count: blocked.count });
  }
  if (blocked.code === 'worktree_locked') {
    return t('gitWorktrees.blockedLocked', { reason: blocked.detail ?? '' });
  }
  if (blocked.code === 'worktree_nested_repository') {
    return t('gitWorktrees.blockedSubmodules');
  }
  if (blocked.code === 'worktree_unmerged_commits') {
    return t('gitWorktrees.blockedUnmerged', {
      head: blocked.unmergedHead ?? '',
    });
  }
  if (blocked.code === 'worktree_operation_in_progress') {
    return t('gitWorktrees.blockedOperation', {
      operation: blocked.operation ?? '',
    });
  }
  if (blocked.code === 'worktree_remove_refused') {
    // git's own sentence says more than any wording here could, and it
    // names the override. Fall back only when the daemon sent none.
    return blocked.detail || t('gitWorktrees.blockedRefused');
  }
  return t('gitWorktrees.blockedUnknown');
}

const WorktreeRow = memo(function WorktreeRow({
  worktree,
  status,
  sessions,
  removal,
  busy,
  onOpenSession,
  onRemove,
  onCancelRemove,
}: {
  worktree: DaemonGitWorktree;
  status: DaemonGitWorktreeStatus | null | undefined;
  sessions: DaemonSessionSummary[];
  removal: RemoveState | null;
  /** A removal of THIS worktree is in flight, whichever row is confirming. */
  busy: boolean;
  onOpenSession?: (sessionId: string) => void;
  onRemove: (path: string, force: boolean) => void;
  onCancelRemove: () => void;
}) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // Not just open or shut: the panel swaps its own buttons as a confirmation
  // becomes a refusal and a refusal becomes an error, and the keyboard falls
  // out of it each time one it was on is unmounted.
  const confirmShape =
    removal === null
      ? null
      : (removal.error ?? removal.blocked?.code ?? 'confirm');
  // On a change of shape, not on arrival: filtering a row out unmounts it
  // while the removal state lives on in the parent, so clearing the filter
  // mounts it again with the panel already open — and focusing then would
  // take the keyboard out of the filter box the user is still typing in.
  const focusedShape = useRef(confirmShape);
  useEffect(() => {
    if (confirmShape !== null && focusedShape.current !== confirmShape) {
      confirmRef.current?.querySelector('button')?.focus();
    }
    focusedShape.current = confirmShape;
  }, [confirmShape]);
  const removable = !worktree.isMain && !worktree.bare && !worktree.isWorkspace;
  const skipStatus = worktree.prunable !== undefined || worktree.bare;

  let statusNode: ReactNode = null;
  if (!skipStatus) {
    if (status === undefined) {
      statusNode = (
        <span className={styles.status} data-testid="worktree-status">
          <Loader2Icon size={11} className={styles.spin} />
        </span>
      );
    } else if (status === null || !status.available) {
      statusNode = (
        <span className={styles.status} data-testid="worktree-status">
          {t('gitWorktrees.statusError')}
        </span>
      );
    } else {
      const changes = changeCount(status);
      statusNode = (
        <span
          className={`${styles.status}${changes > 0 ? ` ${styles.statusDirty}` : ''}`}
          data-testid="worktree-status"
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
    const refusal = refusalSentence(t, removal);
    let text: string;
    if (refusal !== null) {
      text = refusal;
    } else if (worktree.prunable !== undefined) {
      // Git has already lost this worktree, so clearing the entry is
      // bookkeeping: promising to delete a directory would be wrong either
      // way — it is usually gone already, and where it survives its files are
      // left alone. What does go is the bookkeeping git kept for it, which is
      // what the wording says.
      text = t('gitWorktrees.confirmStale');
    } else if (worktree.branch === null && worktree.detached) {
      // No branch to keep, so the ordinary wording would promise one. What
      // this removal really takes is every commit nothing else points at.
      text = t('gitWorktrees.confirmDetached');
    } else {
      text = t('gitWorktrees.confirm');
    }
    // Whatever the daemon refused on, the second click overrides all of it at
    // once, so everything else it would take is named here too. Each stays its
    // own sentence: a lock reason is free-form text that need not end in
    // punctuation.
    const blocked = removal.blocked;
    const also: string[] = [];
    if (blocked) {
      if (blocked.changes !== undefined && blocked.code !== 'worktree_dirty') {
        also.push(t('gitWorktrees.blockedDirty', { count: blocked.changes }));
      }
      if (blocked.statusUnknown && blocked.code !== 'worktree_status_unknown') {
        also.push(t('gitWorktrees.blockedUnknown'));
      }
      if (
        blocked.unmergedHead &&
        blocked.code !== 'worktree_unmerged_commits'
      ) {
        also.push(
          t('gitWorktrees.blockedUnmerged', { head: blocked.unmergedHead }),
        );
      }
      if (blocked.submodules && blocked.code !== 'worktree_nested_repository') {
        also.push(t('gitWorktrees.blockedSubmodules'));
      }
      if (
        blocked.operation &&
        blocked.code !== 'worktree_operation_in_progress'
      ) {
        also.push(
          t('gitWorktrees.blockedOperation', { operation: blocked.operation }),
        );
      }
    }
    confirmNode = (
      <div className={styles.confirm} role="alert" ref={confirmRef}>
        <span
          className={`${styles.confirmText}${removal.error ? ` ${styles.error}` : ''}`}
        >
          <span className={styles.sentence}>{text}</span>
          {also.map((sentence) => (
            <span key={sentence} className={styles.sentence}>
              {sentence}
            </span>
          ))}
        </span>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.btn}
            disabled={removal.busy || busy}
            onClick={onCancelRemove}
          >
            {t('gitWorktrees.cancel')}
          </button>
          {!removal.error && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={removal.busy || busy}
              onClick={() =>
                onRemove(worktree.path, removal.blocked !== undefined)
              }
            >
              {(removal.busy || busy) && (
                <Loader2Icon size={12} className={styles.spin} />
              )}
              {removal.busy || busy
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
          {/* The only other truncated text in the row carries a title; a
              branch name is just as likely to be the part that is cut. */}
          <span
            className={styles.branchName}
            title={worktree.branch ?? undefined}
          >
            {worktree.branch ??
              (worktree.detached
                ? t('gitWorktrees.detached')
                : t('gitWorktrees.bare'))}
          </span>
        </span>
        {worktree.head && (
          <span className={styles.meta} title={worktree.head}>
            {worktree.head.slice(0, 7)}
          </span>
        )}
        {statusNode}
        <span className={styles.spacer} />
        {removable && !removal && !busy && (
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
});

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
  // Kept through a failed refresh only while a removal's *explanation* is on
  // screen, which is what the placeholder would otherwise replace. An
  // unanswered confirmation is not one: it would hold a list that may already
  // be missing the row a successful removal took, with its button still
  // armed. With no
  // explanation to protect, a stale list is worse than saying nothing: the
  // rows would still show a worktree the removal just took away.
  const [list, setList] = useState<DaemonGitWorktreesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, DaemonGitWorktreeStatus | null>
  >({});
  const [filter, setFilter] = useState('');
  const [removal, setRemoval] = useState<RemoveState | null>(null);
  // Outlives the row it is about: the removal succeeded, so the refresh that
  // follows drops that row, and a message rendered inside it would go with it.
  const [notice, setNotice] = useState<string | null>(null);
  // Removals in flight, by path. A confirmation can only be open on one row,
  // so without this a row whose request is outstanding re-arms its trash
  // button the moment the user opens a confirmation somewhere else.
  const [removing, setRemoving] = useState<readonly string[]>([]);
  // Which row is confirming, read synchronously: a request settles long after
  // the render that issued it, and the answer has to reach the row it is
  // about or, failing that, somewhere the user will see it.
  const confirmPathRef = useRef<string | null>(null);
  // Which repository the rows belong to, read when a request settles: the
  // answer to a removal in one workspace means nothing in the next.
  const shownWorkspaceRef = useRef(workspaceCwd);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    // Another workspace is another repository: its worktrees and their state
    // have nothing to do with what is on screen, so drop both rather than
    // render the previous repository's rows until the new list lands.
    setList(null);
    setStatuses({});
    setNotice(null);
    setRemoving([]);
    confirmPathRef.current = null;
    shownWorkspaceRef.current = workspaceCwd;
    // A confirmation is about a row of the previous repository, and it is
    // matched to rows by path — which another repository can spell the same.
    setRemoval(null);
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
  //
  // Every list this effect sees is read again rather than reused: another
  // session can dirty a worktree while this tab sits open, and a badge that
  // says "clean" because it was cached is worse than one that takes a moment
  // to arrive. Values already on screen stay until their replacement lands,
  // so no row flashes empty during a refresh.
  useEffect(() => {
    if (!list?.available) return;
    let cancelled = false;
    const ws = client.workspaceByCwd(workspaceCwd);
    const queue = list.worktrees
      .filter((w) => w.prunable === undefined && !w.bare)
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
      const opening = !removal || removal.path !== path;
      confirmPathRef.current = path;
      setRemoval(opening ? { path, busy: false } : { ...removal, busy: true });
      if (opening) return;
      if (removing.includes(path)) return;
      setNotice(null);
      setRemoving((prev) => [...prev, path]);
      // Every write below is scoped to the path it is about: by the time a
      // request settles the user may be confirming a different row, and this
      // state is what puts a "Remove anyway" button under their cursor.
      const settle = (next: RemoveState | null) => {
        if (shownWorkspaceRef.current !== workspaceCwd) return;
        if (confirmPathRef.current === path) {
          confirmPathRef.current = next?.path ?? null;
          setRemoval(next);
          return;
        }
        // The user moved to another row, so this answer has no panel to land
        // in. A refusal dropped here would be a destructive action declined
        // with nothing said about it.
        if (next?.blocked || next?.error) {
          setNotice(
            t('gitWorktrees.refusedElsewhere', {
              name: baseName(path),
              reason: refusalSentence(t, next) ?? '',
            }),
          );
        }
      };
      // Guarded like every other write here: two workspaces of one
      // repository list the same worktree paths, so an answer arriving after
      // a switch could clear the in-flight mark of a removal it is not about.
      const finish = () => {
        if (shownWorkspaceRef.current !== workspaceCwd) return;
        setRemoving((prev) => prev.filter((inFlight) => inFlight !== path));
      };
      client
        .workspaceByCwd(workspaceCwd)
        .workspaceGitRemoveWorktree(path, { force })
        .then((result) => {
          finish();
          settle(null);
          if (shownWorkspaceRef.current !== workspaceCwd) return;
          // The row is about to disappear, which on its own reads as "the
          // directory is gone" — the very thing the confirmation promised and
          // the daemon is reporting it could not do.
          if (result?.directoryRemains) {
            setNotice(
              t('gitWorktrees.keptDirectory', { name: baseName(path) }),
            );
          }
          setGeneration((g) => g + 1);
        })
        .catch((err: unknown) => {
          finish();
          if (shownWorkspaceRef.current !== workspaceCwd) return;
          // Even a refusal can leave the repository changed — the daemon's
          // last resort for a stale entry takes and releases git's own locks
          // across the repository, and can prune an entry and then report the
          // refusal it found afterwards — so re-read the list rather than
          // leaving rows on screen that git no longer has.
          setGeneration((g) => g + 1);
          const body = errorBody(err);
          const code = typeof body?.['code'] === 'string' ? body['code'] : '';
          if (BLOCKING_CODES.has(code)) {
            // Chosen by code, not by which field happens to be present:
            // an in-use refusal carries both, and reading `changes` there
            // would report uncommitted work as a number of sessions.
            const field = code === 'worktree_in_use' ? 'sessions' : 'changes';
            const count = typeof body?.[field] === 'number' ? body[field] : 0;
            const detail =
              typeof body?.['detail'] === 'string'
                ? body['detail']
                : typeof body?.['reason'] === 'string'
                  ? body['reason']
                  : undefined;
            const changes =
              typeof body?.['changes'] === 'number'
                ? body['changes']
                : undefined;
            const statusUnknown = body?.['statusUnknown'] === true;
            const operation =
              typeof body?.['operation'] === 'string'
                ? body['operation']
                : undefined;
            const unmergedHead =
              typeof body?.['unmergedHead'] === 'string'
                ? body['unmergedHead']
                : undefined;
            const submodules = body?.['submodules'] === true;
            settle({
              path,
              blocked: {
                code,
                count,
                ...(detail ? { detail } : {}),
                ...(changes !== undefined ? { changes } : {}),
                ...(statusUnknown ? { statusUnknown: true } : {}),
                ...(operation ? { operation } : {}),
                ...(unmergedHead ? { unmergedHead } : {}),
                ...(submodules ? { submodules: true } : {}),
              },
              busy: false,
            });
            return;
          }
          // The daemon names which workspace blocks the removal, because the
          // one that does may be rooted below the worktree — and then the
          // sentence alone leaves the user with nothing to go and remove.
          if (code === 'worktree_is_workspace') {
            const root = body?.['workspaceCwd'];
            settle({
              path,
              error: t('gitWorktrees.blockedWorkspaceHere', {
                name: typeof root === 'string' ? baseName(root) : '',
              }),
              busy: false,
            });
            return;
          }
          // A classified git failure carries the machine token in `error` and
          // git's own sentence in `message`; every other shape puts the
          // sentence in `error` and has no `message`. Prefer the sentence.
          const message =
            typeof body?.['message'] === 'string'
              ? body['message']
              : typeof body?.['error'] === 'string'
                ? body['error']
                : t('gitWorktrees.removeFailed');
          settle({ path, error: message, busy: false });
        });
    },
    [client, workspaceCwd, removal, removing, t],
  );

  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      list?.worktrees.filter(
        (w) =>
          !q ||
          w.path.toLowerCase().includes(q) ||
          (w.branch ?? '').toLowerCase().includes(q) ||
          (w.slug ?? '').toLowerCase().includes(q),
      ) ?? [],
    [list, q],
  );
  // Joined once per session list rather than re-scanned inside every row on
  // every one of the N status arrivals.
  const sessionsByPath = useMemo(() => {
    const byPath = new Map<string, DaemonSessionSummary[]>();
    for (const session of sessions) {
      const key = session.worktree?.path;
      if (key === undefined) continue;
      const bucket = byPath.get(key);
      if (bucket) bucket.push(session);
      else byPath.set(key, [session]);
    }
    return byPath;
  }, [sessions]);
  const cancelRemove = useCallback(() => {
    confirmPathRef.current = null;
    setRemoval(null);
  }, []);

  // A refusal belongs to a row; if that row is not on screen — filtered out,
  // or dropped by a refresh that arrived while the request was in flight —
  // the panel it would have opened in is not there and the answer would be
  // lost. Not being on screen is the whole condition: the sentence says the
  // removal was refused while the user was looking elsewhere, which is true
  // either way, and a refusal with nowhere to land is the one case that must
  // not go unsaid.
  const strandedRemoval =
    removal &&
    (removal.blocked || removal.error) &&
    !visible.some((w) => w.path === removal.path)
      ? removal
      : null;

  let body: ReactNode;
  if (loading && !list) {
    body = (
      <div className={styles.placeholder}>{t('gitWorktrees.loading')}</div>
    );
  } else if (error && (!list || !(removal?.blocked || removal?.error))) {
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
            sessions={sessionsByPath.get(worktree.path) ?? NO_SESSIONS}
            removal={removal?.path === worktree.path ? removal : null}
            busy={removing.includes(worktree.path)}
            onOpenSession={onOpenSession}
            onRemove={remove}
            onCancelRemove={cancelRemove}
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
        {onNewWorktreeSession && list?.available && (
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
      {strandedRemoval !== null && (
        <div className={styles.notice} role="status">
          {t('gitWorktrees.refusedElsewhere', {
            name: baseName(strandedRemoval.path),
            reason: refusalSentence(t, strandedRemoval) ?? '',
          })}
        </div>
      )}
      {notice && (
        <div
          className={styles.notice}
          role="status"
          data-testid="worktree-notice"
        >
          {notice}
        </div>
      )}
      {body}
    </div>
  );
}
