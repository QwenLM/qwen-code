import { useState, useEffect, useCallback } from 'react';

interface SessionInfo {
  sessionId: string;
  title?: string;
  createdAt?: string;
}

interface SessionPanelProps {
  currentSessionId?: string | null;
  onSessionChange?: () => void;
  onLoadSession?: (sessionId: string) => void;
  onNewSession?: () => Promise<unknown> | void;
  loadSessions?: () => Promise<SessionInfo[]>;
}

export function SessionPanel({
  currentSessionId,
  onSessionChange,
  onLoadSession,
  onNewSession,
  loadSessions,
}: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      setSessions(loadSessions ? await loadSessions() : []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [loadSessions]);

  useEffect(() => {
    if (expanded) fetchSessions();
  }, [expanded, fetchSessions]);

  const loadSession = async (id: string) => {
    setExpanded(false);
    if (onLoadSession) {
      onLoadSession(id);
    }
  };

  const newSession = async () => {
    onSessionChange?.();
    setExpanded(false);
    if (onNewSession) {
      await onNewSession();
    }
  };

  return (
    <div className="session-panel">
      <div className="session-panel-bar">
        <button className="session-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? '▼' : '▶'} Sessions
        </button>
        <button className="session-btn session-btn-new" onClick={newSession}>
          + New
        </button>
      </div>

      {expanded && (
        <div className="session-list">
          {loading && <div className="session-loading">Loading...</div>}
          {!loading && sessions.length === 0 && (
            <div className="session-empty">No sessions found</div>
          )}
          {sessions.map((s) => {
            const isCurrent = s.sessionId === currentSessionId;
            return (
              <button
                key={s.sessionId}
                className={`session-item ${isCurrent ? 'session-item-current' : ''}`}
                onClick={() => loadSession(s.sessionId)}
              >
                <span className="session-item-title">
                  {s.title || s.sessionId.slice(0, 8)}
                </span>
                {isCurrent && (
                  <span className="session-item-current-label">current</span>
                )}
                {s.createdAt && (
                  <span className="session-item-time">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
