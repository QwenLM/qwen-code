/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  createDesktopSession,
  listDesktopSessions,
  loadDesktopStatus,
  type DesktopConnectionStatus,
  type DesktopSessionSummary,
} from './api/client.js';
import {
  connectSessionSocket,
  type SessionSocketClient,
} from './api/websocket.js';
import {
  chatReducer,
  createInitialChatState,
  type ChatState,
  type ChatTimelineItem,
} from './stores/chatStore.js';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; status: DesktopConnectionStatus }
  | { state: 'error'; message: string };

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ state: 'loading' });
  const [workspacePath, setWorkspacePath] = useState('');
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [chatState, dispatchChat] = useReducer(
    chatReducer,
    undefined,
    createInitialChatState,
  );
  const socketRef = useRef<SessionSocketClient | null>(null);

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      try {
        const status = await loadDesktopStatus();
        if (!disposed) {
          setLoadState({ state: 'ready', status });
        }
      } catch (error) {
        if (!disposed) {
          setLoadState({
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Unable to reach desktop service.',
          });
        }
      }
    };

    void load();

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (loadState.state !== 'ready') {
      return;
    }

    let disposed = false;
    void listDesktopSessions(
      loadState.status.serverInfo,
      workspacePath || undefined,
    )
      .then((result) => {
        if (!disposed) {
          setSessions(result.sessions);
          setSessionError(null);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSessionError(getErrorMessage(error));
        }
      });

    return () => {
      disposed = true;
    };
  }, [loadState, workspacePath]);

  useEffect(() => {
    socketRef.current?.close();
    socketRef.current = null;

    if (loadState.state !== 'ready' || !activeSessionId) {
      return;
    }

    dispatchChat({ type: 'connect' });
    const socket = connectSessionSocket(
      loadState.status.serverInfo,
      activeSessionId,
      {
        onMessage: (message) =>
          dispatchChat({ type: 'server_message', message }),
        onClose: () => dispatchChat({ type: 'disconnect' }),
        onError: () => setSessionError('Session socket connection failed.'),
      },
    );
    socketRef.current = socket;

    return () => {
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeSessionId, loadState]);

  const chooseWorkspace = useCallback(async () => {
    try {
      const selectedPath = await window.qwenDesktop.selectDirectory();
      if (selectedPath) {
        setWorkspacePath(selectedPath);
      }
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, []);

  const createSession = useCallback(async () => {
    if (loadState.state !== 'ready' || !workspacePath) {
      return;
    }

    try {
      const session = await createDesktopSession(
        loadState.status.serverInfo,
        workspacePath,
      );
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.sessionId);
      setSessionError(null);
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, [loadState, workspacePath]);

  const sendMessage = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const content = messageText.trim();
      if (!content || !socketRef.current) {
        return;
      }

      dispatchChat({ type: 'append_user_message', content });
      socketRef.current.sendUserMessage(content);
      setMessageText('');
    },
    [messageText],
  );

  const stopGeneration = useCallback(() => {
    socketRef.current?.stopGeneration();
  }, []);

  const respondToPermission = useCallback(
    (requestId: string, optionId: string) => {
      socketRef.current?.respondToPermission(requestId, optionId);
      dispatchChat({ type: 'clear_permission_request', requestId });
    },
    [],
  );

  const respondToAskUserQuestion = useCallback(
    (requestId: string, optionId: string) => {
      socketRef.current?.respondToAskUserQuestion(requestId, optionId, {});
      dispatchChat({ type: 'clear_ask_user_question', requestId });
    },
    [],
  );

  const statusLabel = useMemo(() => {
    if (loadState.state === 'ready') {
      return 'Connected';
    }

    if (loadState.state === 'error') {
      return 'Offline';
    }

    return 'Starting';
  }, [loadState]);

  return (
    <main className="desktop-shell">
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            Q
          </div>
          <div>
            <h1>Qwen Code</h1>
            <p>Desktop</p>
          </div>
        </div>

        <section className="sidebar-section">
          <h2>Workspace</h2>
          <div className="workspace-path">
            {workspacePath || 'No folder selected'}
          </div>
          <button className="secondary-button" onClick={chooseWorkspace}>
            Select Folder
          </button>
          <button
            className="primary-button"
            disabled={loadState.state !== 'ready' || !workspacePath}
            onClick={createSession}
          >
            New Session
          </button>
        </section>

        <section className="sidebar-section sidebar-section-fill">
          <h2>Sessions</h2>
          <SessionList
            activeSessionId={activeSessionId}
            sessions={sessions}
            onSelect={setActiveSessionId}
          />
        </section>
      </aside>

      <section className="workbench" aria-label="Workbench">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local service</p>
            <h2>{statusLabel}</h2>
          </div>
          <StatusPill state={loadState.state} />
        </header>

        <div className="workspace-grid">
          <section className="panel panel-main">
            <div className="panel-header">
              <h3>Conversation</h3>
              <span>
                {chatState.streaming ? 'Streaming' : chatState.connection}
              </span>
            </div>
            <ChatTimeline state={chatState} activeSessionId={activeSessionId} />
            <PermissionPrompts
              state={chatState}
              onAskUserQuestionResponse={respondToAskUserQuestion}
              onPermissionResponse={respondToPermission}
            />
            <form className="composer" onSubmit={sendMessage}>
              <textarea
                aria-label="Message"
                disabled={!activeSessionId}
                onChange={(event) => setMessageText(event.target.value)}
                placeholder={activeSessionId ? 'Message Qwen Code' : ''}
                rows={3}
                value={messageText}
              />
              <div className="composer-actions">
                <button
                  className="secondary-button"
                  disabled={!chatState.streaming}
                  type="button"
                  onClick={stopGeneration}
                >
                  Stop
                </button>
                <button
                  className="primary-button"
                  disabled={!activeSessionId || messageText.trim().length === 0}
                  type="submit"
                >
                  Send
                </button>
              </div>
            </form>
          </section>

          <section className="panel panel-side">
            <div className="panel-header">
              <h3>Runtime</h3>
            </div>
            <RuntimeDetails loadState={loadState} />
            <SessionDetails
              activeSessionId={activeSessionId}
              chatState={chatState}
              sessionError={sessionError}
            />
          </section>
        </div>
      </section>
    </main>
  );
}

function SessionList({
  activeSessionId,
  sessions,
  onSelect,
}: {
  activeSessionId: string | null;
  sessions: DesktopSessionSummary[];
  onSelect: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return <div className="empty-row">No sessions</div>;
  }

  return (
    <div className="session-list">
      {sessions.map((session) => (
        <button
          className={
            session.sessionId === activeSessionId
              ? 'session-row session-row-active'
              : 'session-row'
          }
          key={session.sessionId}
          onClick={() => onSelect(session.sessionId)}
        >
          <span>{session.title || session.sessionId}</span>
          <small>{session.cwd || session.sessionId}</small>
        </button>
      ))}
    </div>
  );
}

function ChatTimeline({
  activeSessionId,
  state,
}: {
  activeSessionId: string | null;
  state: ChatState;
}) {
  if (!activeSessionId) {
    return <div className="conversation-empty">No session selected</div>;
  }

  if (state.items.length === 0) {
    return <div className="conversation-empty">Session ready</div>;
  }

  return (
    <div className="chat-timeline">
      {state.items.map((item) => (
        <TimelineItem item={item} key={item.id} />
      ))}
    </div>
  );
}

function TimelineItem({ item }: { item: ChatTimelineItem }) {
  if (item.type === 'message') {
    return (
      <article className={`chat-message chat-message-${item.role}`}>
        <div className="message-role">{item.role}</div>
        <p>{item.text}</p>
      </article>
    );
  }

  if (item.type === 'tool') {
    return (
      <article className="chat-tool">
        <div className="message-role">{item.toolCall.kind || 'tool'}</div>
        <strong>{item.toolCall.title || item.toolCall.toolCallId}</strong>
        {item.toolCall.status ? <span>{item.toolCall.status}</span> : null}
      </article>
    );
  }

  if (item.type === 'plan') {
    return (
      <article className="chat-plan">
        <div className="message-role">plan</div>
        <ol>
          {item.entries.map((entry) => (
            <li key={`${entry.content}-${entry.status}`}>
              <span>{entry.status}</span>
              {entry.content}
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return <div className="chat-event">{item.label}</div>;
}

function PermissionPrompts({
  onAskUserQuestionResponse,
  onPermissionResponse,
  state,
}: {
  onAskUserQuestionResponse: (requestId: string, optionId: string) => void;
  onPermissionResponse: (requestId: string, optionId: string) => void;
  state: ChatState;
}) {
  const permission = state.pendingPermission;
  const question = state.pendingAskUserQuestion;
  if (!permission && !question) {
    return null;
  }

  return (
    <div className="permission-strip">
      {permission ? (
        <section className="permission-panel">
          <div>
            <span className="message-role">
              {permission.request.toolCall.kind || 'permission'}
            </span>
            <strong>
              {permission.request.toolCall.title ||
                permission.request.toolCall.toolCallId}
            </strong>
          </div>
          <div className="permission-actions">
            {permission.request.options.map((option) => (
              <button
                className={
                  option.kind.startsWith('reject')
                    ? 'secondary-button'
                    : 'primary-button'
                }
                key={option.optionId}
                onClick={() =>
                  onPermissionResponse(permission.requestId, option.optionId)
                }
                type="button"
              >
                {option.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {question ? (
        <section className="permission-panel">
          {question.request.questions.map((item) => (
            <div key={`${item.header}-${item.question}`}>
              <span className="message-role">{item.header}</span>
              <strong>{item.question}</strong>
              {item.options.length > 0 ? (
                <ul className="question-options">
                  {item.options.map((option) => (
                    <li key={`${option.label}-${option.description}`}>
                      {option.label}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          <div className="permission-actions">
            <button
              className="secondary-button"
              onClick={() =>
                onAskUserQuestionResponse(question.requestId, 'cancel')
              }
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button"
              onClick={() =>
                onAskUserQuestionResponse(question.requestId, 'proceed_once')
              }
              type="button"
            >
              Submit
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatusPill({ state }: { state: LoadState['state'] }) {
  return <span className={`status-pill status-pill-${state}`}>{state}</span>;
}

function RuntimeDetails({ loadState }: { loadState: LoadState }) {
  if (loadState.state === 'loading') {
    return <div className="runtime-row muted">Checking service</div>;
  }

  if (loadState.state === 'error') {
    return <div className="runtime-row error-text">{loadState.message}</div>;
  }

  return (
    <dl className="runtime-details">
      <div>
        <dt>Server</dt>
        <dd>{loadState.status.serverUrl}</dd>
      </div>
      <div>
        <dt>Desktop</dt>
        <dd>{loadState.status.runtime.desktop.version}</dd>
      </div>
      <div>
        <dt>Platform</dt>
        <dd>
          {loadState.status.runtime.platform.type}-
          {loadState.status.runtime.platform.arch}
        </dd>
      </div>
      <div>
        <dt>Node</dt>
        <dd>{loadState.status.runtime.desktop.nodeVersion}</dd>
      </div>
      <div>
        <dt>ACP</dt>
        <dd>
          {loadState.status.runtime.cli.acpReady ? 'Ready' : 'Not started'}
        </dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>{loadState.status.health.uptimeMs} ms</dd>
      </div>
    </dl>
  );
}

function SessionDetails({
  activeSessionId,
  chatState,
  sessionError,
}: {
  activeSessionId: string | null;
  chatState: ChatState;
  sessionError: string | null;
}) {
  return (
    <div className="session-details">
      <div className="panel-header panel-header-inline">
        <h3>Session</h3>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Active</dt>
          <dd>{activeSessionId || 'None'}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{chatState.mode || 'Unknown'}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>{chatState.availableCommands.length}</dd>
        </div>
        <div>
          <dt>Skills</dt>
          <dd>{chatState.availableSkills.length}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{chatState.latestUsage?.usage?.totalTokens ?? 'Unknown'}</dd>
        </div>
        {sessionError || chatState.error ? (
          <div>
            <dt>Error</dt>
            <dd className="error-text">{sessionError || chatState.error}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Desktop operation failed.';
}
