/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from '../utils/random-uuid.js';
import { useWorkspaceFileChanges } from './artifacts/useWorkspaceFileChanges';
import { useModelRefresh } from '../hooks/useModelRefresh';
import { useSubscriptionLogout } from '../hooks/useSubscriptionLogout';
import { CapacityRecoveryDialog } from './workspaces/CapacityRecoveryDialog';
import { useCapacityRecovery } from '../hooks/useCapacityRecovery';
import {
  beginLocalCommand,
  finishLocalCommand,
} from '../utils/message-deletion';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ExpandIcon, ShrinkIcon } from 'lucide-react';
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
  isDaemonRewindUserBlock,
  type DaemonInputAnnotation,
  type DaemonSessionArtifact,
  type DaemonSessionMonitorTaskStatus,
  type DaemonSessionSummary,
  type DaemonTranscriptBlock,
  type DaemonWorkspaceCapability,
  type ReasoningSelection,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';
import { SubagentDetailsProvider } from '../subagentDetailsContext';
import { MonitorDetailsProvider } from '../monitorDetailsContext';
import { WorkflowDetailsProvider } from '../workflowDetailsContext';
import { useI18n } from '../i18n';
import { getWorkflowModeMessages } from './workflow-mode-messages';
import {
  McpAppReadOnlyContext,
  McpAppVisibilityContext,
} from '../mcpAppHostContext';
import { getSubagentDetailsUnavailableReason } from './messages/toolFormatting';
import { useWebShellCustomization } from '../customization';
import {
  SESSION_MONITOR_TOOL_CORRELATION_FEATURE,
  SESSION_TRANSCRIPT_PAGINATION_FEATURE,
} from '../constants/sessions';
import { useAnimationFrameTranscriptSnapshot } from '../hooks/useAnimationFrameTranscriptBlocks';
import { useMessagesFromBlocks } from '../hooks/useMessages';
import { useSessionArtifacts } from '../hooks/useSessionArtifacts';
import { ReportedArtifactRegistration } from './ReportedArtifactRegistration';
import { useBackgroundTasks } from '../hooks/useBackgroundTasks';
import { extractPendingPermission } from '../adapters/transcriptAdapter';
import { isNamedSubSessionApproval } from '../adapters/toolClassification';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { AttachmentPreviewRequest } from '../adapters/messageTypes';
import type {
  ComposerSubmitCommit,
  ComposerSubmitMetadata,
  EditorHandle,
} from '../hooks/useComposerCore';
import { useQueuedPrompts } from '../hooks/useQueuedPrompts';
import {
  isModelSetupCommand,
  resolveModelManagement,
  type WebShellModelManagementOptions,
} from '../modelManagement';
import type {
  WebShellUnavailableModel,
  WebShellUnavailableModelTooltipMount,
} from '../unavailableModels';
import { isAskUserPermission } from '../utils/askUserPermission';
import { isDaemonApprovalMode } from '../utils/sessionPreparation';
import { isVisibleComposerModel } from '../utils/composerModels';
import { shouldBlockComposerSubmit } from '../utils/composerInputState';
import { base64ToBlob } from '../utils/base64';
import {
  createPromptIdempotencyKey,
  isDefinitelyRejectedPromptAdmission,
} from '../utils/promptAdmission';
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
import {
  useContextUsageControls,
  type RegisterContextUsageControls,
} from '../hooks/useContextUsageControls';
import { isGoalGateBlocked } from '../utils/goalGate';
import type { WebShellSlashCommandHandler } from '../App';
import { getModelDisplayName } from '../utils/modelDisplay';
import { formatDateTime } from '../utils/formatDateTime';
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
  useDaemonActivePromptBridge,
} from '../session-catalog/session-catalog-hooks';
import type {
  Admission,
  ChatStatusFacts,
  PendingApproval,
  PendingQuestion,
} from '../chat-core/contract';
import { ChatSurface } from '../chat-core/ChatSurface';
import { useDaemonChatControllerFromState } from '../daemon/useDaemonChatController';
import type { MessageListHandle } from './MessageList';
import { StreamingStatus } from './StreamingStatus';
import type { ComposerToolbarAction } from './ChatEditor';
import { SessionRecoveryBanner } from './SessionRecoveryBanner';
import { ComposerStatusStack } from './ComposerStatusStack';
import { GoalEditDialog } from './dialogs/GoalEditDialog';
import { nextApprovalMode, parsePlanCommand } from '../utils/planMode';
import { useApprovalModes } from '../hooks/useApprovalModes';
import { createContextUsageMessageData } from './messages/ContextUsageMessage';
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
import { SessionDetailsTooltip } from './sidebar/SessionDetailsTooltip';
import styles from './ChatPane.module.css';
import accentStyles from './WorkspaceAccent.module.css';

// Split-view panes get the same session-scoped composer controls as the main
// chat. The width toggle is omitted because panes size themselves.
const PANE_TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [
  'addMenu',
  'approvalMode',
  'plan',
  'workflowMode',
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

interface PaneFailedPrompt {
  owner: { sessionId: string | undefined };
  sessionId: string | undefined;
  messageId: string;
  block: DaemonTranscriptBlock;
  text: string;
  submittedPrompt?: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  idempotencyKey: string;
  reason: 'failed' | 'uncertain';
}

function getLatestPaneUserBlock(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (isDaemonRewindUserBlock(block)) {
      return block;
    }
  }
  return undefined;
}

function matchesPaneUserBlock(
  block: DaemonTranscriptBlock | undefined,
  target: DaemonTranscriptBlock,
): boolean {
  if (!block || block.kind !== 'user' || target.kind !== 'user') return false;
  if (block === target || block.id === target.id) return true;
  const expectedRecords = target.sourceRecordIds;
  const currentRecords = block.sourceRecordIds;
  return (
    expectedRecords !== undefined &&
    expectedRecords.length > 0 &&
    currentRecords !== undefined &&
    currentRecords.length === expectedRecords.length &&
    currentRecords.every((record, index) => record === expectedRecords[index])
  );
}

