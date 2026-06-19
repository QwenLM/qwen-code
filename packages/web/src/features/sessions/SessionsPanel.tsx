import { useState } from 'react';
import { useSessions } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

interface SessionsPanelProps {
  onOpenChat: () => void;
}

export function SessionsPanel({ onOpenChat }: SessionsPanelProps) {
  const sessions = useSessions({ autoLoad: true });
  const [actionError, setActionError] = useState<string>();

  async function loadSession(sessionId: string) {
    setActionError(undefined);
    try {
      await sessions.loadSession?.(sessionId);
      onOpenChat();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function resumeSession(sessionId: string) {
    setActionError(undefined);
    try {
      await sessions.resumeSession?.(sessionId);
      onOpenChat();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function deleteSession(sessionId: string) {
    setActionError(undefined);
    try {
      await sessions.deleteSession(sessionId);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function newSession() {
    setActionError(undefined);
    try {
      await sessions.newSession?.();
      onOpenChat();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  return (
    <div className="web-panel">
      <PanelHeader
        count={sessions.sessions.length}
        onRefresh={() => void sessions.reload()}
        onNew={() => void newSession()}
      />
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={sessions.loading}
        error={sessions.error}
        empty={sessions.sessions.length === 0}
        emptyText="No sessions found for this workspace."
      >
        <div className="web-list">
          {sessions.sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              onLoad={() => void loadSession(session.sessionId)}
              onResume={() => void resumeSession(session.sessionId)}
              onDelete={() => void deleteSession(session.sessionId)}
            />
          ))}
        </div>
      </ResourceState>
    </div>
  );
}

function PanelHeader({
  count,
  onRefresh,
  onNew,
}: {
  count: number;
  onRefresh: () => void;
  onNew: () => void;
}) {
  return (
    <div className="web-panel-header">
      <div>
        <h2>Session inbox</h2>
        <p>
          {count} session{count === 1 ? '' : 's'}
        </p>
      </div>
      <div className="web-actions">
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" onClick={onNew}>
          New session
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onLoad,
  onResume,
  onDelete,
}: {
  session: DaemonSessionSummary;
  onLoad: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="web-card">
      <div className="web-card-main">
        <h3>{session.displayName ?? session.title ?? session.sessionId}</h3>
        <p>{session.workspaceCwd}</p>
        <div className="web-meta">
          <span>{session.clientCount ?? 0} client(s)</span>
          {session.hasActivePrompt ? <span>active prompt</span> : null}
          {session.updatedAt ? <span>updated {session.updatedAt}</span> : null}
        </div>
      </div>
      <div className="web-card-actions">
        <button type="button" onClick={onLoad}>
          Load
        </button>
        <button type="button" onClick={onResume}>
          Resume
        </button>
        <button type="button" onClick={onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}
