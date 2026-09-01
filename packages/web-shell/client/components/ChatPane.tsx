/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Maximize2Icon, Minimize2Icon } from 'lucide-react';
import {
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useDaemonSessionOwnerGuard,
  useStreamingState,
  useTranscriptHistory,
  useTranscriptStore,
  useWorkspace,
  type DaemonSessionActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  type DaemonSessionArtifact,
  type DaemonSessionMonitorTaskStatus,
  type DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';
import { SubagentDetailsProvider } from '../subagentDetailsContext';
import { MonitorDetailsProvider } from '../monitorDetailsContext';
import { WorkflowDetailsProvider } from '../workflowDetailsContext';
import { useI18n } from '../i18n';
import { useWebShellCustomization } from '../customization';
import {
  SESSION_MONITOR_TOOL_CORRELATION_FEATURE,
  SESSION_TRANSCRIPT_PAGINATION_FEATURE,
} from '../constants/sessions';
import { useAnimationFrameTranscriptSnapshot } from '../hooks/useAnimationFrameTranscriptBlocks';
import { useMessagesFromBlocks } from '../hooks/useMessages';
import { useSessionArtifacts } from '../hooks/useSessionArtifacts';
import { useBackgroundTasks } from '../hooks/useBackgroundTasks';
import { extractPendingPermission } from '../adapters/transcriptAdapter';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { AttachmentPreviewRequest } from '../adapters/messageTypes';
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
import { base64ToBlob } from '../utils/base64';
import { isDefinitelyRejectedPromptAdmission } from '../utils/promptAdmission';
import {
  getActiveTodosForPlanRevision,
  isExitPlanApprovalRequest,
} from '../utils/todos';
import { findMonitorTaskForTool } from '../utils/monitorTasks';
import {
  getTaskActivityKey,
  hasActiveTaskActivity,
} from '../utils/taskActivity';
import { invokeSlashCommandHandler } from '../utils/slash-command-action';
import { parseWebShellGoalCommand } from '../utils/goalCondition';
import { buildGoalControlRequest } from '../utils/goalControlRequest';
import { isGoalGateBlocked } from '../utils/goalGate';
import type { WebShellSlashCommandHandler } from '../App';
import { getModelDisplayName } from '../utils/modelDisplay';
import {
  hasMultipleWorkspaces,
  workspaceLabelForCwd,
} from '../utils/workspace';
import { workspaceAccentColor } from '../utils/workspaceColor';
import {
  resolveVoiceWorkspaceTarget,
  type VoiceStatusRevision,
} from '../voice/voice-workspace-target';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from '../constants/localCommands';
import { mergeCommands } from '../hooks/daemonSessionMappers';
import {
  useSessionCatalogController,
  useSessionHasActivePrompt,
} from '../session-catalog/session-catalog-hooks';
import { MessageList } from './MessageList';
import { StreamingStatus } from './StreamingStatus';
import { ChatEditor, type ComposerToolbarAction } from './ChatEditor';
import { QueuedPromptDisplay } from './QueuedPromptDisplay';
import { GoalStatusStrip } from './GoalStatusStrip';
import composerStatusStyles from './ComposerStatusStack.module.css';
import { GoalEditDialog } from './dialogs/GoalEditDialog';
import { ToolApproval } from './messages/ToolApproval';
import { AskUserQuestion } from './messages/AskUserQuestion';
import { serializeContextUsageMessage } from './messages/ContextUsageMessage';
import type {
  TurnOutputKind,
  TurnOutputOpenRequest,
} from './artifacts/TurnOutputs';
import { TURN_OUTPUT_KINDS } from './artifacts/TurnOutputs';
import { useArtifactWorkspaceTarget } from './artifacts/useArtifactWorkspaceTarget';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
  getScheduledTasksByTurn,
} from './artifacts/turnOutputSelectors';
import { PaneHeaderActions } from './PaneHeaderActions';
import styles from './ChatPane.module.css';
import accentStyles from './WorkspaceAccent.module.css';

// Split-view panes get the same session-scoped composer controls as the main
// chat. The width toggle is omitted because panes size themselves.
const PANE_TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [
  'addMenu',
  'approvalMode',
  'contextUsage',
  'model',
  'voice',
];
const EMPTY_VOICE_WORKSPACE_REVISIONS: Readonly<Record<string, number>> = {};

function OptionalMonitorDetailsProvider({
  enabled,
  onOpen,
  children,
}: {
  enabled: boolean;
  onOpen: (tool: ACPToolCall) => Promise<boolean>;
  children: ReactNode;
}) {
  return enabled ? (
    <MonitorDetailsProvider onOpen={onOpen}>{children}</MonitorDetailsProvider>
  ) : (
    children
  );
}

export interface PaneHeaderActionsInfo {
  sessionId: string;
  workspaceCwd?: string;
  /** The pane's own session actions; lets an action drive session data. */
  sessionActions?: DaemonSessionActions;
}

export type PaneHeaderActionsRenderer = (
  info: PaneHeaderActionsInfo,
) => ReactNode;