export interface ChatPaneProps {
  /** Header label; falls back to the session's own display name / id. */
  title?: string;
  /** Session-list metadata for the shared title details. */
  sessionSummary?: DaemonSessionSummary;
  showSessionDetails?: boolean;
  /** Last interacted pane, independent of whether its session is running. */
  isActive?: boolean;
  /** Must be referentially stable; reports pending state and unmount cleanup. */
  onApprovalChange?: (sessionId: string, pending: boolean) => void;
  /**
   * The workspace this pane's session lives in. Passed explicitly by the split
   * view (which knows it per session); falls back to the connection's own
   * workspace.
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
  modelManagement?: WebShellModelManagementOptions;
  unavailableModels?: readonly WebShellUnavailableModel[];
  mountUnavailableModelTooltip?: WebShellUnavailableModelTooltipMount;
  onOpenGoals?: () => void;
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  onOpenMonitor?: (
    task: DaemonSessionMonitorTaskStatus,
    sessionId: string,
    sessionActions: DaemonSessionActions,
  ) => void;
  registerContextUsageControls?: RegisterContextUsageControls;
  onBeforeContextCompress?: (sessionId: string) => void;
  onOpenContextUsage?: (
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
  /** Show the session without a composer; approvals still render. */
  readOnly?: boolean;
  onFirstPromptAdmitted?: (text: string) => void;
  /** Whether this pane owns Session Catalog turn-completion reconciliation. */
  reportCatalogTurnCompletion?: boolean;
  hidden?: boolean;
  voiceUserRevision?: number;
  voiceWorkspaceRevisions?: Readonly<Record<string, number>>;
  voiceWorkspaces?: readonly DaemonWorkspaceCapability[];
  /** Enable the app-scoped experimental Session Workflow presentation. */
  sessionWorkflowEnabled?: boolean;
  showResponseTokensPerSecond?: boolean;
  planControlVisible?: boolean;
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
  sessionSummary,
  showSessionDetails = true,
  isActive = false,
  onApprovalChange,
  workspaceCwd,
  renderHeaderActions,
  onClose,
  onToggleMaximize,
  isMaximized = false,
  onError,
  onImageIngestionNotice,
  onSlashCommand,
  modelManagement,
  unavailableModels,
  mountUnavailableModelTooltip,
  onOpenGoals,
  onRightPanelOpen,
  onOpenMonitor,
  onPaneArtifactsChange,
  registerContextUsageControls,
  onBeforeContextCompress,
  onOpenContextUsage,
  messageTurnOutputs,
  embedded = false,
  readOnly = false,
  onFirstPromptAdmitted,
  reportCatalogTurnCompletion = true,
  hidden = false,
  voiceUserRevision = 0,
  voiceWorkspaceRevisions = EMPTY_VOICE_WORKSPACE_REVISIONS,
  voiceWorkspaces,
  sessionWorkflowEnabled = false,
  showResponseTokensPerSecond = false,
  planControlVisible = false,
}: ChatPaneProps) {
  const { t, language } = useI18n();
  const parentSurfaceVisible = useContext(McpAppVisibilityContext);
  const {
    renderComposerFooter: CustomComposerFooter,
    askUserFreeTextLabel,
    onRefreshModels,
    allowedApprovalModes,
  } = useWebShellCustomization();
  const connection = useConnection();
  const modelRefresh = useModelRefresh(onRefreshModels);
  const actions = useActions();
  const sessionOwnerGuard = useDaemonSessionOwnerGuard();
  const workspace = useWorkspace();
  const paneSettingsCwd =
    connection.sessionContext?.kind === 'standalone'
      ? undefined
      : (workspaceCwd ?? connection.workspaceCwd);
  const availableApprovalModes = useApprovalModes(
    paneSettingsCwd,
    allowedApprovalModes,
  );
  const capacityRecovery = useCapacityRecovery(
    workspace.client,
    workspace.capabilities?.features,
    connection,
    actions,
  );
  const attachmentWorkspaceTarget = useArtifactWorkspaceTarget(
    connection.workspaceCwd,
  );
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  // Each pane owns its DaemonSessionProvider, so each publishes the daemon's
  // live prompt state into its own provider (#9487).
  const daemonHasActivePrompt = useDaemonActivePromptBridge(
    workspace.client,
    workspaceCwd ?? connection.workspaceCwd,
    connection.sessionId,
  );
  const sessionHasActivePrompt =
    daemonHasActivePrompt || !!connection.backgroundTurn;
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
  const { artifacts, hydrated, refresh } = useSessionArtifacts();
  const openSubagentDetails = useCallback(
    (tool: ACPToolCall, parentSessionId = connection.sessionId) => {
      if (
        !parentSessionId ||
        !onRightPanelOpen ||
        getSubagentDetailsUnavailableReason(tool)
      )
        return;
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
        id: `subagent:${parentSessionId}:${tool.callId}`,
        kind: 'subagent',
        title: tool.title || subagentType || t('agent.label'),
        turnId: tool.callId,
        tool,
        sessionId: parentSessionId,
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
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const readCurrentBlocks = useCallback(
    (): readonly DaemonTranscriptBlock[] =>
      (
        store as {
          getSnapshot?: () => { blocks: readonly DaemonTranscriptBlock[] };
        }
      ).getSnapshot?.().blocks ?? blocksRef.current,
    [store],
  );
  const [failedPrompt, setFailedPrompt] = useState<PaneFailedPrompt | null>(
    null,
  );
  const failedPromptRef = useRef<PaneFailedPrompt | null>(null);
  const updateFailedPrompt = useCallback((next: PaneFailedPrompt | null) => {
    failedPromptRef.current = next;
    setFailedPrompt(next);
  }, []);
  const admissionOwnerRef = useRef({ sessionId: connection.sessionId });
  if (admissionOwnerRef.current.sessionId !== connection.sessionId) {
    admissionOwnerRef.current = { sessionId: connection.sessionId };
  }
  useEffect(() => {
    firstPromptAdmittedRef.current = false;
    updateFailedPrompt(null);
  }, [connection.sessionId, updateFailedPrompt]);
  useEffect(() => {
    const failed = failedPromptRef.current;
    if (!failed) return;
    if (failed.sessionId !== connection.sessionId) {
      updateFailedPrompt(null);
      return;
    }
    const snapshotBlocks = readCurrentBlocks();
    const currentMatch = [...snapshotBlocks]
      .reverse()
      .find((block) => matchesPaneUserBlock(block, failed.block));
    if (!currentMatch) {
      updateFailedPrompt(null);
      return;
    }
    const renderedMatch = [...blocks]
      .reverse()
      .find((block) => matchesPaneUserBlock(block, failed.block));
    if (!renderedMatch) return;
    if (renderedMatch.promptId) {
      updateFailedPrompt(null);
      return;
    }
    const renderedIndex = blocks.indexOf(renderedMatch);
    if (
      renderedIndex >= 0 &&
      blocks
        .slice(renderedIndex + 1)
        .some(
          (block) =>
            isDaemonRewindUserBlock(block) ||
            (block.kind === 'assistant' &&
              block.meta?.['source'] !== 'background_notification') ||
            block.kind === 'thought' ||
            block.kind === 'tool',
        )
    ) {
      updateFailedPrompt(null);
      return;
    }
    if (
      failed.messageId !== renderedMatch.id ||
      failed.block !== renderedMatch
    ) {
      updateFailedPrompt({
        ...failed,
        messageId: renderedMatch.id,
        block: renderedMatch,
      });
    }
  }, [blocks, connection.sessionId, readCurrentBlocks, updateFailedPrompt]);
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
  const transcriptViewportRef = useRef<MessageListHandle>(null);
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
  const modelManagementPolicy = resolveModelManagement(modelManagement);
  const modelManagementRef = useRef(modelManagementPolicy);
  modelManagementRef.current = modelManagementPolicy;
  const onSlashCommandRef = useRef(onSlashCommand);
  onSlashCommandRef.current = onSlashCommand;
  const {
    available: subscriptionAvailable,
    handleCommand: handleSubscriptionLogout,
  } = useSubscriptionLogout({
    t,
    onCommand: (text) =>
      invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError),
    workspaceCwd: paneSettingsCwd,
    isBlocked: () =>
      streamingStateRef.current !== 'idle' ||
      sessionHasActivePromptRef.current ||
      isGoalGateBlocked({
        sessionId: connectionRef.current.sessionId,
        goalState: connectionRef.current.goalState,
      }),
    onBlocked: () => {
      onImageIngestionNotice?.('warning', t('queue.commandBlocked'));
      return false;
    },
    onNotice: (_kind, message) =>
      store.dispatch([
        {
          type: 'status',
          promptId: `local-command:${randomUUID()}`,
          text: message,
        },
      ]),
    onError: reportError,
  });
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
  useEffect(() => {
    const sessionId = connection.sessionId;
    if (!sessionId || !onApprovalChange) return;
    onApprovalChange(sessionId, approvalActive);
    return () => onApprovalChange(sessionId, false);
  }, [connection.sessionId, approvalActive, onApprovalChange]);
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
  const fileChangesByTurn = useWorkspaceFileChanges(
    messages,
    artifactsByTurn,
    connection.workspaceCwd ||
      connection.standaloneSession?.projectlessOutputDirectory ||
      '',
    connection.sessionId,
    connection.workspaceCwd && sessionSummary
      ? (sessionSummary.worktree?.path ?? connection.workspaceCwd)
      : connection.workspaceCwd
        ? undefined
        : null,
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
  const canSendMidTurnNow =
    connection.capabilities?.features.includes('session_mid_turn_send_now') ===
    true;
  const canInjectMidTurnMedia =
    connection.capabilities?.features.includes('session_attachments') === true;
  const {
    queuedPrompts,
    queuedTexts,
    enqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    sendQueuedPromptNow,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  } = useQueuedPrompts({
    getPromptDispatchError: (text) =>
      !modelManagementRef.current.allowAdd &&
      isModelSetupCommand(text, connectionRef.current.commands)
        ? t('settings.models.addDisabled')
        : undefined,
    connected: connection.status === 'connected',
    writeBlocked: readOnly || connection.runtimeStopped,
    runtimeStopped: connection.runtimeStopped,
    sessionId: connection.sessionId,
    workspaceCwd: connection.workspaceCwd,
    clientId: connection.clientId,
    canMutateMidTurn,
    canQueryMidTurn,
    canQueryPendingPrompts:
      connection.capabilities?.features.includes('session_prompt') === true,
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
    if (
      connection.localPrompt &&
      connection.localPrompt.sessionId === connection.sessionId
    ) {
      return connection.localPrompt.startedAt;
    }
    if (connection.backgroundTurn) return connection.backgroundTurn.startedAt;
    if (!isResponding) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'user' && !message.agentMessage?.sentTo) {
        return message.timestamp;
      }
    }
    return undefined;
  }, [
    messages,
    isResponding,
    connection.backgroundTurn,
    connection.localPrompt,
    connection.sessionId,
  ]);

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

  const planPreparationRef = useRef<{ isCurrent: () => boolean } | null>(null);
  const planMode = connection.currentMode === 'plan';
  const executionMode = planMode
    ? (connection.planExecutionMode ?? 'default')
    : (connection.currentMode ?? 'default');
  const [modeControlsBusy, setModeControlsBusy] = useState(false);
  const modeTransitionRef = useRef<{
    owner: { isCurrent: () => boolean };
    requestId?: string;
    initialMode?: string;
    hadActiveTurn?: boolean;
  } | null>(null);
  const releaseModeTransition = useCallback(
    (transition: typeof modeTransitionRef.current) => {
      if (modeTransitionRef.current !== transition) return;
      modeTransitionRef.current = null;
      setModeControlsBusy(false);
    },
    [],
  );
  useEffect(() => {
    const transition = modeTransitionRef.current;
    if (!transition) return;
    const activeTurn = streamingState !== 'idle' || sessionHasActivePrompt;
    if (
      !transition.owner.isCurrent() ||
      (transition.requestId &&
        ((connection.currentMode !== 'plan' &&
          connection.currentMode !== transition.initialMode) ||
          (isExitPlanApprovalRequest(pendingToolApproval) &&
            pendingToolApproval?.id !== transition.requestId) ||
          (transition.hadActiveTurn && !activeTurn)))
    ) {
      releaseModeTransition(transition);
    } else if (activeTurn) {
      transition.hadActiveTurn = true;
    }
  });

  const setComposerMode = useCallback(
    async (modeId: string, enabled: boolean): Promise<boolean> => {
      if (modeTransitionRef.current?.owner.isCurrent()) return false;
      if (
        connection.loadingTranscript ||
        shouldBlockComposerSubmit({
          connectionStatus: connection.status,
          hasSession: Boolean(connection.sessionId),
        })
      )
        return false;
      if (!isDaemonApprovalMode(modeId) || modeId === 'plan') {
        reportError(
          new Error(`Unsupported execution approval mode: ${modeId}`),
          'Failed to set approval mode',
        );
        return false;
      }
      const owner = sessionOwnerGuard.capture();
      const transition = { owner };
      modeTransitionRef.current = transition;
      setModeControlsBusy(true);
      try {
        await actions.setApprovalMode(modeId, { planMode: enabled });
        if (!owner.isCurrent()) return false;
        const approval = pendingToolApprovalRef.current;
        if (
          !enabled &&
          approval &&
          !isExitPlanApprovalRequest(approval) &&
          !isNamedSubSessionApproval(approval) &&
          (modeId === 'yolo' ||
            (modeId === 'auto-edit' && approval.toolKind === 'edit'))
        ) {
          const allowOnce = approval.options.find(
            (option) => option.kind === 'allow_once',
          );
          if (allowOnce)
            void actions
              .submitPermission(approval.id, allowOnce.id)
              .catch((error: unknown) =>
                reportError(error, 'Failed to auto-approve tool call'),
              );
        }
        return true;
      } catch (error) {
        if (owner.isCurrent())
          reportError(error, 'Failed to set approval mode');
        return false;
      } finally {
        releaseModeTransition(transition);
      }
    },
    [
      actions,
      connection.loadingTranscript,
      connection.status,
      connection.sessionId,
      reportError,
      sessionOwnerGuard,
      releaseModeTransition,
    ],
  );

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      commitAccepted?: ComposerSubmitCommit,
      metadata?: ComposerSubmitMetadata,
    ): boolean => {
      let trimmed = text.trim();
      if (!trimmed && (images?.length ?? 0) === 0 && (files?.length ?? 0) === 0)
        return false;
      if (planPreparationRef.current?.isCurrent()) return false;
      if (connectionRef.current.loadingTranscript) return false;
      // Same fence as App's composer: a stopped runtime keeps the draft in
      // the composer (the pane banner offers Resume); a submit here would
      // only race the dead runtime. The parked state retains sessionId, so
      // shouldBlockComposerSubmit alone cannot catch it.
      if (connectionRef.current.runtimeStopped) {
        onImageIngestionNotice?.('warning', t('capacityChoice.stopped'));
        return false;
      }
      transcriptViewportRef.current?.scrollToBottom();
      // Account commands must pass login and model checks before host overrides.
      const subscriptionHandled = handleSubscriptionLogout(text);
      if (subscriptionHandled !== undefined) return subscriptionHandled;
      if (
        trimmed &&
        invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError)
      ) {
        return true;
      }
      // Only when the host declines does the policy consume a model-setup
      // command — below the runtimeStopped fence so a stopped runtime keeps
      // the draft instead of toasting, and ahead of any daemon dispatch.
      if (
        !modelManagementRef.current.allowAdd &&
        isModelSetupCommand(text, connectionRef.current.commands)
      ) {
        onImageIngestionNotice?.('warning', t('settings.models.addDisabled'));
        return true;
      }
      const planCommand = trimmed.match(/^\/plan(?:\s+(.*))?$/is);
      const planOperation = planCommand
        ? parsePlanCommand(planCommand[1] ?? '', planMode)
        : undefined;
      if (planOperation) {
        if (modeTransitionRef.current?.owner.isCurrent()) {
          reportError(
            new Error(t('mode.changePending')),
            t('local.approvalMode'),
          );
          return false;
        }
        if (
          connection.loadingTranscript ||
          shouldBlockComposerSubmit({
            connectionStatus: connection.status,
            hasSession: Boolean(connection.sessionId),
          })
        )
          return false;
        if (!planOperation.prompt) {
          void setComposerMode(executionMode, planOperation.enabled);
          return true;
        }
        if (
          streamingStateRef.current !== 'idle' ||
          sessionHasActivePromptRef.current
        )
          return false;
        trimmed = planOperation.prompt;
        if (
          !modelManagementRef.current.allowAdd &&
          isModelSetupCommand(trimmed, connectionRef.current.commands)
        ) {
          onImageIngestionNotice?.('warning', t('settings.models.addDisabled'));
          return true;
        }
      }
      if (!planOperation && /^\/goal(?:\s|$)/i.test(trimmed)) {
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
        store.appendLocalUserMessage(text, undefined, {
          localCommandId: `local-command:${randomUUID()}`,
        });
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
        text.trim().startsWith('/') &&
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
        const submissionIdempotencyKey = createPromptIdempotencyKey();
        let admissionStarted = false;
        let admitted = false;
        const submit = () => {
          if (
            !modelManagementRef.current.allowAdd &&
            isModelSetupCommand(trimmed, connectionRef.current.commands)
          ) {
            onImageIngestionNotice?.(
              'warning',
              t('settings.models.addDisabled'),
            );
            return;
          }
          const previousUserBlock = getLatestPaneUserBlock(readCurrentBlocks());
          let capturedUserBlock: DaemonTranscriptBlock | undefined;
          let composerCommitted = false;
          const captureAppendedUserBlock = () => {
            if (capturedUserBlock) return capturedUserBlock;
            const latest = getLatestPaneUserBlock(readCurrentBlocks());
            if (latest && latest !== previousUserBlock) {
              capturedUserBlock = latest;
              if (!composerCommitted) {
                composerCommitted = true;
                clearFollowup();
                commitAccepted?.();
              }
            }
            return capturedUserBlock;
          };
          const result = actions
            .sendPrompt(trimmed, {
              submittedPrompt: text,
              idempotencyKey: submissionIdempotencyKey,
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
                if (!composerCommitted) {
                  composerCommitted = true;
                  commitAccepted?.();
                }
              },
            })
            .catch((error: unknown) => {
              if (admissionOwnerRef.current !== admissionOwner) return;
              const definitelyRejected =
                isDefinitelyRejectedPromptAdmission(error);
              const admissionUncertain =
                !admitted && admissionStarted && !definitelyRejected;
              const failedBlock = captureAppendedUserBlock();
              if (!admitted && failedBlock) {
                updateFailedPrompt({
                  owner: admissionOwner,
                  sessionId: connectionRef.current.sessionId,
                  messageId: failedBlock.id,
                  block: failedBlock,
                  text: trimmed,
                  submittedPrompt: text,
                  images: images ? [...images] : undefined,
                  files: files ? [...files] : undefined,
                  inputAnnotations: inputAnnotations
                    ? [...inputAnnotations]
                    : undefined,
                  idempotencyKey: submissionIdempotencyKey,
                  reason: admissionUncertain ? 'uncertain' : 'failed',
                });
              }
              if (admissionUncertain) {
                if (catalogOwnerCwd) {
                  sessionCatalogController.promptAdmissionUncertain(
                    catalogOwnerCwd,
                  );
                }
                onImageIngestionNotice?.(
                  'warning',
                  t('userMessage.deliveryUncertain'),
                );
                console.warn(
                  '[ChatPane] prompt admission outcome is unknown',
                  error,
                );
                return;
              }
              reportError(error, 'Failed to send prompt');
            });
          captureAppendedUserBlock();
          return result;
        };
        if (planOperation) {
          const owner = sessionOwnerGuard.capture();
          planPreparationRef.current = owner;
          void setComposerMode(executionMode, planOperation.enabled).then(
            (applied) => {
              if (planPreparationRef.current === owner)
                planPreparationRef.current = null;
              const current = connectionRef.current;
              if (
                !applied ||
                !owner.isCurrent() ||
                current.runtimeStopped ||
                current.loadingTranscript ||
                shouldBlockComposerSubmit({
                  connectionStatus: current.status,
                  hasSession: Boolean(current.sessionId),
                }) ||
                streamingStateRef.current !== 'idle' ||
                sessionHasActivePromptRef.current ||
                isGoalGateBlocked({
                  sessionId: current.sessionId,
                  goalState: current.goalState,
                })
              )
                return;
              void submit();
            },
          );
        } else {
          void submit();
        }
        return false;
      }
      const queued =
        !trimmed && !inputAnnotations
          ? enqueuePrompt(
              trimmed,
              images,
              files,
              undefined,
              undefined,
              undefined,
              text,
            )
          : enqueuePrompt(
              trimmed,
              images,
              files,
              undefined,
              inputAnnotations,
              notifyFirstPromptAdmitted,
              text,
            );
      if (queued !== false && catalogOwnerCwd) {
        sessionCatalogController.invalidateWorkspace(catalogOwnerCwd);
      }
      return queued;
    },
    [
      actions,
      executionMode,
      planMode,
      setComposerMode,
      sessionOwnerGuard,
      catalogOwnerCwd,
      clearFollowup,
      connection.goalState,
      connection.loadingTranscript,
      connection.sessionId,
      connection.status,
      controlGoal,
      handleSubscriptionLogout,
      enqueuePrompt,
      onFirstPromptAdmitted,
      onImageIngestionNotice,
      onOpenGoals,
      readCurrentBlocks,
      reportError,
      sessionCatalogController,
      store,
      t,
      updateFailedPrompt,
    ],
  );

  const handleFailedPromptRetry = useCallback(() => {
    if (
      streamingStateRef.current !== 'idle' ||
      sessionHasActivePromptRef.current
    ) {
      return;
    }
    const failed = failedPromptRef.current;
    if (!failed || failed.sessionId !== connectionRef.current.sessionId) {
      updateFailedPrompt(null);
      return;
    }
    const retryOwner = failed.owner;
    if (admissionOwnerRef.current !== retryOwner) {
      updateFailedPrompt(null);
      return;
    }
    updateFailedPrompt(null);
    let admissionStarted = false;
    let admitted = false;
    void actions
      .sendPrompt(failed.text, {
        submittedPrompt: failed.submittedPrompt ?? failed.text,
        optimisticUserMessage: false,
        bindBlockId: failed.messageId,
        idempotencyKey: failed.idempotencyKey,
        ...(failed.images?.length ? { images: failed.images } : {}),
        ...(failed.files?.length ? { files: failed.files } : {}),
        ...(failed.inputAnnotations?.length
          ? { inputAnnotations: failed.inputAnnotations }
          : {}),
        onAdmissionStarted: () => {
          admissionStarted = true;
        },
        onAdmitted: () => {
          if (admissionOwnerRef.current !== retryOwner) return;
          admitted = true;
          if (connectionRef.current.sessionId && catalogOwnerCwd) {
            sessionCatalogController.promptAdmitted(
              catalogOwnerCwd,
              connectionRef.current.sessionId,
            );
          }
        },
      })
      .catch((error: unknown) => {
        if (admissionOwnerRef.current !== retryOwner) return;
        const definitelyRejected = isDefinitelyRejectedPromptAdmission(error);
        const admissionUncertain =
          !admitted && admissionStarted && !definitelyRejected;
        if (!admitted) {
          updateFailedPrompt({
            ...failed,
            reason: admissionUncertain ? 'uncertain' : 'failed',
          });
        }
        if (admissionUncertain) {
          if (catalogOwnerCwd) {
            sessionCatalogController.promptAdmissionUncertain(catalogOwnerCwd);
          }
          onImageIngestionNotice?.(
            'warning',
            t('userMessage.deliveryUncertain'),
          );
          console.warn(
            '[ChatPane] prompt retry admission outcome is unknown',
            error,
          );
          return;
        }
        reportError(error, 'Failed to send prompt');
      });
  }, [
    actions,
    catalogOwnerCwd,
    onImageIngestionNotice,
    reportError,
    sessionCatalogController,
    t,
    updateFailedPrompt,
  ]);

  const visibleFailedPromptBlock = useMemo(() => {
    if (!failedPrompt || failedPrompt.sessionId !== connection.sessionId) {
      return undefined;
    }
    return [...blocks]
      .reverse()
      .find((block) => matchesPaneUserBlock(block, failedPrompt.block));
  }, [blocks, connection.sessionId, failedPrompt]);

  const submitPanePermission = useCallback(
    async (id: string, selectedOption: string): Promise<Admission> => {
      const request = pendingToolApprovalRef.current;
      const isPlan = request?.id === id && isExitPlanApprovalRequest(request);
      if (isPlan && modeTransitionRef.current?.owner.isCurrent()) {
        return 'rejected';
      }
      const owner = sessionOwnerGuard.capture();
      const option = request?.options.find(
        (entry) => entry.id === selectedOption,
      );
      const approvesPlan =
        isPlan &&
        (option?.kind === 'allow_once' || option?.kind === 'allow_always');
      const transition = isPlan
        ? {
            owner,
            ...(approvesPlan
              ? {
                  requestId: id,
                  initialMode: connectionRef.current.currentMode,
                  hadActiveTurn:
                    streamingStateRef.current !== 'idle' ||
                    sessionHasActivePromptRef.current,
                }
              : {}),
          }
        : null;
      if (transition) {
        modeTransitionRef.current = transition;
        setModeControlsBusy(true);
      }
      try {
        const applied =
          approvesPlan && connection.planExecutionMode !== undefined
            ? await actions.respondToPermission(id, {
                outcome: { outcome: 'selected', optionId: selectedOption },
                expectedPlanExecutionMode: connection.planExecutionMode,
              })
            : await actions.submitPermission(id, selectedOption);
        if (transition && (!approvesPlan || !applied)) {
          releaseModeTransition(transition);
        }
        return applied ? 'accepted' : 'rejected';
      } catch {
        if (transition) releaseModeTransition(transition);
        return 'unknown';
      }
    },
    [
      actions,
      sessionOwnerGuard,
      releaseModeTransition,
      connection.planExecutionMode,
    ],
  );

  const pendingApprovals = useMemo<readonly PendingApproval[]>(
    () =>
      pendingToolApproval
        ? [
            {
              id: pendingToolApproval.id,
              status: 'pending',
              request: pendingToolApproval,
            },
          ]
        : [],
    [pendingToolApproval],
  );
  const pendingQuestions = useMemo<readonly PendingQuestion[]>(
    () =>
      pendingAskUserApproval
        ? [{ id: pendingAskUserApproval.id, request: pendingAskUserApproval }]
        : [],
    [pendingAskUserApproval],
  );
  const pendingSignature = pendingToolApproval
    ? `a:${pendingToolApproval.id}`
    : pendingAskUserApproval
      ? `q:${pendingAskUserApproval.id}`
      : '';
  const statusFacts = useMemo<ChatStatusFacts>(
    () => ({
      queueLength: queuedPrompts.length,
      goalActive: Boolean(liveGoalSnapshot?.goal),
    }),
    [queuedPrompts.length, liveGoalSnapshot?.goal],
  );
  const surfaceController = useDaemonChatControllerFromState({
    connection,
    actions,
    transcriptHistory,
    messages,
    pendingApprovals,
    pendingQuestions,
    pendingSignature,
    transcriptState: connection.loadingTranscript ? 'loading' : 'ready',
    statusFacts,
    submitPermission: submitPanePermission,
  });

  const reviewSourceRef = useRef({ messages, artifactsByTurn });
  reviewSourceRef.current = { messages, artifactsByTurn };
  const handleRightPanelOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      if (!onRightPanelOpen) return;
      const source = reviewSourceRef.current;
      onRightPanelOpen({
        ...request,
        ...(request.kind === 'review'
          ? {
              unfilteredChanges:
                getFileChangesByTurn(
                  source.messages,
                  source.artifactsByTurn,
                  connection.workspaceCwd ||
                    connection.standaloneSession?.projectlessOutputDirectory ||
                    '',
                ).get(request.turnId) ?? request.changes,
            }
          : {}),
        sourceSessionId: connection.sessionId,
      });
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      connection.standaloneSession?.projectlessOutputDirectory,
      onRightPanelOpen,
    ],
  );
  const paneWorkspaceCwd = workspaceCwd ?? connection.workspaceCwd;
  const modelPickerScope = useMemo(
    () => ({
      sessionId: connection.sessionId,
      workspaceCwd: paneWorkspaceCwd,
      daemonBaseUrl: workspace.baseUrl,
    }),
    [connection.sessionId, paneWorkspaceCwd, workspace.baseUrl],
  );
  const previewSessionIdRef = useRef(connection.sessionId);
  previewSessionIdRef.current = connection.sessionId;

  const handleImagePreview = useCallback(
    (
      src: string,
      alt?: string,
      source?: { kind: 'attachment'; attachmentId: string },
    ) => {
      if (!connection.sessionId) return;
      handleRightPanelOpen({
        id: 'image',
        kind: 'image',
        title: t('turnOutputs.imagePreview'),
        turnId: connection.sessionId,
        src,
        ...(alt ? { alt } : {}),
        ...(source ? { attachmentId: source.attachmentId } : {}),
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
          ...(resolvedFile.attachmentId
            ? { attachmentId: resolvedFile.attachmentId }
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
      mergeCommands(
        connection.commands ?? [],
        getLocalCommands(t, { subscriptionAvailable }),
      ),
      t,
    )
      .filter(
        (command) =>
          subscriptionAvailable ||
          !['logout', 'upgrade'].includes(command.name) ||
          Boolean(command.source && command.source !== 'builtin-command'),
      )
      .filter(
        (command) =>
          modelManagementPolicy.allowAdd ||
          !isModelSetupCommand(`/${command.name}`, connection.commands),
      )
      .map((command) => {
        const skillKey = skillDescriptionKey(command.name);
        if (!skillKey) return command;
        return {
          ...command,
          displayCategory: 'skill' as const,
          description: t(skillKey),
        };
      });
  }, [
    connection.commands,
    modelManagementPolicy.allowAdd,
    subscriptionAvailable,
    t,
  ]);
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
  const contextUsageAvailable = !shouldBlockComposerSubmit({
    connectionStatus: connection.status,
    hasSession: Boolean(connection.sessionId),
  });
  const handleShowContextUsage = useCallback(() => {
    if (!contextUsageAvailable) {
      return;
    }
    const owner = sessionOwnerGuard.capture();
    const localCommandId = `local-command:${randomUUID()}`;
    beginLocalCommand(store, localCommandId);
    if (streamingStateRef.current === 'idle') {
      store.appendLocalUserMessage('/context', undefined, { localCommandId });
    }
    actions
      .getContextUsage({ detail: false })
      .finally(() => finishLocalCommand(store, localCommandId))
      .then((result) => {
        if (!owner.isCurrent()) return;
        store.dispatch([
          {
            type: 'status',
            promptId: localCommandId,
            text: t('contextUsage.title'),
            data: createContextUsageMessageData(result),
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
    contextUsageAvailable,
    reportError,
    sessionOwnerGuard,
    store,
    t,
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
      if (
        isDaemonApprovalMode(modeId) &&
        modeId !== 'plan' &&
        !availableApprovalModes.some((mode) => mode === modeId)
      ) {
        reportError(
          new Error(`Approval mode not offered here: ${modeId}`),
          'Failed to set approval mode',
        );
        return;
      }
      void setComposerMode(modeId, planMode);
    },
    [availableApprovalModes, setComposerMode, planMode, reportError],
  );
  const handleCycleMode = useCallback(() => {
    const next = nextApprovalMode(availableApprovalModes, executionMode);
    if (next) handleSelectMode(next);
  }, [availableApprovalModes, executionMode, handleSelectMode]);
  const handleTogglePlan = useCallback(() => {
    void setComposerMode(executionMode, !planMode);
  }, [setComposerMode, executionMode, planMode]);
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
  const handleWorkflowModeChange = useCallback(
    (requested: boolean) => {
      if (connection.loadingTranscript || connection.catchingUp) return;
      const owner = sessionOwnerGuard.capture();
      void actions.setWorkflowMode(requested).catch((error: unknown) => {
        if (owner.isCurrent())
          reportError(error, getWorkflowModeMessages(language).updateFailed);
      });
    },
    [
      actions,
      connection.loadingTranscript,
      connection.catchingUp,
      sessionOwnerGuard,
      reportError,
      language,
    ],
  );
  const handleSelectReasoningEffort = useCallback(
    (value: ReasoningSelection) =>
      actions
        .setReasoningEffort(value, {
          persist: connection.sessionContext?.kind !== 'standalone',
        })
        .catch((error: unknown) =>
          reportError(error, t('reasoning.updateFailed')),
        ),
    [actions, connection.sessionContext?.kind, reportError, t],
  );

  const headerLabel =
    title || connection.displayName || connection.sessionId?.slice(0, 8) || '';
  const sessionStamp = sessionSummary?.updatedAt || sessionSummary?.createdAt;

  // Multi-workspace-ness comes from the shared workspace provider (the
  // pane's own session connection may not carry it).
  const showWorkspaceChip =
    hasMultipleWorkspaces(workspace.capabilities) && !!paneWorkspaceCwd;
  const prepareContextCompression = useCallback(() => {
    clearFollowup();
    if (connection.sessionId) onBeforeContextCompress?.(connection.sessionId);
  }, [clearFollowup, connection.sessionId, onBeforeContextCompress]);
  const handleOpenContextUsage = useCallback(() => {
    if (connection.sessionId)
      onOpenContextUsage?.(connection.sessionId, actions);
  }, [actions, connection.sessionId, onOpenContextUsage]);
  const contextUsageControls = useContextUsageControls({
    connection,
    actions,
    ownerGuard: sessionOwnerGuard,
    onBeforeCompress: prepareContextCompression,
    busy: streamingState !== 'idle' || sessionHasActivePrompt,
    writeBlocked:
      Boolean(connection.loadingTranscript) ||
      approvalActive ||
      modeControlsBusy,
  });
  useEffect(() => {
    if (contextUsageControls)
      return registerContextUsageControls?.(contextUsageControls);
  }, [contextUsageControls, registerContextUsageControls]);

  // Memoized so the array identity is stable across renders — `ChatEditor` is
  // `React.memo`, and a fresh `[...]` each render would defeat it.
  const paneToolbarActions = useMemo(
    () =>
      (embedded && showWorkspaceChip
        ? [...PANE_TOOLBAR_ACTIONS, 'workspace' as const]
        : PANE_TOOLBAR_ACTIONS
      ).filter((action) => action !== 'plan' || planControlVisible),
    [embedded, showWorkspaceChip, planControlVisible],
  );
  const headerActions =
    !readOnly && connection.sessionId && renderHeaderActions
      ? renderHeaderActions({
          sessionId: connection.sessionId,
          workspaceCwd: paneWorkspaceCwd || undefined,
          sessionActions: actions,
        })
      : null;

  // The header identifies each split pane's workspace; only embedded panes
  // without a header need the composer chip. The accent matches sidebar dots.
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
  const showComposerStatus =
    !readOnly && (queuedPrompts.length > 0 || liveGoalSnapshot?.goal);

  return (
    <section
      className={`${styles.pane} ${embedded ? styles.paneEmbedded : ''}`.trim()}
      data-testid="chat-pane"
      data-pane-active={isActive ? '' : undefined}
      aria-current={isActive ? 'location' : undefined}
      aria-label={headerLabel}
    >
      {/* Each pane runs under its own DaemonSessionProvider, so App's
          registration mount only covers the main session; register this
          pane's reported artifacts here. */}
      <ReportedArtifactRegistration
        registered={artifacts}
        hydrated={hydrated}
        refresh={refresh}
      />
      {!readOnly && goalEditOpen && connection.goalState?.goal && (
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
          {showSessionDetails && sessionSummary && !hidden ? (
            <SessionDetailsTooltip
              session={{
                ...sessionSummary,
                hasActivePrompt: sessionHasActivePrompt,
              }}
              label={headerLabel}
              time={sessionStamp ? formatDateTime(sessionStamp) : ''}
              completedUnread={false}
              workspaceLabel={workspaceLabel}
              side="bottom"
            >
              <span className={styles.title}>{headerLabel}</span>
            </SessionDetailsTooltip>
          ) : (
            <span className={styles.title} title={headerLabel}>
              {headerLabel}
            </span>
          )}
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
                      {isMaximized ? (
                        <ShrinkIcon size={16} aria-hidden />
                      ) : (
                        <ExpandIcon size={16} aria-hidden />
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

      <OptionalMonitorDetailsProvider
        enabled={monitorDetailsSupported}
        onOpen={openMonitorDetails}
      >
        <SubagentDetailsProvider
          onOpen={openSubagentDetails}
          onOpenBackground={
            onRightPanelOpen && connection.sessionId
              ? (turn) => {
                  if (!connection.sessionId) return;
                  onRightPanelOpen({
                    id: `background:${connection.sessionId}:${turn.taskId}`,
                    kind: 'background_task',
                    title: turn.label ?? turn.kind,
                    turnId: turn.turnId,
                    backgroundTurn: turn,
                    sourceSessionId: connection.sessionId,
                    workspaceCwd: connection.workspaceCwd ?? workspaceCwd,
                  });
                }
              : undefined
          }
        >
          <McpAppVisibilityContext.Provider
            value={parentSurfaceVisible && !hidden}
          >
            <McpAppReadOnlyContext.Provider value={readOnly}>
              <WorkflowDetailsProvider tasks={sessionTasks}>
                <ChatSurface
                  controller={surfaceController}
                  className={styles.surface}
                  transcriptClassName={styles.body}
                  footerClassName={styles.footer}
                  decisionClassName={styles.approval}
                  decisionTestId="pane-approval"
                  transcriptRef={transcriptViewportRef}
                  sessionViewportEnabled
                  workspaceFeaturesEnabled
                  commands={commands}
                  visibleToolbarActions={paneToolbarActions}
                  atWorkspaceCwd={paneWorkspaceCwd}
                  onError={reportError}
                  showBrowserNotifications
                  approvalDisabled={isExitPlanApproval && modeControlsBusy}
                  planExecutionMode={connection.planExecutionMode}
                  planTodos={planTodos}
                  // Several panes can show approvals at once; don't auto-focus
                  // one pane's approval (it would steal focus from the pane the
                  // user is in). Keyboard handling is focus-scoped, so each
                  // pane's approval is still fully keyboard-operable once
                  // clicked/tabbed into.
                  approvalKeyboardActive={false}
                  generateContent={
                    connection.capabilities?.features.includes(
                      'session_generation',
                    )
                      ? actions.generateSessionContent
                      : undefined
                  }
                  askUserFreeTextLabel={askUserFreeTextLabel}
                  transcriptProps={{
                    sourceSessionId: connection.sessionId,
                    catchingUp: connection.catchingUp,
                    transcriptBlockCount: blocks.length,
                    transcriptActivity: store,
                    onReloadTranscript: transcriptReloadSupported
                      ? reloadTranscript
                      : undefined,
                    isResponding,
                    workspaceCwd: connection.workspaceCwd || '',
                    hideSessionTimeline: true,
                    turnFileChanges: visibleTurnOutputKinds.has('file')
                      ? fileChangesByTurn
                      : undefined,
                    turnArtifacts: visibleTurnOutputKinds.has('artifact')
                      ? artifactsByTurn
                      : undefined,
                    turnScheduledTasks: visibleTurnOutputKinds.has(
                      'scheduled_task',
                    )
                      ? scheduledTasksByTurn
                      : undefined,
                    onTurnOutputOpen: handleRightPanelOpen,
                    onImagePreview: handleImagePreview,
                    onAttachmentPreview: handleAttachmentPreview,
                    onError: reportError,
                    failedPromptMessageId:
                      readOnly ||
                      isResponding ||
                      sessionHasActivePrompt ||
                      !visibleFailedPromptBlock
                        ? undefined
                        : visibleFailedPromptBlock.id,
                    failedPromptStatus:
                      readOnly ||
                      isResponding ||
                      sessionHasActivePrompt ||
                      !visibleFailedPromptBlock
                        ? undefined
                        : failedPrompt?.reason,
                    onRetryFailedPrompt: readOnly
                      ? undefined
                      : handleFailedPromptRetry,
                    generateContent: connection.capabilities?.features.includes(
                      'session_generation',
                    )
                      ? actions.generateSessionContent
                      : undefined,
                  }}
                  panels={
                    !readOnly && capacityRecovery.intent ? (
                      <CapacityRecoveryDialog
                        intent={capacityRecovery.intent}
                        onClose={capacityRecovery.dismiss}
                      />
                    ) : undefined
                  }
                  composerStatus={
                    <>
                      {connection.runtimeStopped && (
                        <div
                          role="status"
                          data-testid="workspace-runtime-stopped"
                        >
                          <span>
                            {t('capacityChoice.stopped')}{' '}
                            {connection.runtimeStopPersistenceUnconfirmed
                              ? t('capacityChoice.persistenceUnconfirmed')
                              : ''}
                          </span>
                          {!readOnly && (
                            <button
                              type="button"
                              onClick={() => {
                                if (connection.sessionId)
                                  void actions
                                    .loadSession(connection.sessionId, {
                                      sessionContext: connection.sessionContext,
                                    })
                                    .catch((error: unknown) =>
                                      reportError(
                                        error,
                                        'Failed to resume session',
                                      ),
                                    );
                              }}
                            >
                              {t('capacityChoice.resume')}
                            </button>
                          )}
                        </div>
                      )}
                      {/* Panes keep the composer status compact: spinner + elapsed
                          time + token count + cancel hint, but no rotating "witty"
                          loading phrase. */}
                      <StreamingStatus
                        showResponseTokensPerSecond={
                          showResponseTokensPerSecond && !approvalActive
                        }
                        startedAt={activeTurnStartedAt}
                        showPhrase={false}
                        hasActivePrompt={sessionHasActivePrompt}
                        backgroundLabel={
                          connection.backgroundTurn?.label ??
                          connection.backgroundTurn?.kind
                        }
                      />
                      {showComposerStatus && (
                        <ComposerStatusStack
                          queued={{
                            prompts: queuedPrompts,
                            t,
                            canMutateMidTurn,
                            canInsertMidTurn:
                              streamingState !== 'idle' ||
                              sessionHasActivePrompt,
                            onDelete: removeQueuedPrompt,
                            canSendMidTurnNow,
                            onInsert: insertQueuedPrompt,
                            onSendNow: sendQueuedPromptNow,
                            onEdit: editQueuedPrompt,
                            onImagePreview: handleImagePreview,
                            onAttachmentPreview: handleAttachmentPreview,
                          }}
                          goal={
                            liveGoalSnapshot?.goal
                              ? {
                                  snapshot: liveGoalSnapshot,
                                  busy: goalControlBusy,
                                  onEdit: () => {
                                    setGoalEditError(null);
                                    setGoalEditOpen(true);
                                  },
                                  onPause: () => runGoalControl('pause'),
                                  onResume: () => runGoalControl('resume'),
                                  onClear: () => runGoalControl('clear'),
                                  onOpenGoals,
                                }
                              : undefined
                          }
                        />
                      )}
                      <SessionRecoveryBanner
                        blocked={
                          readOnly || approvalActive || sessionHasActivePrompt
                        }
                      />
                    </>
                  }
                  composerEditorVisible={!readOnly}
                  composerRef={editorRef}
                  onComposerSubmit={handleSubmit}
                  composerProps={{
                    sessionId: connection.sessionId,
                    isRunning: isResponding || sessionHasActivePrompt,
                    skills,
                    queuedMessages: queuedTexts,
                    onPopQueuedMessages: editLastQueuedPrompt,
                    onClearQueuedMessages: clearQueuedPrompts,
                    tokenCount: contextUsageAvailable
                      ? (connection.tokenCount ?? 0)
                      : 0,
                    contextWindow: contextUsageAvailable
                      ? (connection.contextWindow ?? 0)
                      : 0,
                    onShowContextUsage: contextUsageAvailable
                      ? handleShowContextUsage
                      : undefined,
                    contextUsageControls: onOpenContextUsage
                      ? contextUsageControls
                      : undefined,
                    onOpenContextUsage:
                      contextUsageAvailable && onOpenContextUsage
                        ? handleOpenContextUsage
                        : undefined,
                    workspaceName: showWorkspaceChip
                      ? workspaceLabel
                      : undefined,
                    workspaceTitle: paneWorkspaceCwd,
                    workspaceColor: workspaceAccent,
                    currentMode: executionMode,
                    availableModes: availableApprovalModes,
                    onCycleMode: handleCycleMode,
                    modeControlsDisabled: modeControlsBusy,
                    planMode,
                    onTogglePlan: handleTogglePlan,
                    sessionWorkflowEnabled,
                    currentModel: connection.currentModel ?? '',
                    modelRefresh,
                    availableModels,
                    modelPickerScope,
                    unavailableModels,
                    mountUnavailableModelTooltip,
                    onSelectMode: handleSelectMode,
                    onSelectModel: handleSelectModel,
                    workflowMode: connection.workflowMode,
                    workflowModeStatus:
                      connection.loadingTranscript ||
                      connection.catchingUp ||
                      connection.status !== 'connected'
                        ? 'syncing'
                        : (connection.workflowModeStatus ?? 'unknown'),
                    workflowModePending: connection.workflowModePending,
                    onWorkflowModeChange: handleWorkflowModeChange,
                    reasoning: connection.reasoning,
                    onSelectReasoningEffort: handleSelectReasoningEffort,
                    disabled: approvalActive,
                    voiceTarget: hidden ? undefined : voiceTarget,
                    voiceStatusRevision,
                    followupState,
                    onAcceptFollowup,
                    onDismissFollowup,
                    onImageIngestionNotice,
                    onImagePreview: handleImagePreview,
                    onAttachmentPreview: handleAttachmentPreview,
                    placeholderText: t('splitView.composerPlaceholder'),
                  }}
                  composerFooter={
                    CustomComposerFooter ? (
                      <CustomComposerFooter
                        disabled={approvalActive}
                        isRunning={isResponding || sessionHasActivePrompt}
                        currentMode={connection.currentMode ?? 'default'}
                        currentModel={connection.currentModel ?? ''}
                        sessionName={connection.displayName}
                      />
                    ) : undefined
                  }
                />
              </WorkflowDetailsProvider>
            </McpAppReadOnlyContext.Provider>
          </McpAppVisibilityContext.Provider>
        </SubagentDetailsProvider>
      </OptionalMonitorDetailsProvider>
    </section>
  );
}
