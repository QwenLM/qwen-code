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
  checkoutDesktopProjectBranch,
  commitDesktopProjectChanges,
  createDesktopProjectGitBranch,
  createDesktopSession,
  getDesktopProjectGitDiff,
  getDesktopProjectGitStatus,
  getDesktopSessionModeState,
  getDesktopSessionModelState,
  getDesktopTerminal,
  getDesktopUserSettings,
  killDesktopTerminal,
  listDesktopProjectGitBranches,
  listDesktopProjects,
  listDesktopSessions,
  loadDesktopSession,
  loadDesktopStatus,
  openDesktopProject,
  revertDesktopProjectChanges,
  runDesktopTerminalCommand,
  setDesktopSessionMode,
  setDesktopSessionModel,
  stageDesktopProjectChanges,
  updateDesktopUserSettings,
  writeDesktopTerminalInput,
  type DesktopGitBranch,
  type DesktopGitDiff,
  type DesktopGitReviewTarget,
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
  validateSettingsForm,
} from './stores/settingsStore.js';
import { WorkspacePage } from './components/layout/WorkspacePage.js';
import type { LoadState } from './components/layout/types.js';
import type {
  DesktopApprovalMode,
  DesktopServerMessage,
} from '../shared/desktopProtocol.js';

type PendingSocketAction =
  | { type: 'load'; sessionId: string; cwd: string }
  | { type: 'send'; sessionId: string; content: string };

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ state: 'loading' });
  const [projects, setProjects] = useState<DesktopProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isDraftSession, setIsDraftSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<DesktopGitDiff | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalInput, setTerminalInput] = useState('');
  const [terminal, setTerminal] = useState<DesktopTerminal | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
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
  const pendingSocketActionRef = useRef<PendingSocketAction | null>(null);
  const pendingPublishSessionRef = useRef<DesktopSessionSummary | null>(null);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const activeProjectPath = activeProject?.path ?? '';

  const refreshSessions = useCallback(async (): Promise<
    DesktopSessionSummary[]
  > => {
    if (loadState.state !== 'ready') {
      return [];
    }

    const result = await listDesktopSessions(
      loadState.status.serverInfo,
      activeProjectPath || undefined,
    );
    setSessions(result.sessions);
    setSessionError(null);
    return result.sessions;
  }, [activeProjectPath, loadState]);

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
          dispatchModel({ type: 'settings_models_loaded', settings });
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
    void refreshSessions()
      .then((result) => {
        if (!disposed) {
          setSessions(result);
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
  }, [loadState, refreshSessions]);

  const publishPendingSession = useCallback(() => {
    const pendingSession = pendingPublishSessionRef.current;
    if (!pendingSession || pendingSession.sessionId !== activeSessionId) {
      return;
    }

    pendingPublishSessionRef.current = null;
    void refreshSessions()
      .then((nextSessions) => {
        if (
          nextSessions.some(
            (session) => session.sessionId === pendingSession.sessionId,
          )
        ) {
          return;
        }

        setSessions((current) =>
          current.some(
            (session) => session.sessionId === pendingSession.sessionId,
          )
            ? current
            : [pendingSession, ...current],
        );
      })
      .catch((error: unknown) => {
        setSessionError(getErrorMessage(error));
        setSessions((current) =>
          current.some(
            (session) => session.sessionId === pendingSession.sessionId,
          )
            ? current
            : [pendingSession, ...current],
        );
      });
  }, [activeSessionId, refreshSessions]);

  useEffect(() => {
    socketRef.current?.close();
    socketRef.current = null;
    dispatchModel({ type: 'reset' });

    if (loadState.state !== 'ready' || !activeSessionId) {
      return;
    }

    dispatchChat({ type: 'connect' });
    let disposed = false;
    const socket = connectSessionSocket(
      loadState.status.serverInfo,
      activeSessionId,
      {
        onOpen: () => {
          const action = pendingSocketActionRef.current;
          if (!action || action.sessionId !== activeSessionId) {
            return;
          }

          pendingSocketActionRef.current = null;
          if (action.type === 'send') {
            socket.sendUserMessage(action.content);
            return;
          }

          void loadDesktopSession(
            loadState.status.serverInfo,
            action.sessionId,
            action.cwd,
          )
            .then((session) => {
              if (disposed) {
                return;
              }

              dispatchModel({
                type: 'session_runtime_loaded',
                models: session.models,
                modes: session.modes,
              });
              dispatchChat({ type: 'history_loaded' });
              setSessions((current) =>
                current.map((entry) =>
                  entry.sessionId === session.sessionId
                    ? { ...entry, ...session }
                    : entry,
                ),
              );
              setSessionError(null);
            })
            .catch((error: unknown) => {
              if (!disposed) {
                setSessionError(getErrorMessage(error));
              }
            });
        },
        onMessage: (message) => {
          handleSessionSocketMessage(message, dispatchChat, dispatchModel);
          if (message.type === 'message_complete') {
            publishPendingSession();
          }
        },
        onClose: () => {
          if (!disposed) {
            dispatchChat({ type: 'disconnect' });
          }
        },
        onError: () => {
          if (!disposed) {
            setSessionError('Session socket connection failed.');
          }
        },
      },
    );
    socketRef.current = socket;

    return () => {
      disposed = true;
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeSessionId, loadState, publishPendingSession]);

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
        setIsDraftSession(false);
        setGitDiff(null);
        pendingSocketActionRef.current = null;
        pendingPublishSessionRef.current = null;
        dispatchChat({ type: 'reset' });
      }
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, [loadState]);

  const createSession = useCallback(() => {
    if (loadState.state !== 'ready' || !activeProject) {
      return;
    }

    socketRef.current?.close();
    socketRef.current = null;
    pendingSocketActionRef.current = null;
    pendingPublishSessionRef.current = null;
    setActiveSessionId(null);
    setIsDraftSession(true);
    setMessageText('');
    setSessionError(null);
    dispatchChat({ type: 'reset' });
    dispatchModel({ type: 'reset' });
  }, [activeProject, loadState]);

  const selectProject = useCallback(
    (projectId: string) => {
      const selectedProject =
        projects.find((project) => project.id === projectId) ?? null;
      setActiveProjectId(projectId);
      setActiveSessionId(null);
      setIsDraftSession(false);
      setMessageText('');
      setGitDiff(null);
      pendingSocketActionRef.current = null;
      pendingPublishSessionRef.current = null;
      dispatchChat({ type: 'reset' });

      if (loadState.state !== 'ready' || !selectedProject) {
        return;
      }

      void openDesktopProject(loadState.status.serverInfo, selectedProject.path)
        .then((project) => {
          setProjects((current) => [
            project,
            ...current.filter((entry) => entry.id !== project.id),
          ]);
          setSessionError(null);
        })
        .catch((error: unknown) => {
          setSessionError(getErrorMessage(error));
        });
    },
    [loadState, projects],
  );

  const selectSession = useCallback(
    (sessionId: string) => {
      if (loadState.state !== 'ready' || !activeProject) {
        return;
      }

      pendingSocketActionRef.current = {
        type: 'load',
        sessionId,
        cwd: activeProject.path,
      };
      pendingPublishSessionRef.current = null;
      setIsDraftSession(false);
      setMessageText('');
      setSessionError(null);
      dispatchChat({ type: 'reset' });
      dispatchModel({ type: 'reset' });

      if (activeSessionId === sessionId) {
        socketRef.current?.close();
        socketRef.current = null;
        setActiveSessionId(null);
        window.setTimeout(() => setActiveSessionId(sessionId), 0);
        return;
      }

      setActiveSessionId(sessionId);
    },
    [activeProject, activeSessionId, loadState],
  );

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

  const listProjectBranches = useCallback(async (): Promise<
    DesktopGitBranch[]
  > => {
    if (loadState.state !== 'ready' || !activeProject) {
      return [];
    }

    const result = await listDesktopProjectGitBranches(
      loadState.status.serverInfo,
      activeProject.id,
    );
    return result.branches;
  }, [activeProject, loadState]);

  const checkoutProjectBranch = useCallback(
    async (branchName: string): Promise<void> => {
      if (loadState.state !== 'ready' || !activeProject) {
        return;
      }

      try {
        const result = await checkoutDesktopProjectBranch(
          loadState.status.serverInfo,
          activeProject.id,
          branchName,
        );
        applyReviewMutation(result.status, result.diff);
        setSessionError(null);
      } catch (error) {
        setSessionError(getErrorMessage(error));
        throw error;
      }
    },
    [activeProject, applyReviewMutation, loadState],
  );

  const createProjectBranch = useCallback(
    async (branchName: string): Promise<void> => {
      if (loadState.state !== 'ready' || !activeProject) {
        return;
      }

      try {
        const result = await createDesktopProjectGitBranch(
          loadState.status.serverInfo,
          activeProject.id,
          branchName,
        );
        applyReviewMutation(result.status, result.diff);
        setSessionError(null);
      } catch (error) {
        setSessionError(getErrorMessage(error));
        throw error;
      }
    },
    [activeProject, applyReviewMutation, loadState],
  );

  const stageReviewTarget = useCallback(
    async (target: DesktopGitReviewTarget) => {
      if (loadState.state !== 'ready' || !activeProject) {
        return;
      }

      try {
        const result = await stageDesktopProjectChanges(
          loadState.status.serverInfo,
          activeProject.id,
          target,
        );
        applyReviewMutation(result.status, result.diff);
      } catch (error) {
        setReviewError(getErrorMessage(error));
      }
    },
    [activeProject, applyReviewMutation, loadState],
  );

  const revertReviewTarget = useCallback(
    async (target: DesktopGitReviewTarget) => {
      if (loadState.state !== 'ready' || !activeProject) {
        return;
      }

      try {
        const result = await revertDesktopProjectChanges(
          loadState.status.serverInfo,
          activeProject.id,
          target,
        );
        applyReviewMutation(result.status, result.diff);
      } catch (error) {
        setReviewError(getErrorMessage(error));
      }
    },
    [activeProject, applyReviewMutation, loadState],
  );

  const openReviewFile = useCallback(
    async (filePath: string) => {
      if (!activeProject) {
        return;
      }

      try {
        await window.qwenDesktop.openPath(
          joinProjectFilePath(activeProject.path, filePath),
        );
        setReviewError(null);
      } catch (error) {
        setReviewError(getErrorMessage(error));
      }
    },
    [activeProject],
  );

  const updateMessageText = useCallback((message: string) => {
    setMessageText(message);
    setChatNotice(null);
  }, []);

  const copyChatMessage = useCallback(async (message: string) => {
    try {
      await writeClipboardText(message);
      setChatNotice('Copied response.');
    } catch (error) {
      setSessionError(getErrorMessage(error));
    }
  }, []);

  const retryChatMessage = useCallback((message: string) => {
    setMessageText(message);
    setChatNotice('Restored last prompt to composer.');
  }, []);

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
      setTerminalNotice(null);
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [activeProject, loadState, terminalCommand]);

  const writeTerminalInput = useCallback(async () => {
    if (
      loadState.state !== 'ready' ||
      !terminal ||
      terminal.status !== 'running' ||
      terminalInput.trim().length === 0
    ) {
      return;
    }

    try {
      setTerminal(
        await writeDesktopTerminalInput(
          loadState.status.serverInfo,
          terminal.id,
          ensureTerminalInputLine(terminalInput),
        ),
      );
      setTerminalInput('');
      setTerminalError(null);
      setTerminalNotice('Input sent.');
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [loadState, terminal, terminalInput]);

  const killTerminal = useCallback(async () => {
    if (loadState.state !== 'ready' || !terminal) {
      return;
    }

    try {
      setTerminal(
        await killDesktopTerminal(loadState.status.serverInfo, terminal.id),
      );
      setTerminalError(null);
      setTerminalNotice('Terminal stopped.');
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [loadState, terminal]);

  const clearTerminal = useCallback(() => {
    setTerminal(null);
    setTerminalInput('');
    setTerminalError(null);
    setTerminalNotice(null);
  }, []);

  const copyTerminalOutput = useCallback(async () => {
    if (!terminal) {
      return;
    }

    try {
      await writeClipboardText(formatTerminalTranscript(terminal));
      setTerminalError(null);
      setTerminalNotice('Copied terminal output.');
    } catch (error) {
      setTerminalError(getErrorMessage(error));
    }
  }, [terminal]);

  const attachTerminalOutputToComposer = useCallback(() => {
    if (!terminal) {
      setTerminalError('Run a terminal command before attaching output.');
      return;
    }

    const output = terminal.output.trim();
    if (!output) {
      setTerminalError('Terminal output is empty.');
      return;
    }

    const content = buildTerminalAttachmentDraft(terminal);
    setMessageText((current) =>
      current.trim().length > 0
        ? `${current.trimEnd()}\n\n${content}`
        : content,
    );
    setTerminalError(null);
    setTerminalNotice('Attached terminal output to composer.');
  }, [terminal]);

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

    const validation = validateSettingsForm(
      settingsState.form,
      settingsState.settings,
    );
    if (!validation.valid) {
      dispatchSettings({
        type: 'save_error',
        message: validation.reason ?? 'Settings are incomplete.',
      });
      return;
    }

    dispatchSettings({ type: 'save_start' });
    try {
      const settings = await updateDesktopUserSettings(
        loadState.status.serverInfo,
        buildSettingsUpdateRequest(settingsState.form),
      );
      dispatchSettings({ type: 'save_success', settings });
      dispatchModel({ type: 'settings_models_loaded', settings });
    } catch (error) {
      dispatchSettings({ type: 'save_error', message: getErrorMessage(error) });
    }
  }, [loadState, settingsState.form, settingsState.settings]);

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
      if (!content) {
        return;
      }

      if (!activeSessionId && activeProject) {
        if (loadState.state !== 'ready' || !activeProject) {
          return;
        }

        dispatchChat({ type: 'append_user_message', content });
        setMessageText('');
        setChatNotice(null);
        void createDesktopSession(
          loadState.status.serverInfo,
          activeProject.path,
        )
          .then((session) => {
            const pendingSession = {
              ...session,
              cwd: session.cwd ?? activeProject.path,
              title: session.title ?? summarizeMessage(content),
            };
            pendingPublishSessionRef.current = pendingSession;
            pendingSocketActionRef.current = {
              type: 'send',
              sessionId: session.sessionId,
              content,
            };
            setIsDraftSession(false);
            setActiveSessionId(session.sessionId);
            dispatchModel({
              type: 'session_runtime_loaded',
              models: session.models,
              modes: session.modes,
            });
            setSessionError(null);
          })
          .catch((error: unknown) => {
            setSessionError(getErrorMessage(error));
            dispatchChat({
              type: 'server_message',
              message: {
                type: 'error',
                code: 'session_create_failed',
                message: getErrorMessage(error),
                retryable: true,
              },
            });
          });
        return;
      }

      if (!socketRef.current) {
        return;
      }

      dispatchChat({ type: 'append_user_message', content });
      socketRef.current.sendUserMessage(content);
      setMessageText('');
      setChatNotice(null);
    },
    [activeProject, activeSessionId, loadState, messageText],
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
      isDraftSession={isDraftSession}
      projects={projects}
      reviewError={reviewError}
      sessionError={sessionError}
      sessions={sessions}
      settingsState={settingsState}
      statusLabel={statusLabel}
      terminal={terminal}
      terminalCommand={terminalCommand}
      terminalError={terminalError}
      terminalInput={terminalInput}
      terminalNotice={terminalNotice}
      chatNotice={chatNotice}
      onAskUserQuestionResponse={respondToAskUserQuestion}
      onAuthenticate={authenticate}
      onChooseWorkspace={chooseWorkspace}
      onClearTerminal={clearTerminal}
      onCommit={commitChanges}
      onCommitMessageChange={setCommitMessage}
      onCopyMessage={copyChatMessage}
      onCopyTerminalOutput={copyTerminalOutput}
      onCreateSession={createSession}
      onKillTerminal={killTerminal}
      onMessageTextChange={updateMessageText}
      onModeChange={changeMode}
      onModelChange={changeModel}
      onOpenFileReference={openReviewFile}
      onPermissionResponse={respondToPermission}
      onRefreshProjectGitStatus={refreshProjectGitStatus}
      onListProjectBranches={listProjectBranches}
      onCheckoutProjectBranch={checkoutProjectBranch}
      onCreateProjectBranch={createProjectBranch}
      onOpenReviewFile={openReviewFile}
      onRevertReviewTarget={revertReviewTarget}
      onRunTerminalCommand={runTerminalCommand}
      onSaveSettings={saveSettings}
      onAttachTerminalOutput={attachTerminalOutputToComposer}
      onSelectProject={selectProject}
      onSelectSession={selectSession}
      onSendMessage={sendMessage}
      onSettingsDispatch={dispatchSettings}
      onStageReviewTarget={stageReviewTarget}
      onStopGeneration={stopGeneration}
      onRetryMessage={retryChatMessage}
      onTerminalCommandChange={setTerminalCommand}
      onTerminalInputChange={setTerminalInput}
      onWriteTerminalInput={writeTerminalInput}
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

function summarizeMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  return normalized.length > 80
    ? `${normalized.slice(0, 77).trimEnd()}...`
    : normalized;
}

