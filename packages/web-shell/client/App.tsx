import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDaemonSession } from './hooks/useDaemonSession';
import {
  transcriptBlocksToMessages,
  extractPendingPermission,
  extractStreamingState,
} from './adapters/transcriptAdapter';
import { MessageList } from './components/MessageList';
import { Editor, type PastedImage } from './components/Editor';
import { StatusBar } from './components/StatusBar';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { StreamingStatus } from './components/StreamingStatus';
import { TodoPanel } from './components/panels/TodoPanel';
import { WelcomeHeader } from './components/WelcomeHeader';
import { ModelDialog } from './components/dialogs/ModelDialog';
import { ApprovalModeDialog } from './components/dialogs/ApprovalModeDialog';
import { ResumeDialog } from './components/dialogs/ResumeDialog';
import { McpDialog } from './components/dialogs/McpDialog';
import { MemoryDialog } from './components/dialogs/MemoryDialog';
import { AgentsDialog } from './components/dialogs/AgentsDialog';
import { SkillsDialog } from './components/dialogs/SkillsDialog';
import { LOCAL_COMMANDS } from './constants/localCommands';
import { getDaemonBaseUrl, getDaemonToken } from './config/daemon';
import type { DaemonApprovalMode } from '@qwen-code/sdk/daemon';
import type { CommandInfo, StreamingState } from './adapters/types';

const DAEMON_BASE_URL = getDaemonBaseUrl();
const DAEMON_TOKEN = getDaemonToken();
const WEB_SHELL_VERSION = '0.0.1';
const MODES_CYCLE = ['plan', 'default', 'auto-edit', 'yolo'];

function getSessionIdFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.pathname.match(/\/session\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function replaceSessionUrl(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  window.history.replaceState(null, '', url);
}

function parseRenameArgument(
  raw: string,
):
  | { type: 'auto' }
  | { type: 'manual'; displayName: string }
  | { type: 'delegate' } {
  const trimmed = raw.trim().replace(/[\r\n]+/g, ' ');
  if (!trimmed) return { type: 'auto' };
  if (trimmed === '--') return { type: 'manual', displayName: '' };
  if (trimmed.startsWith('-- ')) {
    return { type: 'manual', displayName: trimmed.slice(3).trim() };
  }
  if (trimmed.toLowerCase() === '--auto') return { type: 'auto' };
  if (trimmed.startsWith('--')) return { type: 'delegate' };
  return { type: 'manual', displayName: trimmed };
}

export function App() {
  const initialSessionId = useMemo(() => getSessionIdFromUrl(), []);
  const { store, state, connection, actions, promptStatus } = useDaemonSession({
    baseUrl: DAEMON_BASE_URL,
    token: DAEMON_TOKEN,
    initialSessionId,
  });

  const messages = useMemo(
    () => transcriptBlocksToMessages(state.blocks),
    [state.blocks],
  );
  const pendingApproval = useMemo(
    () => extractPendingPermission(state),
    [state],
  );
  const floatingTodos = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === 'plan') {
        return message.todos;
      }
    }
    return [];
  }, [messages]);
  const transcriptStreamingState = useMemo(
    () => extractStreamingState(state),
    [state],
  );
  const streamingState = useMemo<StreamingState>(() => {
    if (promptStatus === 'idle') {
      return transcriptStreamingState;
    }
    if (transcriptStreamingState !== 'idle') {
      return transcriptStreamingState;
    }
    return promptStatus === 'waiting' ? 'waiting' : 'responding';
  }, [promptStatus, transcriptStreamingState]);
  const connected = connection.status === 'connected';

  const [modelDialogMode, setModelDialogMode] = useState<
    'main' | 'fast' | null
  >(null);
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showMcpDialog, setShowMcpDialog] = useState(false);
  const [showSkillsDialog, setShowSkillsDialog] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [agentsDialogMode, setAgentsDialogMode] = useState<
    'create' | 'manage' | null
  >(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [currentModel, setCurrentModel] = useState('');
  const [currentMode, setCurrentMode] = useState('default');

  const handleToggleShortcuts = useCallback(() => {
    setShowShortcuts((prev) => !prev);
  }, []);

  const handleSetMode = useCallback(
    (modeId: string) => {
      actions
        .setApprovalMode(modeId as DaemonApprovalMode)
        .then((result) => {
          setCurrentMode(result.mode || modeId);
        })
        .catch(() => {});
    },
    [actions],
  );

  useEffect(() => {
    if (connection.currentModel) {
      setCurrentModel(connection.currentModel);
    }
  }, [connection.currentModel]);

  useEffect(() => {
    if (connection.currentMode) {
      setCurrentMode(connection.currentMode);
    }
  }, [connection.currentMode]);

  useEffect(() => {
    if (connection.sessionId) {
      replaceSessionUrl(connection.sessionId);
    }
  }, [connection.sessionId]);

  const handleCycleMode = useCallback(() => {
    const idx = MODES_CYCLE.indexOf(currentMode);
    const next = MODES_CYCLE[(idx + 1) % MODES_CYCLE.length];
    handleSetMode(next);
  }, [currentMode, handleSetMode]);

  const handleSubmit = useCallback(
    (text: string, images?: PastedImage[]) => {
      const promptBlocked = streamingState !== 'idle';
      if (text.startsWith('/')) {
        const match = text.match(/^\/([\w-]+)/);
        if (match) {
          const cmd = match[1];
          if (cmd === 'model') {
            const modelArg = text.slice(match[0].length).trim();
            if (modelArg === '--fast') {
              if (promptBlocked) return false;
              setModelDialogMode('fast');
              return true;
            }
            if (modelArg.startsWith('--fast ')) {
              if (promptBlocked) return false;
              actions.sendPrompt(text, images).catch(() => {});
              return true;
            }
            if (modelArg) {
              actions
                .setModel(modelArg)
                .then(() => {
                  setCurrentModel(modelArg);
                })
                .catch(() => {});
            } else {
              setModelDialogMode('main');
            }
            return true;
          }
          if (cmd === 'plan') {
            if (promptBlocked) return false;
            const prompt = text.slice(match[0].length).trim();
            actions
              .setApprovalMode('plan')
              .then(() => {
                setCurrentMode('plan');
                if (prompt) {
                  actions.sendPrompt(prompt, images).catch(() => {});
                }
              })
              .catch(() => {});
            return true;
          }
          if (cmd === 'approval-mode' || cmd === 'mode') {
            const modeArg = text.slice(match[0].length).trim();
            if (modeArg) {
              handleSetMode(modeArg);
            } else {
              setShowModeDialog(true);
            }
            return true;
          }
          if (cmd === 'mcp') {
            setShowMcpDialog(true);
            return true;
          }
          if (cmd === 'skills') {
            const skillArg = text.slice(match[0].length).trim();
            if (skillArg) {
              if (promptBlocked) return false;
              actions.sendPrompt(text, images).catch(() => {});
            } else {
              setShowSkillsDialog(true);
            }
            return true;
          }
          if (cmd === 'memory') {
            setShowMemoryDialog(true);
            return true;
          }
          if (cmd === 'agents') {
            const subCommand = text.slice(match[0].length).trim();
            setAgentsDialogMode(subCommand === 'create' ? 'create' : 'manage');
            return true;
          }
          if (cmd === 'clear') {
            store.reset();
            return true;
          }
          if (cmd === 'new' || cmd === 'reset') {
            actions.newSession().catch(() => {});
            return true;
          }
          if (cmd === 'rename') {
            const renameArg = parseRenameArgument(text.slice(match[0].length));
            if (renameArg.type === 'auto' || renameArg.type === 'delegate') {
              if (promptBlocked) return false;
              actions.sendPrompt(text, images).catch(() => {});
              return true;
            }
            const displayName = renameArg.displayName;
            if (!displayName) {
              store.dispatch([
                {
                  type: 'error',
                  text: '请输入新的会话名称，例如 /rename 项目排查，或使用 /rename --auto 自动生成',
                },
              ]);
              return true;
            }
            actions
              .renameSession(displayName)
              .then(() => {
                store.dispatch([
                  {
                    type: 'status',
                    text: `会话已重命名为 ${displayName}`,
                  },
                ]);
              })
              .catch((error: unknown) => {
                store.dispatch([
                  {
                    type: 'error',
                    text:
                      error instanceof Error ? error.message : '会话重命名失败',
                  },
                ]);
              });
            return true;
          }
          if (cmd === 'resume') {
            const sessionId = text.slice(match[0].length).trim();
            if (sessionId) {
              actions.loadSession(sessionId).catch(() => {});
            } else {
              setShowResumeDialog(true);
            }
            return true;
          }
        }
        // Forward slash commands as prompts
        if (promptBlocked) return false;
        actions.sendPrompt(text, images).catch(() => {});
        return true;
      } else if (text.startsWith('!')) {
        if (promptBlocked) return false;
        const cmd = text.slice(1).trim();
        if (!cmd) return false;
        actions
          .sendPrompt(
            `Run the following shell command exactly, do not modify it:\n\`\`\`sh\n${cmd}\n\`\`\``,
          )
          .catch(() => {});
        return true;
      } else {
        if (promptBlocked) return false;
        actions.sendPrompt(text, images).catch(() => {});
        return true;
      }
    },
    [actions, store, handleSetMode, streamingState],
  );

  const handleConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) => {
      actions.respondToPermission(id, selectedOption, answers).catch(() => {});
    },
    [actions],
  );

  const handleCancel = useCallback(() => {
    actions.cancel().catch(() => {});
  }, [actions]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && streamingState !== 'idle' && !pendingApproval) {
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [streamingState, handleCancel, pendingApproval]);

  const isDisabled = !connected;

  const handleModelSelect = useCallback(
    (modelId: string) => {
      actions
        .setModel(modelId)
        .then(() => {
          setCurrentModel(modelId);
        })
        .catch(() => {});
    },
    [actions],
  );

  const handleFastModelSelect = useCallback(
    (modelId: string) => {
      if (streamingState !== 'idle') return;
      actions.sendPrompt(`/model --fast ${modelId}`).catch(() => {});
    },
    [actions, streamingState],
  );

  const commands = useMemo(
    () => mergeCommands(LOCAL_COMMANDS, connection.commands ?? []),
    [connection.commands],
  );

  return (
    <div className="app">
      {modelDialogMode ? (
        <ModelDialog
          mode={modelDialogMode}
          currentModel={currentModel}
          availableModels={connection.models ?? []}
          onSelect={
            modelDialogMode === 'fast'
              ? handleFastModelSelect
              : handleModelSelect
          }
          onClose={() => setModelDialogMode(null)}
        />
      ) : showResumeDialog ? (
        <ResumeDialog
          currentSessionId={connection.sessionId}
          loadSessions={actions.listSessions}
          onSelect={(sessionId) => {
            actions.loadSession(sessionId).catch(() => {});
          }}
          onClose={() => setShowResumeDialog(false)}
        />
      ) : showModeDialog ? (
        <ApprovalModeDialog
          currentMode={currentMode}
          onSelect={handleSetMode}
          onClose={() => setShowModeDialog(false)}
        />
      ) : showMcpDialog ? (
        <McpDialog
          loadStatus={actions.loadMcpStatus}
          restartServer={actions.restartMcpServer}
          onClose={() => setShowMcpDialog(false)}
        />
      ) : showSkillsDialog ? (
        <SkillsDialog
          loadStatus={actions.loadSkillsStatus}
          onClose={() => setShowSkillsDialog(false)}
        />
      ) : showMemoryDialog ? (
        <MemoryDialog
          loadStatus={actions.loadMemoryStatus}
          writeMemory={actions.writeMemory}
          onClose={() => setShowMemoryDialog(false)}
        />
      ) : agentsDialogMode ? (
        <AgentsDialog
          initialMode={agentsDialogMode}
          listAgents={actions.listAgents}
          getAgent={actions.getAgent}
          createAgent={actions.createAgent}
          deleteAgent={actions.deleteAgent}
          onClose={() => setAgentsDialogMode(null)}
        />
      ) : (
        <>
          <div
            className={
              messages.length > 0 || streamingState !== 'idle'
                ? 'app-content app-content-has-messages'
                : 'app-content'
            }
          >
            <MessageList
              messages={messages}
              pendingApproval={pendingApproval}
              onConfirm={handleConfirm}
              welcomeHeader={
                <WelcomeHeader
                  version={WEB_SHELL_VERSION}
                  cwd={connection.workspaceCwd || ''}
                  currentModel={currentModel}
                  currentMode={currentMode}
                />
              }
            />

            <StreamingStatus
              streamingState={streamingState}
              tokenCount={connection.tokenCount ?? 0}
            />
          </div>

          <div className="app-footer">
            {floatingTodos.length > 0 && <TodoPanel todos={floatingTodos} />}
            <div className="composer">
              <Editor
                onSubmit={handleSubmit}
                onCycleMode={handleCycleMode}
                onToggleShortcuts={handleToggleShortcuts}
                disabled={isDisabled}
                commands={commands}
                skills={connection.skills ?? []}
                currentMode={currentMode}
                placeholderText={
                  !connected
                    ? '连接中...'
                    : streamingState !== 'idle'
                      ? '正在处理中，可输入 /resume 切换会话'
                      : '输入您的消息或 @ 文件路径'
                }
              />
            </div>

            {showShortcuts ? (
              <ShortcutsPanel />
            ) : (
              <StatusBar
                connected={connected}
                streamingState={streamingState}
                currentModel={currentModel}
                currentMode={currentMode}
                tokenCount={connection.tokenCount ?? 0}
                contextWindow={connection.contextWindow ?? 0}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function mergeCommands(...groups: CommandInfo[][]): CommandInfo[] {
  const byName = new Map<string, CommandInfo>();
  for (const group of groups) {
    for (const command of group) {
      byName.set(command.name, {
        ...byName.get(command.name),
        ...command,
      });
    }
  }
  return [...byName.values()];
}
