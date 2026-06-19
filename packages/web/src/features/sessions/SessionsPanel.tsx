import { useState } from 'react';
import { useConnection, useSessions } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

interface SessionsPanelProps {
  onOpenChat: () => void;
}

type SessionAction = 'open' | 'rename' | 'release' | 'delete' | 'new';

interface PendingAction {
  sessionId?: string;
  action: SessionAction;
}

export function SessionsPanel({ onOpenChat }: SessionsPanelProps) {
  const connection = useConnection();
  const sessions = useSessions({ autoLoad: true });
  const [actionError, setActionError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();

  function openSession(session: DaemonSessionSummary) {
    if (session.sessionId === connection.sessionId) {
      onOpenChat();
      return;
    }
    setActionError(undefined);
    setPendingAction({ sessionId: session.sessionId, action: 'open' });
    try {
      const shouldResume =
        session.hasActivePrompt || (session.clientCount ?? 0) > 0;
      const switchSession = shouldResume
        ? sessions.resumeSession?.(session.sessionId)
        : sessions.loadSession?.(session.sessionId);
      if (!switchSession) throw new Error('Session switching is unavailable.');
      void switchSession.catch((error: unknown) => {
        if (!isSessionSwitchCleanup(error)) setActionError(errorMessage(error));
      });
      onOpenChat();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function renameSession(sessionId: string, displayName: string) {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    setActionError(undefined);
    setPendingAction({ sessionId, action: 'rename' });
    try {
      await sessions.renameSession(sessionId, trimmed);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function releaseSession(sessionId: string) {
    setActionError(undefined);
    setPendingAction({ sessionId, action: 'release' });
    try {
      await sessions.releaseSession(sessionId);
      if (sessionId === connection.sessionId) {
        await sessions.newSession?.();
        onOpenChat();
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function deleteSession(sessionId: string) {
    if (!window.confirm('确认删除该会话？此操作不可撤销。')) return;
    setActionError(undefined);
    setPendingAction({ sessionId, action: 'delete' });
    try {
      await sessions.deleteSession(sessionId);
      if (sessionId === connection.sessionId) {
        await sessions.newSession?.();
        onOpenChat();
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function newSession() {
    setActionError(undefined);
    setPendingAction({ action: 'new' });
    try {
      await sessions.newSession?.();
      onOpenChat();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  return (
    <div className="web-panel">
      <PanelHeader
        count={sessions.sessions.length}
        currentSessionId={connection.sessionId}
        onRefresh={() => void sessions.reload()}
        onNew={() => void newSession()}
        newBusy={pendingAction?.action === 'new'}
      />
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={sessions.loading}
        error={sessions.error}
        empty={sessions.sessions.length === 0}
        emptyText="当前 workspace 暂无会话。"
      >
        <div className="web-list">
          {sessions.sessions.map((session) => {
            const current = session.sessionId === connection.sessionId;
            const busy = pendingAction?.sessionId === session.sessionId;
            return (
              <SessionRow
                key={session.sessionId}
                session={session}
                current={current}
                busy={busy}
                pendingAction={busy ? pendingAction?.action : undefined}
                onOpen={() => void openSession(session)}
                onRename={(displayName) =>
                  void renameSession(session.sessionId, displayName)
                }
                onRelease={() => void releaseSession(session.sessionId)}
                onDelete={() => void deleteSession(session.sessionId)}
              />
            );
          })}
        </div>
      </ResourceState>
    </div>
  );
}

function PanelHeader({
  count,
  currentSessionId,
  onRefresh,
  onNew,
  newBusy,
}: {
  count: number;
  currentSessionId?: string;
  onRefresh: () => void;
  onNew: () => void;
  newBusy: boolean;
}) {
  return (
    <div className="web-panel-header">
      <div>
        <h2>会话工作台</h2>
        <p>
          {count} 个会话
          {currentSessionId ? ` · 当前 ${currentSessionId.slice(0, 8)}` : ''}
        </p>
      </div>
      <div className="web-actions">
        <button type="button" onClick={onRefresh}>
          刷新
        </button>
        <button type="button" onClick={onNew} disabled={newBusy}>
          {newBusy ? '创建中' : '新建会话'}
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  current,
  busy,
  pendingAction,
  onOpen,
  onRename,
  onRelease,
  onDelete,
}: {
  session: DaemonSessionSummary;
  current: boolean;
  busy: boolean;
  pendingAction?: SessionAction;
  onOpen: () => void;
  onRename: (displayName: string) => void;
  onRelease: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(getSessionTitle(session));
  const live = (session.clientCount ?? 0) > 0;

  function cancelEdit() {
    setDisplayName(getSessionTitle(session));
    setEditing(false);
  }

  function saveEdit() {
    onRename(displayName);
    setEditing(false);
  }

  return (
    <article className={current ? 'web-card current' : 'web-card'}>
      <div className="web-card-main">
        {editing ? (
          <div className="web-inline-edit">
            <input
              aria-label="会话名称"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveEdit();
                if (event.key === 'Escape') cancelEdit();
              }}
            />
            <button type="button" onClick={saveEdit} disabled={busy}>
              保存
            </button>
            <button type="button" onClick={cancelEdit} disabled={busy}>
              取消
            </button>
          </div>
        ) : (
          <div className="web-session-title-row">
            <h3>{getSessionTitle(session)}</h3>
            {current ? <span className="web-session-badge">当前</span> : null}
            {live ? <span className="web-session-badge">live</span> : null}
            {session.hasActivePrompt ? (
              <span className="web-session-badge">执行中</span>
            ) : null}
          </div>
        )}
        <p>{session.workspaceCwd}</p>
        <div className="web-meta">
          <span>{session.sessionId.slice(0, 8)}</span>
          <span>{session.clientCount ?? 0} client(s)</span>
          {session.updatedAt ? (
            <span>更新于 {formatSessionTime(session.updatedAt)}</span>
          ) : null}
        </div>
      </div>
      <div className="web-card-actions">
        <button type="button" onClick={onOpen} disabled={busy || current}>
          {current ? '正在使用' : actionLabel(pendingAction, '打开')}
        </button>
        <button
          type="button"
          onClick={() => {
            setDisplayName(getSessionTitle(session));
            setEditing(true);
          }}
          disabled={busy || editing}
        >
          {actionLabel(pendingAction, '重命名', 'rename')}
        </button>
        <button type="button" onClick={onRelease} disabled={busy}>
          {actionLabel(pendingAction, '释放', 'release')}
        </button>
        <button type="button" onClick={onDelete} disabled={busy}>
          {actionLabel(pendingAction, '删除', 'delete')}
        </button>
      </div>
    </article>
  );
}

function getSessionTitle(session: DaemonSessionSummary) {
  return session.displayName ?? session.title ?? session.sessionId.slice(0, 8);
}

function isSessionSwitchCleanup(error: unknown) {
  return (
    error instanceof DOMException &&
    error.name === 'AbortError' &&
    error.message === 'Session load interrupted by cleanup'
  );
}

function actionLabel(
  pendingAction: SessionAction | undefined,
  fallback: string,
  action?: SessionAction,
) {
  if (!pendingAction) return fallback;
  if (action && pendingAction !== action) return fallback;
  switch (pendingAction) {
    case 'open':
      return '打开中';
    case 'rename':
      return '保存中';
    case 'release':
      return '释放中';
    case 'delete':
      return '删除中';
    case 'new':
      return fallback;
    default:
      return fallback;
  }
}

function formatSessionTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