interface UnknownPromptAdmission {
  owner: { sessionId: string | undefined };
  commitAccepted?: ComposerSubmitCommit;
  payloadAvailable: boolean;
}

export interface ChatPaneProps {
  /** Header label; falls back to the session's own display name / id. */
  title?: string;
  /**
   * The workspace this pane's session lives in. Passed explicitly by the split
   * view (which knows it per session) and shown as a composer-toolbar chip on a
   * multi-workspace daemon; falls back to the connection's own workspace.
   */
  workspaceCwd?: string;
  /**
   * Extra actions rendered in the pane header, before the built-in
   * maximize/close buttons. Receives this pane's session id (and workspace
   * when known) so the host can scope each control to the right session. When
   * the actions no longer fit beside the title they collapse into a `…`
   * overflow menu.
   *
   * Each child should be a single interactive element (button or link). When
   * collapsed, the overflow menu lists the actions and proxies a click to that
   * element, labelling each item from its accessible name (decorative
   * `aria-hidden` glyphs are ignored). The action instance stays mounted in a
   * hidden, off-pane slot across collapse so its state survives; because that
   * slot is `visibility: hidden`, an action that opens a popover anchored to
   * itself must render the popover through a portal — one rendered as a
   * descendant of the action (or anchored to its bounding box) would be
   * invisible or mispositioned while collapsed.
   */
  renderHeaderActions?: PaneHeaderActionsRenderer;
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
  onImageIngestionNotice?: (tone: 'warning' | 'error', message: string) => void;
  /** Host slash-command callback shared with the main chat composer. */
  onSlashCommand?: WebShellSlashCommandHandler;
  onOpenGoals?: () => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onOpenMonitor?: (
    task: DaemonSessionMonitorTaskStatus,
    sessionId: string,
    sessionActions: DaemonSessionActions,
  ) => void;
  onPaneArtifactsChange?: (
    sessionId: string,
    artifacts: readonly DaemonSessionArtifact[],
  ) => void;
  messageTurnOutputs?: readonly TurnOutputKind[];
  /** Render inside a parent surface that already provides its own frame. */
  embedded?: boolean;
  onFirstPromptAdmitted?: (text: string) => void;
  /** Whether this pane owns Session Catalog turn-completion reconciliation. */
  reportCatalogTurnCompletion?: boolean;
  hidden?: boolean;
  voiceUserRevision?: number;
  voiceWorkspaceRevisions?: Readonly<Record<string, number>>;
  voiceWorkspaces?: readonly DaemonWorkspaceCapability[];
  /** Enable the app-scoped experimental Session Workflow presentation. */
  sessionWorkflowEnabled?: boolean;
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
  renderHeaderActions,
  onClose,
  onToggleMaximize,
  isMaximized = false,
  onError,
  onImageIngestionNotice,
  onSlashCommand,
  onOpenGoals,
  onRightPanelOpen,
  onOpenMonitor,
  onPaneArtifactsChange,
  messageTurnOutputs,
  embedded = false,
  onFirstPromptAdmitted,
  reportCatalogTurnCompletion = true,
  hidden = false,
  voiceUserRevision = 0,
  voiceWorkspaceRevisions = EMPTY_VOICE_WORKSPACE_REVISIONS,
  voiceWorkspaces,
  sessionWorkflowEnabled = false,
}: ChatPaneProps) {
  const { t } = useI18n();
  const { renderComposerFooter: CustomComposerFooter, askUserFreeTextLabel } =
    useWebShellCustomization();
  const connection = useConnection();
  const actions = useActions();
  const sessionOwnerGuard = useDaemonSessionOwnerGuard();
  const workspace = useWorkspace();
  const attachmentWorkspaceTarget = useArtifactWorkspaceTarget(
    connection.workspaceCwd,
  );
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  const sessionHasActivePrompt = useSessionHasActivePrompt(
    workspace.client,
    workspaceCwd ?? connection.workspaceCwd,
    connection.sessionId,
  );
  const sessionHasActivePromptRef = useRef(sessionHasActivePrompt);
  sessionHasActivePromptRef.current = sessionHasActivePrompt;
  const { blocks, blockChangeSummary } = useAnimationFrameTranscriptSnapshot();
  const messages = useMessagesFromBlocks(t, blocks, blockChangeSummary);
  const taskActivityKey = useMemo(
    () => getTaskActivityKey(messages),
    [messages],
  );
  const workflowsEnabled =
    connection.supportedCommands?.workflowsEnabled === true;
  // The activity fact travels beside the key, derived structurally — the
  // key itself is not parseable back (callId is unconstrained text) — and
  // gated on the endpoint the hook will actually poll.
  const taskActivityActive = useMemo(
    () => hasActiveTaskActivity(messages, { workflowsEnabled }),
    [messages, workflowsEnabled],
  );
  const sessionTasks = useBackgroundTasks(
    connection.sessionId,
    taskActivityKey,
    taskActivityActive,
    connection.status === 'connected',
    0,
    workflowsEnabled,
  );
  const transcriptHistory = useTranscriptHistory();
  const store = useTranscriptStore();
  const streamingState = useStreamingState();
  const [goalControlBusy, setGoalControlBusy] = useState(false);
  const goalControlOpSeqRef = useRef(0);
  const goalControlOwnerRef = useRef<
    { opId: number; sessionId: string | undefined } | undefined
  >(undefined);
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [goalEditError, setGoalEditError] = useState<string | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const connectionGoalComplete =
    connection.goalState?.goal?.status === 'complete';
  const liveGoalSnapshot = connectionGoalComplete
    ? undefined
    : connection.goalState;
  useEffect(() => {
    const owner = goalControlOwnerRef.current;
    // Release the busy latch only when no control operation owns it, or when
    // its owner belongs to a session we have left (that operation's `finally`
    // can no longer release it here). Releasing it while an operation is still
    // in flight — which a server-side goal replacement would otherwise do —
    // re-enables the strip and lets a second control dispatch against the same
    // expected revision, so one of the two loses with a 409.
    if (!owner || owner.sessionId !== connection.sessionId) {
      goalControlOwnerRef.current = undefined;
      setGoalControlBusy(false);
    }
    setGoalEditOpen(false);
    setGoalEditError(null);
  }, [
    connection.goalState?.goal?.goalId,
    connection.sessionId,
    connectionGoalComplete,
  ]);
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
  const monitorSessionIdRef = useRef(connection.sessionId);
  monitorSessionIdRef.current = connection.sessionId;
  const monitorDetailsSupported =
    connection.capabilities?.features.includes(
      SESSION_MONITOR_TOOL_CORRELATION_FEATURE,
    ) === true && onOpenMonitor !== undefined;
  const openMonitorDetails = useCallback(
    async (tool: ACPToolCall): Promise<boolean> => {
      const sessionId = monitorSessionIdRef.current;
      if (!sessionId || !onOpenMonitor) return false;
      try {
        const snapshot = await actions.getTasks();
        if (
          monitorSessionIdRef.current !== sessionId ||
          snapshot.sessionId !== sessionId
        ) {
          return false;
        }
        const task = findMonitorTaskForTool(snapshot.tasks, tool);
        if (!task) return false;
        onOpenMonitor(task, sessionId, actions);
        return true;
      } catch {
        return false;
      }
    },
    [actions, onOpenMonitor],
  );
  useEffect(() => {
    const sessionId = connection.sessionId;
    if (!sessionId) return;
    onPaneArtifactsChange?.(sessionId, artifacts);
    return () => {
      onPaneArtifactsChange?.(sessionId, []);
    };
  }, [artifacts, connection.sessionId, onPaneArtifactsChange]);
  const streamingStateRef = useRef(streamingState);
  streamingStateRef.current = streamingState;
  const catalogOwnerCwd =
    connection.workspaceCwd &&
    workspaceCwd &&
    connection.workspaceCwd !== workspaceCwd
      ? undefined
      : (connection.workspaceCwd ?? workspaceCwd);
  const previousCatalogStreamingStateRef = useRef(streamingState);
  const catalogStreamingSessionIdRef = useRef<string | undefined>(
    streamingState !== 'idle' ? connection.sessionId : undefined,
  );
  const catalogStreamingWorkspaceCwdRef = useRef<string | undefined>(
    streamingState !== 'idle' ? catalogOwnerCwd : undefined,
  );
  useEffect(() => {
    const previous = previousCatalogStreamingStateRef.current;
    previousCatalogStreamingStateRef.current = streamingState;
    if (
      streamingState !== 'idle' &&
      (previous === 'idle' ||
        catalogStreamingSessionIdRef.current === undefined)
    ) {
      catalogStreamingSessionIdRef.current = connection.sessionId;
      catalogStreamingWorkspaceCwdRef.current = catalogOwnerCwd;
    } else if (
      streamingState !== 'idle' &&
      connection.sessionId === catalogStreamingSessionIdRef.current &&
      catalogStreamingWorkspaceCwdRef.current === undefined
    ) {
      catalogStreamingWorkspaceCwdRef.current = catalogOwnerCwd;
    }
    if (
      previous !== 'idle' &&
      streamingState === 'idle' &&
      connection.sessionId &&
      connection.sessionId === catalogStreamingSessionIdRef.current &&
      catalogOwnerCwd &&
      catalogOwnerCwd === catalogStreamingWorkspaceCwdRef.current &&
      reportCatalogTurnCompletion
    ) {
      sessionCatalogController.turnCompleted(
        catalogOwnerCwd,
        connection.sessionId,
      );
    }
  }, [
    catalogOwnerCwd,
    connection.sessionId,
    reportCatalogTurnCompletion,
    sessionCatalogController,
    streamingState,
  ]);
  const firstPromptAdmittedRef = useRef(false);
  const [unknownPromptAdmission, setUnknownPromptAdmission] =
    useState<UnknownPromptAdmission | null>(null);
  const admissionOwnerRef = useRef({ sessionId: connection.sessionId });
  if (admissionOwnerRef.current.sessionId !== connection.sessionId) {
    admissionOwnerRef.current = { sessionId: connection.sessionId };
  }
  useEffect(() => {
    firstPromptAdmittedRef.current = false;
    setUnknownPromptAdmission(null);
  }, [connection.sessionId]);
  const admissionPayloadLocked =
    unknownPromptAdmission?.payloadAvailable === true;
  const discardUnknownPromptPayload = useCallback(() => {
    const current = unknownPromptAdmission;
    if (!current?.payloadAvailable) return;
    if (admissionOwnerRef.current !== current.owner) {
      setUnknownPromptAdmission(null);
      return;
    }
    current.commitAccepted?.();
    setUnknownPromptAdmission({
      owner: current.owner,
      payloadAvailable: false,
    });
  }, [unknownPromptAdmission]);
  const continueEditingUnknownPrompt = useCallback(() => {
    if (!window.confirm(t('queue.continueEditingConfirm'))) return;
    const current = unknownPromptAdmission;
    if (!current?.payloadAvailable) return;
    if (admissionOwnerRef.current !== current.owner) {
      setUnknownPromptAdmission(null);
      return;
    }
    setUnknownPromptAdmission({
      owner: current.owner,
      payloadAvailable: false,
    });
  }, [t, unknownPromptAdmission]);
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
  const pendingApproval = useMemo(
    () => extractPendingPermission(blocks),
    [blocks],
  );
  const isAskUser = isAskUserPermission(pendingApproval);
  const pendingToolApproval =
    pendingApproval && !isAskUser ? pendingApproval : null;
  const pendingAskUserApproval =
    pendingApproval && isAskUser ? pendingApproval : null;
  const isExitPlanApproval = isExitPlanApprovalRequest(pendingToolApproval);
  const planTodos = useMemo(
    () =>
      sessionWorkflowEnabled && isExitPlanApproval
        ? getActiveTodosForPlanRevision(messages, pendingToolApproval?.todoPlan)
        : [],
    [isExitPlanApproval, messages, pendingToolApproval, sessionWorkflowEnabled],
  );
  // Tracked in a ref so an async approval-mode switch (handleSelectMode) reads
  // the approval current when setApprovalMode *resolves*, not a stale one
  // captured at click time — mirrors App's pendingApprovalRef.
  const pendingToolApprovalRef = useRef(pendingToolApproval);
  pendingToolApprovalRef.current = pendingToolApproval;
  const approvalActive =
    pendingToolApproval !== null || pendingAskUserApproval !== null;
  const paneVoiceCwd =
    connection.sessionId &&
    connection.workspaceCwd &&
    (!workspaceCwd || workspaceCwd === connection.workspaceCwd)
      ? connection.workspaceCwd
      : undefined;
  const voiceTarget = useMemo(
    () =>
      resolveVoiceWorkspaceTarget({
        capabilities: workspace.capabilities,
        intendedCwd: paneVoiceCwd,
        sessionId: connection.sessionId,
        workspaces: voiceWorkspaces,
      }),
    [
      connection.sessionId,
      paneVoiceCwd,
      voiceWorkspaces,
      workspace.capabilities,
    ],
  );
  const voiceStatusRevision: VoiceStatusRevision = useMemo(
    () => ({
      user: voiceUserRevision,
      workspace: voiceTarget
        ? (voiceWorkspaceRevisions[voiceTarget.workspaceKey] ?? 0)
        : 0,
    }),
    [voiceTarget, voiceUserRevision, voiceWorkspaceRevisions],
  );
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
  const canMutateMidTurn =
    connection.capabilities?.features.includes(
      'session_mid_turn_message_mutation',
    ) === true;
  const canQueryMidTurn =
    connection.capabilities?.features.includes(
      'session_mid_turn_message_query',
    ) === true;
  const canInjectMidTurnMedia =
    connection.capabilities?.features.includes('session_attachments') === true;
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
    workspaceCwd: connection.workspaceCwd,
    clientId: connection.clientId,
    canMutateMidTurn,
    canQueryMidTurn,
    canInjectMidTurnMedia,
    workspaceFileActions: attachmentWorkspaceTarget?.actions,
    streamingState,
    sessionHasActivePrompt,
    sessionActions: actions,
    store,
    editorRef,
    reportError,
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

  const controlGoal = useCallback(
    async (
      action: 'replace' | 'edit' | 'pause' | 'resume' | 'clear',
      objective?: string,
    ) => {
      const busyOwner = sessionOwnerGuard.capture();
      const busySessionId = connectionRef.current.sessionId;
      const expectedGoalId = connectionRef.current.goalState?.goal?.goalId;
      const opId = ++goalControlOpSeqRef.current;
      goalControlOwnerRef.current = { opId, sessionId: busySessionId };
      setGoalControlBusy(true);
      try {
        const snapshot = (await actions.getGoal()).snapshot;
        const goal = snapshot.goal;
        if (
          (action === 'replace' || action === 'edit') &&
          goal?.goalId !== expectedGoalId
        ) {
          throw new Error(t('goals.error.goalUnavailable'));
        }
        const request = buildGoalControlRequest(action, goal, objective, {
          emptyObjective: t('goals.error.emptyCondition'),
          goalUnavailable: t('goals.error.goalUnavailable'),
        });
        if (!busyOwner.isCurrent()) {
          throw new Error(t('goals.error.goalUnavailable'));
        }
        try {
          return await actions.controlGoal(request);
        } catch (error) {
          await actions.getGoal().catch(() => undefined);
          throw error;
        }
      } finally {
        // A newer operation (or a session change) owns the latch now; leave it
        // to whoever owns it rather than releasing it under them.
        if (goalControlOwnerRef.current?.opId === opId) {
          goalControlOwnerRef.current = undefined;
          if (connectionRef.current.sessionId === busySessionId) {
            setGoalControlBusy(false);
          }
        }
      }
    },
    [actions, sessionOwnerGuard, t],
  );

  const runGoalControl = useCallback(
    (action: 'pause' | 'resume' | 'clear') => {
      const owner = sessionOwnerGuard.capture();
      void controlGoal(action).catch((error: unknown) => {
        // A control dropped because the pane moved to another session is not a
        // failure the user needs to see — `handleGoalEditSave` and the main
        // composer swallow the same race.
        if (!owner.isCurrent()) return;
        reportError(error, t(`goals.error.${action}Failed`));
      });
    },
    [controlGoal, reportError, sessionOwnerGuard, t],
  );

  const handleGoalEditSave = useCallback(
    (objective: string) => {
      const owner = sessionOwnerGuard.capture();
      setGoalEditError(null);
      void controlGoal('edit', objective)
        .then(() => {
          if (owner.isCurrent()) setGoalEditOpen(false);
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          setGoalEditError(
            error instanceof Error ? error.message : String(error),
          );
          reportError(error, t('goals.error.editFailed'));
        });
    },
    [controlGoal, reportError, sessionOwnerGuard, t],
  );

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      commitAccepted?: ComposerSubmitCommit,
      metadata?: ComposerSubmitMetadata,
    ): boolean => {
      const trimmed = text.trim();
      if (!trimmed && (images?.length ?? 0) === 0 && (files?.length ?? 0) === 0)
        return false;
      if (admissionPayloadLocked) return false;
      // The host handler is documented as running before Web Shell handles a
      // slash command, so it gets `/goal` first here exactly as it does in the
      // main composer — otherwise an override works on one surface only.
      if (
        trimmed &&
        invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError)
      ) {
        return true;
      }
      if (/^\/goal(?:\s|$)/i.test(trimmed)) {
        // The same guard App.tsx applies before any slash handling: a control
        // that cannot reach the daemon must leave the text in the composer
        // instead of consuming it, appending a transcript entry, and failing
        // later at `requireSessionForAction` with only a toast.
        if (
          shouldBlockComposerSubmit({
            connectionStatus: connection.status,
            hasSession: Boolean(connection.sessionId),
          })
        ) {
          return false;
        }
        if (
          (images?.length ?? 0) > 0 ||
          (files?.length ?? 0) > 0 ||
          (metadata?.inputAnnotations?.length ?? 0) > 0
        ) {
          const message = t('goals.error.attachmentsUnsupported');
          reportError(new Error(message), message);
          return false;
        }
        const operation = parseWebShellGoalCommand(trimmed);
        if (operation.kind === 'status') {
          // A pane without a Goals surface (the side-task pane passes no
          // handler) would otherwise consume the text and open nothing.
          if (!onOpenGoals) {
            reportError(
              new Error(t('goals.error.goalsUnavailable')),
              t('goals.error.goalsUnavailable'),
            );
            return false;
          }
          onOpenGoals();
          return true;
        }
        if (operation.kind === 'error') {
          const message = t('goals.error.requiresObjective', {
            keyword: operation.keyword,
          });
          reportError(new Error(message), message);
          return false;
        }
        const action = operation.kind === 'set' ? 'replace' : operation.kind;
        const objective =
          operation.kind === 'set' || operation.kind === 'edit'
            ? operation.objective
            : undefined;
        store.appendLocalUserMessage(text);
        void controlGoal(action, objective).catch((error: unknown) => {
          reportError(error, `Failed to ${operation.kind} /goal`);
        });
        return true;
      }
      if (
        shouldBlockComposerSubmit({
          connectionStatus: connection.status,
          hasSession: Boolean(connection.sessionId),
        })
      ) {
        return false;
      }
      const inputAnnotations = metadata?.inputAnnotations;
      const notifyFirstPromptAdmitted = () => {
        if (
          trimmed &&
          !firstPromptAdmittedRef.current &&
          onFirstPromptAdmitted
        ) {
          firstPromptAdmittedRef.current = true;
          onFirstPromptAdmitted(trimmed);
        }
      };
      const commandBlockedByGoal =
        trimmed.startsWith('/') &&
        isGoalGateBlocked({
          sessionId: connection.sessionId,
          goalState: connection.goalState,
        });
      if (commandBlockedByGoal) return false;
      if (
        streamingStateRef.current === 'idle' &&
        !sessionHasActivePromptRef.current
      ) {
        const admissionOwner = admissionOwnerRef.current;
        let admissionStarted = false;
        let admitted = false;
        actions
          .sendPrompt(trimmed, {
            ...(images && images.length ? { images } : {}),
            ...(files && files.length ? { files } : {}),
            ...(inputAnnotations ? { inputAnnotations } : {}),
            onAdmissionStarted: () => {
              admissionStarted = true;
            },
            onAdmitted: () => {
              if (admissionOwnerRef.current !== admissionOwner) return;
              if (connection.sessionId && catalogOwnerCwd) {
                sessionCatalogController.promptAdmitted(
                  catalogOwnerCwd,
                  connection.sessionId,
                );
              }
              admitted = true;
              notifyFirstPromptAdmitted();
              clearFollowup();
              commitAccepted?.();
            },
          })
          .catch((error: unknown) => {
            if (admissionOwnerRef.current !== admissionOwner) return;
            const definitelyRejected =
              isDefinitelyRejectedPromptAdmission(error);
            if (admitted || !admissionStarted || definitelyRejected) {
              reportError(error, 'Failed to send prompt');
              return;
            }
            if (catalogOwnerCwd) {
              sessionCatalogController.promptAdmissionUncertain(
                catalogOwnerCwd,
              );
            }
            setUnknownPromptAdmission({
              owner: admissionOwner,
              commitAccepted,
              payloadAvailable: true,
            });
            onImageIngestionNotice?.('warning', t('queue.admissionUnknown'));
            console.warn(
              '[ChatPane] prompt admission outcome is unknown',
              error,
            );
          });
        return false;
      }
      const queued =
        !trimmed && !inputAnnotations
          ? enqueuePrompt(trimmed, images, files)
          : enqueuePrompt(
              trimmed,
              images,
              files,
              undefined,
              inputAnnotations,
              notifyFirstPromptAdmitted,
            );
      if (queued !== false && catalogOwnerCwd) {
        sessionCatalogController.invalidateWorkspace(catalogOwnerCwd);
      }
      return queued;
    },
    [
      actions,
      admissionPayloadLocked,
      catalogOwnerCwd,
      clearFollowup,
      connection.goalState,
      connection.sessionId,
      connection.status,
      controlGoal,
      enqueuePrompt,
      onFirstPromptAdmitted,
      onImageIngestionNotice,
      onOpenGoals,
      reportError,
      sessionCatalogController,
      store,
      t,
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
  const handleAskUserConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) =>
      actions.submitPermission(id, selectedOption, answers),
    [actions],
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
      onRightPanelOpen({
        ...request,
        sourceSessionId: connection.sessionId,
      });
    },
    [connection.sessionId, onRightPanelOpen],
  );
  const paneWorkspaceCwd = workspaceCwd ?? connection.workspaceCwd;
  const previewSessionIdRef = useRef(connection.sessionId);
  previewSessionIdRef.current = connection.sessionId;

  const handleImagePreview = useCallback(
    (src: string, alt?: string) => {
      if (!connection.sessionId) return;
      handleRightPanelOpen({
        id: 'image',
        kind: 'image',
        title: t('turnOutputs.imagePreview'),
        turnId: connection.sessionId,
        src,
        ...(alt ? { alt } : {}),
      });
    },
    [connection.sessionId, handleRightPanelOpen, t],
  );
  const handleAttachmentPreview = useCallback(
    (file: AttachmentPreviewRequest) => {
      const sessionId = connection.sessionId;
      if (!sessionId) return;
      const open = (resolvedFile: AttachmentPreviewRequest) =>
        handleRightPanelOpen({
          id: `attachment:${resolvedFile.attachmentId ?? resolvedFile.workspacePath ?? resolvedFile.name}`,
          kind: 'attachment',
          title: resolvedFile.name,
          turnId: sessionId,
          ...(resolvedFile.mimeType ? { mimeType: resolvedFile.mimeType } : {}),
          ...(resolvedFile.data ? { data: resolvedFile.data } : {}),
          ...(resolvedFile.text !== undefined
            ? { text: resolvedFile.text }
            : {}),
          ...(paneWorkspaceCwd ? { workspaceCwd: paneWorkspaceCwd } : {}),
          ...(resolvedFile.workspacePath
            ? { workspacePath: resolvedFile.workspacePath }
            : {}),
        });
      if (
        file.attachmentId &&
        file.text === undefined &&
        file.data === undefined
      ) {
        void actions
          .readAttachment(file.attachmentId)
          .then((attachment) => {
            if (previewSessionIdRef.current !== sessionId) return;
            open({
              ...file,
              data: base64ToBlob(attachment.data, attachment.mimeType),
              mimeType: attachment.mimeType,
            });
          })
          .catch((error: unknown) => {
            if (previewSessionIdRef.current !== sessionId) return;
            reportError(error, 'Failed to preview attachment');
          });
        return;
      }
      open(file);
    },
    [
      actions,
      connection.sessionId,
      handleRightPanelOpen,
      paneWorkspaceCwd,
      reportError,
    ],
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
  const skills = useMemo(() => {
    const commandsByName = new Map(
      commands.map((command) => [command.name.toLowerCase(), command]),
    );
    return (connection.skills ?? [])
      .map((name) => {
        const command = commandsByName.get(name.toLowerCase());
        return {
          name,
          description: command?.description ?? '',
          ...(command?.argumentHint
            ? { argumentHint: command.argumentHint }
            : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [commands, connection.skills]);
  const handleShowContextUsage = useCallback(() => {
    if (
      shouldBlockComposerSubmit({
        connectionStatus: connection.status,
        hasSession: Boolean(connection.sessionId),
      })
    ) {
      return;
    }
    const owner = sessionOwnerGuard.capture();
    if (streamingStateRef.current === 'idle') {
      store.appendLocalUserMessage('/context');
    }
    actions
      .getContextUsage({ detail: false })
      .then((result) => {
        if (!owner.isCurrent()) return;
        store.dispatch([
          {
            type: 'status',
            text: serializeContextUsageMessage(result),
            clearActiveText: false,
          },
        ]);
      })
      .catch((error: unknown) => {
        if (!owner.isCurrent()) return;
        reportError(error, 'Failed to load context usage');
      });
  }, [
    actions,
    connection.sessionId,
    connection.status,
    reportError,
    sessionOwnerGuard,
    store,
  ]);
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
  const handleSelectReasoningEffort = useCallback(
    (value: string) =>
      actions
        .setReasoningEffort(value)
        .catch((error: unknown) =>
          reportError(error, t('reasoning.updateFailed')),
        ),
    [actions, reportError, t],
  );

  const headerLabel =
    title || connection.displayName || connection.sessionId?.slice(0, 8) || '';

  // On a multi-workspace daemon, surface this pane's workspace as a composer-
  // toolbar chip (next to where the git-branch chip sits), so it's clear which
  // workspace a message goes to. Multi-workspace-ness comes from the shared
  // workspace provider (the pane's own session connection may not carry it).
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
  const headerActions =
    connection.sessionId && renderHeaderActions
      ? renderHeaderActions({
          sessionId: connection.sessionId,
          workspaceCwd: paneWorkspaceCwd || undefined,
          sessionActions: actions,
        })
      : null;

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
      className={`${styles.pane} ${embedded ? styles.paneEmbedded : ''}`.trim()}
      data-testid="chat-pane"
      aria-label={headerLabel}
    >
      {goalEditOpen && connection.goalState?.goal && (
        <GoalEditDialog
          objective={connection.goalState.goal.objective}
          saving={goalControlBusy}
          error={goalEditError}
          onSave={handleGoalEditSave}
          onClose={() => {
            if (goalControlBusy) return;
            setGoalEditOpen(false);
            setGoalEditError(null);
          }}
        />
      )}
      {!embedded && (
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
          <PaneHeaderActions
            trailing={
              onToggleMaximize || onClose ? (
                <>
                  {onToggleMaximize && (
                    <button
                      type="button"
                      className={styles.maximizeButton}
                      onClick={onToggleMaximize}
                      aria-pressed={isMaximized}
                      aria-label={t(
                        isMaximized
                          ? 'splitView.restorePane'
                          : 'splitView.maximizePane',
                      )}
                      title={t(
                        isMaximized
                          ? 'splitView.restorePane'
                          : 'splitView.maximizePane',
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
                      data-testid="pane-close"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        aria-hidden="true"
                      >
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
                </>
              ) : null
            }
          >
            {headerActions}
          </PaneHeaderActions>
        </header>
      )}

      {connection.error && (
        <div className={styles.connectionError} role="alert">
          <span className={styles.connectionErrorText}>
            {t('splitView.paneConnectionError')}: {connection.error}
          </span>
        </div>
      )}

      <div className={styles.body}>
        <OptionalMonitorDetailsProvider
          enabled={monitorDetailsSupported}
          onOpen={openMonitorDetails}
        >
          <SubagentDetailsProvider onOpen={openSubagentDetails}>
            <WorkflowDetailsProvider tasks={sessionTasks}>
              <MessageList
                messages={messages}
                pendingApproval={pendingToolApproval}
                loadingTranscript={connection.loadingTranscript}
                catchingUp={connection.catchingUp}
                hasOlderHistory={transcriptHistory.hasMore}
                loadingOlderHistory={transcriptHistory.loading}
                historyCapacityReached={transcriptHistory.capacityReached}
                historyPaginationError={transcriptHistory.paginationError}
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
                  visibleTurnOutputKinds.has('file')
                    ? fileChangesByTurn
                    : undefined
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
                onImagePreview={handleImagePreview}
                onAttachmentPreview={handleAttachmentPreview}
                onError={reportError}
                generateContent={
                  connection.capabilities?.features.includes(
                    'session_generation',
                  )
                    ? actions.generateSessionContent
                    : undefined
                }
              />
            </WorkflowDetailsProvider>
          </SubagentDetailsProvider>
        </OptionalMonitorDetailsProvider>
      </div>

      <div className={styles.footer}>
        {pendingToolApproval && (
          <div className={styles.approval} data-testid="pane-approval">
            <ToolApproval
              request={pendingToolApproval}
              onConfirm={handleConfirm}
              variant="floating"
              planTodos={planTodos}
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
              onConfirm={handleAskUserConfirm}
              onError={reportError}
              variant="floating"
              keyboardActive={false}
              customInputLabel={askUserFreeTextLabel}
            />
          </div>
        )}
        {/* A pending approval owns the pane footer: the status/queue/editor
            area below the approval drops out of layout (kept mounted so the
            draft survives) instead of leaving a live input under the
            dialog. */}
        <div className={approvalActive ? styles.composerHidden : undefined}>
          {/* Panes keep the composer status compact: spinner + elapsed time +
              token count + cancel hint, but no rotating "witty" loading
              phrase. */}
          <StreamingStatus
            startedAt={activeTurnStartedAt}
            showPhrase={false}
            hasActivePrompt={sessionHasActivePrompt}
          />
          {(queuedPrompts.length > 0 || liveGoalSnapshot?.goal) && (
            <div
              className={composerStatusStyles.root}
              data-testid="composer-status-stack"
            >
              <QueuedPromptDisplay
                prompts={queuedPrompts}
                t={t}
                canMutateMidTurn={canMutateMidTurn}
                canInsertMidTurn={
                  streamingState !== 'idle' || sessionHasActivePrompt
                }
                onDelete={removeQueuedPrompt}
                onInsert={insertQueuedPrompt}
                onEdit={editQueuedPrompt}
                onImagePreview={handleImagePreview}
                onAttachmentPreview={handleAttachmentPreview}
              />
              {liveGoalSnapshot?.goal && (
                <GoalStatusStrip
                  snapshot={liveGoalSnapshot}
                  busy={goalControlBusy}
                  onEdit={() => {
                    setGoalEditError(null);
                    setGoalEditOpen(true);
                  }}
                  onPause={() => runGoalControl('pause')}
                  onResume={() => runGoalControl('resume')}
                  onClear={() => runGoalControl('clear')}
                />
              )}
            </div>
          )}
          {unknownPromptAdmission && (
            <div
              className={styles.admissionUnknown}
              role="status"
              data-testid="pane-prompt-admission-unknown"
            >
              <span>{t('queue.admissionUnknown')}</span>
              {unknownPromptAdmission.payloadAvailable && (
                <span className={styles.admissionUnknownActions}>
                  <button type="button" onClick={continueEditingUnknownPrompt}>
                    {t('queue.continueEditing')}
                  </button>
                  <button type="button" onClick={discardUnknownPromptPayload}>
                    {t('queue.discardUnknown')}
                  </button>
                </span>
              )}
            </div>
          )}
          <ChatEditor
            ref={editorRef}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isRunning={isResponding || sessionHasActivePrompt}
            commands={commands}
            skills={skills}
            queuedMessages={queuedTexts}
            onPopQueuedMessages={editLastQueuedPrompt}
            onClearQueuedMessages={clearQueuedPrompts}
            visibleToolbarActions={paneToolbarActions}
            tokenCount={connection.tokenCount ?? 0}
            contextWindow={connection.contextWindow ?? 0}
            onShowContextUsage={handleShowContextUsage}
            workspaceName={showWorkspaceChip ? workspaceLabel : undefined}
            workspaceTitle={paneWorkspaceCwd}
            workspaceColor={workspaceAccent}
            currentMode={connection.currentMode ?? 'default'}
            sessionWorkflowEnabled={sessionWorkflowEnabled}
            currentModel={connection.currentModel ?? ''}
            availableModels={availableModels}
            onSelectMode={handleSelectMode}
            onSelectModel={handleSelectModel}
            reasoning={connection.reasoning}
            onSelectReasoningEffort={handleSelectReasoningEffort}
            dialogOpen={approvalActive}
            disabled={approvalActive || admissionPayloadLocked}
            voiceTarget={hidden ? undefined : voiceTarget}
            voiceStatusRevision={voiceStatusRevision}
            followupState={followupState}
            onAcceptFollowup={onAcceptFollowup}
            onDismissFollowup={onDismissFollowup}
            onImageIngestionNotice={onImageIngestionNotice}
            sessionId={connection.sessionId}
            onImagePreview={handleImagePreview}
            onAttachmentPreview={handleAttachmentPreview}
            atWorkspaceCwd={paneWorkspaceCwd}
            placeholderText={t('splitView.composerPlaceholder')}
          />
          {CustomComposerFooter && (
            <CustomComposerFooter
              disabled={approvalActive || admissionPayloadLocked}
              isRunning={isResponding || sessionHasActivePrompt}
              currentMode={connection.currentMode ?? 'default'}
              currentModel={connection.currentModel ?? ''}
              sessionName={connection.displayName}
            />
          )}
        </div>
      </div>
    </section>
  );
}
