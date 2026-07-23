/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Maximize2Icon, Minimize2Icon } from 'lucide-react';
import {
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptHistory,
  useTranscriptStore,
  useWorkspace,
  useWorkspaceActions,
  type DaemonWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';
import { SubagentDetailsProvider } from '../subagentDetailsContext';
import { useI18n } from '../i18n';
import { SESSION_TRANSCRIPT_PAGINATION_FEATURE } from '../constants/sessions';
import { useMessages } from '../hooks/useMessages';
import { useSessionArtifacts } from '../hooks/useSessionArtifacts';
import { extractPendingPermission } from '../adapters/transcriptAdapter';
import type { PromptImage } from '../adapters/promptTypes';
import type {
  ComposerSubmitCommit,
  ComposerSubmitMetadata,
  EditorHandle,
} from '../hooks/useComposerCore';
import { useQueuedPrompts } from '../hooks/useQueuedPrompts';
import { isAskUserPermission } from '../utils/askUserPermission';
import { isDaemonApprovalMode } from '../utils/sessionPreparation';
import { isVisibleComposerModel } from '../utils/composerModels';
import { shouldBlockComposerSubmit } from '../utils/composerInputState';
import { invokeSlashCommandHandler } from '../utils/slash-command-action';
import type { WebShellSlashCommandHandler } from '../App';
import { getModelDisplayName } from '../utils/modelDisplay';
import {
  hasMultipleWorkspaces,
  workspaceLabelForCwd,
} from '../utils/workspace';
import { workspaceAccentColor } from '../utils/workspaceColor';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from '../constants/localCommands';
import { mergeCommands } from '../hooks/daemonSessionMappers';
import { MessageList } from './MessageList';
import { StreamingStatus } from './StreamingStatus';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';
import { QueuedPromptDisplay } from './QueuedPromptDisplay';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import type {
  TurnOutputKind,
  TurnOutputOpenRequest,
} from './artifacts/TurnOutputs';
import { TURN_OUTPUT_KINDS } from './artifacts/TurnOutputs';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
  getScheduledTasksByTurn,
} from './artifacts/turnOutputSelectors';
import styles from './ChatPane.module.css';
import accentStyles from './WorkspaceAccent.module.css';

// Split-view panes get the same interactive composer controls as the main chat,
// each scoped to the pane's own session: the approval-mode and model pickers,
// plus voice dictation. The width toggle is omitted (panes size themselves); the
// slash menu is populated from the session's own command list (see below).
const PANE_TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [
  'approvalMode',
  'model',
  'voice',
];

export interface ChatPaneProps {
  /** Header label; falls back to the session's own display name / id. */
  title?: string;
  /**
   * The workspace this pane's session lives in. Passed explicitly by the split
   * view (which knows it per session) and shown as a composer-toolbar chip on a
   * multi-workspace daemon; falls back to the connection's own workspace.
   */
  workspaceCwd?: string;
  onClose?: () => void;
  /**
   * Toggle this pane between maximized (solo, filling the whole split) and the
   * tiled layout. Omitted when only one pane is open — there's nothing to
   * maximize against.
   */
  onToggleMaximize?: () => void;
  /** Whether this pane is currently the maximized (solo) one. */
  isMaximized?: boolean;
  onError?: (error: unknown, fallback: string) => void;
  /** Host slash-command callback shared with the main chat composer. */
  onSlashCommand?: WebShellSlashCommandHandler;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onPaneArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
    workspaceActions: DaemonWorkspaceActions,
  ) => void;
  messageTurnOutputs?: readonly TurnOutputKind[];
  /** Allow prompt admission to recover a disconnected SSE stream. */
  restartSseOnPrompt?: boolean;
}

/**
 * A self-contained interactive chat, scoped to whichever `DaemonSessionProvider`
 * it is nested under. Rendering N of these (each under its own provider) inside
 * one window is the split view: every pane has its own transcript, streaming
 * state, approvals, and composer, and the browser scopes keyboard focus to the
 * pane the user clicks into — so there is no cross-pane approval arbitration.
 */