function joinProjectFilePath(projectPath: string, filePath: string): string {
  const separator = projectPath.includes('\\') ? '\\' : '/';
  const base =
    projectPath.endsWith('/') || projectPath.endsWith('\\')
      ? projectPath.slice(0, -1)
      : projectPath;
  return `${base}${separator}${filePath}`;
}

function ensureTerminalInputLine(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

function formatTerminalTranscript(terminal: DesktopTerminal): string {
  const exitText =
    terminal.exitCode === null ? '' : ` exit ${String(terminal.exitCode)}`;
  return `$ ${terminal.command}\n[${terminal.status}]${exitText}\n${terminal.output}`;
}

function buildTerminalAttachmentDraft(terminal: DesktopTerminal): string {
  const transcript = formatTerminalTranscript(terminal);
  const boundedTranscript =
    transcript.length > 12_000
      ? `...[terminal output truncated]\n${transcript.slice(-12_000)}`
      : transcript;

  return `Review this terminal output from the current project and use it to continue the task.\n\n${boundedTranscript}`;
}

async function writeClipboardText(text: string): Promise<void> {
  if (window.qwenDesktop?.writeClipboardText) {
    await window.qwenDesktop.writeClipboardText(text);
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the DOM copy command below when Clipboard API permission
      // is unavailable in a file:// Electron renderer.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.top = '-1000px';
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  textArea.remove();

  if (!copied) {
    throw new Error('Clipboard is unavailable.');
  }
}
