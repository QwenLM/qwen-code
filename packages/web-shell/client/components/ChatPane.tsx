/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptStore,
  useWorkspace,
  useWorkspaceActions,
  type DaemonWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { useI18n } from '../i18n';
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
import { getModelDisplayName } from '../utils/modelDisplay';
import { hasMultipleWorkspaces, workspaceBasename } from '../utils/workspace';
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
  onError?: (error: unknown, fallback: string) => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onPaneArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
    workspaceActions: DaemonWorkspaceActions,
  ) => void;
  messageTurnOutputs?: readonly TurnOutputKind[];
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
  onError,
  onRightPanelOpen,
  onPaneArtifactsChange,
  messageTurnOutputs,
}: ChatPaneProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const workspaceActions = useWorkspaceActions();
  const workspace = useWorkspace();
  const messages = useMessages(t);
  const blocks = useTranscriptBlocks();
  const store = useTranscriptStore();
  const streamingState = useStreamingState();
  const { artifacts } = useSessionArtifacts();
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
      if (connection.status !== 'connected') return false;
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
    [actions, clearFollowup, connection.status, enqueuePrompt, reportError],
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
      if (request.kind === 'artifact' || request.kind === 'scheduled_task') {
        onRightPanelOpen({ ...request, workspaceActions });
        return;
      }
      onRightPanelOpen(request);
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
  const paneToolbarActions = showWorkspaceChip
    ? [...PANE_TOOLBAR_ACTIONS, 'workspace' as const]
    : PANE_TOOLBAR_ACTIONS;

  return (
    <section
      className={styles.pane}
      data-testid="chat-pane"
      aria-label={headerLabel}
    >
      <header className={styles.header}>
        <span className={styles.title} title={headerLabel}>
          {headerLabel}
        </span>
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
        <MessageList
          messages={messages}
          pendingApproval={pendingToolApproval}
          loadingTranscript={connection.loadingTranscript}
          catchingUp={connection.catchingUp}
          isResponding={isResponding}
          workspaceCwd={connection.workspaceCwd || ''}
          hideSessionTimeline
          turnFileChanges={
            visibleTurnOutputKinds.has('file') ? fileChangesByTurn : undefined
          }
          turnArtifacts={
            visibleTurnOutputKinds.has('artifact') ? artifactsByTurn : undefined
          }
          turnScheduledTasks={
            visibleTurnOutputKinds.has('scheduled_task')
              ? scheduledTasksByTurn
              : undefined
          }
          onTurnOutputOpen={handleRightPanelOpen}
        />
      </div>

      <div className={styles.footer}>
        {pendingToolApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <ToolApproval
              request={pendingToolApproval}
              onConfirm={handleConfirm}
              variant="floating"
              // Several panes can show approvals at once; global Enter/Escape
              // shortcuts aren't focus-scoped, so keep pane approvals
              // click-only to avoid confirming the wrong session's request.
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
          workspaceName={
            showWorkspaceChip && paneWorkspaceCwd
              ? workspaceBasename(paneWorkspaceCwd)
              : undefined
          }
          workspaceTitle={paneWorkspaceCwd}
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