export function ChatPane({
  title,
  workspaceCwd,
  onClose,
  onToggleMaximize,
  isMaximized = false,
  onError,
  onSlashCommand,
  onRightPanelOpen,
  onPaneArtifactsChange,
  messageTurnOutputs,
  restartSseOnPrompt = false,
}: ChatPaneProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const workspaceActions = useWorkspaceActions();
  const workspace = useWorkspace();
  const messages = useMessages(t);
  const blocks = useTranscriptBlocks();
  const transcriptHistory = useTranscriptHistory();
  const store = useTranscriptStore();
  const streamingState = useStreamingState();
  const { artifacts } = useSessionArtifacts();
  const openSubagentDetails = useCallback(
    (tool: ACPToolCall) => {
      if (!connection.sessionId || !onRightPanelOpen) return;
      const rawOutput =
        tool.rawOutput && typeof tool.rawOutput === 'object'
          ? (tool.rawOutput as Record<string, unknown>)
          : undefined;
      const subagentType =
        (typeof tool.args?.subagent_type === 'string'
          ? tool.args.subagent_type
          : undefined) ??
        (typeof rawOutput?.['subagentName'] === 'string'
          ? rawOutput['subagentName']
          : undefined);
      onRightPanelOpen({
        id: `subagent:${connection.sessionId}:${tool.callId}`,
        kind: 'subagent',
        title: tool.title || subagentType || t('agent.label'),
        turnId: tool.callId,
        tool,
        sessionId: connection.sessionId,
        workspaceCwd: connection.workspaceCwd ?? workspaceCwd,
      });
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      onRightPanelOpen,
      t,
      workspaceCwd,
    ],
  );
  useEffect(() => {
    const sessionId = connection.sessionId;
    if (!sessionId) return;
    onPaneArtifactsChange?.(sessionId, artifacts, workspaceActions);
    return () => {
      onPaneArtifactsChange?.(sessionId, [], workspaceActions);
    };
  }, [
    artifacts,
    connection.sessionId,
    onPaneArtifactsChange,
    workspaceActions,
  ]);
  const streamingStateRef = useRef(streamingState);
  streamingStateRef.current = streamingState;
  const reloadTranscript = useCallback(
    async (signal: AbortSignal) => {
      if (!connection.sessionId) return;
      await actions.reloadSession(signal);
    },
    [actions, connection.sessionId],
  );
  const transcriptReloadSupported =
    connection.capabilities?.features.includes(
      SESSION_TRANSCRIPT_PAGINATION_FEATURE,
    ) === true;
  const editorRef = useRef<EditorHandle | null>(null);
  const {
    followupState,
    onAcceptFollowup,
    onDismissFollowup,
    clear: clearFollowup,
  } = useDaemonFollowupSuggestion({
    onAccept: (suggestion) => {
      editorRef.current?.insertText(suggestion);
    },
  });

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      if (onError) onError(error, fallback);
      else console.error(fallback, error);
    },
    [onError],
  );
  const onSlashCommandRef = useRef(onSlashCommand);
  onSlashCommandRef.current = onSlashCommand;
  const notifySuccess = useCallback(
    (message: string) => store.dispatch([{ type: 'status', text: message }]),
    [store],
  );

  const pendingApproval = useMemo(
    () => extractPendingPermission(blocks),
    [blocks],
  );
  const isAskUser = isAskUserPermission(pendingApproval);
  const pendingToolApproval =
    pendingApproval && !isAskUser ? pendingApproval : null;
  const pendingAskUserApproval =
    pendingApproval && isAskUser ? pendingApproval : null;
  // Tracked in a ref so an async approval-mode switch (handleSelectMode) reads
  // the approval current when setApprovalMode *resolves*, not a stale one
  // captured at click time — mirrors App's pendingApprovalRef.
  const pendingToolApprovalRef = useRef(pendingToolApproval);
  pendingToolApprovalRef.current = pendingToolApproval;
  const approvalActive =
    pendingToolApproval !== null || pendingAskUserApproval !== null;
  const isResponding = streamingState !== 'idle';
  const artifactsByTurn = useMemo(
    () =>
      getArtifactsByTurn(messages, artifacts, connection.workspaceCwd || ''),
    [messages, artifacts, connection.workspaceCwd],
  );
  const fileChangesByTurn = useMemo(
    () =>
      getFileChangesByTurn(
        messages,
        artifactsByTurn,
        connection.workspaceCwd || '',
      ),
    [messages, artifactsByTurn, connection.workspaceCwd],
  );
  const scheduledTasksByTurn = useMemo(
    () => getScheduledTasksByTurn(messages),
    [messages],
  );
  const visibleTurnOutputKinds = useMemo(
    () => new Set<TurnOutputKind>(messageTurnOutputs ?? TURN_OUTPUT_KINDS),
    [messageTurnOutputs],
  );
  const {
    queuedPrompts,
    queuedTexts,
    enqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  } = useQueuedPrompts({
    connected: connection.status === 'connected',
    sessionId: connection.sessionId,
    clientId: connection.clientId,
    streamingState,
    sessionActions: actions,
    store,
    editorRef,
    reportError,
    notifySuccess,
    t,
  });

  // Anchor the streaming timer to the turn's own start (the last user message's
  // timestamp) rather than letting StreamingStatus fall back to "now" — so a
  // pane opened mid-turn shows the real elapsed time, not a reset-to-zero clock.
  const activeTurnStartedAt = useMemo(() => {
    if (!isResponding) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'user') return message.timestamp;
    }
    return undefined;
  }, [messages, isResponding]);

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      commitAccepted?: ComposerSubmitCommit,
      metadata?: ComposerSubmitMetadata,
    ): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (
        invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError)
      ) {
        return true;
      }
      if (
        shouldBlockComposerSubmit({
          connectionStatus: connection.status,
          hasSession: Boolean(connection.sessionId),
          restartSseOnPrompt,
        })
      ) {
        return false;
      }
      const inputAnnotations = metadata?.inputAnnotations;
      if (streamingStateRef.current === 'idle') {
        actions
          .sendPrompt(trimmed, {
            ...(images && images.length ? { images } : {}),
            ...(inputAnnotations ? { inputAnnotations } : {}),
            onAdmitted: () => {
              clearFollowup();
              commitAccepted?.();
            },
          })
          .catch((error: unknown) =>
            reportError(error, 'Failed to send prompt'),
          );
        return false;
      }
      return inputAnnotations
        ? enqueuePrompt(trimmed, images, undefined, inputAnnotations)
        : enqueuePrompt(trimmed, images);
    },
    [
      actions,
      clearFollowup,
      connection.sessionId,
      connection.status,
      enqueuePrompt,
      reportError,
      restartSseOnPrompt,
    ],
  );

  const handleConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) => {
      actions
        .submitPermission(id, selectedOption, answers)
        .catch((error: unknown) =>
          reportError(error, 'Failed to submit permission choice'),
        );
    },
    [actions, reportError],
  );

  const handleCancel = useCallback(() => {
    actions
      .cancel()
      .catch((error: unknown) =>
        reportError(error, 'Failed to cancel request'),
      );
  }, [actions, reportError]);

  const handleRightPanelOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      if (!onRightPanelOpen) return;
      if (request.kind === 'subagent') {
        onRightPanelOpen(request);
        return;
      }
      onRightPanelOpen({ ...request, workspaceActions });
    },
    [onRightPanelOpen, workspaceActions],
  );

  // Composer wiring, all scoped to THIS pane's own DaemonSession context. The
  // slash menu lists the session's daemon commands — they run server-side when
  // submitted (via sendPrompt), so e.g. `/clear` clears this pane's session, not
  // the outer one. The approval-mode and model pickers likewise drive this
  // session's own actions; the SDK reflects the change back on `connection`.
  const commands = useMemo(() => {
    return localizeBuiltinDescriptions(
      mergeCommands(connection.commands ?? [], getLocalCommands(t)),
      t,
    ).map((command) => {
      const skillKey = skillDescriptionKey(command.name);
      if (!skillKey) return command;
      return {
        ...command,
        displayCategory: 'skill' as const,
        description: t(skillKey),
      };
    });
  }, [connection.commands, t]);
  const availableModels = useMemo(
    () =>
      (connection.models ?? []).filter(isVisibleComposerModel).map((model) => ({
        id: model.id,
        label: getModelDisplayName(model.label || model.id),
      })),
    [connection.models],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      // Modes always arrive from the toolbar's own picker, but narrow anyway so
      // the daemon action gets a well-typed value (mirrors App's handleSetMode).
      if (!isDaemonApprovalMode(modeId)) {
        reportError(
          new Error(`Unsupported approval mode: ${modeId}`),
          'Failed to set approval mode',
        );
        return;
      }
      actions
        .setApprovalMode(modeId)
        .then(() => {
          // Mirror App's handleSetMode: switching THIS pane to yolo (or
          // auto-edit for an edit tool) auto-approves a tool call already
          // awaiting approval in this pane, so the shortcut behaves the same as
          // in the single-session chat.
          const approval = pendingToolApprovalRef.current;
          if (!approval) return;
          const autoApprove =
            modeId === 'yolo' ||
            (modeId === 'auto-edit' && approval.toolKind === 'edit');
          if (!autoApprove) return;
          const allowOnce = approval.options.find(
            (option) => option.kind === 'allow_once',
          );
          if (!allowOnce) return;
          actions
            .submitPermission(approval.id, allowOnce.id)
            .catch((error: unknown) =>
              reportError(error, 'Failed to auto-approve tool call'),
            );
        })
        .catch((error: unknown) =>
          reportError(error, 'Failed to set approval mode'),
        );
    },
    [actions, reportError],
  );
  const handleSelectModel = useCallback(
    (modelId: string) => {
      actions
        .setModel(modelId)
        .catch((error: unknown) =>
          reportError(error, 'Failed to switch model'),
        );
    },
    [actions, reportError],
  );

  const headerLabel =
    title || connection.displayName || connection.sessionId?.slice(0, 8) || '';

  // On a multi-workspace daemon, surface this pane's workspace as a composer-
  // toolbar chip (next to where the git-branch chip sits), so it's clear which
  // workspace a message goes to. Multi-workspace-ness comes from the shared
  // workspace provider (the pane's own session connection may not carry it).
  const paneWorkspaceCwd = workspaceCwd ?? connection.workspaceCwd;
  const showWorkspaceChip =
    hasMultipleWorkspaces(workspace.capabilities) && !!paneWorkspaceCwd;
  // Memoized so the array identity is stable across renders — `ChatEditor` is
  // `React.memo`, and a fresh `[...]` each render would defeat it.
  const paneToolbarActions = useMemo(
    () =>
      showWorkspaceChip
        ? [...PANE_TOOLBAR_ACTIONS, 'workspace' as const]
        : PANE_TOOLBAR_ACTIONS,
    [showWorkspaceChip],
  );

  // Also surface the workspace in the pane HEADER (always visible at the top),
  // not just the composer chip at the bottom — on a narrow split the composer
  // chip collapses to a bare folder icon, so the header is where you tell panes
  // apart. A stable per-workspace accent color (same palette as the sidebar
  // session-group dots) lets same-workspace panes read as a group at a glance,
  // and keeps them distinguishable even when the header name ellipsizes.
  const workspaceLabel =
    showWorkspaceChip && paneWorkspaceCwd
      ? workspaceLabelForCwd(
          paneWorkspaceCwd,
          workspace.capabilities?.workspaces,
        )
      : undefined;
  const workspaceAccent = showWorkspaceChip
    ? workspaceAccentColor(paneWorkspaceCwd, workspace.capabilities)
    : undefined;
  const workspaceAccentClass = workspaceAccent
    ? accentStyles[workspaceAccent]
    : undefined;

  return (
    <section
      className={styles.pane}
      data-testid="chat-pane"
      aria-label={headerLabel}
    >
      <header
        className={`${styles.header} ${workspaceAccentClass ?? ''}`.trim()}
      >
        {workspaceLabel && (
          <span
            // role="img" so the whole dot+name badge is announced as its
            // aria-label ("Workspace: <name>"); aria-label on a bare <span>
            // (generic role) isn't reliably surfaced by screen readers.
            role="img"
            className={styles.workspaceTag}
            title={paneWorkspaceCwd}
            aria-label={t('workspace.paneLabel', { name: workspaceLabel })}
            data-web-shell-pane-workspace
          >
            <span className={styles.workspaceTagDot} aria-hidden="true" />
            <span className={styles.workspaceTagText}>{workspaceLabel}</span>
          </span>
        )}
        <span className={styles.title} title={headerLabel}>
          {headerLabel}
        </span>
        {onToggleMaximize && (
          <button
            type="button"
            className={styles.maximizeButton}
            onClick={onToggleMaximize}
            aria-pressed={isMaximized}
            aria-label={t(
              isMaximized ? 'splitView.restorePane' : 'splitView.maximizePane',
            )}
            title={t(
              isMaximized ? 'splitView.restorePane' : 'splitView.maximizePane',
            )}
          >
            {/* Same icon vocabulary as the dialog fullscreen toggle. */}
            {isMaximized ? (
              <Minimize2Icon size={16} aria-hidden />
            ) : (
              <Maximize2Icon size={16} aria-hidden />
            )}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('splitView.closePane')}
            title={t('splitView.closePane')}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </header>

      {connection.error && (
        <div className={styles.connectionError} role="alert">
          <span className={styles.connectionErrorText}>
            {t('splitView.paneConnectionError')}: {connection.error}
          </span>
        </div>
      )}

      <div className={styles.body}>
        <SubagentDetailsProvider onOpen={openSubagentDetails}>
          <MessageList
            messages={messages}
            pendingApproval={pendingToolApproval}
            loadingTranscript={connection.loadingTranscript}
            catchingUp={connection.catchingUp}
            hasOlderHistory={transcriptHistory.hasMore}
            loadingOlderHistory={transcriptHistory.loading}
            historyCapacityReached={transcriptHistory.capacityReached}
            onLoadOlderHistory={transcriptHistory.loadMore}
            transcriptBlockCount={blocks.length}
            transcriptActivity={store}
            onReloadTranscript={
              transcriptReloadSupported ? reloadTranscript : undefined
            }
            isResponding={isResponding}
            workspaceCwd={connection.workspaceCwd || ''}
            hideSessionTimeline
            turnFileChanges={
              visibleTurnOutputKinds.has('file') ? fileChangesByTurn : undefined
            }
            turnArtifacts={
              visibleTurnOutputKinds.has('artifact')
                ? artifactsByTurn
                : undefined
            }
            turnScheduledTasks={
              visibleTurnOutputKinds.has('scheduled_task')
                ? scheduledTasksByTurn
                : undefined
            }
            onTurnOutputOpen={handleRightPanelOpen}
            generateContent={
              connection.capabilities?.features.includes('session_generation')
                ? actions.generateSessionContent
                : undefined
            }
          />
        </SubagentDetailsProvider>
      </div>

      <div className={styles.footer}>
        {pendingToolApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <ToolApproval
              request={pendingToolApproval}
              onConfirm={handleConfirm}
              variant="floating"
              // Several panes can show approvals at once; don't auto-focus one
              // pane's approval (it would steal focus from the pane the user is
              // in). Keyboard handling is focus-scoped, so each pane's approval
              // is still fully keyboard-operable once clicked/tabbed into.
              keyboardActive={false}
            />
          </div>
        )}
        {pendingAskUserApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <AskUserQuestion
              request={pendingAskUserApproval}
              onConfirm={handleConfirm}
              variant="floating"
              keyboardActive={false}
            />
          </div>
        )}
        {/* Panes keep the composer status compact: spinner + elapsed time +
            token count + cancel hint, but no rotating "witty" loading phrase. */}
        <StreamingStatus startedAt={activeTurnStartedAt} showPhrase={false} />
        <QueuedPromptDisplay
          prompts={queuedPrompts}
          t={t}
          onDelete={removeQueuedPrompt}
          onInsert={insertQueuedPrompt}
          onEdit={editQueuedPrompt}
        />
        <ChatEditor
          ref={editorRef}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          isRunning={isResponding}
          commands={commands}
          queuedMessages={queuedTexts}
          onPopQueuedMessages={editLastQueuedPrompt}
          onClearQueuedMessages={clearQueuedPrompts}
          visibleToolbarActions={paneToolbarActions}
          workspaceName={showWorkspaceChip ? workspaceLabel : undefined}
          workspaceTitle={paneWorkspaceCwd}
          workspaceColor={workspaceAccent}
          currentMode={connection.currentMode ?? 'default'}
          currentModel={connection.currentModel ?? ''}
          availableModels={availableModels}
          onSelectMode={handleSelectMode}
          onSelectModel={handleSelectModel}
          dialogOpen={approvalActive}
          followupState={followupState}
          onAcceptFollowup={onAcceptFollowup}
          onDismissFollowup={onDismissFollowup}
          placeholderText={t('splitView.composerPlaceholder')}
        />
      </div>
    </section>
  );
}
