/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Dispatch,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  authenticateDesktop,
  commitDesktopProjectChanges,
  createDesktopSession,
  getDesktopProjectGitDiff,
  getDesktopProjectGitStatus,
  getDesktopSessionModeState,
  getDesktopSessionModelState,
  getDesktopTerminal,
  getDesktopUserSettings,
  killDesktopTerminal,
  listDesktopProjects,
  listDesktopSessions,
  loadDesktopStatus,
  openDesktopProject,
  revertDesktopProjectChanges,
  runDesktopTerminalCommand,
  setDesktopSessionMode,
  setDesktopSessionModel,
  stageDesktopProjectChanges,
  updateDesktopUserSettings,
  type DesktopGitDiff,
  type DesktopProject,
  type DesktopSessionSummary,
  type DesktopTerminal,
} from './api/client.js';
import {
  connectSessionSocket,
  type SessionSocketClient,
} from './api/websocket.js';
import {
  chatReducer,
  createInitialChatState,
  type ChatAction,
} from './stores/chatStore.js';
import {
  createInitialModelState,
  type ModelAction,
  modelReducer,
} from './stores/modelStore.js';
import {
  buildSettingsUpdateRequest,
  createInitialSettingsState,
  settingsReducer,
} from './stores/settingsStore.js';
import { WorkspacePage } from './components/layout/WorkspacePage.js';
import type { LoadState } from './components/layout/types.js';
import type {
  DesktopApprovalMode,
  DesktopServerMessage,
} from '../shared/desktopProtocol.js';

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ state: 'loading' });
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<DesktopGitDiff | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminal, setTerminal] = useState<DesktopTerminal | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [chatState, dispatchChat] = useReducer(
    chatReducer,
    undefined,
    createInitialChatState,
  );
  const [settingsState, dispatchSettings] = useReducer(
    settingsReducer,
    undefined,
    createInitialSettingsState,
  );
  const [modelState, dispatchModel] = useReducer(
    modelReducer,
    undefined,
    createInitialModelState,
  );
  const socketRef = useRef<SessionSocketClient | null>(null);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const activeProjectPath = activeProject?.path ?? '';

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
    dispatchSettings({ type: 'load_start' });
    void getDesktopUserSettings(loadState.status.serverInfo)
      .then((settings) => {
        if (!disposed) {
          dispatchSettings({ type: 'load_success', settings });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          dispatchSettings({
            type: 'load_error',
            message: getErrorMessage(error),
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [loadState]);

  useEffect(() => {
    if (loadState.state !== 'ready') {
      return;
    }

    let disposed = false;
    void listDesktopProjects(loadState.status.serverInfo)
      .then((result) => {
        if (disposed) {
          return;
        }

        setProjects(result.projects);
        setActiveProjectId(
          (current) => current ?? result.projects[0]?.id ?? null,
        );
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSessionError(getErrorMessage(error));
        }
      });

    return () => {
      disposed = true;
    };
  }, [loadState]);

  useEffect(() => {
    if (loadState.state !== 'ready') {
      return;
    }

    let disposed = false;
    void listDesktopSessions(
      loadState.status.serverInfo,
      activeProjectPath || undefined,
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
  }, [activeProjectPath, loadState]);

  useEffect(() => {
    socketRef.current?.close();
    socketRef.current = null;
    dispatchModel({ type: 'reset' });

    if (loadState.state !== 'ready' || !activeSessionId) {
      return;
    }

    dispatchChat({ type: 'connect' });
    const socket = connectSessionSocket(
      loadState.status.serverInfo,
      activeSessionId,
      {
        onMessage: (message) =>
          handleSessionSocketMessage(message, dispatchChat, dispatchModel),
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

  useEffect(() => {
    if (loadState.state !== 'ready' || !activeSessionId) {
      return;
    }

    let disposed = false;
    void Promise.allSettled([
      getDesktopSessionModelState(loadState.status.serverInfo, activeSessionId),
      getDesktopSessionModeState(loadState.status.serverInfo, activeSessionId),
    ]).then(([models, modes]) => {
      if (disposed) {
        return;
      }

      dispatchModel({
        type: 'session_runtime_loaded',
        models: models.status === 'fulfilled' ? models.value : undefined,
        modes: modes.status === 'fulfilled' ? modes.value : undefined,
      });
    });

    return () => {
      disposed = true;
    };
  }, [activeSessionId, loadState]);

  const chooseWorkspace = useCallback(async () => {
    if (loadState.state !== 'ready') {
      return;
    }

    try {
      const selectedPath = await window.qwenDesktop.selectDirectory();
      if (selectedPath) {
        const project = await openDesktopProject(
          loadState.status.serverInfo,
          selectedPath,
        );
        setProjects((current) => [
          project,
          ...current.filter((entry) => entry.id !== project.id),
        ]);
        setActiveProjectId(project.id);
        setActiveSessionId(null);
      }
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, [loadState]);

  const createSession = useCallback(async () => {
    if (loadState.state !== 'ready' || !activeProject) {
      return;
    }

    try {
      const session = await createDesktopSession(
        loadState.status.serverInfo,
        activeProject.path,
      );
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.sessionId);
      dispatchModel({
        type: 'session_runtime_loaded',
        models: session.models,
        modes: session.modes,
      });
      setSessionError(null);
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, [activeProject, loadState]);

  const selectProject = useCallback((projectId: string) => {
    setActiveProjectId(projectId);
    setActiveSessionId(null);
  }, []);

  const refreshProjectGitStatus = useCallback(async () => {
    if (loadState.state !== 'ready' || !activeProject) {
      return;
    }

    try {
      const gitStatus = await getDesktopProjectGitStatus(
        loadState.status.serverInfo,
        activeProject.id,
      );
      setProjects((current) =>
        current.map((project) =>
          project.id === activeProject.id
            ? {
                ...project,
                gitBranch: gitStatus.branch,
                gitStatus,
              }
            : project,
        ),
      );
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, [activeProject, loadState]);

  const loadProjectReview = useCallback(async () => {
    if (loadState.state !== 'ready' || !activeProject) {
      setGitDiff(null);
      return;
    }

    try {
      const diff = await getDesktopProjectGitDiff(
        loadState.status.serverInfo,
        activeProject.id,
      );
      setGitDiff(diff);
      setReviewError(null);
    } catch (error) {
      setGitDiff(null);
      setReviewError(getErrorMessage(error));
    }
  }, [activeProject, loadState]);

  useEffect(() => {
    void loadProjectReview();
  }, [loadProjectReview]);

  const applyReviewMutation = useCallback(
    (status: DesktopProject['gitStatus'], diff: DesktopGitDiff) => {
      if (!activeProject) {
        return;
      }

      setProjects((current) =>
        current.map((project) =>
          project.id === activeProject.id
            ? {
                ...project,
                gitBranch: status.branch,
                gitStatus: status,
              }
            : project,
        ),
      );
      setGitDiff(diff);
      setReviewError(null);
    },
    [activeProject],
  );

  const stageAllChanges = useCallback(async () => {
    if (loadState.state !== 'ready' || !activeProject) {
      return;
    }

    try {
      const result = await stageDesktopProjectChanges(
        loadState.status.serverInfo,
        activeProject.id,
      );
      applyReviewMutation(result.status, result.diff);
    } catch (error) {
      setReviewError(getErrorMessage(error));
    }
  }, [activeProject, applyReviewMutation, loadState]);

  const revertAllChanges = useCallback(async () => {
    if (loadState.state !== 'ready' || !activeProject) {
      return;
    }

    try {
      const result = await revertDesktopProjectChanges(
        loadState.status.serverInfo,
        activeProject.id,
      );
      applyReviewMutation(result.status, result.diff);
    } catch (error) {
      setReviewError(getErrorMessage(error));
    }
  }, [activeProject, applyReviewMutation, loadState]);

  const commitChanges = useCallback(async () => {
    if (
      loadState.state !== 'ready' ||
      !activeProject ||
      commitMessage.trim().length === 0
    ) {
      return;
    }

    try {
      const result = await commitDesktopProjectChanges(
        loadState.status.serverInfo,
        activeProject.id,
        commitMessage,
      );
      applyReviewMutation(result.status, result.diff);
      setCommitMessage('');
    } catch (error) {
      setReviewError(getErrorMessage(error));
    }
  }, [activeProject, applyReviewMutation, commitMessage, loadState]);

  const runTerminalCommand = useCallback(async () => {
    if (
      loadState.state !== 'ready' ||
      !activeProject ||
      terminalCommand.trim().length === 0
    ) {
      return;
    }

    try {
      const nextTerminal = await runDesktopTerminalCommand(
        loadState.status.serverInfo,
        activeProject.id,
        terminalCommand,
      );
      setTerminal(nextTerminal);
      setTerminalCommand('');
      setTerminalError(null);
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [activeProject, loadState, terminalCommand]);

  const killTerminal = useCallback(async () => {
    if (loadState.state !== 'ready' || !terminal) {
      return;
    }

    try {
      setTerminal(
        await killDesktopTerminal(loadState.status.serverInfo, terminal.id),
      );
      setTerminalError(null);
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [loadState, terminal]);

  const clearTerminal = useCallback(() => {
    setTerminal(null);
    setTerminalError(null);
  }, []);

  useEffect(() => {
    if (loadState.state !== 'ready' || terminal?.status !== 'running') {
      return;
    }

    const interval = window.setInterval(() => {
      void getDesktopTerminal(loadState.status.serverInfo, terminal.id)
        .then((nextTerminal) => {
          setTerminal(nextTerminal);
          setTerminalError(null);
        })
        .catch((error: unknown) => {
          setTerminalError(getErrorMessage(error));
        });
    }, 400);

    return () => {
      window.clearInterval(interval);
    };
  }, [loadState, terminal]);

  const saveSettings = useCallback(async () => {
    if (loadState.state !== 'ready') {
      return;
    }

    dispatchSettings({ type: 'save_start' });
    try {
      const settings = await updateDesktopUserSettings(
        loadState.status.serverInfo,
        buildSettingsUpdateRequest(settingsState.form),
      );
      dispatchSettings({ type: 'save_success', settings });
    } catch (error) {
      dispatchSettings({ type: 'save_error', message: getErrorMessage(error) });
    }
  }, [loadState, settingsState.form]);

  const authenticate = useCallback(
    async (methodId: string) => {
      if (loadState.state !== 'ready') {
        return;
      }

      try {
        await authenticateDesktop(loadState.status.serverInfo, methodId);
        setSessionError(null);
      } catch (error) {
        setSessionError(getErrorMessage(error));
      }
    },
    [loadState],
  );

  const changeModel = useCallback(
    async (modelId: string) => {
      if (loadState.state !== 'ready' || !activeSessionId) {
        return;
      }

      dispatchModel({ type: 'model_save_start' });
      try {
        const models = await setDesktopSessionModel(
          loadState.status.serverInfo,
          activeSessionId,
          modelId,
        );
        dispatchModel({ type: 'model_saved', models });
      } catch (error) {
        dispatchModel({ type: 'error', message: getErrorMessage(error) });
      }
    },
    [activeSessionId, loadState],
  );

  const changeMode = useCallback(
    async (mode: DesktopApprovalMode) => {
      if (loadState.state !== 'ready' || !activeSessionId) {
        return;
      }

      dispatchModel({ type: 'mode_save_start' });
      try {
        const modes = await setDesktopSessionMode(
          loadState.status.serverInfo,
          activeSessionId,
          mode,
        );
        dispatchModel({ type: 'mode_saved', modes });
      } catch (error) {
        dispatchModel({ type: 'error', message: getErrorMessage(error) });
      }
    },
    [activeSessionId, loadState],
  );

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
    <WorkspacePage
      activeProject={activeProject}
      activeProjectId={activeProjectId}
      activeSessionId={activeSessionId}
      chatState={chatState}
      commitMessage={commitMessage}
      gitDiff={gitDiff}
      loadState={loadState}
      messageText={messageText}
      modelState={modelState}
      projects={projects}
      reviewError={reviewError}
      sessionError={sessionError}
      sessions={sessions}
      settingsState={settingsState}
      statusLabel={statusLabel}
      terminal={terminal}
      terminalCommand={terminalCommand}
      terminalError={terminalError}
      onAskUserQuestionResponse={respondToAskUserQuestion}
      onAuthenticate={authenticate}
      onChooseWorkspace={chooseWorkspace}
      onClearTerminal={clearTerminal}
      onCommit={commitChanges}
      onCommitMessageChange={setCommitMessage}
      onCreateSession={createSession}
      onKillTerminal={killTerminal}
      onMessageTextChange={setMessageText}
      onModeChange={changeMode}
      onModelChange={changeModel}
      onPermissionResponse={respondToPermission}
      onRefreshProjectGitStatus={refreshProjectGitStatus}
      onRevertAllChanges={revertAllChanges}
      onRunTerminalCommand={runTerminalCommand}
      onSaveSettings={saveSettings}
      onSelectProject={selectProject}
      onSelectSession={setActiveSessionId}
      onSendMessage={sendMessage}
      onSettingsDispatch={dispatchSettings}
      onStageAllChanges={stageAllChanges}
      onStopGeneration={stopGeneration}
      onTerminalCommandChange={setTerminalCommand}
    />
  );
}

function handleSessionSocketMessage(
  message: DesktopServerMessage,
  dispatchChat: Dispatch<ChatAction>,
  dispatchModel: Dispatch<ModelAction>,
): void {
  dispatchChat({ type: 'server_message', message });

  if (message.type === 'mode_changed' && isApprovalMode(message.mode)) {
    dispatchModel({ type: 'mode_changed', mode: message.mode });
  }

  if (message.type === 'model_changed') {
    dispatchModel({ type: 'model_changed', modelId: message.modelId });
  }
}

function isApprovalMode(value: string): value is DesktopApprovalMode {
  return (
    value === 'plan' ||
    value === 'default' ||
    value === 'auto-edit' ||
    value === 'yolo'
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Desktop operation failed.';
}
