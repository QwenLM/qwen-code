import './styles/globals.css';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DAEMON_APPROVAL_MODES,
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useSettings,
  useProviders,
  useSessionNotices,
  useDaemonSessionOwnerGuard,
  useStreamingState,
  useTranscriptHistory,
  useTranscriptStore,
  useWorkspace,
  useWorkspaceActions,
  useWorkspaceEventSignals,
  type DaemonSessionActions,
  type DaemonSessionNotice,
  type DaemonSessionOwnerSnapshot,
  type DaemonReasoningControls,
  type DaemonProductSessionContext,
  type DaemonStreamingState,
} from '@qwen-code/web-shell/daemon-react-sdk';
import {
  DaemonHttpError,
  isDaemonTurnError,
  isStandaloneSessionNotFoundError,
  isStaleBranchPointError,
  STANDALONE_SESSIONS_CAPABILITY,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonInputAnnotation,
  DaemonSessionAgentTaskStatus,
  DaemonSkillToggleMutation,
  DaemonTranscriptBlockChangeSummary,
  DaemonTranscriptBlock,
  DaemonSessionMonitorTaskStatus,
  DaemonSessionShellTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionArtifact,
  DaemonSessionSummary,
  DaemonStandaloneCreationRecovery,
  DaemonStandaloneSessionLookup,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
  GoalSnapshotV2,
  ReasoningSelection,
} from '@qwen-code/sdk/daemon';

import { isGoalGateBlocked as isGoalGateBlockedFor } from './utils/goalGate';
import { keepWorkspaceSplitSessionIds } from './utils/standalone-session-routing';
import { type SessionGitIntent } from './components/GitModePopover';
import { gitModeIntentMustReset } from './utils/gitModeIntent';
import { LocalControlQrButton } from './components/LocalControlQrButton';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_MONITOR_TOOL_CORRELATION_FEATURE,
  SESSION_SIDE_TASK_FEATURE,
  SESSION_TRANSCRIPT_PAGINATION_FEATURE,
  WEB_SHELL_SESSION_SOURCE_TYPE,
  WEB_SHELL_SIDE_TASK_SOURCE_TYPE,
} from './constants/sessions';
import { extractPendingPermission } from './adapters/transcriptAdapter';
import { isRetryableTurnErrorKind } from './adapters/transcriptToMessages';
import { MessageList, type MessageListHandle } from './components/MessageList';
import { SubagentDetailsProvider } from './subagentDetailsContext';
import { MonitorDetailsProvider } from './monitorDetailsContext';
import { WorkflowDetailsProvider } from './workflowDetailsContext';
import { findMonitorTaskForTool } from './utils/monitorTasks';
import { isComposerTask } from './utils/composerTasks';
import {
  getTaskActivityKey,
  hasActiveTaskActivity,
} from './utils/taskActivity';
import { extractVoiceModels, type VoiceModelOption } from './voice/voiceModels';
import {
  loadVoiceProviders,
  resolveVoiceWorkspaceTarget,
  setVoiceModelSetting,
  supportsVoiceModelSettings,
  type VoiceStatusRevision,
} from './voice/voice-workspace-target';
import { useVoiceWorkspaceSettings } from './voice/use-voice-workspace-settings';
import {
  useSessionCatalogController,
  useSessionHasActivePrompt,
} from './session-catalog/session-catalog-hooks';
import {
  loadSessionCatalogOnce,
  SESSION_CATALOG_TRAILING_REFRESH_MS,
} from './session-catalog/session-catalog-store';
import { useLiveVoiceSetup } from './live/useLiveVoiceSetup';
import {
  ChatEditor,
  type ComposerToolbarAction,
} from './components/ChatEditor';
import type {
  ComposerSubmitCommit,
  EditorHandle,
} from './hooks/useComposerCore';
import type { PromptFile, PromptImage } from './adapters/promptTypes';
import type { AttachmentPreviewRequest } from './adapters/messageTypes';
import { StatusBar, type StatusBarHandle } from './components/StatusBar';
import { GoalStatusStrip } from './components/GoalStatusStrip';
import composerStatusStyles from './components/ComposerStatusStack.module.css';
import { GoalEditDialog } from './components/dialogs/GoalEditDialog';
import { StreamingStatus } from './components/StreamingStatus';
import {
  ToastHost,
  TOAST_REQUEST_EVENT,
  type ToastRequestDetail,
  type ToastTone,
  type WebShellToast,
} from './components/ToastHost';
import { TodoPanel } from './components/panels/TodoPanel';
import {
  EnvironmentPanel,
  type EnvironmentAgentTask,
} from './components/panels/EnvironmentPanel';
import { ChatContextHeader } from './components/ChatContextHeader';
import { WelcomeHeader } from './components/WelcomeHeader';
import { ApprovalModeDialog } from './components/dialogs/ApprovalModeDialog';
import { ResumeDialog } from './components/dialogs/ResumeDialog';
import { DialogShell } from './components/dialogs/DialogShell';
import {
  ModelDialog,
  type ModelDialogModel,
  type ModelDialogMode,
} from './components/dialogs/ModelDialog';
import { ModelFallbacksDialog } from './components/dialogs/ModelFallbacksDialog';
import { AgentsManagerPage } from './components/agents/AgentsManagerPage';
import { MemoryMessage } from './components/messages/MemoryMessage';
import { AuthMessage } from './components/messages/AuthMessage';
import { ToolsDialog } from './components/dialogs/ToolsDialog';
import { GitDialog, type GitDialogView } from './components/dialogs/GitDialog';
import { SkillsManagerPage } from './components/skills/SkillsManagerPage';
import { DaemonStatusDialog } from './components/dialogs/DaemonStatusDialog';
import { SessionOverviewPanel } from './components/SessionOverviewPanel';
import { WorkspacesOverviewPanel } from './components/workspaces/WorkspacesOverviewPanel';
import { SplitView } from './components/SplitView';
import { GaugeIcon } from 'lucide-react';
import type { PaneHeaderActionsRenderer } from './components/ChatPane';
import {
  ArtifactPanel,
  type ArtifactPanelTab,
  type SideTaskListItem,
} from './components/artifacts/ArtifactPanel';
import { releaseWebTerminal } from './components/terminal/TerminalPanel';
import { Drawer, DrawerContent, DrawerTitle } from './components/ui/drawer';
import type {
  TurnOutputFileChange,
  TurnOutputKind,
  TurnOutputOpenRequest,
  TurnOutputScheduledTask,
} from './components/artifacts/TurnOutputs';
import {
  displayPath,
  getFileChangePreviewContent,
  TURN_OUTPUT_KINDS,
} from './components/artifacts/TurnOutputs';
import {
  resolveArtifactWorkspaceOwner,
  useArtifactWorkspaceTarget,
} from './components/artifacts/useArtifactWorkspaceTarget';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
  getScheduledTasksByTurn,
} from './components/artifacts/turnOutputSelectors';
import { useIsLargeScreen } from './hooks/useIsLargeScreen';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import {
  clearSplitSessions,
  loadSplitSessions,
  MAX_SPLIT_PANES,
  parseSplitSessionIds,
  saveSplitSessions,
} from './utils/splitUrl';
import { ScheduledTasksDialog } from './components/dialogs/ScheduledTasksDialog';
import { GoalsDialog } from './components/dialogs/GoalsDialog';
import { WorkflowRunsPage } from './components/workflows/WorkflowRunsPage';
import { parseWebShellGoalCommand } from './utils/goalCondition';
import { buildGoalControlRequest } from './utils/goalControlRequest';
import { ExtensionsManagerPage } from './components/extensions/ExtensionsManagerPage';
import { PluginManagerPage } from './components/plugins/PluginManagerPage';
import { ChannelsManagerPage } from './components/channels/ChannelsManagerPage';
import { ShadowDomBoundary } from './components/ShadowDomBoundary';
import { McpAppHostContext } from './mcpAppHostContext';
import { SettingsMessage } from './components/messages/SettingsMessage';
import { isAskUserPermission } from './utils/askUserPermission';
import { ToolApproval } from './components/messages/ToolApproval';
import { AskUserQuestion } from './components/messages/AskUserQuestion';
import { HelpDialog } from './components/dialogs/HelpDialog';
import { ThemeDialog } from './components/dialogs/ThemeDialog';
import { DeleteSessionDialog } from './components/dialogs/DeleteSessionDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { RewindDialog } from './components/dialogs/RewindDialog';
import { AddWorkspaceDialog } from './components/dialogs/AddWorkspaceDialog';
import { Button } from './components/ui/button';
import {
  isPluginShadowPanel,
  installWebShellShadowStyles,
  resolveWebShellShadowDom,
  type WebShellShadowDom,
} from './shadowDom';
import {
  WebShellSidebar,
  type WebShellSidebarBranding,
  type WebShellSidebarFooterOptions,
  type WebShellSidebarWorkspaceOverviewOptions,
  type WebShellSidebarLockedWorkspace,
  type WebShellSidebarPrimaryNavOptions,
  type WebShellSidebarSessionActionsOptions,
} from './components/sidebar/WebShellSidebar';
import { isSidebarToggleShortcut } from './components/sidebar/sidebarToggleShortcut';
import { workspaceLabel } from './utils/workspace';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameTranscriptSnapshot } from './hooks/useAnimationFrameTranscriptBlocks';
import { useBackgroundTasks } from './hooks/useBackgroundTasks';
import { isSessionDisconnectedError } from './utils/sessionErrors';
import {
  projectStreamingTailMessages,
  useMessagesFromBlocks,
} from './hooks/useMessages';
import { useSessionArtifacts } from './hooks/useSessionArtifacts';
import { useShallowMemo, useStableArray } from './hooks/useShallowMemo';
import {
  I18nProvider,
  getTranslator,
  languageSettingToWebShellLanguage,
  languageLabel,
  normalizeLanguage,
  type WebShellLanguage,
} from './i18n';
import {
  copyFromLastAssistantMessage,
  COPY_MESSAGES,
} from './utils/copyCommand';
import { getShadowAwareActiveElement, isEditableTarget } from './utils/dom';
import {
  invokeSlashCommandHandler,
  SLASH_COMMAND_PATTERN,
} from './utils/slash-command-action';
import { getModelDisplayName } from './utils/modelDisplay';
import { isVisibleComposerModel } from './utils/composerModels';
import { filterModelSwitchMessages } from './utils/modelSwitchMessages';
import { decideEscapeIntent } from './utils/escapeIntent';
import type { SkillInfo } from './completions/slashCompletion';
import { collectSystemInfo } from './utils/systemInfo';
import {
  decodeVisionModelForPicker,
  encodeVisionModelForSetting,
  extractBareModelId,
} from './utils/modelEncoding';
import { appendOrDeferLocalUserMessage } from './utils/localCommandQueue';
import { QueuedPromptDisplay } from './components/QueuedPromptDisplay';
import { useQueuedPrompts } from './hooks/useQueuedPrompts';
import { useNewSessionSuggestion } from './hooks/useNewSessionSuggestion';
import {
  TasksStatusMessage,
  type SerializedTasksMessage,
} from './components/messages/TasksStatusMessage';
import { SessionWorkflowCockpit } from './components/workflow/SessionWorkflowCockpit';
import { serializeContextUsageMessage } from './components/messages/ContextUsageMessage';
import {
  serializeStatsMessage,
  type StatsView,
} from './components/messages/StatsMessage';
import {
  serializeStatusMessage,
  type StatusInfo,
} from './components/messages/StatusMessage';
import type { SerializedMcpStatusMessage } from './components/messages/McpStatusMessage';
import { McpManagerPage } from './components/mcp/McpManagerPage';
import { BtwMessage } from './components/messages/BtwMessage';
import {
  createAndAttachSessionForPrompt,
  isDaemonApprovalMode,
} from './utils/sessionPreparation';
import {
  getComposerPlaceholderKey,
  getComposerPlaceholderState,
  shouldBlockComposerSubmit,
  shouldDisableComposerInput,
  type ComposerPlaceholderState,
} from './utils/composerInputState';
import { isDefinitelyRejectedPromptAdmission } from './utils/promptAdmission';
import { base64ToBlob } from './utils/base64';
import type {
  ACPToolCall,
  CommandInfo,
  Message,
  PermissionRequest,
} from './adapters/types';
import { isBackgroundSubAgentToolCall } from './adapters/toolClassification';
import {
  computeTodoDetails,
  computeTodoTimeline,
  getAgentToolsForPlan,
  getFloatingTodos,
  getSessionWorkflowTodos,
  getActiveTodosForPlanRevision,
  isExitPlanApprovalRequest,
  todoDetailSignature,
  todoTimelineSignature,
  type FloatingTodosState,
  type TodoDetail,
  type TodoSnapshotDiff,
} from './utils/todos';
import { ThemeProvider } from './themeContext';
import { InteractionBlockContext } from './interactionBlockContext';
import {
  WebShellThemeId,
  THEME_SETTING_KEY,
  LANGUAGE_SETTING_KEY,
  themeSettingToWebShellTheme,
  webShellThemeToSettingValue,
  type WebShellTheme,
} from './themeContext';
import {
  WebShellCustomizationProvider,
  type WebShellComposerApi,
  type WebShellComposerInput,
  type WebShellMarkdownCustomization,
  type ToolHeaderExtraRenderer,
  type UserMessageContentRenderer,
  type UserMessageContentParser,
  type AssistantTurnFooterRenderer,
  type WelcomeHeaderRenderer,
  type WelcomeFooterRenderer,
  type ComposerToolbarStartRenderer,
  type ComposerToolbarEndRenderer,
  type ComposerToolbarRightRenderer,
  type ComposerHeaderRenderer,
  type ComposerFooterRenderer,
  type ChatHeaderRenderer,
  type WebShellChatHeaderItem,
  type WebShellChatHeaderOptions,
  type WebShellRightPanelItem,
  type WebShellRightPanelOptions,
  type WebShellEnvironmentPanelItem,
  type WebShellEnvironmentPanelOptions,
  type FooterRenderer,
  type LoadingPhrasesResolver,
  type MarkdownTableMode,
  type WebShellTaskInfo,
  type WebShellAtProvider,
  type WebShellBuiltinAtProvidersConfig,
  type ComposerTagClickHandler,
  type ComposerTagRenderer,
  type WebShellComposerTagIconMap,
  type WebShellBottomStatusItem,
  type WebShellPreparedSubmit,
  type WebShellSubmitSnapshot,
} from './customization';
import type { CommandDisplayCategoryOrder } from './utils/commandDisplay';
import { WebShellPortalRootContext } from './portalRoot';
import { CompactModeContext, TodoContextsProvider } from './WebShellContexts';
import styles from './App.module.css';

const MODES_CYCLE = DAEMON_APPROVAL_MODES;
const MAX_TOASTS = 4;
const TOAST_AUTO_DISMISS_MS = 5000;
const DEFAULT_REVIEW_PANEL_WIDTH = 500;
const MIN_ARTIFACT_PANEL_WIDTH = 320;
const MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL = 500;
const SUBAGENT_PANEL_ANIMATION_FALLBACK_MS = 700;
const MIN_DOCKED_MESSAGE_AREA_WIDTH = 800;
const DOCKED_ENVIRONMENT_PANEL_WIDTH = 332;

function isWebTerminalTarget(event: Event): boolean {
  const target = event.composedPath()[0] ?? event.target;
  return (
    target instanceof Element && target.closest('[data-web-terminal]') !== null
  );
}

// The docked fullscreen surface contains Tab itself instead of going through
// Radix FocusScope: FocusScope registers every mounted scope in a
// module-global stack and pauses the current head even with trapped={false},
// so a docked panel mounting under an open DialogShell would pause the
// modal's trap. The surface covers the viewport, so the keyboard is the only
// escape route; wrap it at the tabbable edges like FocusScope's loop does.
function getFullscreenSurfaceTabEdges(
  container: HTMLElement,
): [HTMLElement | null, HTMLElement | null] {
  const candidates: HTMLElement[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as HTMLElement;
      if (element.hidden) return NodeFilter.FILTER_SKIP;
      if (element instanceof HTMLInputElement && element.type === 'hidden') {
        return NodeFilter.FILTER_SKIP;
      }
      if (
        (element instanceof HTMLButtonElement ||
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement) &&
        element.disabled
      ) {
        return NodeFilter.FILTER_SKIP;
      }
      return element.tabIndex >= 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) {
    candidates.push(walker.currentNode as HTMLElement);
  }
  const visible = candidates.filter((element) =>
    typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ checkVisibilityCSS: true })
      : true,
  );
  return [visible[0] ?? null, visible[visible.length - 1] ?? null];
}
const DEFAULT_COMPOSER_TOOLBAR_ACTIONS = [
  'approvalMode',
  'contextUsage',
  'model',
  'widthMode',
  'voice',
  'workspace',
] as const satisfies readonly ComposerToolbarAction[];
const DEFAULT_EMPTY_COMPOSER_TOOLBAR_ACTIONS = [
  ...DEFAULT_COMPOSER_TOOLBAR_ACTIONS,
  'gitBranch',
] as const satisfies readonly ComposerToolbarAction[];
const MAX_ARTIFACT_PANEL_SESSION_STATES = 20;
interface ArtifactPanelSessionState {
  open: boolean;
  tabs: ArtifactPanelTab[];
  activeTabId: string | null;
  reviewChanges: readonly TurnOutputFileChange[];
  selectedReviewPath: string | null;
  extraArtifacts: DaemonSessionArtifact[];
  width: number;
}
interface PaneArtifactSnapshot {
  artifacts: readonly DaemonSessionArtifact[];
}
const BOUND_RUN_SWITCH_TIMEOUT_MS = 30_000;

function availableSkillInfos(status: {
  skills?: Array<{
    status?: string;
    name: string;
    description?: string;
    argumentHint?: string;
  }>;
}): SkillInfo[] {
  return (status.skills ?? [])
    .filter((skill) => skill.status === 'ok')
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function availableSessionSkillInfos(
  skills: readonly string[],
  commands: readonly {
    name: string;
    description: string;
    argumentHint?: string;
  }[],
): SkillInfo[] {
  const commandsByName = new Map(
    commands.map((command) => [command.name.toLowerCase(), command]),
  );
  return skills
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
}

function sessionSkillsReflectToggle(
  sessionSkills: readonly string[] | undefined,
  mutationSkills: ReadonlyArray<{ name: string; enabled: boolean }>,
): boolean {
  if (sessionSkills === undefined) {
    return false;
  }
  const enabledNames = new Set(sessionSkills.map((name) => name.toLowerCase()));
  return mutationSkills.every((skill) => {
    const enabled = enabledNames.has(skill.name.toLowerCase());
    return skill.enabled === enabled;
  });
}

function skillMutationsForWorkspace(
  lastSkillMutation: DaemonSkillToggleMutation | undefined,
  skillMutationsByCwd: Record<string, DaemonSkillToggleMutation[]> | undefined,
  workspaceCwd?: string,
): readonly DaemonSkillToggleMutation[] {
  if (skillMutationsByCwd) {
    return workspaceCwd ? (skillMutationsByCwd[workspaceCwd] ?? []) : [];
  }
  return lastSkillMutation ? [lastSkillMutation] : [];
}

function mergeSkillToggles(
  current: ReadonlyArray<{ name: string; enabled: boolean }>,
  incoming: ReadonlyArray<{ name: string; enabled: boolean }>,
): Array<{ name: string; enabled: boolean }> {
  const byName = new Map(
    current.map((skill) => [skill.name.toLowerCase(), skill] as const),
  );
  for (const skill of incoming) {
    byName.set(skill.name.toLowerCase(), skill);
  }
  return [...byName.values()];
}

const HIDE_TIPS_SETTING_KEY = 'ui.hideTips';

/** Maps each ModelDialogMode to its i18n title key — single source of truth. */
const MODE_TITLE_KEY: Record<ModelDialogMode, string> = {
  main: 'model.select',
  fast: 'model.setFast',
  voice: 'model.setVoice',
  vision: 'model.setVision',
};

function normalizeHiddenCommand(command: string): string {
  return command.trim().replace(/^\/+/, '').toLowerCase();
}

function resolvePreparedSubmit(
  prompt: string,
  inputAnnotations: readonly DaemonInputAnnotation[],
  prepared: void | WebShellPreparedSubmit,
): WebShellPreparedSubmit {
  if (!prepared || typeof prepared.prompt !== 'string') {
    return { prompt, inputAnnotations };
  }
  return {
    prompt: prepared.prompt,
    inputAnnotations: prepared.inputAnnotations ?? inputAnnotations,
  };
}

interface SendPromptOptionsWithRetry {
  optimisticUserMessage?: boolean;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  retry?: boolean;
  onAdmissionStarted?: () => void;
  clearComposerOnPromptStart?: boolean;
  commitComposerAccepted?: ComposerSubmitCommit;
  onAdmitted?: () => void;
}

interface OptimisticUserMessage {
  sessionId: string;
  messageId: string;
  identity: TranscriptUserMessageIdentity;
  previousIdentity?: TranscriptUserMessageIdentity;
  owner: CancelledRetryOwner;
}

interface FailedPrompt {
  sessionId: string;
  messageId: string;
  identity: TranscriptUserMessageIdentity;
  previousIdentity?: TranscriptUserMessageIdentity;
  text: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  owner: CancelledRetryOwner;
}

interface TranscriptUserMessageIdentity {
  block: DaemonTranscriptBlock;
}

interface TranscriptTurnErrorIdentity {
  block: DaemonTranscriptBlock;
}

interface FailedPromptRetry {
  sessionId: string;
  messageId: string;
  startedAt: number;
  admitted: boolean;
  settled: boolean;
  owner: CancelledRetryOwner;
  transcriptIdentity:
    | { kind: 'failed-prompt'; identity: TranscriptUserMessageIdentity }
    | { kind: 'turn-error'; identity: TranscriptTurnErrorIdentity };
}

type CancelledRetryState =
  | {
      kind: 'failed-prompt';
      attemptId: number;
      failed: FailedPrompt;
    }
  | {
      kind: 'turn-error';
      attemptId: number;
      errorId: string;
      identity: TranscriptTurnErrorIdentity;
      text: string;
      images?: PromptImage[];
      files?: PromptFile[];
      inputAnnotations?: DaemonInputAnnotation[];
      previousRetriedTurnErrorId: string | null;
      previousShowRetryHint: boolean;
    };

type CancelledRetryRestoreResult = 'restored' | 'pending' | 'invalid';

interface CancelledRetryOwner {
  sessionId?: string;
  workspaceCwd?: string;
  sessionKey?: string;
  sourceVersion: number;
  snapshot: DaemonSessionOwnerSnapshot;
}

function retryOwnerMatchesCurrent(
  owner: CancelledRetryOwner,
  sessionId: string | undefined,
  workspaceCwd: string | undefined,
  sourceVersion: number,
): boolean {
  const workspaceMatches =
    (owner.workspaceCwd !== undefined && owner.workspaceCwd === workspaceCwd) ||
    owner.snapshot.isCurrent();
  return (
    owner.sessionId === sessionId &&
    owner.sourceVersion === sourceVersion &&
    workspaceMatches
  );
}

interface CancelledRetryEntry {
  owner?: CancelledRetryOwner;
  state: CancelledRetryState;
}

function mergeCancelledRetryEntries(
  current: readonly CancelledRetryEntry[],
  incoming: readonly CancelledRetryEntry[],
): CancelledRetryEntry[] {
  return incoming.reduce<CancelledRetryEntry[]>(
    (merged, candidate) => {
      const existing = merged.find(
        (entry) => entry.state.kind === candidate.state.kind,
      );
      if (existing && existing.state.attemptId >= candidate.state.attemptId) {
        return merged;
      }
      return [
        ...merged.filter((entry) => entry.state.kind !== candidate.state.kind),
        candidate,
      ];
    },
    [...current],
  );
}

interface UnknownPromptAdmission {
  sessionId: string;
  messageId?: string;
  text?: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  payloadAvailable: boolean;
}

function getLatestUserBlockId(
  blocks: readonly DaemonTranscriptBlock[],
): string | undefined {
  return getLatestUserBlock(blocks)?.id;
}

function getLatestUserBlock(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block?.kind === 'user' &&
      block.meta?.['source'] !== 'background_notification'
    ) {
      return block;
    }
  }
  return undefined;
}

function matchesUserMessageIdentity(
  block: DaemonTranscriptBlock | undefined,
  identity: TranscriptUserMessageIdentity | undefined,
  allowLocalId = false,
): boolean {
  if (!identity) return block === undefined;
  if (!block || block.kind !== 'user' || identity.block.kind !== 'user') {
    return false;
  }
  if (block === identity.block) return true;
  if (allowLocalId && block.id === identity.block.id) return true;
  const expectedRecords = identity.block.sourceRecordIds;
  const currentRecords = block.sourceRecordIds;
  return (
    expectedRecords !== undefined &&
    expectedRecords.length > 0 &&
    currentRecords !== undefined &&
    currentRecords.length === expectedRecords.length &&
    currentRecords.every((record, index) => record === expectedRecords[index])
  );
}

function findUserMessageByIdentity(
  blocks: readonly DaemonTranscriptBlock[],
  identity: TranscriptUserMessageIdentity,
  allowLocalId = false,
): DaemonTranscriptBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (
      block?.kind === 'user' &&
      block.meta?.['source'] !== 'background_notification' &&
      matchesUserMessageIdentity(block, identity, allowLocalId)
    ) {
      return block;
    }
  }
  return undefined;
}

function getLogicalSessionKey(
  sessionId: string | undefined,
  workspaceCwd: string | undefined,
): string | undefined {
  return sessionId ? `${workspaceCwd ?? ''}\0${sessionId}` : undefined;
}

function getRetryableTurnError(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTranscriptBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === 'user') {
      if (block.meta?.['source'] === 'background_notification') continue;
      break;
    }
    if (block?.kind === 'error' && block.source === 'turn_error') {
      return block;
    }
    if (block?.kind !== 'debug') break;
  }
  return undefined;
}

function matchesTurnErrorIdentity(
  block: DaemonTranscriptBlock | undefined,
  identity: TranscriptTurnErrorIdentity,
): boolean {
  if (
    !block ||
    block.kind !== 'error' ||
    block.source !== 'turn_error' ||
    identity.block.kind !== 'error' ||
    identity.block.source !== 'turn_error'
  ) {
    return false;
  }
  if (block === identity.block) return true;
  const expectedPromptId = identity.block.promptId;
  if (expectedPromptId) return block.promptId === expectedPromptId;
  return (
    identity.block.eventId !== undefined &&
    block.eventId === identity.block.eventId
  );
}

function retryTranscriptIdentityMatches(
  blocks: readonly DaemonTranscriptBlock[],
  transcriptIdentity: FailedPromptRetry['transcriptIdentity'],
  allowLocalUserId = false,
): boolean {
  return transcriptIdentity.kind === 'failed-prompt'
    ? matchesUserMessageIdentity(
        getLatestUserBlock(blocks),
        transcriptIdentity.identity,
        allowLocalUserId,
      )
    : matchesTurnErrorIdentity(
        getRetryableTurnError(blocks),
        transcriptIdentity.identity,
      );
}

interface LocalAnchoredMessage {
  anchorAfterId?: string;
  anchorIndex: number;
  message: Message;
}

function buildDisplayMessages(
  messages: Message[],
  recapMessage: LocalAnchoredMessage | null,
): Message[] {
  if (!recapMessage) return filterModelSwitchMessages(messages);
  const result = [...messages];
  const anchorIndex = recapMessage.anchorAfterId
    ? result.findIndex((message) => message.id === recapMessage.anchorAfterId)
    : -1;
  result.splice(
    anchorIndex >= 0
      ? anchorIndex + 1
      : Math.min(recapMessage.anchorIndex, result.length),
    0,
    recapMessage.message,
  );
  return filterModelSwitchMessages(result);
}

type LiveMessageListProps = Omit<
  ComponentPropsWithoutRef<typeof MessageList>,
  'messages' | 'transcriptBlockCount'
> & {
  baselineBlocks: readonly DaemonTranscriptBlock[];
  baselineSummary?: DaemonTranscriptBlockChangeSummary;
  baselineMessages: Message[];
  recapMessage: LocalAnchoredMessage | null;
  messagesRef: { current: Message[] };
  onTranscriptChange?: (blocks: readonly DaemonTranscriptBlock[]) => void;
  t: ReturnType<typeof getTranslator>;
};

const LiveMessageList = memo(
  forwardRef<MessageListHandle, LiveMessageListProps>(function LiveMessageList(
    {
      baselineBlocks,
      baselineSummary,
      baselineMessages,
      recapMessage,
      messagesRef,
      onTranscriptChange,
      t,
      ...props
    },
    ref,
  ) {
    const live = useAnimationFrameTranscriptSnapshot();
    const messages = useMemo(
      () =>
        projectStreamingTailMessages(
          {
            blocks: baselineBlocks,
            messages: baselineMessages,
            t,
            blockChangeSummary: baselineSummary,
          },
          live.blocks,
          t,
          live.blockChangeSummary,
        ) ?? baselineMessages,
      [
        baselineBlocks,
        baselineMessages,
        baselineSummary,
        live.blockChangeSummary,
        live.blocks,
        t,
      ],
    );
    const displayMessages = useMemo(
      () => buildDisplayMessages(messages, recapMessage),
      [messages, recapMessage],
    );
    useLayoutEffect(() => {
      messagesRef.current = messages;
    }, [messages, messagesRef]);
    useEffect(() => {
      onTranscriptChange?.(live.blocks);
    }, [live.blocks, onTranscriptChange]);

    return (
      <MessageList
        {...props}
        ref={ref}
        messages={displayMessages}
        transcriptBlockCount={live.blocks.length}
      />
    );
  }),
);

interface ModelSwitchSummary {
  authType: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isRuntime?: boolean;
}

export interface BugReportInfo {
  title: string;
  systemInfo: Record<string, string>;
}

export interface WebShellSidebarOptions {
  enabled?: boolean;
  defaultCollapsed?: boolean;
  /** Whether to show WebShell's built-in compact drawer toggle. Defaults to true. */
  showCompactToggle?: boolean;
  /** Whether to show the Tasks/Channels session-source switch. Defaults to true. */
  showSessionSourceSwitch?: boolean;
  /** Hide or replace the complete sidebar branding row. */
  branding?: false | WebShellSidebarBranding;
  /** Customize the primary navigation area (new task button, custom entries). */
  primaryNav?: WebShellSidebarPrimaryNavOptions;
  /** Whether to hide the "Projects" header row (with search and add workspace). Defaults to false (shown). */
  hideProjectHeader?: boolean;
  /** Customize which action buttons appear on session rows. */
  sessionActions?: WebShellSidebarSessionActionsOptions;
  /** Hide the footer completely or select the built-in entries it exposes. */
  footer?: false | WebShellSidebarFooterOptions;
  /** Customize the workspace row shown when lockWorkspaceCwd is active. */
  lockedWorkspace?: WebShellSidebarLockedWorkspace;
  /**
   * Session counts, full path and facet chips (MCP, skills, …) on workspace
   * rows. Pass `false` to keep plain folder headers.
   */
  workspaceOverview?: false | WebShellSidebarWorkspaceOverviewOptions;
}

export type SessionChangeEvent =
  | { type: 'rename'; sessionId: string; newName: string }
  | { type: 'submit'; sessionId: string; prompt: string; queued: boolean }
  | { type: 'turn_complete'; sessionId: string; error?: Error };

export interface WebShellApi {
  /** Open the in-window split view, matching the built-in sidebar button. */
  openSplitView: () => void;
  /** Open the Session Overview panel, matching the built-in sidebar button. */
  openSessionOverview: () => void;
  /** Open the compact session drawer, matching the hamburger control. */
  openSessionDrawer: () => void;
  /** Start a new session using the same lifecycle as the built-in New Chat action. */
  createNewSession: () => Promise<boolean>;
  /** Open the right panel with a new side-task draft. */
  createSideTask: () => boolean;
  /** Resolve the visible approval, optionally binding it to an exact request. */
  respondToPendingPermission?: {
    (decision: 'allow' | 'reject'): Promise<boolean>;
    (requestId: string, decision: 'allow' | 'reject'): Promise<boolean>;
  };
}

export type WebShellComposerPlaceholderState = ComposerPlaceholderState;

export type WebShellComposerPlaceholders = Readonly<
  Partial<Record<WebShellComposerPlaceholderState, string>>
>;

export interface WebShellSlashCommand {
  /** Slash command name without the leading slash, normalized to lower case. */
  command: string;
  /** Trimmed text following the command name. */
  args: string;
  /** Original text submitted from the composer. */
  input: string;
}

export type WebShellSlashCommandHandler = (
  command: WebShellSlashCommand,
) => boolean | void;

export interface WebShellProps {
  /** Host-specific label for the Ask User Question free-text choice. */
  askUserFreeTextLabel?: string;
  /** Called whenever the attached daemon session or workspace changes. */
  onSessionIdChange?: (
    sessionId: string | undefined,
    workspaceId?: string,
    workspaceCwd?: string,
    sessionContext?: DaemonProductSessionContext,
  ) => void;
  /** Called when the active session id or display name changes. */
  onSessionInfoChange?: (session: {
    sessionId?: string;
    sessionName?: string;
  }) => void;
  /** Called after a new session is created. Session setup waits up to 30 seconds. */
  onSessionCreated?: (sessionId: string) => Promise<void> | void;
  /** Visual theme for the embedded shell. */
  theme?: WebShellTheme;
  /** Called when `/theme` changes the web-shell theme. */
  onThemeChange?: (theme: WebShellTheme) => void;
  /** UI language for the web-shell. Defaults to `?language=` or browser language. */
  language?: 'en' | 'zh-CN' | 'zh' | 'zh-cn';
  /** Called when `/language ui` changes the web-shell UI language. */
  onLanguageChange?: (language: WebShellLanguage) => void;
  /** Additional CSS class name appended to the root element. */
  className?: string;
  /** Inline styles applied to the root element. */
  style?: React.CSSProperties;
  /** Optional Shadow DOM isolation for plugin content and/or all portals. */
  shadowDom?: WebShellShadowDom;
  /** Maximum chat content width in regular mode. Defaults to 1000px. */
  chatMaxWidth?: number;
  /** Optional workspace sidebar. Disabled by default. */
  sidebar?: boolean | WebShellSidebarOptions;
  /** Persistent chat header options. */
  header?: WebShellChatHeaderOptions;
  /** Right extension panel options. */
  rightPanel?: WebShellRightPanelOptions;
  /** Environment information panel options. */
  environmentPanel?: WebShellEnvironmentPanelOptions;
  /** Session ids to control the split view; an empty array closes it. */
  splitSessionIds?: readonly string[];
  /** Called when the split pane list changes from inside WebShell. */
  onSplitSessionIdsChange?: (sessionIds: string[]) => void;
  /**
   * Extra actions rendered in each split-pane header, before the built-in
   * close button. Receives the pane's session id (and workspace when known).
   * When the actions no longer fit they collapse into a `…` overflow menu.
   */
  renderPaneHeaderActions?: PaneHeaderActionsRenderer;
  /**
   * Called instead of the built-in right panel open behavior when a user clicks
   * a turn output such as review changes, an artifact, or a scheduled task.
   */
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  /** Override file-review links without replacing the other right panels. */
  onFileReviewOpen?: (
    request: Extract<TurnOutputOpenRequest, { kind: 'review' }>,
  ) => void;
  /** Open a workspace file in the embedding host instead of WebShell preview. */
  onWorkspaceFileOpen?: (path: string) => void;
  /** Open a completed Insight report in a host-native surface. */
  onInsightReportOpen?: (path: string) => void;
  /**
   * Controls which turn output cards appear below messages. Defaults to all.
   */
  messageTurnOutputs?: readonly TurnOutputKind[];
  /** Imperative handle for externally opening WebShell surfaces. */
  shellRef?: React.Ref<WebShellApi>;
  /** Built-in composer toolbar actions to show. Defaults to all actions. */
  composerToolbarActions?: readonly ComposerToolbarAction[];
  /** Optionally filter main-model entries without changing shared defaults. */
  mainModelFilter?: (model: ModelDialogModel) => boolean;
  /** Stack completion details vertically for narrow embedded hosts. */
  compactComposerOverlays?: boolean;
  /** Submit slash items marked as immediate actions when selected. */
  autoSubmitSlashCommands?: boolean;
  /** Host-only slash entries or presentation overrides. */
  additionalSlashCommands?: readonly CommandInfo[];
  /** Keep Context Usage available while restored-session usage is loading. */
  contextUsageAlwaysVisible?: boolean;
  /** Let the host expose the last user turn's edit-and-resend action. */
  userMessageEditing?: boolean;
  /**
   * Called before WebShell starts its built-in user-message edit flow. Return
   * true when the host owns the edit-and-resend lifecycle.
   */
  onUserMessageEditRequest?: (
    turnIndex: number,
    content: string,
  ) => boolean | void;
  /** Cycle the approval mode when an otherwise-unhandled Tab is pressed. */
  cycleModeOnTab?: boolean;
  /**
   * Creator attribution recorded on sessions this shell creates, and the
   * source filter embedded hosts use to list only their own sessions. Defaults
   * to the browser Web Shell's `'default'`; the VS Code companion overrides it
   * so its sessions stay distinguishable from CLI and browser ones.
   */
  sessionSourceType?: string;
  /** Built-in actions appended to the context-sensitive default toolbar. */
  composerToolbarAdditionalActions?: readonly ComposerToolbarAction[];
  /**
   * Main-composer copy by semantic state. Omitted or blank entries retain the
   * WebShell localized default; shell-mode and follow-up copy still wins.
   */
  composerPlaceholders?: WebShellComposerPlaceholders;
  /** Called when connection status changes (idle/connecting/connected/disconnected/error). */
  onConnectionChange?: (status: string) => void;
  /** Called when prompt status changes (idle/waiting/responding). */
  onStreamingStateChange?: (state: DaemonStreamingState) => void;
  /**
   * Called with the initial merged agent task snapshot and when its roster,
   * status, or stable metadata changes. Poll-only runtime, stats, and activity
   * updates are suppressed.
   */
  onAgentTasksChange?: (tasks: readonly DaemonSessionAgentTaskStatus[]) => void;
  /**
   * Called whenever transcript blocks change. Receives the full blocks array
   * at most once per animation frame during active generation.
   */
  onTranscriptChange?: (blocks: readonly DaemonTranscriptBlock[]) => void;
  /**
   * Called when a critical error occurs (auth failure, session gone, etc).
   * Each distinct connection error value is reported once; reporting resets
   * when the connection recovers. Replacing the handler while an error
   * persists does not re-deliver that error.
   */
  onError?: (error: Error) => void;
  /** Called when `/bug` is invoked. Receives system info. If omitted, web-shell opens the report URL itself. */
  onBugReport?: (info: BugReportInfo) => void;
  /** Slash command names to hide from completion/help, for example `['approval-mode']`. */
  hiddenSlashCommands?: string[];
  /** Slash command category order. Defaults to custom, skill, system. */
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  /**
   * Called before Web Shell handles a slash command. Return true to skip the
   * built-in or daemon behavior after handling the command in the host.
   */
  onSlashCommand?: WebShellSlashCommandHandler;
  /** Built-in @ mention providers to enable. Defaults to all built-ins. */
  builtinAtProviders?: WebShellBuiltinAtProvidersConfig;
  /**
   * Controls whether the composer's file-upload entry points (drag-and-drop
   * and the @ panel upload item) are enabled. Works alongside the daemon's
   * `workspace_file_upload` capability, not instead of it: `false` force-
   * disables upload even when the daemon advertises the capability, while
   * `true`/omitted still requires the capability to be satisfied.
   */
  fileUploadEnabled?: boolean;
  /**
   * Directory that drag-and-dropped files upload into, **relative to the
   * workspace root**. Use a relative path WITHOUT a leading `/` — e.g.
   * `'uploads'`, `'uploads/images'`, or omit it to upload into the
   * workspace root (the default). A leading-slash path like `'/uploads'`
   * is rejected by the daemon as outside the workspace. The directory
   * (including intermediate components) is created automatically on upload
   * when it does not exist.
   */
  fileUploadDirectory?: string;
  /** Additional @ mention categories shown alongside built-in files/extensions. */
  atProviders?: readonly WebShellAtProvider[];
  /** Icon URLs for custom composer tag kinds used by @ mention chips. */
  composerTagIcons?: WebShellComposerTagIconMap;
  /** Custom renderer for the tool-card header content after the status icon and tool name. */
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  /** Custom renderer for the welcome header. Receives version, cwd, model, and mode. */
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  /** Custom renderer shown below the chat composer in the empty welcome state. */
  renderWelcomeFooter?: WelcomeFooterRenderer;
  /**
   * Show renderWelcomeFooter between the welcome header and composer on
   * mobile empty state. Requires renderWelcomeFooter to be provided for the
   * mobile CSS reordering to take effect.
   */
  mobileWelcomeFooterMiddle?: boolean;
  /** Parse user-message text into display parts such as chips. */
  parseUserMessageContent?: UserMessageContentParser;
  /** Custom renderer for the inside of user chat bubbles. Defaults to plain text. */
  renderUserMessageContent?: UserMessageContentRenderer;
  /** Custom renderer for composer and user-message tags. */
  renderComposerTag?: ComposerTagRenderer;
  /** Custom hover content for composer and user-message tags. */
  renderComposerTagTooltip?: ComposerTagRenderer;
  /** Click handler for composer and user-message tags. */
  onComposerTagClick?: ComposerTagClickHandler;
  /** Custom renderer displayed after the final assistant message of each turn. */
  renderAssistantTurnFooter?: AssistantTurnFooterRenderer;
  /** Custom renderer inserted before the built-in chat composer toolbar controls. */
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  /** Custom renderer inserted after the built-in composer toolbar controls. */
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  /** Custom renderer inserted into the composer toolbar's right-side action area. */
  renderComposerToolbarRight?: ComposerToolbarRightRenderer;
  /** Custom renderer shown directly above the chat composer input. */
  renderComposerHeader?: ComposerHeaderRenderer;
  /** Custom renderer shown directly below the chat composer input. */
  renderComposerFooter?: ComposerFooterRenderer;
  /**
   * Replaces the complete persistent chat header. Only rendered when a
   * session is active (not in the welcome/empty state).
   */
  renderChatHeader?: ChatHeaderRenderer;
  /** Custom component for the footer area below the Editor. Replaces the built-in StatusBar. */
  renderFooter?: FooterRenderer;
  /** Extra status items shown in the floating bottom panel beside the TODO summary. */
  bottomStatusItems?: readonly WebShellBottomStatusItem[];
  /** Collapse thinking blocks to 5 lines with a click-to-expand toggle. */
  compactThinking?: boolean;
  /** Let the host own pending Edit diff previews instead of the inline tool row. */
  hostOwnsEditDiffPreview?: boolean;
  /** Auto-collapse completed turns to just the prompt and final answer, with a per-turn toggle. Defaults to true. */
  collapseCompletedTurns?: boolean;
  /** Markdown table rendering mode. Defaults to basic. */
  markdownTableMode?: MarkdownTableMode;
  /** Enable virtual scrolling only when rendered transcript rows exceed this threshold. Defaults to 200. */
  virtualScrollThreshold?: number;
  /** Custom Markdown behavior for assistant content only. */
  markdown?: WebShellMarkdownCustomization;
  /**
   * Override the witty phrases cycled while a prompt is streaming. Receives the
   * resolved UI language; return phrases to replace the built-in defaults, an
   * empty array to hide the phrase, or `undefined`/`null` to keep the defaults.
   */
  loadingPhrases?: LoadingPhrasesResolver;
  /** When provided, all toast notifications are forwarded to this callback and the built-in ToastHost is hidden. */
  onToast?: (tone: ToastTone, message: string) => void;
  /** Imperative handle for externally controlling the composer input. */
  composerRef?: React.Ref<WebShellComposerApi>;
  /** Called once the real composer API is mounted and safe to call. */
  onComposerReady?: (api: WebShellComposerApi) => void;
  /** Declarative composer input value. Increment composerInputVersion to replay the same value. */
  composerInput?: WebShellComposerInput;
  /** Replay key for composerInput. */
  composerInputVersion?: number;
  /** Called when a session-level event occurs (rename, submit, turn complete). */
  onSessionChange?: (event: SessionChangeEvent) => void;
  /**
   * Prepare the immutable payload for a daemon submission. Called once for a
   * direct or queued logical submit, after local command routing and before
   * session creation, composer commit, optimistic rendering, or admission.
   * Retries reuse the previously prepared payload and skip this callback.
   */
  prepareSubmit?: (
    submission: WebShellSubmitSnapshot,
  ) => Promise<void | WebShellPreparedSubmit>;
  /**
   * Called before a prompt is submitted. Return a Promise — the prompt is held
   * until the Promise resolves. If the Promise rejects, the prompt is cancelled.
   * `sessionId` is `undefined` when the session has not yet been created (deferred).
   * Also called for queued prompts (submitted while a turn is streaming).
   */
  onSubmitBefore?: (params: {
    sessionId: string | undefined;
    prompt: string;
  }) => Promise<void>;
}

interface AppProps extends WebShellProps {
  initialSelectedWorkspaceCwd?: string;
  lockedWorkspaceCwd?: string;
  lockedWorkspaceCapability?: DaemonWorkspaceCapability;
  restartSseOnPrompt?: boolean;
  historyPageSize?: number;
}

type SessionActionsWithCreate = {
  createSession: (options?: {
    workspaceCwd?: string;
    sessionContext?: DaemonProductSessionContext;
    approvalMode?: string;
    sourceType?: string;
    worktree?: { slug?: string };
    branch?: { name: string };
  }) => Promise<{
    sessionId: string;
    worktree?: { slug: string; path: string; branch: string };
    branch?: { name: string; baseBranch: string };
  }>;
  attachSession: () => Promise<void>;
  clearSession: () => Promise<void>;
  releaseSession: (sessionId: string) => Promise<void>;
};

type NewSessionIntent =
  | { kind: 'global' }
  | { kind: 'inherit' }
  | { kind: 'workspace'; cwd: string };

type StandaloneRecoveryResolution =
  | 'idle'
  | 'checking'
  | 'creating'
  | 'absent'
  | 'unknown'
  | 'archived';

const STANDALONE_RECOVERY_POLL_DELAYS_MS = [250, 500, 1000, 2000, 4000];

function getStandaloneRecoverySessionId(
  recovery: DaemonStandaloneCreationRecovery | undefined,
): string | undefined {
  return recovery?.state === 'existing'
    ? recovery.session.sessionId
    : recovery?.sessionId;
}

type PendingReasoningIntent = {
  modelId: string;
  value: ReasoningSelection;
};

function getReasoningSelection(
  reasoning: DaemonReasoningControls,
): ReasoningSelection {
  if (!reasoning.enabled) return 'none';
  return reasoning.effort === 'none' ? 'default' : reasoning.effort;
}

function reasoningPreviewSupports(
  reasoning: DaemonReasoningControls,
  value: ReasoningSelection,
): boolean {
  if (value === 'none') return reasoning.canDisable !== false;
  if (value === 'default') return true;
  return reasoning.efforts.includes(value);
}

const emptyComposerApi: WebShellComposerApi = {
  focus: () => {},
  insertText: () => {},
  setText: () => {},
  addTags: () => {},
  removeTag: () => {},
  clear: () => {},
  submit: () => {},
};

const NON_WORKSPACE_BLOCKED_COMMANDS = new Set([
  'agents',
  'branch',
  'delete',
  'diff',
  'extensions',
  'goal',
  'log',
  'memory',
  'mcp',
  'prs',
  'release',
  'resume',
  'schedule',
  'settings',
  'skills',
  'tools',
]);

const EMPTY_BOTTOM_STATUS_ITEMS: readonly WebShellBottomStatusItem[] = [];
const EMPTY_SESSION_WORKFLOW_TODOS: FloatingTodosState = {
  todos: [],
  planId: null,
  allCompleted: false,
  sourceMessageId: null,
};
const EMPTY_ADDITIONAL_SLASH_COMMANDS: readonly CommandInfo[] = [];
const DEFAULT_CHAT_MAX_WIDTH = 1000;
const DEFAULT_CHAT_HEADER_ITEMS: readonly WebShellChatHeaderItem[] = [
  'title',
  'environment',
  'rightPanel',
];
const DEFAULT_RIGHT_PANEL_ITEMS: readonly WebShellRightPanelItem[] = [
  'review',
  'sideTask',
];
const DEFAULT_ENVIRONMENT_PANEL_ITEMS: readonly WebShellEnvironmentPanelItem[] =
  ['environment', 'subagents', 'backgroundTasks'];
const BOTTOM_PANEL_GAP_PX = 6;
const BOTTOM_PANEL_FALLBACK_INSET_PX = 40;

// One preview tab per image, keyed by its content, so opening several images
// keeps a tab each while re-clicking the same image just focuses its tab.
function imageTabId(src: string): string {
  let hash = 0;
  for (let i = 0; i < src.length; i++) {
    hash = (hash * 31 + src.charCodeAt(i)) | 0;
  }
  return `image:${hash.toString(36)}`;
}

type ChatWidthMode = `${typeof DEFAULT_CHAT_MAX_WIDTH}` | 'wide';
type MainView =
  | 'chat'
  | 'cockpit'
  | 'scheduledTasks'
  | 'workflows'
  | 'goals'
  | 'split';

const CHAT_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-chat-width';
const CHAT_SHELL_HORIZONTAL_PADDING = 40;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'qwen-code-web-shell-sidebar-collapsed';

function resolveSidebarOptions(sidebar: WebShellProps['sidebar']): {
  enabled: boolean;
  defaultCollapsed: boolean;
  showCompactToggle: boolean;
  showSessionSourceSwitch: boolean;
  branding?: false | WebShellSidebarBranding;
  primaryNav?: WebShellSidebarPrimaryNavOptions;
  hideProjectHeader?: boolean;
  sessionActions?: WebShellSidebarSessionActionsOptions;
  footer?: false | WebShellSidebarFooterOptions;
  lockedWorkspace?: WebShellSidebarLockedWorkspace;
  workspaceOverview?: false | WebShellSidebarWorkspaceOverviewOptions;
} {
  if (sidebar === true) {
    return {
      enabled: true,
      defaultCollapsed: false,
      showCompactToggle: true,
      showSessionSourceSwitch: true,
    };
  }
  if (!sidebar) {
    return {
      enabled: false,
      defaultCollapsed: false,
      showCompactToggle: true,
      showSessionSourceSwitch: true,
    };
  }
  return {
    enabled: sidebar.enabled ?? true,
    defaultCollapsed: sidebar.defaultCollapsed ?? false,
    showCompactToggle: sidebar.showCompactToggle ?? true,
    showSessionSourceSwitch: sidebar.showSessionSourceSwitch ?? true,
    branding: sidebar.branding,
    primaryNav: sidebar.primaryNav,
    hideProjectHeader: sidebar.hideProjectHeader,
    sessionActions: sidebar.sessionActions,
    footer: sidebar.footer,
    lockedWorkspace: sidebar.lockedWorkspace,
    workspaceOverview: sidebar.workspaceOverview,
  };
}

function readSidebarCollapsed(defaultCollapsed: boolean): boolean {
  if (typeof window === 'undefined') return defaultCollapsed;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
  return defaultCollapsed;
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(collapsed),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function getDefaultChatWidthMode(): ChatWidthMode {
  return `${DEFAULT_CHAT_MAX_WIDTH}`;
}

function readChatWidthMode(): ChatWidthMode {
  if (typeof window === 'undefined') return getDefaultChatWidthMode();
  try {
    return window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY) === 'wide'
      ? 'wide'
      : getDefaultChatWidthMode();
  } catch {
    return getDefaultChatWidthMode();
  }
}

function writeChatWidthMode(mode: ChatWidthMode): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function getChatMaxWidth(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CHAT_MAX_WIDTH;
}

function getChatWidthStyle(
  mode: ChatWidthMode,
  chatMaxWidth: number | undefined,
): CSSProperties {
  const contentWidth = `${getChatMaxWidth(chatMaxWidth)}px`;
  const shellWidth = `calc(${contentWidth} + ${CHAT_SHELL_HORIZONTAL_PADDING}px)`;
  return {
    '--chat-regular-content-width': contentWidth,
    '--chat-regular-shell-width': shellWidth,
    '--chat-content-width': mode === 'wide' ? '100%' : contentWidth,
    '--chat-shell-width': mode === 'wide' ? '100%' : shellWidth,
  } as CSSProperties;
}

function assignComposerRef(
  ref: React.Ref<WebShellComposerApi> | undefined,
  value: WebShellComposerApi,
): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<WebShellComposerApi | null>).current = value;
}

function assignShellRef(
  ref: React.Ref<WebShellApi> | undefined,
  value: WebShellApi | null,
): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<WebShellApi | null>).current = value;
}

function areSessionIdsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function getInitialLanguage(): WebShellLanguage {
  if (typeof window === 'undefined') return 'en';
  const params = new URLSearchParams(window.location.search);
  return normalizeLanguage(
    params.get('language') ?? params.get('lang') ?? navigator.language,
  );
}

function cockpitViewRequested(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('view') === 'cockpit'
  );
}

function updateCockpitLocation(open: boolean, replace = false): void {
  const url = new URL(window.location.href);
  if (open) {
    url.searchParams.set('view', 'cockpit');
  } else {
    url.searchParams.delete('view');
  }
  window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

interface AlreadyDispatchedError extends Error {
  _alreadyDispatched: true;
}

function isAlreadyDispatched(error: unknown): error is AlreadyDispatchedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as AlreadyDispatchedError)._alreadyDispatched === true
  );
}

function shouldToastNotice(notice: DaemonSessionNotice): boolean {
  return (
    notice.category === 'validation' ||
    notice.category === 'user_action' ||
    notice.category === 'system'
  );
}

function toastToneFromNotice(notice: DaemonSessionNotice): ToastTone {
  if (notice.severity === 'warning') return 'warning';
  if (notice.severity === 'info') return 'info';
  return 'error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getModelSwitchSummary(result: unknown): ModelSwitchSummary | null {
  if (!isRecord(result)) return null;
  const meta = result._meta;
  if (!isRecord(meta)) return null;
  const summary = meta.qwenModelSwitch;
  if (!isRecord(summary)) return null;
  const authType = summary.authType;
  const modelId = summary.modelId;
  const baseUrl = summary.baseUrl;
  const apiKey = summary.apiKey;
  if (
    typeof authType !== 'string' ||
    typeof modelId !== 'string' ||
    typeof baseUrl !== 'string' ||
    typeof apiKey !== 'string'
  ) {
    return null;
  }
  return {
    authType,
    modelId,
    baseUrl,
    apiKey,
    ...(typeof summary.isRuntime === 'boolean'
      ? { isRuntime: summary.isRuntime }
      : {}),
  };
}

function serializeModelSwitchSummary(
  summary: ModelSwitchSummary,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return t('model.usingModel', {
    isRuntime: summary.isRuntime ? 1 : 0,
    modelId: summary.modelId,
  });
}

function isEditToolPermission(request: PermissionRequest): boolean {
  return request.toolKind === 'edit';
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

export { getTaskActivityKey } from './utils/taskActivity';

export function mergeMonitorTaskSnapshot(
  current: DaemonSessionMonitorTaskStatus,
  next: DaemonSessionMonitorTaskStatus,
): DaemonSessionMonitorTaskStatus {
  return current.status !== 'running' && next.status === 'running'
    ? current
    : next;
}

function mergeShellTaskSnapshot(
  current: DaemonSessionShellTaskStatus,
  next: DaemonSessionShellTaskStatus,
): DaemonSessionShellTaskStatus {
  return current.status !== 'running' && next.status === 'running'
    ? current
    : next;
}

interface SideTaskCatalogState {
  parentSessionId?: string;
  items: SideTaskListItem[];
  loaded: boolean;
}

// Merge a fresh side-task listing into the cached catalog. The listing is
// authoritative: a cached item survives only while it is still listed or is a
// locally created draft the daemon has not echoed back yet (optimisticIds).
// Without the optimistic guard, a task deleted or archived on another client
// would be re-added from the cache forever.
export function mergeSideTaskCatalog(
  catalog: SideTaskCatalogState,
  parentSessionId: string,
  listedItems: SideTaskListItem[],
  optimisticIds: ReadonlySet<string>,
): SideTaskCatalogState {
  if (catalog.parentSessionId !== parentSessionId) {
    return { parentSessionId, items: listedItems, loaded: true };
  }
  const listedIds = new Set(listedItems.map((item) => item.sessionId));
  return {
    parentSessionId,
    loaded: true,
    items: [
      ...listedItems,
      ...catalog.items.filter(
        (item) =>
          !listedIds.has(item.sessionId) && optimisticIds.has(item.sessionId),
      ),
    ],
  };
}

function agentStatusFromTool(
  tool: ACPToolCall,
): DaemonSessionAgentTaskStatus['status'] {
  if (tool.status === 'pending' || tool.status === 'in_progress') {
    return 'running';
  }
  if (tool.status === 'failed') return 'failed';
  const rawOutput = isRecord(tool.rawOutput) ? tool.rawOutput : undefined;
  if (rawOutput?.['status'] === 'cancelled') return 'cancelled';
  return rawOutput?.['status'] === 'failed' ? 'failed' : 'completed';
}

function agentTaskAsToolCall(task: DaemonSessionAgentTaskStatus): ACPToolCall {
  const status =
    task.status === 'running' || task.status === 'paused'
      ? 'in_progress'
      : task.status === 'failed'
        ? 'failed'
        : 'completed';
  return {
    callId: task.id,
    toolName: 'agent',
    title: `Agent: ${task.label}`,
    status,
    args: {
      description: task.description,
      ...(task.prompt ? { prompt: task.prompt } : {}),
      ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
      run_in_background: task.isBackgrounded,
    },
    rawOutput: {
      type: 'task_execution',
      subagentName: task.subagentType,
      status: task.status,
    },
    startTime: task.startTime,
    ...(task.endTime !== undefined ? { endTime: task.endTime } : {}),
  };
}

function isEnvironmentAgentToolCall(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (name === 'agent' || name === 'task') return true;
  if (typeof tool.args?.subagent_type === 'string') return true;
  return (
    isRecord(tool.rawOutput) && tool.rawOutput['type'] === 'task_execution'
  );
}

function derivedTaskIdForTool(tool: ACPToolCall): string | undefined {
  const rawOutput = isRecord(tool.rawOutput) ? tool.rawOutput : undefined;
  const subagentName =
    typeof rawOutput?.['subagentName'] === 'string'
      ? rawOutput['subagentName']
      : undefined;
  const subagentType =
    typeof tool.args?.subagent_type === 'string'
      ? tool.args.subagent_type
      : undefined;
  return subagentName
    ? `${subagentName}-${tool.callId}`
    : subagentType
      ? `${subagentType}-${tool.callId}`
      : undefined;
}

export function getEnvironmentAgentTasks(
  messages: readonly Message[],
  sessionTasks: readonly DaemonSessionTaskWithWorkflowStatus[],
): EnvironmentAgentTask[] {
  const liveAgents = sessionTasks.filter(
    (task): task is DaemonSessionAgentTaskStatus => task.kind === 'agent',
  );
  const taskIdsByToolUseId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'system' || !isRecord(message.data)) continue;
    const taskId = message.data['taskId'];
    const toolUseId = message.data['toolUseId'];
    if (typeof taskId === 'string' && typeof toolUseId === 'string') {
      taskIdsByToolUseId.set(toolUseId, taskId);
    }
  }

  // A live task already linked precisely (by toolUseId, message taskId, or
  // derived id) to some transcript tool call must never be claimed by the loose
  // content fallback: two agents sharing a description would otherwise collapse
  // into one (the fallback steals the linked task, its owner re-matches it, and
  // the orphan is dropped).
  const envToolCallIds = new Set<string>();
  const preciselyClaimedTaskIds = new Set<string>(taskIdsByToolUseId.values());
  const collectPreciseLinks = (tools: readonly ACPToolCall[]) => {
    for (const tool of tools) {
      if (
        isEnvironmentAgentToolCall(tool) &&
        !envToolCallIds.has(tool.callId)
      ) {
        envToolCallIds.add(tool.callId);
        const derivedTaskId = derivedTaskIdForTool(tool);
        if (derivedTaskId) preciselyClaimedTaskIds.add(derivedTaskId);
      }
      if (tool.subTools) collectPreciseLinks(tool.subTools);
    }
  };
  for (const message of messages) {
    if (message.role === 'tool_group') collectPreciseLinks(message.tools);
  }
  const isPreciselyClaimed = (task: DaemonSessionAgentTaskStatus): boolean =>
    (task.toolUseId != null && envToolCallIds.has(task.toolUseId)) ||
    preciselyClaimedTaskIds.has(task.id);

  const agents: EnvironmentAgentTask[] = [];
  const seenTaskIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  const visit = (tools: readonly ACPToolCall[]) => {
    for (const tool of tools) {
      if (
        isEnvironmentAgentToolCall(tool) &&
        !seenToolCallIds.has(tool.callId)
      ) {
        seenToolCallIds.add(tool.callId);
        const rawOutput = isRecord(tool.rawOutput) ? tool.rawOutput : undefined;
        const color =
          typeof rawOutput?.['subagentColor'] === 'string'
            ? rawOutput['subagentColor']
            : undefined;
        const description =
          typeof tool.args?.description === 'string'
            ? tool.args.description
            : undefined;
        const prompt =
          typeof tool.args?.prompt === 'string' ? tool.args.prompt : undefined;
        const subagentType =
          typeof tool.args?.subagent_type === 'string'
            ? tool.args.subagent_type
            : undefined;
        const subagentName =
          typeof rawOutput?.['subagentName'] === 'string'
            ? rawOutput['subagentName']
            : undefined;
        const taskId = taskIdsByToolUseId.get(tool.callId);
        const derivedTaskId = derivedTaskIdForTool(tool);
        // Completed background agents can lose their toolUseId / derived-id
        // linkage (e.g. across a daemon reload); fall back to content matching,
        // the same signal the daemon's legacy resolver uses.
        const matchesLiveTaskContent = (
          task: DaemonSessionAgentTaskStatus,
        ): boolean => {
          if (prompt && task.prompt === prompt) return true;
          if (
            description &&
            task.description === description &&
            subagentType &&
            task.subagentType === subagentType
          ) {
            return true;
          }
          return !!description && task.description === description;
        };
        const liveTask = liveAgents.find(
          (task) =>
            task.toolUseId === tool.callId ||
            task.id === taskId ||
            task.id === derivedTaskId ||
            (!seenTaskIds.has(task.id) &&
              !isPreciselyClaimed(task) &&
              matchesLiveTaskContent(task)),
        );
        const title = tool.title?.replace(/^Agent:\s*/i, '').trim();
        const meaningfulTitle =
          title && title.toLowerCase() !== 'agent' ? title : undefined;
        const label =
          meaningfulTitle ??
          description ??
          prompt ??
          subagentName ??
          subagentType ??
          '';
        const taskDescription =
          description ?? prompt ?? subagentName ?? subagentType ?? '';
        const startTime = tool.startTime ?? 0;

        agents.push(
          liveTask
            ? {
                ...liveTask,
                toolUseId: tool.callId,
                label,
                description: taskDescription || liveTask.description,
                ...(subagentType ? { subagentType } : {}),
                ...(color ? { color } : {}),
              }
            : {
                kind: 'agent',
                id: taskId ?? derivedTaskId ?? tool.callId,
                label,
                description: taskDescription,
                status: agentStatusFromTool(tool),
                startTime,
                ...(tool.endTime !== undefined
                  ? { endTime: tool.endTime }
                  : {}),
                runtimeMs: Math.max(
                  0,
                  (tool.endTime ?? tool.startTime ?? startTime) - startTime,
                ),
                ...(subagentType ? { subagentType } : {}),
                ...(color ? { color } : {}),
                isBackgrounded: isBackgroundSubAgentToolCall(tool),
                toolUseId: tool.callId,
              },
        );
        if (liveTask) seenTaskIds.add(liveTask.id);
      }
      if (tool.subTools) visit(tool.subTools);
    }
  };

  for (const message of messages) {
    if (message.role === 'tool_group') visit(message.tools);
  }
  for (const task of liveAgents) {
    if (
      seenTaskIds.has(task.id) ||
      (task.toolUseId && seenToolCallIds.has(task.toolUseId))
    ) {
      continue;
    }
    const alreadyListed = agents.some(
      (a) =>
        (a.toolUseId != null && a.toolUseId === task.toolUseId) ||
        (a.description !== '' && a.description === task.description),
    );
    if (alreadyListed) continue;
    agents.push(task);
  }
  return agents;
}

function findToolCall(
  messages: readonly Message[],
  callId: string,
): ACPToolCall | undefined {
  const findNested = (
    tools: readonly ACPToolCall[],
  ): ACPToolCall | undefined => {
    for (const tool of tools) {
      if (tool.callId === callId) return tool;
      const nested = tool.subTools ? findNested(tool.subTools) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };

  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    const tool = findNested(message.tools);
    if (tool) return tool;
  }
  return undefined;
}

function mapToWebShellTaskInfo(
  task: DaemonSessionTaskWithWorkflowStatus,
): WebShellTaskInfo {
  const base = {
    id: task.id,
    label: task.label,
    description: task.description,
    runtimeMs: task.runtimeMs,
    startTime: task.startTime,
    endTime: task.endTime,
    error: task.error,
  };

  switch (task.kind) {
    case 'agent':
      return {
        ...base,
        kind: 'agent',
        status: task.status,
        subagentType: task.subagentType,
        isBackgrounded: task.isBackgrounded,
        prompt: task.prompt,
      };
    case 'shell':
      return {
        ...base,
        kind: 'shell',
        status: task.status,
        command: task.command,
        cwd: task.cwd,
        pid: task.pid,
        exitCode: task.exitCode,
      };
    case 'monitor':
      return {
        ...base,
        kind: 'monitor',
        status: task.status,
        command: task.command,
        pid: task.pid,
        exitCode: task.exitCode,
      };
    case 'workflow':
      return {
        ...base,
        kind: 'workflow',
        status: task.status,
        currentPhase: task.currentPhase ?? undefined,
        agentsDispatched: task.agentsDispatched,
        agentsCompleted: task.agentsCompleted,
        tokensSpent: task.tokensSpent,
        tokenBudgetTotal: task.tokenBudgetTotal ?? undefined,
      };
    default:
      return task satisfies never;
  }
}

function translateCopyMessage(
  message: string,
  t: ReturnType<typeof getTranslator>,
): string {
  if (message === COPY_MESSAGES.NO_OUTPUT) return t('copy.noOutput');
  if (message === COPY_MESSAGES.NO_TEXT) return t('copy.noText');
  if (message === COPY_MESSAGES.CODE_MISSING) return t('copy.codeMissing');
  if (message === COPY_MESSAGES.LATEX_MISSING) return t('copy.latexMissing');
  if (message === COPY_MESSAGES.INLINE_LATEX_MISSING) {
    return t('copy.inlineLatexMissing');
  }
  if (message === COPY_MESSAGES.OUTPUT_COPIED) return t('copy.outputCopied');
  if (message.startsWith(COPY_MESSAGES.CLIPBOARD_PREFIX)) {
    return `${t('copy.failedFallback')}. ${message.slice(
      COPY_MESSAGES.CLIPBOARD_PREFIX.length,
    )}`;
  }
  if (message.endsWith(COPY_MESSAGES.COPIED_SUFFIX)) {
    return t('copy.toClipboard', {
      label: message.slice(0, -COPY_MESSAGES.COPIED_SUFFIX.length),
    });
  }
  return message;
}

function isSameGitStatus(
  current: DaemonWorkspaceGitStatus | undefined,
  next: DaemonWorkspaceGitStatus | undefined,
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  return (
    current.v === next.v &&
    current.workspaceCwd === next.workspaceCwd &&
    current.branch === next.branch &&
    current.detached === next.detached &&
    current.staged === next.staged &&
    current.unstaged === next.unstaged &&
    current.untracked === next.untracked &&
    current.conflicted === next.conflicted &&
    current.hasUpstream === next.hasUpstream &&
    current.ahead === next.ahead &&
    current.behind === next.behind &&
    current.stashCount === next.stashCount &&
    current.operation === next.operation
  );
}

/**
 * Read a model setting's value for the scope currently being edited. Model
 * pickers persist to `modelSettingScope`, so their "current" value reflects
 * only that scope's own value (not the merged/effective one) — otherwise the
 * User tab would show, and appear to clear, an inherited workspace value.
 */
function readScopedModelSetting(
  settings: ReadonlyArray<{
    key: string;
    values: { effective: unknown; user?: unknown; workspace?: unknown };
  }>,
  scope: 'workspace' | 'user',
  key: string,
): unknown {
  const setting = settings.find((s) => s.key === key);
  if (!setting) return undefined;
  return scope === 'user' ? setting.values.user : setting.values.workspace;
}

export function App({
  askUserFreeTextLabel,
  onSessionIdChange,
  onSessionInfoChange,
  onSessionCreated,
  theme: providedTheme,
  onThemeChange,
  language: providedLanguage,
  onLanguageChange,
  className: externalClassName,
  style: externalStyle,
  shadowDom,
  onConnectionChange,
  onStreamingStateChange,
  onError,
  onBugReport,
  hiddenSlashCommands,
  slashCommandCategoryOrder,
  onSlashCommand,
  builtinAtProviders,
  atProviders,
  composerTagIcons,
  fileUploadEnabled,
  fileUploadDirectory,
  renderToolHeaderExtra,
  renderWelcomeHeader,
  renderWelcomeFooter,
  mobileWelcomeFooterMiddle = false,
  parseUserMessageContent,
  renderUserMessageContent,
  renderComposerTag,
  renderComposerTagTooltip,
  onComposerTagClick,
  renderAssistantTurnFooter,
  renderComposerToolbarStart,
  renderComposerToolbarEnd,
  renderComposerToolbarRight,
  renderComposerHeader,
  renderComposerFooter,
  renderChatHeader,
  renderFooter,
  bottomStatusItems,
  chatMaxWidth,
  sidebar,
  header,
  rightPanel,
  environmentPanel,
  splitSessionIds: externalSplitSessionIds,
  onSplitSessionIdsChange,
  renderPaneHeaderActions,
  onRightPanelOpen,
  onFileReviewOpen,
  onWorkspaceFileOpen,
  onInsightReportOpen,
  messageTurnOutputs,
  shellRef,
  composerToolbarActions,
  mainModelFilter,
  compactComposerOverlays = false,
  autoSubmitSlashCommands = false,
  additionalSlashCommands = EMPTY_ADDITIONAL_SLASH_COMMANDS,
  contextUsageAlwaysVisible = false,
  userMessageEditing = false,
  onUserMessageEditRequest,
  cycleModeOnTab = false,
  sessionSourceType = WEB_SHELL_SESSION_SOURCE_TYPE,
  composerToolbarAdditionalActions,
  composerPlaceholders,
  compactThinking = false,
  hostOwnsEditDiffPreview = false,
  collapseCompletedTurns = true,
  markdownTableMode = 'basic',
  virtualScrollThreshold,
  markdown,
  loadingPhrases,
  onAgentTasksChange,
  onTranscriptChange,
  onToast,
  composerRef,
  onComposerReady,
  composerInput,
  composerInputVersion,
  onSessionChange,
  prepareSubmit,
  onSubmitBefore,
  restartSseOnPrompt,
  historyPageSize,
  initialSelectedWorkspaceCwd,
  lockedWorkspaceCwd,
  lockedWorkspaceCapability,
}: AppProps = {}) {
  const [chatWidthMode, setChatWidthMode] =
    useState<ChatWidthMode>(readChatWidthMode);
  const [selectedLanguage, setSelectedLanguage] = useState<WebShellLanguage>(
    () =>
      providedLanguage === undefined
        ? getInitialLanguage()
        : normalizeLanguage(providedLanguage),
  );
  const t = useMemo(() => getTranslator(selectedLanguage), [selectedLanguage]);
  const shadowDomOptions = useMemo(
    () => resolveWebShellShadowDom(shadowDom),
    [shadowDom],
  );
  const sidebarOptions = useMemo(
    () => resolveSidebarOptions(sidebar),
    [sidebar],
  );
  const chatHeaderItems = header?.items ?? DEFAULT_CHAT_HEADER_ITEMS;
  const chatHeaderEnabled =
    chatHeaderItems.length > 0 && Boolean(header || renderChatHeader);
  const titleHeaderItemVisible = chatHeaderItems.includes('title');
  const environmentHeaderItemVisible = chatHeaderItems.includes('environment');
  const rightPanelHeaderItemVisible = chatHeaderItems.includes('rightPanel');
  const tokenUsageHeaderItemVisible = chatHeaderItems.includes('tokenUsage');
  const rightPanelItems = rightPanel?.items ?? DEFAULT_RIGHT_PANEL_ITEMS;
  const environmentPanelItems =
    environmentPanel?.items ?? DEFAULT_ENVIRONMENT_PANEL_ITEMS;
  // The environment panel is only reachable through the chat header toggle,
  // so its sections replace the composer git entry / footer task pills only
  // when that header is actually enabled. Embeddings that omit the header keep
  // the legacy entries.
  const environmentPanelReachable =
    chatHeaderEnabled &&
    environmentHeaderItemVisible &&
    (!renderChatHeader || Boolean(header));
  const environmentGitReplacementEnabled =
    environmentPanelReachable && environmentPanelItems.includes('environment');
  const environmentTasksReplacementEnabled =
    environmentPanelReachable &&
    environmentPanelItems.includes('backgroundTasks');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(sidebarOptions.defaultCollapsed),
  );
  const [sidebarSwitchingSessionId, setSidebarSwitchingSessionId] = useState<
    string | null
  >(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [forceMobileDrawer, setForceMobileDrawer] = useState(false);
  const closeMobileDrawer = useCallback(() => {
    setMobileDrawerOpen(false);
    setForceMobileDrawer(false);
  }, []);
  // Split view still needs desktop-scale horizontal room.
  const isLargeScreen = useIsLargeScreen();
  const canDockArtifactPanel = useIsLargeScreen('(min-width: 1001px)');
  const prefersReducedMotion = usePrefersReducedMotion();
  // In split view the session sidebar competes with the panes for width. Below
  // this width it auto-collapses to its icon rail so the panes get the room, and
  // expands again once the window grows back. A wide split keeps the full
  // sidebar (and the user's own collapse preference).
  const splitSidebarHasRoom = useIsLargeScreen('(min-width: 1200px)');

  useEffect(() => {
    if (!sidebarOptions.enabled) closeMobileDrawer();
  }, [closeMobileDrawer, sidebarOptions.enabled]);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 760px)');
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) closeMobileDrawer();
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [closeMobileDrawer]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isWebTerminalTarget(e)) return;
      // A pending tool/permission approval owns Escape (it rejects the call),
      // so don't let the drawer swallow it while a prompt is visible.
      if (pendingApprovalRef.current) return;
      // The fullscreen artifact surface owns Escape too (it shrinks back);
      // a force-hidden drawer must not swallow the key first.
      if (artifactPanelFullscreenRef.current) return;
      const target = e.target as HTMLElement | null;
      // Only let an editable element keep Escape for itself when it lives
      // outside the drawer; the drawer's own search input should still close
      // the drawer on the first Escape.
      if (
        isEditableTarget(target) &&
        !target?.closest('[data-sidebar-shell]')
      ) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      closeMobileDrawer();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const preventScroll = (e: TouchEvent) => {
      // Allow native scrolling inside the drawer panel (e.g. the session list).
      // The dim backdrop also lives under [data-sidebar-shell], so exclude it:
      // a touchmove starting on the backdrop must still be blocked, otherwise
      // iOS Safari scrolls the page behind the open drawer.
      const el = e.target as HTMLElement | null;
      if (
        el?.closest('[data-sidebar-shell]') &&
        !el.closest(`.${styles.mobileBackdrop}`)
      ) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [mobileDrawerOpen, closeMobileDrawer]);
  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    writeSidebarCollapsed(collapsed);
  }, []);

  // #5074: Cmd+B / Ctrl+B toggles the session sidebar, matching the editor
  // convention (VS Code et al.). It works while any element is focused —
  // the composer has no bold formatting, so nothing competes for the
  // binding. Phone-width layouts render the sidebar as a drawer, so the
  // shortcut toggles that instead of the collapsed rail.
  useEffect(() => {
    if (!sidebarOptions.enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarToggleShortcut(e)) return;
      if (isWebTerminalTarget(e)) return;
      // The composer keeps the editor-convention behavior (VS Code toggles
      // the sidebar while the editor is focused), but other editable targets
      // — sidebar search, session rename, settings inputs — must not have
      // the sidebar yanked around while the user is typing, matching the
      // codebase's isEditableTarget convention.
      const target = e.target as HTMLElement | null;
      if (
        isEditableTarget(target) &&
        !target?.closest('[data-web-shell-composer-editor]')
      ) {
        return;
      }
      e.preventDefault();
      // All state updates are dispatched sequentially outside the updater
      // functions (React purity contract — mirrors the hamburger handler),
      // which is why this effect re-binds on state changes: the listener
      // closure must stay fresh.
      if (
        forceMobileDrawer ||
        window.matchMedia('(max-width: 760px)').matches
      ) {
        // A forced drawer on a wide viewport still belongs to the drawer
        // path: collapsing the rail underneath the overlay would look like
        // a no-op to the user.
        if (mobileDrawerOpen) {
          setMobileDrawerOpen(false);
          setForceMobileDrawer(false);
        } else {
          setMobileDrawerOpen(true);
        }
        return;
      }
      const next = !sidebarCollapsed;
      setSidebarCollapsed(next);
      writeSidebarCollapsed(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    sidebarOptions.enabled,
    mobileDrawerOpen,
    forceMobileDrawer,
    sidebarCollapsed,
  ]);
  const customization = useMemo(
    () => ({
      askUserFreeTextLabel,
      composerTagIcons,
      builtinAtProviders,
      atProviders,
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      parseUserMessageContent,
      renderUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      renderAssistantTurnFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderComposerToolbarRight,
      renderComposerHeader,
      renderComposerFooter,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdownTableMode,
      markdown,
      loadingPhrases,
      fileUploadEnabled,
      fileUploadDirectory,
    }),
    [
      askUserFreeTextLabel,
      composerTagIcons,
      builtinAtProviders,
      atProviders,
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      parseUserMessageContent,
      renderUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      renderAssistantTurnFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderComposerToolbarRight,
      renderComposerHeader,
      renderComposerFooter,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdownTableMode,
      markdown,
      loadingPhrases,
      fileUploadEnabled,
      fileUploadDirectory,
    ],
  );
  const mainChatCustomization = useMemo(
    () => ({ ...customization, hostOwnsEditDiffPreview }),
    [customization, hostOwnsEditDiffPreview],
  );
  const CustomFooter = renderFooter;
  const CustomComposerHeader = renderComposerHeader;
  const CustomComposerFooter = renderComposerFooter;
  const store = useTranscriptStore();
  const { blocks, blockChangeSummary } = useAnimationFrameTranscriptSnapshot({
    structuralOnly: true,
  });
  const connection = useConnection();
  const logicalSessionKey = getLogicalSessionKey(
    connection.sessionId,
    connection.workspaceCwd,
  );
  const sessionWriteBlocked = Boolean(connection.loadingTranscript);
  const sessionWriteBlockedRef = useRef(sessionWriteBlocked);
  const sessionWriteBlockGenerationRef = useRef(0);
  if (sessionWriteBlocked && !sessionWriteBlockedRef.current) {
    sessionWriteBlockGenerationRef.current += 1;
  }
  sessionWriteBlockedRef.current = sessionWriteBlocked;
  const appMountedRef = useRef(true);
  useLayoutEffect(() => {
    appMountedRef.current = true;
    return () => {
      appMountedRef.current = false;
    };
  }, []);
  const sessionOwnerGuard = useDaemonSessionOwnerGuard();
  const transcriptHistory = useTranscriptHistory();
  const workspace = useWorkspace();
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  // Daemon-authoritative "turn is running" signal for the connected session:
  // keeps the conversation indicator (and its cancel affordances) alive
  // through >3s silent tool gaps where streamingState drops to idle (#9487).
  const sessionHasActivePrompt = useSessionHasActivePrompt(
    workspace.client,
    connection.workspaceCwd,
    connection.sessionId,
  );
  const sessionHasActivePromptRef = useRef(sessionHasActivePrompt);
  sessionHasActivePromptRef.current = sessionHasActivePrompt;
  const refreshWorkspaceCapabilities = workspace.refreshCapabilities;
  const workspaces = useMemo(() => {
    const capabilityWorkspaces = workspace.capabilities?.workspaces ?? [];
    if (
      lockedWorkspaceCapability &&
      !capabilityWorkspaces.some(
        (entry) => entry.cwd === lockedWorkspaceCapability.cwd,
      )
    ) {
      return [...capabilityWorkspaces, lockedWorkspaceCapability];
    }
    return capabilityWorkspaces;
  }, [lockedWorkspaceCapability, workspace.capabilities?.workspaces]);
  const ordinaryWorkspaces = useMemo(
    () => workspaces.filter((entry) => entry.kind !== 'live'),
    [workspaces],
  );
  const trustedPrimaryWorkspaceCwd = useMemo(
    () =>
      ordinaryWorkspaces.find(
        (entry) => entry.primary && entry.trusted !== false,
      )?.cwd,
    [ordinaryWorkspaces],
  );
  const isKnownLiveWorkspaceCwd = useCallback(
    (cwd: string | undefined) =>
      cwd !== undefined &&
      workspaces.some((entry) => entry.kind === 'live' && entry.cwd === cwd),
    [workspaces],
  );
  const composerWorkspacesRef = useRef<
    | Array<{
        id: string;
        cwd: string;
        label: string;
        primary: boolean;
        trusted: boolean;
      }>
    | undefined
  >(undefined);
  const nextComposerWorkspaces = !lockedWorkspaceCwd
    ? ordinaryWorkspaces.map((entry) => ({
        id: entry.id,
        cwd: entry.cwd,
        label: workspaceLabel(entry),
        primary: entry.primary,
        trusted: entry.trusted,
      }))
    : undefined;
  const currentComposerWorkspaces = composerWorkspacesRef.current;
  if (
    currentComposerWorkspaces?.length !== nextComposerWorkspaces?.length ||
    currentComposerWorkspaces?.some((current, index) => {
      const next = nextComposerWorkspaces?.[index];
      return (
        !next ||
        current.id !== next.id ||
        current.cwd !== next.cwd ||
        current.label !== next.label ||
        current.primary !== next.primary ||
        current.trusted !== next.trusted
      );
    })
  ) {
    composerWorkspacesRef.current = nextComposerWorkspaces;
  }
  const composerWorkspaces = composerWorkspacesRef.current;
  const workspacesRef = useRef(ordinaryWorkspaces);
  workspacesRef.current = ordinaryWorkspaces;
  const visibleWorkspaces = useMemo(
    () =>
      lockedWorkspaceCwd
        ? ordinaryWorkspaces.filter((entry) => entry.cwd === lockedWorkspaceCwd)
        : ordinaryWorkspaces,
    [lockedWorkspaceCwd, ordinaryWorkspaces],
  );
  const sessionActions = useActions();
  const reloadTranscript = useCallback(
    async (signal: AbortSignal) => {
      if (!connection.sessionId) return;
      await sessionActions.reloadSession(signal);
    },
    [connection.sessionId, sessionActions],
  );
  const transcriptReloadSupported =
    connection.capabilities?.features.includes(
      SESSION_TRANSCRIPT_PAGINATION_FEATURE,
    ) === true;
  const monitorDetailsSupported =
    connection.capabilities?.features.includes(
      SESSION_MONITOR_TOOL_CORRELATION_FEATURE,
    ) === true;
  const { notices, dismissNotice } = useSessionNotices();
  const workspaceActions = useWorkspaceActions();
  const artifactWorkspaceTarget = useArtifactWorkspaceTarget(
    connection.workspaceCwd,
  );
  const artifactWorkspaceCwd = artifactWorkspaceTarget?.workspaceCwd;
  const artifactWorkspaceActions = artifactWorkspaceTarget?.actions;
  const artifactWorkspaceCwdRef = useRef(artifactWorkspaceCwd);
  const artifactWorkspaceActionsRef = useRef(artifactWorkspaceActions);
  const workspaceCapabilitiesRef = useRef(workspace.capabilities);
  artifactWorkspaceCwdRef.current = artifactWorkspaceCwd;
  artifactWorkspaceActionsRef.current = artifactWorkspaceActions;
  workspaceCapabilitiesRef.current = workspace.capabilities;
  const workspaceCapabilitiesReady =
    workspace.capabilities !== undefined && workspace.status !== 'error';
  const standaloneSessionsSupported =
    workspace.capabilities?.features?.includes(
      STANDALONE_SESSIONS_CAPABILITY,
    ) === true;
  const dynamicWorkspaceRegistrationSupported =
    workspace.capabilities?.features?.includes(
      'dynamic_workspace_registration',
    ) === true;
  const persistentWorkspaceRegistrationSupported =
    workspace.capabilities?.features?.includes(
      'persistent_workspace_registration',
    ) === true;
  const scratchWorkspaceRegistrationSupported =
    workspace.capabilities?.features?.includes(
      'scratch_workspace_registration',
    ) === true;
  const workspaceDisplayNameSupported =
    workspace.capabilities?.features?.includes('workspace_display_name') ===
    true;
  // Headless daemon hosts omit the tag so the Browse affordance stays
  // hidden instead of failing on every click.
  const nativeDirectoryPickerSupported =
    workspace.capabilities?.features?.includes('native_directory_picker') ===
    true;
  const gitHubPrsSupported =
    workspace.capabilities?.features?.includes('workspace_github_prs') === true;
  const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] = useState(false);
  const [workspaceMutationBusy, setWorkspaceMutationBusy] = useState(false);
  const workspaceMutationTokenRef = useRef<symbol | null>(null);
  const workspaceSwitchTokenRef = useRef<symbol | null>(null);
  // Changes before async session clearing updates connection state.
  const composerSourceVersionRef = useRef(0);
  type ScratchOutcomeState = 'clear' | 'refreshing' | 'awaiting-ack';
  const scratchOutcomeUnknownRef = useRef<ScratchOutcomeState>('clear');
  const committedScratchCwdRef = useRef<string | undefined>(undefined);
  const [scratchOutcomeUnknown, setScratchOutcomeUnknown] =
    useState<ScratchOutcomeState>('clear');
  // The ref is the synchronous authority: a second click can arrive before
  // React commits the disabled state rendered from its state mirror.
  const setScratchOutcome = useCallback((state: ScratchOutcomeState) => {
    scratchOutcomeUnknownRef.current = state;
    setScratchOutcomeUnknown(state);
  }, []);
  // Phase 4: the workspace picked for the *next* new session on multi-workspace
  // daemons. Kept in a ref too because session creation is lazy (first prompt),
  // so the ensureSessionForPrompt callback must read the latest value.
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<
    string | undefined
  >(initialSelectedWorkspaceCwd);
  const selectedWorkspaceCwdRef = useRef(selectedWorkspaceCwd);
  selectedWorkspaceCwdRef.current = selectedWorkspaceCwd;
  const resolveWorkspaceMaintenanceTargetCwd = useCallback(() => {
    const preferredCwd = lockedWorkspaceCwd ?? selectedWorkspaceCwdRef.current;
    if (preferredCwd) {
      return ordinaryWorkspaces.find(
        (entry) => entry.cwd === preferredCwd && entry.trusted !== false,
      )?.cwd;
    }
    return trustedPrimaryWorkspaceCwd;
  }, [lockedWorkspaceCwd, ordinaryWorkspaces, trustedPrimaryWorkspaceCwd]);
  const [pendingSessionContext, setPendingSessionContextState] = useState<
    DaemonProductSessionContext | undefined
  >(undefined);
  const pendingSessionContextRef = useRef(pendingSessionContext);
  const setPendingSessionContext = useCallback(
    (context: DaemonProductSessionContext | undefined) => {
      pendingSessionContextRef.current = context;
      setPendingSessionContextState(context);
    },
    [],
  );
  const legacyWorkspaceContextCwd =
    connection.workspaceCwd ||
    lockedWorkspaceCwd ||
    selectedWorkspaceCwd ||
    trustedPrimaryWorkspaceCwd ||
    workspace.capabilities?.workspaceCwd;
  const settledSessionContext = useMemo<
    DaemonProductSessionContext | undefined
  >(
    () =>
      connection.sessionContext ??
      (isKnownLiveWorkspaceCwd(connection.workspaceCwd)
        ? { kind: 'live' }
        : legacyWorkspaceContextCwd
          ? { kind: 'workspace', cwd: legacyWorkspaceContextCwd }
          : undefined),
    [
      connection.sessionContext,
      connection.workspaceCwd,
      isKnownLiveWorkspaceCwd,
      legacyWorkspaceContextCwd,
    ],
  );
  const effectiveSessionContext = useMemo(
    () => pendingSessionContext ?? settledSessionContext,
    [pendingSessionContext, settledSessionContext],
  );
  const workspaceContextActive = effectiveSessionContext?.kind === 'workspace';
  const pendingNonWorkspaceNavigation =
    pendingSessionContext !== undefined &&
    pendingSessionContext.kind !== 'workspace' &&
    settledSessionContext?.kind === 'workspace';
  const effectiveStandaloneSession =
    effectiveSessionContext?.kind === 'standalone'
      ? connection.standaloneSession
      : undefined;
  const standaloneCreationRecovery =
    effectiveStandaloneSession?.creationRecovery;
  const standaloneWorkingDirectory =
    effectiveStandaloneSession?.workingDirectory;
  const standaloneDirectoryErrorCode = effectiveStandaloneSession?.errorCode;
  const [standaloneRecoveryResolution, setStandaloneRecoveryResolution] =
    useState<StandaloneRecoveryResolution>('idle');
  const standaloneRecoveryRequestRef = useRef(0);
  const [standaloneRepairBusy, setStandaloneRepairBusy] = useState(false);
  const standaloneRepairRequestRef = useRef(0);
  useEffect(() => {
    standaloneRecoveryRequestRef.current += 1;
    standaloneRepairRequestRef.current += 1;
    setStandaloneRecoveryResolution('idle');
    setStandaloneRepairBusy(false);
  }, [connection.sessionId]);
  const [selectedWorkspaceGitStatus, setSelectedWorkspaceGitStatus] = useState<
    DaemonWorkspaceGitStatus | undefined
  >(undefined);
  /** Git mode intent for the next lazily-created session (branch or worktree). */
  const [gitModeIntent, setGitModeIntent] = useState<SessionGitIntent>({
    mode: 'current',
  });
  const gitModeIntentRef = useRef(gitModeIntent);
  useEffect(() => {
    gitModeIntentRef.current = gitModeIntent;
  }, [gitModeIntent]);

  useEffect(() => {
    if (
      !workspace.capabilities ||
      !selectedWorkspaceCwd ||
      !workspaceContextActive
    ) {
      return;
    }
    const selected = ordinaryWorkspaces.find(
      (entry) => entry.cwd === selectedWorkspaceCwd,
    );
    if (selected?.trusted) return;
    const primaryCwd = ordinaryWorkspaces.find(
      (entry) => entry.primary && entry.trusted !== false,
    )?.cwd;
    composerSourceVersionRef.current += 1;
    selectedWorkspaceCwdRef.current = undefined;
    setSelectedWorkspaceCwd(undefined);
    setPendingSessionContext(
      primaryCwd ? { kind: 'workspace', cwd: primaryCwd } : undefined,
    );
    gitModeIntentRef.current = { mode: 'current' };
    setGitModeIntent({ mode: 'current' });
  }, [
    ordinaryWorkspaces,
    selectedWorkspaceCwd,
    setPendingSessionContext,
    workspace.capabilities,
    workspaceContextActive,
  ]);
  // The workspace the chip's status was last fetched for. On a workspace switch
  // we clear the status immediately so the chip never shows the previous repo's
  // branch/dirty counts while the new fetch is in flight; same-workspace
  // re-runs (branch change, focus, poll) keep the live value to avoid flicker.
  const gitStatusWorkspaceCwdRef = useRef<string | undefined>(undefined);
  /** Worktree metadata for the current session (set after creation). */
  const [sessionWorktree, setSessionWorktree] = useState<
    { slug: string; path: string; branch: string } | undefined
  >(undefined);
  /** Branch metadata for the current session (set after creation with branch mode). */
  const [sessionBranch, setSessionBranch] = useState<
    { name: string; baseBranch: string } | undefined
  >(undefined);
  const [sessionStatusDisplayName, setSessionStatusDisplayName] = useState<
    string | undefined
  >(undefined);
  const [currentSessionSummary, setCurrentSessionSummary] = useState<
    DaemonSessionSummary | undefined
  >(undefined);
  // Tracks the logical session from the latest effect run. In-flight fetches
  // compare their captured key against this ref on resolve: a match means
  // the response is still relevant and may set OR clear the worktree state;
  // a mismatch means connection.sessionId moved on (reconnect cycling or a
  // user-initiated switch) and the stale response is dropped.
  const worktreeSessionKeyRef = useRef<string | undefined>(undefined);
  const sessionStatusRequestRef = useRef(0);
  useLayoutEffect(() => {
    setSessionWorktree(undefined);
    setSessionBranch(undefined);
    setSessionStatusDisplayName(undefined);
    setCurrentSessionSummary(undefined);
  }, [logicalSessionKey]);
  // Restore worktree info from the server when switching to an existing
  // session. The effect intentionally does NOT cancel in-flight fetches on
  // cleanup: connection.sessionId can cycle through several sessions during
  // the DaemonSessionProvider reconnection loop, and cancelling would
  // discard the one response we actually need.
  useEffect(() => {
    const sid = connection.sessionId;
    const sessionKey = logicalSessionKey;
    const owner = sessionOwnerGuard.capture();
    const requestId = ++sessionStatusRequestRef.current;
    worktreeSessionKeyRef.current = sessionKey;
    if (!sid) {
      setSessionWorktree(undefined);
      setSessionBranch(undefined);
      setSessionStatusDisplayName(undefined);
      setCurrentSessionSummary(undefined);
      return;
    }
    if (
      connection.status !== 'connected' ||
      connection.loadingTranscript ||
      connection.catchingUp
    ) {
      return;
    }
    if (connection.sessionContext?.kind === 'standalone') {
      workspace.client
        .getStandaloneSession(sid)
        .then((summary) => {
          if (
            'state' in summary ||
            sessionStatusRequestRef.current !== requestId ||
            worktreeSessionKeyRef.current !== sessionKey ||
            !owner.isCurrent()
          ) {
            return;
          }
          setSessionWorktree(undefined);
          setSessionBranch(undefined);
          setSessionStatusDisplayName(summary.displayName);
          setCurrentSessionSummary(summary);
        })
        .catch(() => {
          if (
            sessionStatusRequestRef.current === requestId &&
            worktreeSessionKeyRef.current === sessionKey &&
            owner.isCurrent()
          ) {
            setSessionStatusDisplayName(undefined);
            setCurrentSessionSummary(undefined);
          }
        });
      return;
    }
    workspace.client
      .sessionStatus(sid)
      .then((summary) => {
        if (connection.sessionContext?.kind === 'live') {
          if (
            sessionStatusRequestRef.current === requestId &&
            worktreeSessionKeyRef.current === sessionKey &&
            owner.isCurrent()
          ) {
            setSessionWorktree(undefined);
            setSessionBranch(undefined);
            setSessionStatusDisplayName(summary.displayName);
            setCurrentSessionSummary(summary);
          }
          return;
        }
        if (
          sessionStatusRequestRef.current === requestId &&
          worktreeSessionKeyRef.current === sessionKey &&
          owner.isCurrent()
        ) {
          setSessionWorktree(summary.worktree);
          setSessionBranch(summary.branch);
          setSessionStatusDisplayName(summary.displayName);
          setCurrentSessionSummary(summary);
        }
        return loadSessionCatalogOnce(
          workspace.client,
          {
            routeKind: 'legacy',
            workspaceCwd: summary.workspaceCwd,
            options: { pageSize: 200 },
          },
          { fresh: true },
        )
          .then((page) => {
            if (
              worktreeSessionKeyRef.current !== sessionKey ||
              sessionStatusRequestRef.current !== requestId ||
              !owner.isCurrent()
            ) {
              return;
            }
            const listedSession = page.sessions.find(
              (session) => session.sessionId === sid,
            );
            setSessionStatusDisplayName(
              listedSession?.displayName ?? summary.displayName,
            );
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (
          sessionStatusRequestRef.current === requestId &&
          worktreeSessionKeyRef.current === sessionKey &&
          owner.isCurrent()
        ) {
          setSessionWorktree(undefined);
          setSessionBranch(undefined);
          setSessionStatusDisplayName(undefined);
          setCurrentSessionSummary(undefined);
        }
      });
  }, [
    connection.catchingUp,
    connection.clientId,
    connection.loadingTranscript,
    connection.sessionId,
    connection.sessionContext,
    connection.status,
    connection.workspaceCwd,
    logicalSessionKey,
    sessionOwnerGuard,
    sessionHasActivePrompt,
    workspace.client,
  ]);
  // Active workspace: the connected session's workspace, else the workspace
  // picked for the next session (locked / selected / primary). Computed once
  // and shared by the git-status effect and the Changes-dialog entry point so
  // the chip and the dialog always target the same repo.
  const activeWorkspaceCwd = useMemo(() => {
    if (!workspaceContextActive) return undefined;
    const explicitContext = pendingSessionContext ?? connection.sessionContext;
    if (explicitContext?.kind === 'workspace') {
      return explicitContext.cwd;
    }
    return connection.sessionId
      ? connection.workspaceCwd
      : resolveWorkspaceMaintenanceTargetCwd();
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    connection.sessionContext,
    pendingSessionContext,
    resolveWorkspaceMaintenanceTargetCwd,
    workspaceContextActive,
  ]);
  const workspaceWorkflowsEnabled =
    workspaces.find((entry) => entry.cwd === activeWorkspaceCwd)
      ?.workflowsEnabled ?? false;
  const workflowsEnabled = connection.sessionId
    ? (connection.supportedCommands?.workflowsEnabled ??
      workspaceWorkflowsEnabled)
    : workspaceWorkflowsEnabled;
  // Worktree sessions query git status with the worktree path (?cwd=
  // parameter); the chip prefers the live branch from that status, falling
  // back to the creation-time sessionWorktree.branch.
  useEffect(() => {
    if (!activeWorkspaceCwd || isKnownLiveWorkspaceCwd(activeWorkspaceCwd)) {
      gitStatusWorkspaceCwdRef.current = undefined;
      setSelectedWorkspaceGitStatus(undefined);
      return;
    }
    const statusTarget = sessionWorktree?.path ?? activeWorkspaceCwd;
    if (gitStatusWorkspaceCwdRef.current !== statusTarget) {
      gitStatusWorkspaceCwdRef.current = statusTarget;
      setSelectedWorkspaceGitStatus(undefined);
    }
    let cancelled = false;
    const fetchStatus = () => {
      const git = workspace.client.workspaceByCwd(activeWorkspaceCwd);
      // Fast path: last-known cache (branch-only on a cold start) paints the
      // chip immediately.
      void git
        .workspaceGit({ cwd: sessionWorktree?.path })
        .then((status) => {
          if (!cancelled) {
            setSelectedWorkspaceGitStatus((current) =>
              isSameGitStatus(current, status) ? current : status,
            );
          }
        })
        .catch(() => {
          if (!cancelled) setSelectedWorkspaceGitStatus(undefined);
        });
      // Fresh path: resolves when the daemon's recomputation lands, so the
      // enriched counters fill in without depending on SSE — the
      // `git_status_changed` push only flows on a per-session event stream,
      // which doesn't exist before the first prompt (deferred connect).
      // Daemon-side in-flight dedup shares one `git status` computation
      // across both requests. Worktree `?cwd=` reads always compute
      // directly, so a second request would be a duplicate there.
      if (!sessionWorktree) {
        void git
          .workspaceGit({ wait: true })
          .then((status) => {
            if (!cancelled) {
              setSelectedWorkspaceGitStatus((current) =>
                isSameGitStatus(current, status) ? current : status,
              );
            }
          })
          .catch((err) => {
            console.warn('[web-shell] git status fresh path failed:', err);
          });
      }
    };
    fetchStatus();
    // Refresh triggers stay on focus and on a slow poll for the active
    // workspace only. A live branch change re-runs this effect via the
    // connection.gitBranch dependency. With an active session the daemon's
    // `git_status_changed` push (mirrored by the effect below) additionally
    // covers realtime updates between polls.
    const onFocus = () => fetchStatus();
    window.addEventListener('focus', onFocus);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchStatus();
    }, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(poll);
    };
  }, [
    activeWorkspaceCwd,
    connection.gitBranch,
    isKnownLiveWorkspaceCwd,
    workspace.client,
    sessionWorktree,
  ]);
  // Mirror the daemon's `git_status_changed` push (surfaced as
  // connection.gitStatus by the session provider) into the chip state so the
  // enriched counters fill in right after the branch-only first paint.
  // Worktree sessions bypass the daemon cache/SSE path — their status comes
  // from the ?cwd= fetch above.
  useEffect(() => {
    const status = connection.gitStatus;
    if (!status || sessionWorktree) return;
    if (status.workspaceCwd !== activeWorkspaceCwd) return;
    setSelectedWorkspaceGitStatus(status);
  }, [connection.gitStatus, activeWorkspaceCwd, sessionWorktree]);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<WebShellToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const pushToast = useCallback((tone: ToastTone, message: string) => {
    if (onToastRef.current) {
      onToastRef.current(tone, message);
      return;
    }
    const toast: WebShellToast = {
      id: `web-shell-toast-${Date.now()}-${++toastIdRef.current}`,
      tone,
      message,
      // Deadline instead of duration: the host remounts its items when the
      // elevated portal moves, and a fresh timer per remount would keep a
      // toast on screen indefinitely across repeated fullscreen toggles.
      dismissAt: Date.now() + TOAST_AUTO_DISMISS_MS,
    };
    setToasts((current) => {
      const withoutDuplicate = current.filter(
        (item) => item.tone !== tone || item.message !== message,
      );
      return [...withoutDuplicate, toast].slice(-MAX_TOASTS);
    });
  }, []);

  const messages = useMessagesFromBlocks(t, blocks, blockChangeSummary);
  const messagesRef = useRef(messages);
  const [failedPrompt, setFailedPrompt] = useState<FailedPrompt | null>(null);
  const failedPromptRef = useRef<FailedPrompt | null>(failedPrompt);
  const [failedPromptRetry, setFailedPromptRetry] =
    useState<FailedPromptRetry | null>(null);
  const cancelledRetryStatesRef = useRef(
    new Map<string, CancelledRetryEntry[]>(),
  );
  const cancelledRetryAttemptRef = useRef(0);
  const [cancelledRetryRevision, setCancelledRetryRevision] = useState(0);
  const [unknownPromptAdmission, setUnknownPromptAdmission] =
    useState<UnknownPromptAdmission | null>(null);
  const unknownPromptAdmissionRef = useRef<UnknownPromptAdmission | null>(null);
  const updateUnknownPromptAdmission = useCallback(
    (next: UnknownPromptAdmission | null) => {
      unknownPromptAdmissionRef.current = next;
      setUnknownPromptAdmission(next);
    },
    [],
  );
  const updateFailedPrompt = useCallback((next: FailedPrompt | null) => {
    failedPromptRef.current = next;
    setFailedPrompt(next);
  }, []);
  const failedPromptOwnerRef = useRef<{
    sessionId?: string;
    workspaceCwd?: string;
    snapshot: DaemonSessionOwnerSnapshot;
  }>({
    sessionId: connection.sessionId,
    workspaceCwd: connection.workspaceCwd,
    snapshot: sessionOwnerGuard.capture(),
  });
  useLayoutEffect(() => {
    const previousOwner = failedPromptOwnerRef.current;
    failedPromptOwnerRef.current = {
      sessionId: connection.sessionId,
      workspaceCwd: connection.workspaceCwd,
      snapshot: sessionOwnerGuard.capture(),
    };
    if (
      previousOwner.sessionId === connection.sessionId &&
      previousOwner.workspaceCwd === undefined &&
      connection.workspaceCwd !== undefined &&
      previousOwner.snapshot.isCurrent()
    ) {
      return;
    }
    updateFailedPrompt(null);
    setFailedPromptRetry(null);
    updateUnknownPromptAdmission(null);
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    sessionOwnerGuard,
    updateFailedPrompt,
    updateUnknownPromptAdmission,
  ]);
  const [recapMessage, setRecapMessage] = useState<LocalAnchoredMessage | null>(
    null,
  );
  const [btwMessage, setBtwMessage] = useState<Message | null>(null);
  const nextRecapMessageIdRef = useRef(1);
  const nextBtwMessageIdRef = useRef(1);
  const btwAbortControllerRef = useRef<AbortController | null>(null);
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  const contextBodyRef = useRef<HTMLDivElement | null>(null);
  const [contextBodyWidth, setContextBodyWidth] = useState<number | null>(null);
  const currentSessionIdRef = useRef(connection.sessionId);
  const lastNotifiedSessionIdRef = useRef<string | undefined>(undefined);
  const lastNotifiedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const lastNotifiedWorkspaceCwdRef = useRef<string | undefined>(undefined);
  const lastNotifiedNonWorkspaceContextRef = useRef<
    'standalone' | 'live' | undefined
  >(undefined);
  const displayMessages = useMemo(
    () => buildDisplayMessages(messages, recapMessage),
    [messages, recapMessage],
  );
  useEffect(() => {
    const failed = failedPromptRef.current;
    if (!failed) return;
    const currentFailedBlock = findUserMessageByIdentity(
      store.getSnapshot().blocks,
      failed.identity,
      failed.owner.snapshot.isCurrent(),
    );
    const failedBlock = findUserMessageByIdentity(
      blocks,
      failed.identity,
      failed.owner.snapshot.isCurrent(),
    );
    if (failed.sessionId !== connection.sessionId || !currentFailedBlock) {
      updateFailedPrompt(null);
      return;
    }
    if (!failedBlock) return;
    const failedIndex = displayMessages.findIndex(
      (message) => message.id === failedBlock.id,
    );
    if (failedIndex < 0) return;
    if (
      displayMessages
        .slice(failedIndex + 1)
        .some((message) => message.role === 'user')
    ) {
      updateFailedPrompt(null);
      return;
    }
    if (
      failed.messageId !== failedBlock.id ||
      failed.identity.block !== failedBlock
    ) {
      updateFailedPrompt({
        ...failed,
        messageId: failedBlock.id,
        identity: { block: failedBlock },
      });
    }
  }, [
    blocks,
    connection.sessionId,
    displayMessages,
    failedPrompt,
    store,
    updateFailedPrompt,
  ]);
  useEffect(() => {
    const unknown = unknownPromptAdmissionRef.current;
    if (unknown && unknown.sessionId !== connection.sessionId) {
      updateUnknownPromptAdmission(null);
    }
  }, [connection.sessionId, updateUnknownPromptAdmission]);
  const {
    artifacts,
    loading: artifactsLoading,
    error: artifactsError,
  } = useSessionArtifacts();
  const [artifactPanelExtraArtifacts, setArtifactPanelExtraArtifacts] =
    useState<DaemonSessionArtifact[]>([]);
  const [paneArtifactSnapshots, setPaneArtifactSnapshots] = useState<
    Map<string, PaneArtifactSnapshot>
  >(() => new Map());
  const [artifactPanelTabs, setArtifactPanelTabs] = useState<
    ArtifactPanelTab[]
  >([]);
  const artifactPanelTabsRef = useRef(artifactPanelTabs);
  artifactPanelTabsRef.current = artifactPanelTabs;
  useEffect(() => {
    if (artifactPanelExtraArtifacts.length === 0 || artifacts.length === 0) {
      return;
    }
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
    // Extras referenced by open artifact tabs must survive the reconcile:
    // they keep those tabs renderable through transient gaps in the live
    // list, and stay inert while the live list (merged first) covers them.
    const openArtifactIds = new Set(
      artifactPanelTabs
        .filter((tab) => tab.kind === 'artifact')
        .map((tab) => (tab.kind === 'artifact' ? tab.artifactId : '')),
    );
    setArtifactPanelExtraArtifacts((previous) => {
      const next = previous.filter(
        (artifact) =>
          !artifactIds.has(artifact.id) || openArtifactIds.has(artifact.id),
      );
      return next.length === previous.length ? previous : next;
    });
  }, [artifacts, artifactPanelExtraArtifacts.length, artifactPanelTabs]);
  const paneArtifactExtras = useMemo(
    () =>
      Array.from(paneArtifactSnapshots.values()).flatMap((snapshot) => [
        ...snapshot.artifacts,
      ]),
    [paneArtifactSnapshots],
  );
  const artifactPanelArtifacts = useMemo(() => {
    if (
      artifactPanelExtraArtifacts.length === 0 &&
      paneArtifactExtras.length === 0
    ) {
      return artifacts;
    }
    const merged = [...artifacts];
    // Pane snapshots outrank open-time extras so a retained extra never
    // shadows a fresher pane report for the same artifact id.
    for (const artifact of [
      ...paneArtifactExtras,
      ...artifactPanelExtraArtifacts,
    ]) {
      const index = merged.findIndex((item) => item.id === artifact.id);
      if (index < 0) {
        merged.push(artifact);
      }
    }
    return merged;
  }, [artifacts, artifactPanelExtraArtifacts, paneArtifactExtras]);
  const handlePaneArtifactsChange = useCallback(
    (
      paneSessionId: string,
      paneArtifacts: readonly DaemonSessionArtifact[],
    ) => {
      if (paneArtifacts.length > 0) {
        const paneArtifactIds = new Set(
          paneArtifacts.map((artifact) => artifact.id),
        );
        // Keep extras whose artifact tab is still open: once the pane closes
        // and its snapshot is dropped, the extra is the tab's only copy.
        const openArtifactIds = new Set(
          artifactPanelTabsRef.current
            .filter((tab) => tab.kind === 'artifact')
            .map((tab) => (tab.kind === 'artifact' ? tab.artifactId : '')),
        );
        setArtifactPanelExtraArtifacts((current) => {
          const next = current.filter(
            (artifact) =>
              !paneArtifactIds.has(artifact.id) ||
              openArtifactIds.has(artifact.id),
          );
          return next.length === current.length ? current : next;
        });
      }
      setPaneArtifactSnapshots((current) => {
        const previous = current.get(paneSessionId);
        const unchanged =
          previous?.artifacts.length === paneArtifacts.length &&
          previous.artifacts.every((artifact, index) => {
            const nextArtifact = paneArtifacts[index];
            // `metadata` is deliberately not compared: artifact events carry
            // freshly parsed objects, so an identity check here would defeat
            // the guard without catching a realistic change.
            return (
              nextArtifact?.id === artifact.id &&
              nextArtifact.status === artifact.status &&
              nextArtifact.updatedAt === artifact.updatedAt &&
              nextArtifact.sizeBytes === artifact.sizeBytes &&
              nextArtifact.title === artifact.title &&
              nextArtifact.workspacePath === artifact.workspacePath
            );
          });
        if (unchanged) return current;
        const next = new Map(current);
        if (paneArtifacts.length === 0) {
          next.delete(paneSessionId);
        } else {
          next.set(paneSessionId, {
            artifacts: [...paneArtifacts],
          });
        }
        return next;
      });
    },
    [],
  );
  const artifactsByTurn = useMemo(
    () =>
      getArtifactsByTurn(
        displayMessages,
        artifacts,
        connection.workspaceCwd || '',
      ),
    [displayMessages, artifacts, connection.workspaceCwd],
  );
  const fileChangesByTurn = useMemo(
    () =>
      getFileChangesByTurn(
        displayMessages,
        artifactsByTurn,
        connection.workspaceCwd || '',
      ),
    [displayMessages, artifactsByTurn, connection.workspaceCwd],
  );
  const latestReviewChanges = useMemo(() => {
    let latest: readonly TurnOutputFileChange[] = [];
    for (const changes of fileChangesByTurn.values()) {
      if (changes.length > 0) latest = changes;
    }
    return latest;
  }, [fileChangesByTurn]);
  const scheduledTasksByTurn = useMemo(
    () => getScheduledTasksByTurn(displayMessages),
    [displayMessages],
  );
  const visibleTurnOutputKinds = useMemo(
    () => new Set<TurnOutputKind>(messageTurnOutputs ?? TURN_OUTPUT_KINDS),
    [messageTurnOutputs],
  );
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [environmentPanelOpen, setEnvironmentPanelOpen] = useState(false);
  const preserveEnvironmentPanelOnArtifactOpenRef = useRef(false);
  useLayoutEffect(() => {
    preserveEnvironmentPanelOnArtifactOpenRef.current = false;
    setEnvironmentPanelOpen(false);
  }, [logicalSessionKey]);
  const artifactPanelOpenRef = useRef(artifactPanelOpen);
  artifactPanelOpenRef.current = artifactPanelOpen;
  const artifactPanelTriggerRef = useRef<HTMLElement | null>(null);
  const rememberArtifactPanelTrigger = useCallback(() => {
    if (
      !artifactPanelOpenRef.current &&
      document.activeElement instanceof HTMLElement
    ) {
      artifactPanelTriggerRef.current = document.activeElement;
    }
  }, []);
  const [activeArtifactPanelTabId, setActiveArtifactPanelTabId] = useState<
    string | null
  >(null);
  const activeArtifactPanelTabIdRef = useRef(activeArtifactPanelTabId);
  activeArtifactPanelTabIdRef.current = activeArtifactPanelTabId;
  const [reviewChanges, setReviewChanges] = useState<
    readonly TurnOutputFileChange[]
  >([]);
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(
    null,
  );
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(
    DEFAULT_REVIEW_PANEL_WIDTH,
  );
  const [artifactPanelFullscreen, setArtifactPanelFullscreen] = useState(false);
  const artifactPanelFullscreenRef = useRef(false);
  artifactPanelFullscreenRef.current = artifactPanelFullscreen;
  // Exiting fullscreen swaps the same DOM node back to .artifactPanelDock,
  // whose open animation would re-play on the already-open panel; suppress it
  // until the dock remounts for a genuine open (panel close, or the floating
  // drawer handing back).
  const [
    suppressArtifactDockOpenAnimation,
    setSuppressArtifactDockOpenAnimation,
  ] = useState(false);
  const [waitForSubagentPanelAnimation, setWaitForSubagentPanelAnimation] =
    useState(false);
  // In-tree portal target for the docked panel (display:contents keeps the
  // portaled wrapper a direct flex item of .appShell). Held in state so the
  // portal container exists before the wrapper renders.
  const [artifactPanelSlotEl, setArtifactPanelSlotEl] =
    useState<HTMLDivElement | null>(null);
  const artifactPanelFullscreenSurfaceRef = useRef<HTMLDivElement | null>(null);
  const artifactPanelResizeCleanupRef = useRef<(() => void) | null>(null);
  const artifactPanelSessionStateRef = useRef<ArtifactPanelSessionState | null>(
    null,
  );
  const artifactPanelStateBySessionRef = useRef(
    new Map<string, ArtifactPanelSessionState>(),
  );
  const artifactPanelSessionIdRef = useRef(logicalSessionKey);
  artifactPanelSessionStateRef.current = {
    open: artifactPanelOpen,
    tabs: artifactPanelTabs,
    activeTabId: activeArtifactPanelTabId,
    reviewChanges,
    selectedReviewPath,
    extraArtifacts: artifactPanelExtraArtifacts,
    width: artifactPanelWidth,
  };
  useEffect(() => {
    const previousSessionId = artifactPanelSessionIdRef.current;
    if (previousSessionId) {
      const currentState = artifactPanelSessionStateRef.current;
      if (currentState) {
        artifactPanelStateBySessionRef.current.set(
          previousSessionId,
          currentState,
        );
        if (
          artifactPanelStateBySessionRef.current.size >
          MAX_ARTIFACT_PANEL_SESSION_STATES
        ) {
          const oldestSessionId = artifactPanelStateBySessionRef.current
            .keys()
            .next().value;
          if (oldestSessionId) {
            const oldestState =
              artifactPanelStateBySessionRef.current.get(oldestSessionId);
            for (const tab of oldestState?.tabs ?? []) {
              if (tab.kind === 'terminal') releaseWebTerminal(tab.id);
            }
            artifactPanelStateBySessionRef.current.delete(oldestSessionId);
          }
        }
      }
    }

    const nextSessionId = logicalSessionKey;
    artifactPanelSessionIdRef.current = nextSessionId;
    const savedState = nextSessionId
      ? artifactPanelStateBySessionRef.current.get(nextSessionId)
      : undefined;
    if (!savedState) {
      setArtifactPanelOpen(false);
      setArtifactPanelTabs([]);
      setActiveArtifactPanelTabId(null);
      setReviewChanges([]);
      setSelectedReviewPath(null);
      setArtifactPanelExtraArtifacts([]);
      setPaneArtifactSnapshots(new Map());
      setArtifactPanelWidth(DEFAULT_REVIEW_PANEL_WIDTH);
      setArtifactPanelFullscreen(false);
      return;
    }

    setArtifactPanelOpen(savedState.open);
    setArtifactPanelTabs(savedState.tabs);
    setActiveArtifactPanelTabId(savedState.activeTabId);
    setReviewChanges(savedState.reviewChanges);
    setSelectedReviewPath(savedState.selectedReviewPath);
    setArtifactPanelExtraArtifacts(savedState.extraArtifacts);
    setPaneArtifactSnapshots(new Map());
    setArtifactPanelWidth(savedState.width);
    setArtifactPanelFullscreen(false);
  }, [logicalSessionKey]);
  const sideTasksAvailable =
    workspaceContextActive &&
    Boolean(connection.sessionId && connection.workspaceCwd) &&
    connection.capabilities?.features.includes(SESSION_SIDE_TASK_FEATURE) ===
      true;
  const webTerminalAvailable =
    workspaceContextActive &&
    rightPanelItems.includes('terminal') &&
    connection.capabilities?.features.includes('web_terminal') === true;
  useEffect(() => {
    if (workspaceContextActive) return;
    const terminalIds = artifactPanelTabs
      .filter((tab) => tab.kind === 'terminal')
      .map((tab) => tab.id);
    if (terminalIds.length === 0) return;
    for (const terminalId of terminalIds) releaseWebTerminal(terminalId);
    setArtifactPanelTabs((tabs) =>
      tabs.filter((tab) => tab.kind !== 'terminal'),
    );
    if (
      activeArtifactPanelTabId &&
      terminalIds.includes(activeArtifactPanelTabId)
    ) {
      setActiveArtifactPanelTabId(null);
      setArtifactPanelOpen(false);
    }
  }, [activeArtifactPanelTabId, artifactPanelTabs, workspaceContextActive]);
  const [sideTaskCatalog, setSideTaskCatalog] = useState<SideTaskCatalogState>({
    items: [],
    loaded: false,
  });
  useLayoutEffect(() => {
    setSideTaskCatalog({ items: [], loaded: false });
  }, [logicalSessionKey]);
  const optimisticSideTaskIdsRef = useRef(new Set<string>());
  const visibleSideTasks =
    sideTaskCatalog.parentSessionId === connection.sessionId
      ? sideTaskCatalog.items
      : [];
  const sideTasksLoading =
    visibleSideTasks.length === 0 &&
    (sideTaskCatalog.parentSessionId !== connection.sessionId ||
      !sideTaskCatalog.loaded);
  const nextSideTaskTabIdRef = useRef(0);
  const createSideTask = useCallback(
    (initialPrompt?: string) => {
      const parentSessionId = connection.sessionId;
      if (!parentSessionId || !sideTasksAvailable) return false;
      const tab: ArtifactPanelTab = {
        id: `side-task:draft:${Date.now()}:${++nextSideTaskTabIdRef.current}`,
        kind: 'side_task',
        title: t('sideTask.title'),
        parentSessionId,
        workspaceCwd: connection.workspaceCwd,
        nameFromFirstPrompt: true,
        ...(initialPrompt?.trim()
          ? { initialPrompt: initialPrompt.trim() }
          : {}),
      };
      setArtifactPanelTabs((tabs) => [...tabs, tab]);
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelOpen(true);
      return true;
    },
    [connection.sessionId, connection.workspaceCwd, sideTasksAvailable, t],
  );
  const createEmptySideTask = useCallback(() => {
    if (createSideTask()) return;
    pushToast('error', t('sideTask.createFailed'));
  }, [createSideTask, pushToast, t]);
  const openTerminalTab = useCallback(() => {
    const id = `terminal:${crypto.randomUUID()}`;
    const count = artifactPanelTabsRef.current.filter(
      (tab) => tab.kind === 'terminal',
    ).length;
    const base = t('terminal.title');
    const tab: ArtifactPanelTab = {
      id,
      kind: 'terminal',
      title: count === 0 ? base : `${base} (${count + 1})`,
      workspaceCwd: connection.workspaceCwd,
    };
    setArtifactPanelTabs((tabs) => [...tabs, tab]);
    setActiveArtifactPanelTabId(tab.id);
    setArtifactPanelOpen(true);
  }, [connection.workspaceCwd, t]);
  const createSideTaskSession = useCallback(
    async (_tabId: string, parentSessionId: string, title: string) => {
      const ownerCwd = connection.workspaceCwd;
      const parentClientId =
        connection.sessionId === parentSessionId
          ? connection.clientId
          : undefined;
      const session = await workspace.client.createSideTaskSession(
        parentSessionId,
        {
          name: title,
        },
        parentClientId,
      );
      if (ownerCwd) {
        sessionCatalogController.sessionCreated(ownerCwd, session.sessionId);
      }
      await workspace.client
        .detachSession(session.sessionId, session.clientId)
        .catch(() => undefined);
      return {
        sessionId: session.sessionId,
        displayName: session.displayName,
      };
    },
    [
      connection.clientId,
      connection.sessionId,
      connection.workspaceCwd,
      sessionCatalogController,
      workspace.client,
    ],
  );
  const handleSideTaskCreated = useCallback(
    (tabId: string, sessionId: string) => {
      let createdTab = artifactPanelTabsRef.current.find(
        (candidate) => candidate.id === tabId,
      );
      setArtifactPanelTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === tabId && tab.kind === 'side_task'
            ? { ...tab, sessionId }
            : tab,
        ),
      );
      if (!createdTab) {
        // Creation can resolve after we navigate away from the parent session;
        // the draft tab then lives in a saved per-session bucket rather than the
        // live tabs, so write the sessionId there too or reopening the parent
        // creates a duplicate side task.
        for (const state of artifactPanelStateBySessionRef.current.values()) {
          const candidate = state.tabs.find(
            (bucketTab) => bucketTab.id === tabId,
          );
          if (!candidate) continue;
          createdTab = candidate;
          state.tabs = state.tabs.map((bucketTab) =>
            bucketTab.id === tabId && bucketTab.kind === 'side_task'
              ? { ...bucketTab, sessionId }
              : bucketTab,
          );
          break;
        }
      }
      const sideTaskTab =
        createdTab?.kind === 'side_task' ? createdTab : undefined;
      if (!sideTaskTab) return;
      optimisticSideTaskIdsRef.current.add(sessionId);
      setSideTaskCatalog((catalog) => {
        if (catalog.parentSessionId !== sideTaskTab.parentSessionId) {
          return catalog;
        }
        if (catalog.items.some((item) => item.sessionId === sessionId)) {
          return catalog;
        }
        return {
          ...catalog,
          items: [
            ...catalog.items,
            {
              sessionId,
              title: sideTaskTab.title,
              workspaceCwd: sideTaskTab.workspaceCwd,
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      });
    },
    [],
  );
  const handleSideTaskTitleChange = useCallback(
    (tabId: string, title: string, fromFirstPrompt = false) => {
      const sideTaskTab = artifactPanelTabsRef.current.find(
        (tab) => tab.id === tabId && tab.kind === 'side_task',
      );
      const sessionId =
        sideTaskTab?.kind === 'side_task' ? sideTaskTab.sessionId : undefined;
      setArtifactPanelTabs((tabs) =>
        tabs.map((tab) => {
          if (tab.id !== tabId || tab.kind !== 'side_task') return tab;
          if (!fromFirstPrompt && tab.title === title) return tab;
          return {
            ...tab,
            title,
            ...(fromFirstPrompt
              ? {
                  nameFromFirstPrompt: false,
                  initialPrompt: undefined,
                }
              : {}),
          };
        }),
      );
      if (sessionId) {
        setSideTaskCatalog((catalog) => ({
          ...catalog,
          items: catalog.items.map((item) =>
            item.sessionId === sessionId ? { ...item, title } : item,
          ),
        }));
      }
    },
    [],
  );
  const openSideTask = useCallback(
    (sideTask: SideTaskListItem) => {
      const parentSessionId = connection.sessionId;
      if (!parentSessionId) return;
      const tab: ArtifactPanelTab = {
        id: `side-task:${sideTask.sessionId}`,
        kind: 'side_task',
        title: sideTask.title,
        sessionId: sideTask.sessionId,
        parentSessionId,
        workspaceCwd: sideTask.workspaceCwd ?? connection.workspaceCwd,
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some(
          (item) =>
            item.kind === 'side_task' && item.sessionId === sideTask.sessionId,
        )
          ? tabs
          : [...tabs, tab],
      );
      const existingTab = artifactPanelTabsRef.current.find(
        (item) =>
          item.kind === 'side_task' && item.sessionId === sideTask.sessionId,
      );
      setActiveArtifactPanelTabId(existingTab?.id ?? tab.id);
      setArtifactPanelOpen(true);
    },
    [connection.sessionId, connection.workspaceCwd],
  );
  useEffect(() => {
    const parentSessionId = connection.sessionId;
    const workspaceCwd = connection.workspaceCwd;
    if (!sideTasksAvailable || !parentSessionId || !workspaceCwd) {
      setSideTaskCatalog({ items: [], loaded: false });
      return;
    }
    if (!artifactPanelOpen) return;
    setSideTaskCatalog((catalog) =>
      catalog.parentSessionId === parentSessionId
        ? { ...catalog, loaded: false }
        : { parentSessionId, items: [], loaded: false },
    );
    let cancelled = false;
    void loadSessionCatalogOnce(
      workspace.client,
      {
        routeKind: 'legacy',
        workspaceCwd,
        options: {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
          sourceType: WEB_SHELL_SIDE_TASK_SOURCE_TYPE,
          sourceId: parentSessionId,
        },
      },
      { fresh: true },
    )
      .then((page) => {
        if (cancelled) return;
        const listedItems = page.sessions.map((session) => ({
          sessionId: session.sessionId,
          title:
            session.displayName?.trim() ||
            `${t('sideTask.title')} ${session.sessionId.slice(0, 8)}`,
          workspaceCwd: session.workspaceCwd || workspaceCwd,
          updatedAt: session.updatedAt || session.createdAt,
        }));
        for (const item of listedItems) {
          optimisticSideTaskIdsRef.current.delete(item.sessionId);
        }
        setSideTaskCatalog((catalog) =>
          mergeSideTaskCatalog(
            catalog,
            parentSessionId,
            listedItems,
            optimisticSideTaskIdsRef.current,
          ),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setSideTaskCatalog((catalog) =>
          catalog.parentSessionId === parentSessionId
            ? { ...catalog, loaded: true }
            : catalog,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    artifactPanelOpen,
    sideTasksAvailable,
    t,
    workspace.client,
  ]);
  const getMaxArtifactPanelWidth = useCallback(() => {
    const chatPaneWidth = chatPaneRef.current?.getBoundingClientRect().width;
    if (!chatPaneWidth) {
      return Math.max(
        MIN_ARTIFACT_PANEL_WIDTH,
        window.innerWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
      );
    }
    return Math.max(
      MIN_ARTIFACT_PANEL_WIDTH,
      artifactPanelWidth +
        chatPaneWidth -
        MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
    );
  }, [artifactPanelWidth]);
  const getDefaultReviewPanelWidth = useCallback(() => {
    const chatPaneWidth =
      chatPaneRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const maxWidth = Math.max(
      MIN_ARTIFACT_PANEL_WIDTH,
      chatPaneWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
    );
    return Math.min(
      maxWidth,
      Math.max(DEFAULT_REVIEW_PANEL_WIDTH, Math.round(chatPaneWidth * 0.56)),
    );
  }, []);
  const openArtifactPanel = useCallback(
    (artifactId: string, previewContent?: string) => {
      if (!artifactId) return;
      rememberArtifactPanelTrigger();
      const artifact = artifactPanelArtifacts.find(
        (item) => item.id === artifactId,
      );
      const tab: ArtifactPanelTab = {
        id: `artifact:${artifactId}`,
        kind: 'artifact',
        artifactId,
        title: artifact?.title ?? 'Artifact',
        ...(connection.workspaceCwd
          ? { workspaceCwd: connection.workspaceCwd }
          : {}),
        ...(artifactWorkspaceTarget?.workspaceId
          ? { workspaceId: artifactWorkspaceTarget.workspaceId }
          : {}),
        ...(previewContent !== undefined ? { previewContent } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) =>
              item.id === tab.id ? { ...item, ...tab } : item,
            )
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [
      artifactPanelArtifacts,
      artifactWorkspaceTarget?.workspaceId,
      connection.workspaceCwd,
      getDefaultReviewPanelWidth,
      rememberArtifactPanelTrigger,
    ],
  );
  const openReviewPanel = useCallback(
    (
      changes: readonly TurnOutputFileChange[],
      selectedPath?: string,
      reviewWorkspaceCwd?: string,
      reviewWorkspaceId?: string,
      tabId = 'review',
    ) => {
      const reviewTab: ArtifactPanelTab = {
        id: tabId,
        kind: 'review',
        title: t('turnOutputs.review'),
        changes,
        ...(selectedPath ? { selectedPath } : {}),
        ...(reviewWorkspaceCwd ? { workspaceCwd: reviewWorkspaceCwd } : {}),
        ...(reviewWorkspaceId ? { workspaceId: reviewWorkspaceId } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === reviewTab.id)
          ? tabs.map((item) => (item.id === reviewTab.id ? reviewTab : item))
          : [reviewTab, ...tabs],
      );
      setActiveArtifactPanelTabId(reviewTab.id);
      setReviewChanges(changes);
      setSelectedReviewPath(selectedPath ?? null);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const openLatestReviewPanel = useCallback(() => {
    if (latestReviewChanges.length === 0) return;
    openReviewPanel(
      latestReviewChanges,
      undefined,
      connection.workspaceCwd,
      artifactWorkspaceTarget?.workspaceId,
    );
  }, [
    artifactWorkspaceTarget?.workspaceId,
    connection.workspaceCwd,
    latestReviewChanges,
    openReviewPanel,
  ]);
  const openScheduledTaskPanel = useCallback(
    (
      task: TurnOutputScheduledTask,
      tabWorkspaceCwd?: string,
      tabWorkspaceId?: string,
      sourceSessionId?: string,
    ) => {
      const tab: ArtifactPanelTab = {
        id: sourceSessionId
          ? `scheduled-task:${sourceSessionId}:${task.toolCallId}`
          : `scheduled-task:${task.toolCallId}`,
        kind: 'scheduled_task',
        title: t('scheduledTasks.title'),
        task: tabWorkspaceId ? { ...task, workspaceId: tabWorkspaceId } : task,
        ...(tabWorkspaceCwd ? { workspaceCwd: tabWorkspaceCwd } : {}),
        ...(tabWorkspaceId ? { workspaceId: tabWorkspaceId } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const openMonitorPanel = useCallback(
    (
      task: DaemonSessionMonitorTaskStatus,
      sourceSessionId?: string,
      sourceSessionActions?: DaemonSessionActions,
    ) => {
      const tab: ArtifactPanelTab = {
        id: sourceSessionId
          ? `monitor:${sourceSessionId}:${task.id}`
          : `monitor:${task.id}`,
        kind: 'monitor',
        title: task.description,
        task,
        ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
        ...(sourceSessionActions
          ? { sessionActions: sourceSessionActions }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => {
              if (item.id !== tab.id || item.kind !== 'monitor') return item;
              const mergedTask = mergeMonitorTaskSnapshot(item.task, task);
              return {
                ...tab,
                title: mergedTask.description,
                task: mergedTask,
              };
            })
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth],
  );
  const openImagePanel = useCallback(
    (src: string, alt?: string) => {
      const tab: ArtifactPanelTab = {
        id: imageTabId(src),
        kind: 'image',
        title: t('turnOutputs.imagePreview'),
        src,
        ...(alt ? { alt } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [tab, ...tabs],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const openTokenUsagePanel = useCallback(
    (
      sourceSessionId: string,
      sourceSessionActions?: DaemonSessionActions,
      closeWithPane = false,
    ) => {
      const tab: ArtifactPanelTab = {
        id: `token-usage:${sourceSessionId}`,
        kind: 'token_usage',
        title: t('tokenUsage.title'),
        sessionId: sourceSessionId,
        ...(closeWithPane ? { closeWithPane: true } : {}),
        ...(sourceSessionActions
          ? { sessionActions: sourceSessionActions }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const openAttachmentPanel = useCallback(
    (
      file: AttachmentPreviewRequest,
      workspaceCwd = connection.workspaceCwd,
      sourceSessionId = connection.sessionId,
    ) => {
      if (
        onWorkspaceFileOpen &&
        file.workspacePath &&
        file.text === undefined &&
        file.data === undefined
      ) {
        onWorkspaceFileOpen(file.workspacePath);
        return;
      }
      const open = (resolvedFile: AttachmentPreviewRequest) => {
        const workspacePath = resolvedFile.workspacePath ?? resolvedFile.name;
        const workspaceId = resolveArtifactWorkspaceOwner(
          workspaceCapabilitiesRef.current,
          workspaceCwd,
        )?.id;
        const previewOnly =
          resolvedFile.text !== undefined ||
          resolvedFile.data !== undefined ||
          resolvedFile.attachmentId !== undefined;
        const tab: ArtifactPanelTab = {
          id: previewOnly
            ? `attachment:${sourceSessionId ?? ''}:${resolvedFile.attachmentId ?? workspacePath}`
            : `file:${workspaceCwd ?? ''}:${workspacePath}`,
          kind: 'file',
          title: resolvedFile.name,
          workspacePath,
          ...(resolvedFile.text !== undefined
            ? { previewContent: resolvedFile.text }
            : {}),
          ...(resolvedFile.data ? { previewData: resolvedFile.data } : {}),
          ...(resolvedFile.mimeType
            ? { previewMimeType: resolvedFile.mimeType }
            : {}),
          ...(previewOnly ? { previewOnly: true } : {}),
          ...(workspaceCwd ? { workspaceCwd } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        };
        setArtifactPanelTabs((tabs) =>
          tabs.some((item) => item.id === tab.id)
            ? tabs.map((item) => (item.id === tab.id ? tab : item))
            : [tab, ...tabs],
        );
        setActiveArtifactPanelTabId(tab.id);
        setArtifactPanelWidth((width) =>
          artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
        );
        setArtifactPanelOpen(true);
      };
      if (
        file.attachmentId &&
        file.text === undefined &&
        file.data === undefined
      ) {
        const owner = sessionOwnerGuard.capture();
        void sessionActions
          .readAttachment(file.attachmentId)
          .then((attachment) => {
            if (!owner.isCurrent()) return;
            open({
              ...file,
              data: base64ToBlob(attachment.data, attachment.mimeType),
              mimeType: attachment.mimeType,
            });
          })
          .catch((error: unknown) => {
            if (!owner.isCurrent()) return;
            pushToast(
              'error',
              formatError(error, 'Failed to preview attachment'),
            );
          });
        return;
      }
      if (
        file.workspacePath &&
        file.text === undefined &&
        file.data === undefined &&
        artifactWorkspaceCwdRef.current === workspaceCwd &&
        artifactWorkspaceActionsRef.current
      ) {
        const owner = sessionOwnerGuard.capture();
        void artifactWorkspaceActionsRef.current
          .stat(file.workspacePath)
          .then((stat) => {
            if (!owner.isCurrent() || stat.type !== 'file') return;
            open(file);
          })
          .catch((error: unknown) => {
            if (!owner.isCurrent()) return;
            pushToast('error', formatError(error, 'Failed to preview file'));
          });
        return;
      }
      open(file);
    },
    [
      connection.workspaceCwd,
      connection.sessionId,
      getDefaultReviewPanelWidth,
      onWorkspaceFileOpen,
      pushToast,
      sessionActions,
      sessionOwnerGuard,
    ],
  );
  const openShellPanel = useCallback(
    (
      task: DaemonSessionShellTaskStatus,
      sourceSessionId?: string,
      sourceSessionActions?: DaemonSessionActions,
    ) => {
      const tab: ArtifactPanelTab = {
        id: sourceSessionId
          ? `shell:${sourceSessionId}:${task.id}`
          : `shell:${task.id}`,
        kind: 'shell',
        title: task.command,
        task,
        ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
        ...(sourceSessionActions
          ? { sessionActions: sourceSessionActions }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => {
              if (item.id !== tab.id || item.kind !== 'shell') return item;
              const mergedTask = mergeShellTaskSnapshot(item.task, task);
              return {
                ...tab,
                title: mergedTask.command,
                task: mergedTask,
              };
            })
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth],
  );
  const openSubagentPanelForSession = useCallback(
    (tool: ACPToolCall, sessionId: string, workspaceCwd?: string) => {
      if (!artifactPanelOpenRef.current) {
        setWaitForSubagentPanelAnimation(true);
      }
      rememberArtifactPanelTrigger();
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
      const tab: ArtifactPanelTab = {
        id: `subagent:${sessionId}:${tool.callId}`,
        kind: 'subagent',
        title: tool.title || subagentType || t('agent.label'),
        sessionId,
        rootToolCallId: tool.callId,
        rootTool: tool,
        ...(workspaceCwd ? { workspaceCwd } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, rememberArtifactPanelTrigger, t],
  );
  const openSubagentPanel = useCallback(
    (tool: ACPToolCall) => {
      if (!connection.sessionId) return;
      openSubagentPanelForSession(
        tool,
        connection.sessionId,
        connection.workspaceCwd,
      );
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      openSubagentPanelForSession,
    ],
  );
  const openEnvironmentAgent = useCallback(
    (task: DaemonSessionAgentTaskStatus) => {
      if (!connection.sessionId) return;
      if (!artifactPanelOpenRef.current) {
        preserveEnvironmentPanelOnArtifactOpenRef.current = true;
      }
      const tool = task.toolUseId
        ? findToolCall(messages, task.toolUseId)
        : undefined;
      openSubagentPanelForSession(
        tool ?? agentTaskAsToolCall(task),
        connection.sessionId,
        connection.workspaceCwd,
      );
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      messages,
      openSubagentPanelForSession,
    ],
  );
  const handleTurnOutputOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      if (request.kind === 'review' && onFileReviewOpen) {
        onFileReviewOpen(request);
        return;
      }
      if (onRightPanelOpen) {
        onRightPanelOpen(request);
        return;
      }
      if (request.kind === 'review') {
        openReviewPanel(
          request.changes,
          request.selectedPath,
          request.workspaceCwd,
          request.workspaceId,
          request.sourceSessionId
            ? `review:${request.sourceSessionId}:${request.turnId}`
            : undefined,
        );
        return;
      }
      if (request.kind === 'scheduled_task') {
        openScheduledTaskPanel(
          request.task,
          request.workspaceCwd,
          request.workspaceId,
          request.sourceSessionId,
        );
        return;
      }
      if (request.kind === 'image') {
        openImagePanel(request.src, request.alt);
        return;
      }
      if (request.kind === 'attachment') {
        openAttachmentPanel(
          {
            name: request.title,
            ...(request.mimeType ? { mimeType: request.mimeType } : {}),
            ...(request.data ? { data: request.data } : {}),
            ...(request.text !== undefined ? { text: request.text } : {}),
            ...(request.workspacePath
              ? { workspacePath: request.workspacePath }
              : {}),
          },
          request.workspaceCwd,
          request.sourceSessionId,
        );
        return;
      }
      if (request.kind === 'subagent') {
        openSubagentPanelForSession(
          request.tool,
          request.sessionId,
          request.workspaceCwd,
        );
        return;
      }
      // Cache the opened row so the tab keeps rendering through transient
      // gaps in the live artifact lists (an SSE reconnect, or the source
      // pane closing); the snapshot/live-list reconciles drop the copy once
      // a fresher source covers the artifact again.
      setArtifactPanelExtraArtifacts((current) => {
        const index = current.findIndex(
          (artifact) => artifact.id === request.artifact.id,
        );
        if (index < 0) return [...current, request.artifact];
        const next = [...current];
        next[index] = request.artifact;
        return next;
      });
      const tab: ArtifactPanelTab = {
        id: request.sourceSessionId
          ? `${request.sourceSessionId}:${request.id}`
          : request.id,
        kind: 'artifact',
        title: request.title,
        artifactId: request.artifactId,
        ...(request.workspaceCwd ? { workspaceCwd: request.workspaceCwd } : {}),
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        ...(request.sourceSessionId
          ? { sourceSessionId: request.sourceSessionId }
          : {}),
        ...(request.previewContent !== undefined
          ? { previewContent: request.previewContent }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) =>
              item.id === tab.id ? { ...item, ...tab } : item,
            )
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [
      getDefaultReviewPanelWidth,
      onFileReviewOpen,
      onRightPanelOpen,
      openReviewPanel,
      openScheduledTaskPanel,
      openImagePanel,
      openAttachmentPanel,
      openSubagentPanelForSession,
    ],
  );
  const openFilePreview = useCallback(
    (
      change: TurnOutputFileChange,
      previewWorkspaceCwd?: string,
      previewWorkspaceId?: string,
    ) => {
      const previewContent = getFileChangePreviewContent(change);
      const tab: ArtifactPanelTab = {
        id: `file:${previewWorkspaceCwd ?? ''}:${change.path}`,
        kind: 'file',
        title: displayPath(change.path, previewWorkspaceCwd),
        workspacePath: change.path,
        ...(previewWorkspaceCwd ? { workspaceCwd: previewWorkspaceCwd } : {}),
        ...(previewWorkspaceId ? { workspaceId: previewWorkspaceId } : {}),
        ...(previewContent !== undefined ? { previewContent } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
    },
    [],
  );
  const closeArtifactPanel = useCallback(() => {
    setArtifactPanelOpen(false);
    // Reset fullscreen in the same commit: while it stays true the covered
    // shells keep display:none, and deferring the reset to the management
    // effect would paint one frame of an empty shell after the close.
    setArtifactPanelFullscreen(false);
    setSuppressArtifactDockOpenAnimation(false);
    setSideTaskCatalog((catalog) =>
      catalog.items.length === 0 ? { ...catalog, loaded: false } : catalog,
    );
  }, []);
  useLayoutEffect(() => {
    // Fullscreen hides the chat pane (display:none); measuring it there
    // reports 0 and would clamp the panel down to its minimum width.
    if (!artifactPanelOpen || artifactPanelFullscreen) return;
    const clampWidth = () => {
      setArtifactPanelWidth((width) => {
        const chatPaneWidth =
          chatPaneRef.current?.getBoundingClientRect().width ??
          window.innerWidth - width;
        const maxWidth = Math.max(
          MIN_ARTIFACT_PANEL_WIDTH,
          width + chatPaneWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
        );
        return Math.min(width, maxWidth);
      });
    };
    clampWidth();
    window.addEventListener('resize', clampWidth);
    const chatPane = chatPaneRef.current;
    const observer = new ResizeObserver(clampWidth);
    if (chatPane) observer.observe(chatPane);
    return () => {
      window.removeEventListener('resize', clampWidth);
      observer.disconnect();
    };
  }, [artifactPanelOpen, artifactPanelFullscreen]);
  const closeArtifactPanelTabs = useCallback((tabIds: ReadonlySet<string>) => {
    if (tabIds.size === 0) return;
    for (const tab of artifactPanelTabsRef.current) {
      if (tabIds.has(tab.id) && tab.kind === 'terminal') {
        releaseWebTerminal(tab.id);
      }
    }
    setArtifactPanelTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => !tabIds.has(tab.id));
      if (nextTabs.length === tabs.length) return tabs;
      if (nextTabs.length === 0) {
        setArtifactPanelOpen(false);
        setArtifactPanelFullscreen(false);
        setSuppressArtifactDockOpenAnimation(false);
        setActiveArtifactPanelTabId(null);
        setReviewChanges([]);
        setSelectedReviewPath(null);
        setArtifactPanelExtraArtifacts([]);
        setPaneArtifactSnapshots(new Map());
        return nextTabs;
      }
      if (
        activeArtifactPanelTabIdRef.current &&
        tabIds.has(activeArtifactPanelTabIdRef.current)
      ) {
        const closedIndex = tabs.findIndex((tab) => tabIds.has(tab.id));
        const nextActive =
          nextTabs[Math.min(closedIndex, nextTabs.length - 1)] ?? nextTabs[0];
        setActiveArtifactPanelTabId(nextActive.id);
      }
      return nextTabs;
    });
  }, []);
  const closeArtifactPanelTab = useCallback(
    (tabId: string) => closeArtifactPanelTabs(new Set([tabId])),
    [closeArtifactPanelTabs],
  );
  const closeTokenUsageTabs = useCallback(
    (sessionIds?: readonly string[], paneOnly = false) => {
      const sessions = sessionIds ? new Set(sessionIds) : undefined;
      closeArtifactPanelTabs(
        new Set(
          artifactPanelTabsRef.current
            .filter(
              (tab) =>
                tab.kind === 'token_usage' &&
                (!paneOnly || tab.closeWithPane) &&
                (!sessions ||
                  (tab.sessionId !== undefined && sessions.has(tab.sessionId))),
            )
            .map((tab) => tab.id),
        ),
      );
    },
    [closeArtifactPanelTabs],
  );
  const handleArtifactPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const resizeHandle = event.currentTarget;
      resizeHandle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = artifactPanelWidth;
      const maxWidth = getMaxArtifactPanelWidth();
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      let pendingWidth = startWidth;
      let animationFrame: number | null = null;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const flushWidth = () => {
        animationFrame = null;
        setArtifactPanelWidth(pendingWidth);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        pendingWidth = Math.min(
          maxWidth,
          Math.max(
            MIN_ARTIFACT_PANEL_WIDTH,
            startWidth - (moveEvent.clientX - startX),
          ),
        );
        if (animationFrame === null) {
          animationFrame = window.requestAnimationFrame(flushWidth);
        }
      };
      let handlePointerUp: () => void = () => {};
      const cleanupResize = (commitWidth: boolean) => {
        artifactPanelResizeCleanupRef.current = null;
        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        if (commitWidth) setArtifactPanelWidth(pendingWidth);
        if (resizeHandle.hasPointerCapture(event.pointerId)) {
          resizeHandle.releasePointerCapture(event.pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };
      handlePointerUp = () => cleanupResize(true);
      artifactPanelResizeCleanupRef.current = () => cleanupResize(false);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [artifactPanelWidth, getMaxArtifactPanelWidth],
  );
  useEffect(() => () => artifactPanelResizeCleanupRef.current?.(), []);
  const rawPendingApproval = useMemo(
    () => extractPendingPermission(blocks),
    [blocks],
  );
  const pendingApproval = useShallowMemo(rawPendingApproval);
  const canActOnPendingApproval = !(
    connection.catchingUp && sidebarSwitchingSessionId !== null
  );
  const pendingAskUserApproval = isAskUserPermission(pendingApproval)
    ? canActOnPendingApproval
      ? pendingApproval
      : null
    : null;
  const pendingToolApproval =
    pendingApproval && !isAskUserPermission(pendingApproval)
      ? canActOnPendingApproval
        ? pendingApproval
        : null
      : null;
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = canActOnPendingApproval ? pendingApproval : null;
  // True exactly when an actionable approval overlay (ToolApproval or
  // AskUserQuestion) is on screen. Single source of truth for the three places
  // that must treat the composer as dormant while an approval owns the keyboard:
  // the panel auto-close, the panel focus-restore guard, and the ChatEditor
  // dialogOpen prop.
  const approvalOverlayActive =
    pendingToolApproval !== null || pendingAskUserApproval !== null;
  const approvalOverlayActiveRef = useRef(approvalOverlayActive);
  approvalOverlayActiveRef.current =
    approvalOverlayActive ||
    (canActOnPendingApproval && extractPendingPermission(blocks) !== null);
  const floatingTodosState = useMemo(
    () => getFloatingTodos(messages),
    [messages],
  );
  const approvalPlanTodos = useMemo(
    () =>
      isExitPlanApprovalRequest(pendingToolApproval)
        ? getActiveTodosForPlanRevision(messages, pendingToolApproval?.todoPlan)
        : [],
    [messages, pendingToolApproval],
  );
  // Keep the timeline Map referentially stable across streaming ticks that
  // don't touch any todo snapshot. The Map is a context value, so a fresh
  // reference would re-render every todo/plan row regardless of memoization;
  // only rebuild when the todo snapshots themselves change.
  const todoTimelineRef = useRef<{
    signature: string;
    timeline: Map<string, TodoSnapshotDiff>;
  } | null>(null);
  const todoTimeline = useMemo(() => {
    const signature = todoTimelineSignature(messages);
    const cached = todoTimelineRef.current;
    if (cached && cached.signature === signature) return cached.timeline;
    const timeline = computeTodoTimeline(messages);
    todoTimelineRef.current = { signature, timeline };
    return timeline;
  }, [messages]);
  // Per-todo detail (start/end + token/API/tool spend) is derived entirely from
  // the transcript: the agent stamps a cumulative-usage snapshot on each todo
  // update and the web-shell diffs consecutive snapshots, so this works live and
  // on resume with no polling. Kept referentially stable like the timeline
  // above (rebuilt only when a relevant snapshot, timestamp, stat, or tool span
  // changes) so an unrelated streaming tick doesn't re-render every expanded
  // todo row that consumes TodoDetailContext.
  const todoDetailRef = useRef<{
    signature: string;
    details: Map<string, TodoDetail>;
  } | null>(null);
  const todoDetails = useMemo(() => {
    const signature = todoDetailSignature(messages);
    const cached = todoDetailRef.current;
    if (cached && cached.signature === signature) return cached.details;
    const details = computeTodoDetails(messages);
    todoDetailRef.current = { signature, details };
    return details;
  }, [messages]);
  const floatingTodos = useStableArray(floatingTodosState.todos, (todo) =>
    JSON.stringify([todo.id, todo.status, todo.content, todo.blockedBy ?? []]),
  );
  const floatingTodosAllCompleted = floatingTodosState.allCompleted;
  const [todoPanelMode, setTodoPanelMode] = useState<'hidden' | 'active'>(
    'hidden',
  );
  const nextTodoPanelMode =
    connection.catchingUp ||
    floatingTodos.length === 0 ||
    floatingTodosAllCompleted
      ? 'hidden'
      : 'active';
  if (nextTodoPanelMode !== todoPanelMode) {
    setTodoPanelMode(nextTodoPanelMode);
  }
  const showFloatingTodos = nextTodoPanelMode !== 'hidden';
  const floatingBottomStatusItems =
    bottomStatusItems ?? EMPTY_BOTTOM_STATUS_ITEMS;
  const showBottomPanels =
    showFloatingTodos || floatingBottomStatusItems.length > 0;
  const footerRef = useRef<HTMLDivElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const portalRootVariableNamesRef = useRef<Set<string>>(new Set());
  const bottomPanelsRef = useRef<HTMLDivElement>(null);
  const [bottomPanelInset, setBottomPanelInset] = useState(0);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(0);
  useLayoutEffect(() => {
    if (!showBottomPanels) {
      setBottomPanelInset(0);
      setBottomPanelHeight(0);
      return;
    }
    const node = bottomPanelsRef.current;
    if (!node) {
      setBottomPanelInset(BOTTOM_PANEL_FALLBACK_INSET_PX);
      setBottomPanelHeight(0);
      return;
    }
    const updateInset = () => {
      const footer = footerRef.current;
      const panelRect = node.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const panelHeight = Math.ceil(panelRect.height);
      const overlapAboveFooter = footerRect
        ? Math.max(0, footerRect.top - panelRect.top)
        : panelHeight + BOTTOM_PANEL_GAP_PX;
      setBottomPanelHeight(panelHeight);
      setBottomPanelInset(
        Math.max(BOTTOM_PANEL_FALLBACK_INSET_PX, Math.ceil(overlapAboveFooter)),
      );
    };
    updateInset();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateInset);
    observer.observe(node);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, [showBottomPanels]);
  const contentStyle = useMemo(
    () =>
      ({
        '--web-shell-bottom-panel-inset': `${bottomPanelInset}px`,
        '--web-shell-bottom-panel-height': `${bottomPanelHeight}px`,
        '--web-shell-bottom-panel-gap': `${BOTTOM_PANEL_GAP_PX}px`,
      }) as CSSProperties,
    [bottomPanelHeight, bottomPanelInset],
  );
  const taskActivityKey = useMemo(
    () => getTaskActivityKey(messages),
    [messages],
  );
  // The activity fact travels beside the key, derived structurally — the
  // key itself is not parseable back (callId is unconstrained text).
  const taskActivityActive = useMemo(
    () => hasActiveTaskActivity(messages, { workflowsEnabled }),
    [messages, workflowsEnabled],
  );
  const [backgroundTasksRefreshTrigger, setBackgroundTasksRefreshTrigger] =
    useState(0);
  const sessionTasks = useBackgroundTasks(
    connection.sessionId,
    taskActivityKey,
    taskActivityActive,
    connection.status === 'connected',
    backgroundTasksRefreshTrigger,
    workflowsEnabled,
  );
  const terminalBackgroundShellTaskIdsKey = useMemo(
    () =>
      sessionTasks
        .filter((task) => task.kind === 'shell' && task.status !== 'running')
        .map((task) => task.id)
        .join(','),
    [sessionTasks],
  );
  // Preserve Set identity when polling returns an equivalent task snapshot.
  const terminalBackgroundShellTaskIds = useMemo(
    () =>
      new Set(
        terminalBackgroundShellTaskIdsKey
          ? terminalBackgroundShellTaskIdsKey.split(',')
          : [],
      ),
    [terminalBackgroundShellTaskIdsKey],
  );
  const backgroundTasks = useMemo(
    // Same rule as the status-bar pill: live background state only, never
    // the project's retained workflow history.
    () => sessionTasks.filter(isComposerTask),
    [sessionTasks],
  );
  const monitorDetailsSessionIdRef = useRef(connection.sessionId);
  monitorDetailsSessionIdRef.current = connection.sessionId;
  const openMonitorPanelFromTool = useCallback(
    async (tool: ACPToolCall): Promise<boolean> => {
      const sessionId = monitorDetailsSessionIdRef.current;
      if (!sessionId) return false;
      const owner = sessionOwnerGuard.capture();
      try {
        const snapshot = await sessionActions.getTasks();
        if (
          !owner.isCurrent() ||
          monitorDetailsSessionIdRef.current !== sessionId ||
          snapshot.sessionId !== sessionId
        ) {
          return false;
        }
        const task = findMonitorTaskForTool(snapshot.tasks, tool);
        if (!task) return false;
        setBackgroundTasksRefreshTrigger((value) => value + 1);
        openMonitorPanel(task);
        return true;
      } catch {
        return false;
      }
    },
    [openMonitorPanel, sessionActions, sessionOwnerGuard],
  );
  useEffect(() => {
    const monitors = new Map(
      backgroundTasks
        .filter(
          (task): task is DaemonSessionMonitorTaskStatus =>
            task.kind === 'monitor',
        )
        .map((task) => [task.id, task]),
    );
    if (monitors.size === 0) return;
    setArtifactPanelTabs((tabs) => {
      let changed = false;
      const next = tabs.map((tab) => {
        if (
          tab.kind !== 'monitor' ||
          (tab.sessionId && tab.sessionId !== connection.sessionId)
        ) {
          return tab;
        }
        const task = monitors.get(tab.task.id);
        if (!task || task === tab.task) return tab;
        const mergedTask = mergeMonitorTaskSnapshot(tab.task, task);
        if (mergedTask === tab.task) return tab;
        changed = true;
        return {
          ...tab,
          title: mergedTask.description,
          task: mergedTask,
        };
      });
      return changed ? next : tabs;
    });
  }, [backgroundTasks, connection.sessionId]);
  useEffect(() => {
    const shellTasks = new Map(
      backgroundTasks
        .filter(
          (task): task is DaemonSessionShellTaskStatus => task.kind === 'shell',
        )
        .map((task) => [task.id, task]),
    );
    if (shellTasks.size === 0) return;
    setArtifactPanelTabs((tabs) => {
      let changed = false;
      const next = tabs.map((tab) => {
        if (
          tab.kind !== 'shell' ||
          (tab.sessionId && tab.sessionId !== connection.sessionId)
        ) {
          return tab;
        }
        const task = shellTasks.get(tab.task.id);
        if (!task || task === tab.task) return tab;
        const mergedTask = mergeShellTaskSnapshot(tab.task, task);
        if (mergedTask === tab.task) return tab;
        changed = true;
        return {
          ...tab,
          title: mergedTask.command,
          task: mergedTask,
        };
      });
      return changed ? next : tabs;
    });
  }, [backgroundTasks, connection.sessionId]);
  const footerTasks = useMemo(
    () => (renderFooter ? backgroundTasks.map(mapToWebShellTaskInfo) : []),
    [backgroundTasks, renderFooter],
  );
  const statusBarRef = useRef<StatusBarHandle>(null);
  const messageListRef = useRef<MessageListHandle | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const notifiedComposerReadyRef = useRef<EditorHandle | null>(null);
  const [canScrollMessageListToBottom, setCanScrollMessageListToBottom] =
    useState(false);
  const previousFooterRectRef = useRef<DOMRect | null>(null);
  const previousEmptyStateRef = useRef(false);
  const resumeChatBottomFollow = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToBottom(behavior);
        requestAnimationFrame(() => {
          messageListRef.current?.scrollToBottom(behavior);
        });
      });
    },
    [],
  );
  const setEditorHandle = useCallback(
    (handle: EditorHandle | null) => {
      editorRef.current = handle;
      assignComposerRef(composerRef, handle ?? emptyComposerApi);
      if (handle && notifiedComposerReadyRef.current !== handle) {
        notifiedComposerReadyRef.current = handle;
        onComposerReady?.(handle);
      }
    },
    [composerRef, onComposerReady],
  );
  useEffect(() => {
    assignComposerRef(composerRef, editorRef.current ?? emptyComposerApi);
  }, [composerRef]);
  const [goalSnapshot, setGoalSnapshot] = useState<GoalSnapshotV2 | null>(null);
  const goalSnapshotRef = useRef<GoalSnapshotV2 | null>(null);
  goalSnapshotRef.current = goalSnapshot;
  const [goalControlBusy, setGoalControlBusy] = useState(false);
  // Which control operation owns the busy latch, mirroring ChatPane's twin. A
  // finishing operation must not release the latch under a newer one that is
  // still in flight, or the strip re-enables mid-control and a second dispatch
  // races the first against the same expected revision.
  const goalControlOpSeqRef = useRef(0);
  const goalControlOwnerRef = useRef<
    { opId: number; sessionId: string | undefined } | undefined
  >(undefined);
  const [goalEditOpen, setGoalEditOpen] = useState(false);
  const [goalEditError, setGoalEditError] = useState<string | null>(null);
  useLayoutEffect(() => {
    setGoalSnapshot(null);
    goalControlOwnerRef.current = undefined;
    setGoalControlBusy(false);
    setGoalEditOpen(false);
    setGoalEditError(null);
  }, [logicalSessionKey]);
  const [isCreatingMissingSession, setIsCreatingMissingSession] =
    useState(false);
  const creatingMissingSessionRef = useRef(false);
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
  const composerTextRef = useRef('');
  const [hasComposerAttachments, setHasComposerAttachments] = useState<
    boolean | null
  >(null);
  const [isStartingNewSessionSuggestion, setIsStartingNewSessionSuggestion] =
    useState(false);
  const streamingState = useStreamingState();
  const failedPromptRetryIsCurrent = Boolean(
    failedPromptRetry &&
      retryOwnerMatchesCurrent(
        failedPromptRetry.owner,
        connection.sessionId,
        connection.workspaceCwd,
        composerSourceVersionRef.current,
      ) &&
      retryTranscriptIdentityMatches(
        blocks,
        failedPromptRetry.transcriptIdentity,
      ),
  );
  useEffect(() => {
    if (
      failedPromptRetry &&
      (!failedPromptRetryIsCurrent ||
        (streamingState === 'idle' && failedPromptRetry.settled))
    ) {
      setFailedPromptRetry(null);
    }
  }, [failedPromptRetry, failedPromptRetryIsCurrent, streamingState]);
  const suppressFailedPromptRetryStreaming = Boolean(
    failedPromptRetry &&
      failedPromptRetryIsCurrent &&
      (!failedPromptRetry.admitted || failedPromptRetry.settled),
  );
  const streamingStateRef = useRef<DaemonStreamingState>(streamingState);
  streamingStateRef.current = streamingState;
  // Cleared in three places: the session-switch effect, the drain loop, and
  // handleCancel. Bumping drainGenerationRef at each clear site also cancels
  // any in-flight inline ! command whose ensureSessionForPrompt is resolving.
  // The session-switch effect exempts the lazy-creation transition (into
  // preparingSessionIdRef.current) so a submit's own session creation does
  // not cancel the command.
  const queuedShellCommandsRef = useRef<string[]>([]);
  const drainGenerationRef = useRef(0);
  const shellSubmitInFlightRef = useRef(false);
  const isDrainingRef = useRef(false);
  const localStreamingStartedAtRef = useRef(Date.now());
  const previousStreamingStateRef =
    useRef<DaemonStreamingState>(streamingState);
  if (
    previousStreamingStateRef.current === 'idle' &&
    streamingState !== 'idle'
  ) {
    localStreamingStartedAtRef.current = Date.now();
  }
  previousStreamingStateRef.current = streamingState;
  const activeTurnStartedAt = useMemo(() => {
    if (streamingState === 'idle') return undefined;
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const message = displayMessages[i];
      if (message?.role === 'user') {
        return message.timestamp ?? localStreamingStartedAtRef.current;
      }
    }
    return localStreamingStartedAtRef.current;
  }, [displayMessages, streamingState]);
  const lastSubmittedPromptRef = useRef<string>('');
  const lastSubmittedImagesRef = useRef<PromptImage[] | undefined>(undefined);
  const lastSubmittedFilesRef = useRef<PromptFile[] | undefined>(undefined);
  const lastSubmittedInputAnnotationsRef = useRef<
    DaemonInputAnnotation[] | undefined
  >(undefined);
  const lastSubmittedSourceVersionRef = useRef(
    composerSourceVersionRef.current,
  );
  const retryableTurnErrorIdRef = useRef<string | null>(null);
  const lastTurnErrorIdRef = useRef<string | null>(null);
  const retryableTurnErrorIdentityRef = useRef<
    TranscriptTurnErrorIdentity | undefined
  >(undefined);
  const retriedTurnErrorIdRef = useRef<string | null>(null);
  const failedTurnErrorRetryRef = useRef<{
    errorId: string;
    text: string;
    images?: PromptImage[];
    files?: PromptFile[];
    inputAnnotations?: DaemonInputAnnotation[];
    owner: CancelledRetryOwner;
  } | null>(null);
  const [showRetryHint, setShowRetryHint] = useState(false);
  const showRetryHintRef = useRef(showRetryHint);
  showRetryHintRef.current = showRetryHint;
  const rearmFailedTurnErrorRetry = useCallback(
    (
      retryableTurnError: DaemonTranscriptBlock,
      currentBlocks: readonly DaemonTranscriptBlock[],
    ) => {
      const failedRetry = failedTurnErrorRetryRef.current;
      if (!failedRetry || retryableTurnError.id === failedRetry.errorId) {
        return;
      }
      if (
        !retryOwnerMatchesCurrent(
          failedRetry.owner,
          connectionRef.current.sessionId,
          connectionRef.current.workspaceCwd,
          composerSourceVersionRef.current,
        )
      ) {
        failedTurnErrorRetryRef.current = null;
        return;
      }
      if (
        !currentBlocks.some(
          (block) =>
            block.kind === 'error' &&
            block.source === 'turn_error' &&
            block.id === failedRetry.errorId,
        )
      ) {
        failedTurnErrorRetryRef.current = null;
        return;
      }
      lastSubmittedPromptRef.current = failedRetry.text;
      lastSubmittedImagesRef.current = failedRetry.images;
      lastSubmittedFilesRef.current = failedRetry.files;
      lastSubmittedInputAnnotationsRef.current = failedRetry.inputAnnotations;
      lastSubmittedSourceVersionRef.current = composerSourceVersionRef.current;
      retryableTurnErrorIdRef.current = retryableTurnError.id;
      retryableTurnErrorIdentityRef.current = { block: retryableTurnError };
      retriedTurnErrorIdRef.current = null;
      failedTurnErrorRetryRef.current = null;
      setShowRetryHint(true);
    },
    [],
  );
  const retryOwnerRef = useRef<CancelledRetryOwner>({
    sessionId: connection.sessionId,
    workspaceCwd: connection.workspaceCwd,
    sessionKey: logicalSessionKey,
    sourceVersion: composerSourceVersionRef.current,
    snapshot: sessionOwnerGuard.capture(),
  });
  useLayoutEffect(() => {
    const previousOwner = retryOwnerRef.current;
    const currentSnapshot = sessionOwnerGuard.capture();
    const workspaceBecameKnown =
      previousOwner.sessionId !== undefined &&
      previousOwner.sessionId === connection.sessionId &&
      previousOwner.workspaceCwd === undefined &&
      connection.workspaceCwd !== undefined &&
      previousOwner.snapshot.isCurrent();
    if (workspaceBecameKnown && logicalSessionKey) {
      const previousSessionKey = previousOwner.sessionKey;
      previousOwner.workspaceCwd = connection.workspaceCwd;
      previousOwner.sessionKey = logicalSessionKey;
      previousOwner.snapshot = currentSnapshot;
      const previousStates =
        previousSessionKey !== undefined
          ? cancelledRetryStatesRef.current.get(previousSessionKey)
          : undefined;
      if (
        previousSessionKey &&
        previousStates &&
        previousSessionKey !== logicalSessionKey
      ) {
        const currentStates =
          cancelledRetryStatesRef.current.get(logicalSessionKey) ?? [];
        cancelledRetryStatesRef.current.set(
          logicalSessionKey,
          mergeCancelledRetryEntries(
            currentStates,
            previousStates.map((previous) => ({ state: previous.state })),
          ),
        );
        cancelledRetryStatesRef.current.delete(previousSessionKey);
      }
      return;
    }
    if (
      retryOwnerMatchesCurrent(
        previousOwner,
        connection.sessionId,
        connection.workspaceCwd,
        composerSourceVersionRef.current,
      )
    ) {
      return;
    }
    if (previousOwner.workspaceCwd === undefined && previousOwner.sessionKey) {
      cancelledRetryStatesRef.current.delete(previousOwner.sessionKey);
    }
    retryOwnerRef.current = {
      sessionId: connection.sessionId,
      workspaceCwd: connection.workspaceCwd,
      sessionKey: logicalSessionKey,
      sourceVersion: composerSourceVersionRef.current,
      snapshot: currentSnapshot,
    };
    lastSubmittedPromptRef.current = '';
    lastSubmittedImagesRef.current = undefined;
    lastSubmittedFilesRef.current = undefined;
    lastSubmittedInputAnnotationsRef.current = undefined;
    lastSubmittedSourceVersionRef.current = -1;
    retryableTurnErrorIdRef.current = null;
    retryableTurnErrorIdentityRef.current = undefined;
    retriedTurnErrorIdRef.current = null;
    failedTurnErrorRetryRef.current = null;
    setShowRetryHint(false);
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    logicalSessionKey,
    sessionOwnerGuard,
  ]);
  const applyCancelledRetryState = useCallback(
    (state: CancelledRetryState): CancelledRetryRestoreResult => {
      const currentBlocks = store.getSnapshot().blocks;
      if (state.kind === 'failed-prompt') {
        let failed = state.failed;
        const latestUserMessage = getLatestUserBlock(currentBlocks);
        if (!matchesUserMessageIdentity(latestUserMessage, failed.identity)) {
          if (
            !matchesUserMessageIdentity(
              latestUserMessage,
              failed.previousIdentity,
            )
          ) {
            return 'invalid';
          }
          store.appendLocalUserMessage(
            failed.text,
            failed.images?.map((image) => ({
              data: image.data,
              mimeType: image.media_type,
            })),
            failed.inputAnnotations?.length
              ? { inputAnnotations: failed.inputAnnotations }
              : undefined,
            failed.files?.map((file) => ({
              name: file.name,
              mimeType: file.media_type,
            })),
          );
          const rehydratedMessage = getLatestUserBlock(
            store.getSnapshot().blocks,
          );
          if (!rehydratedMessage || rehydratedMessage === latestUserMessage) {
            return 'invalid';
          }
          failed = {
            ...failed,
            messageId: rehydratedMessage.id,
            identity: { block: rehydratedMessage },
          };
          state.failed = failed;
        } else if (
          latestUserMessage &&
          (latestUserMessage.id !== failed.messageId ||
            latestUserMessage !== failed.identity.block)
        ) {
          failed = {
            ...failed,
            messageId: latestUserMessage.id,
            identity: { block: latestUserMessage },
          };
          state.failed = failed;
        }
        if (
          !displayMessages.some((message) => message.id === failed.messageId)
        ) {
          return 'pending';
        }
        failed = {
          ...failed,
          owner: retryOwnerRef.current,
        };
        state.failed = failed;
        updateFailedPrompt(failed);
        setFailedPromptRetry(null);
        return 'restored';
      }
      const currentTurnError = getRetryableTurnError(currentBlocks);
      if (!matchesTurnErrorIdentity(currentTurnError, state.identity)) {
        return 'invalid';
      }
      const renderedTurnError = getRetryableTurnError(blocks);
      if (
        !renderedTurnError ||
        !matchesTurnErrorIdentity(renderedTurnError, state.identity)
      ) {
        return 'pending';
      }
      lastSubmittedPromptRef.current = state.text;
      lastSubmittedImagesRef.current = state.images;
      lastSubmittedFilesRef.current = state.files;
      lastSubmittedInputAnnotationsRef.current = state.inputAnnotations;
      lastSubmittedSourceVersionRef.current = composerSourceVersionRef.current;
      retryableTurnErrorIdRef.current = renderedTurnError.id;
      retryableTurnErrorIdentityRef.current = { block: renderedTurnError };
      retriedTurnErrorIdRef.current = state.previousRetriedTurnErrorId;
      setShowRetryHint(state.previousShowRetryHint);
      setFailedPromptRetry(null);
      return 'restored';
    },
    [blocks, displayMessages, store, updateFailedPrompt],
  );
  const restoreOrDeferCancelledRetry = useCallback(
    (owner: CancelledRetryOwner, state: CancelledRetryState) => {
      const resolvedSessionKey = owner.sessionKey;
      if (
        !resolvedSessionKey ||
        (owner.workspaceCwd === undefined && !owner.snapshot.isCurrent())
      ) {
        return;
      }
      const states = mergeCancelledRetryEntries(
        cancelledRetryStatesRef.current.get(resolvedSessionKey) ?? [],
        [
          {
            ...(owner.workspaceCwd === undefined ? { owner } : {}),
            state,
          },
        ],
      );
      cancelledRetryStatesRef.current.set(resolvedSessionKey, states);
      if (appMountedRef.current) {
        setCancelledRetryRevision((current) => current + 1);
      }
    },
    [],
  );
  useLayoutEffect(() => {
    if (
      !logicalSessionKey ||
      sessionWriteBlocked ||
      connection.loadingTranscript ||
      connection.catchingUp
    ) {
      return;
    }
    const exactStates =
      cancelledRetryStatesRef.current.get(logicalSessionKey) ?? [];
    const pendingExactStates: CancelledRetryEntry[] = [];
    for (const entry of exactStates) {
      if (entry.owner && !entry.owner.snapshot.isCurrent()) {
        continue;
      }
      if (applyCancelledRetryState(entry.state) === 'pending') {
        pendingExactStates.push(entry);
      }
    }
    if (pendingExactStates.length > 0) {
      cancelledRetryStatesRef.current.set(
        logicalSessionKey,
        pendingExactStates,
      );
    } else {
      cancelledRetryStatesRef.current.delete(logicalSessionKey);
    }
  }, [
    applyCancelledRetryState,
    cancelledRetryRevision,
    connection.catchingUp,
    connection.loadingTranscript,
    logicalSessionKey,
    sessionWriteBlocked,
  ]);
  const connected = connection.status === 'connected';
  const workspaceEventSignals = useWorkspaceEventSignals();
  const [loadedSkills, setLoadedSkills] = useState<SkillInfo[]>([]);
  const [loadedSkillsReady, setLoadedSkillsReady] = useState(false);
  const [loadedSkillsFallback, setLoadedSkillsFallback] = useState<{
    sessionId: string;
    workspaceCwd: string | undefined;
  }>();
  const connectionSkillSnapshotRef = useRef({
    sessionId: connection.sessionId,
    skills: connection.skills,
  });
  connectionSkillSnapshotRef.current = {
    sessionId: connection.sessionId,
    skills: connection.skills,
  };
  const loadedSkillsRequestRef = useRef(0);
  const reloadLoadedSkills = useCallback(
    async (workspaceCwd?: string, notifyOnError = false) => {
      const request = ++loadedSkillsRequestRef.current;
      try {
        const status =
          workspaceCwd && workspace.client
            ? await workspace.client
                .workspaceByCwd(workspaceCwd)
                .workspaceSkills()
            : await workspaceActions.loadSkillsStatus();
        if (request !== loadedSkillsRequestRef.current) return;
        setLoadedSkills(availableSkillInfos(status));
        setLoadedSkillsReady(true);
        return status;
      } catch (error) {
        if (notifyOnError) {
          pushToast(
            'error',
            formatError(error, 'Failed to refresh composer skills'),
          );
        }
        return false;
      }
    },
    [pushToast, workspace.client, workspaceActions],
  );
  useEffect(() => {
    if (!connected) return;
    if (!workspaceContextActive) {
      loadedSkillsRequestRef.current += 1;
      setLoadedSkills([]);
      setLoadedSkillsReady(true);
      setLoadedSkillsFallback(undefined);
      return;
    }
    void reloadLoadedSkills(connection.workspaceCwd);
  }, [
    connected,
    connection.workspaceCwd,
    reloadLoadedSkills,
    workspaceContextActive,
  ]);
  const handledSkillMutationKeysRef = useRef(new Set<string>());
  const pendingSkillTogglesByContextRef = useRef(
    new Map<string, Array<{ name: string; enabled: boolean }>>(),
  );
  useEffect(() => {
    if (!workspaceContextActive) {
      handledSkillMutationKeysRef.current.clear();
      pendingSkillTogglesByContextRef.current.clear();
      return;
    }
    if (!connected) {
      handledSkillMutationKeysRef.current.clear();
      return;
    }
    const sessionId = connection.sessionId;
    const workspaceCwd = connection.workspaceCwd;
    const contextKey = `${workspaceCwd ?? ''}\n${sessionId ?? ''}`;
    const mutations = skillMutationsForWorkspace(
      workspaceEventSignals?.lastSkillMutation,
      workspaceEventSignals?.skillMutationsByCwd,
      workspaceCwd,
    );
    const mutationKeys = mutations.map(
      (mutation) => `${contextKey}\n${mutation.id}`,
    );
    const unhandled = mutations.filter(
      (_, index) =>
        !handledSkillMutationKeysRef.current.has(mutationKeys[index]!),
    );
    if (unhandled.length === 0) return;
    const markHandled = () => {
      for (const mutationKey of mutationKeys) {
        handledSkillMutationKeysRef.current.add(mutationKey);
      }
    };
    const priorPending =
      pendingSkillTogglesByContextRef.current.get(contextKey) ?? [];
    const pendingToggles = mergeSkillToggles(
      priorPending,
      unhandled.flatMap((mutation) => mutation.skills),
    );
    const sessionSkills = connectionSkillSnapshotRef.current.skills;
    if (
      sessionId &&
      sessionSkills !== undefined &&
      priorPending.length === 0 &&
      unhandled.every(
        (mutation) =>
          mutation.activation === 'applied' &&
          mutation.sessionsFailed === 0 &&
          mutation.sessionsRefreshed > 0,
      )
    ) {
      markHandled();
      setLoadedSkillsFallback(undefined);
      return;
    }
    pendingSkillTogglesByContextRef.current.set(contextKey, pendingToggles);
    let cancelled = false;
    void reloadLoadedSkills(workspaceCwd, true).then((status) => {
      if (cancelled || !status) return;
      markHandled();
      if (!sessionId) {
        pendingSkillTogglesByContextRef.current.delete(contextKey);
        return;
      }
      const availableWorkspaceSkillNames = new Set(
        status.skills
          .filter((skill) => skill.status === 'ok')
          .map((skill) => skill.name.toLowerCase()),
      );
      const pendingForSession = pendingToggles.filter(
        (toggle) =>
          !toggle.enabled ||
          availableWorkspaceSkillNames.has(toggle.name.toLowerCase()),
      );
      if (pendingForSession.length === 0) {
        pendingSkillTogglesByContextRef.current.delete(contextKey);
        setLoadedSkillsFallback(undefined);
        return;
      }
      pendingSkillTogglesByContextRef.current.set(
        contextKey,
        pendingForSession,
      );
      const currentSnapshot = connectionSkillSnapshotRef.current;
      if (
        currentSnapshot.sessionId === sessionId &&
        sessionSkillsReflectToggle(currentSnapshot.skills, pendingForSession)
      ) {
        pendingSkillTogglesByContextRef.current.delete(contextKey);
        setLoadedSkillsFallback(undefined);
        return;
      }
      setLoadedSkillsFallback({ sessionId, workspaceCwd });
    });
    return () => {
      cancelled = true;
    };
  }, [
    connected,
    connection.sessionId,
    connection.workspaceCwd,
    reloadLoadedSkills,
    workspaceEventSignals?.lastSkillMutation,
    workspaceEventSignals?.skillMutationsByCwd,
    workspaceContextActive,
  ]);
  useEffect(() => {
    if (!loadedSkillsFallback) return;
    if (
      connection.sessionId !== loadedSkillsFallback.sessionId ||
      connection.workspaceCwd !== loadedSkillsFallback.workspaceCwd
    ) {
      const previousContextKey = `${loadedSkillsFallback.workspaceCwd ?? ''}\n${loadedSkillsFallback.sessionId}`;
      for (const mutationKey of handledSkillMutationKeysRef.current) {
        if (mutationKey.startsWith(`${previousContextKey}\n`)) {
          handledSkillMutationKeysRef.current.delete(mutationKey);
        }
      }
      setLoadedSkillsFallback(undefined);
      return;
    }
    const contextKey = `${connection.workspaceCwd ?? ''}\n${connection.sessionId ?? ''}`;
    const pendingToggles =
      pendingSkillTogglesByContextRef.current.get(contextKey) ?? [];
    if (
      pendingToggles.length > 0 &&
      sessionSkillsReflectToggle(connection.skills, pendingToggles)
    ) {
      pendingSkillTogglesByContextRef.current.delete(contextKey);
      setLoadedSkillsFallback(undefined);
    }
  }, [
    connection.sessionId,
    connection.skills,
    connection.workspaceCwd,
    loadedSkillsFallback,
  ]);

  const [modelDialogMode, setModelDialogMode] =
    useState<ModelDialogMode | null>(null);
  // Mirror of modelDialogMode (and the fallbacks/auth dialog flags below) for
  // reading the latest values inside the async voice loadProviders callback, so
  // it doesn't open the voice picker on top of a surface opened while loading
  // (see the voiceModel branch in onSubDialog).
  const modelDialogModeRef = useRef<ModelDialogMode | null>(modelDialogMode);
  // Scope a model sub-dialog opened from the Settings panel persists to. Set
  // when opening from the User/Workspace settings tab; reset to 'workspace'
  // whenever the model dialog closes (any path) so command-launched pickers
  // (/model --vision, etc.) always write workspace.
  const [modelSettingScope, setModelSettingScope] = useState<
    'workspace' | 'user'
  >('workspace');
  const [showFallbacksDialog, setShowFallbacksDialog] = useState(false);
  const showFallbacksDialogRef = useRef(showFallbacksDialog);
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[]>([]);
  const [showApprovalModeDialog, setShowApprovalModeDialog] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [showRewindDialog, setShowRewindDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showToolsDialog, setShowToolsDialog] = useState(false);
  // The workspace the Git dialog reads. Set by whichever entry point opened
  // it — the composer git chip / `/diff` (current workspace) or a sidebar
  // folder's git chip (that workspace) — so each can target its own repo.
  const [gitDialog, setGitDialog] = useState<
    { workspaceCwd: string; gitCwd?: string; view: GitDialogView } | undefined
  >(undefined);
  // Main content view. The scheduled-tasks page replaces the chat pane inline
  // (not a modal overlay), mirroring the reference design; creating or opening
  // a chat returns to 'chat'. (Daemon Status is no longer a boolean dialog — it
  // is one of the activePanel values below.)
  const [mainView, setMainView] = useState<MainView>('chat');
  const mainViewRef = useRef(mainView);
  const showChat = useCallback(() => {
    if (cockpitViewRequested()) updateCockpitLocation(false);
    setMainView('chat');
  }, []);
  const useFloatingArtifactPanel =
    !canDockArtifactPanel || mainView === 'split';
  // The floating drawer mounts already-open. Only a genuine closed->open may
  // move focus into it: the docked->floating hand-over of an open panel
  // (viewport resize, split view) mounts the drawer mid-session, where
  // autofocus would yank focus from whatever the user is typing. The ref
  // tracks the panel's open state at the last render where the drawer was
  // NOT mounted and stays frozen while it is, so re-renders never flip the
  // prop under the drawer's mount-time autofocus wiring.
  const floatingArtifactPanelVisible =
    artifactPanelOpen && useFloatingArtifactPanel;
  const artifactPanelOpenBeforeDrawerMountRef = useRef(artifactPanelOpen);
  if (!floatingArtifactPanelVisible) {
    artifactPanelOpenBeforeDrawerMountRef.current = artifactPanelOpen;
  }
  const floatingArtifactDrawerAutoFocus =
    floatingArtifactPanelVisible &&
    !artifactPanelOpenBeforeDrawerMountRef.current;
  const deferSubagentMount =
    waitForSubagentPanelAnimation &&
    artifactPanelOpen &&
    !artifactPanelFullscreen &&
    (useFloatingArtifactPanel ||
      (!prefersReducedMotion && !suppressArtifactDockOpenAnimation));
  useLayoutEffect(() => {
    if (waitForSubagentPanelAnimation && !deferSubagentMount) {
      setWaitForSubagentPanelAnimation(false);
    }
  }, [deferSubagentMount, waitForSubagentPanelAnimation]);
  useEffect(() => {
    if (!deferSubagentMount) return;
    const timeout = window.setTimeout(
      () => setWaitForSubagentPanelAnimation(false),
      SUBAGENT_PANEL_ANIMATION_FALLBACK_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [deferSubagentMount]);
  const toggleArtifactPanelFullscreen = useCallback(() => {
    setArtifactPanelFullscreen((value) => !value);
    // Only the docked node replays its open animation on the fullscreen ->
    // docked class swap; the floating drawer has no such replay.
    if (!useFloatingArtifactPanel) setSuppressArtifactDockOpenAnimation(true);
  }, [useFloatingArtifactPanel]);
  useEffect(() => {
    if (!artifactPanelOpen) {
      setArtifactPanelFullscreen(false);
      setSuppressArtifactDockOpenAnimation(false);
    } else if (useFloatingArtifactPanel) {
      // The dock node unmounts while the drawer takes over; a stale flag would
      // suppress the slide-in of the next genuine dock mount. Keep it while
      // fullscreen persists: the next dock mount enters the fullscreen class,
      // and shrinking it back still replays the slide-in without the flag.
      if (!artifactPanelFullscreen) {
        setSuppressArtifactDockOpenAnimation(false);
      }
    } else if (artifactPanelFullscreen) {
      // Floating -> docked hand-over mid-fullscreen: the toggle never set the
      // flag (the panel was floating when it fired), but shrinking the dock
      // back to its docked class would replay the slide-in.
      setSuppressArtifactDockOpenAnimation(true);
    }
  }, [artifactPanelOpen, useFloatingArtifactPanel, artifactPanelFullscreen]);
  const dockedFullscreenActive =
    artifactPanelOpen && !useFloatingArtifactPanel && artifactPanelFullscreen;
  // Fullscreen moves the docked panel's portal slot into the top-level portal
  // root so a transformed/paint-contained/lower-stacking host ancestor can
  // neither bound the fixed surface nor paint over it; shrinking moves it
  // back. The wrapper itself is portaled INTO the slot, so it stays mounted
  // (and React's delegated listeners stay attached to the slot) across the
  // move — a remount would discard panel-local state.
  useLayoutEffect(() => {
    const slot = artifactPanelSlotEl;
    if (!slot || !dockedFullscreenActive) return;
    const host = slot.parentElement;
    if (!host) return;
    const next = slot.nextSibling;
    (portalRoot ?? document.body).appendChild(slot);
    return () => {
      host.insertBefore(slot, next);
    };
  }, [dockedFullscreenActive, portalRoot, artifactPanelSlotEl]);
  // Document-level modal semantics for the fullscreen surface,
  // matching what the floating variant gets from vaul's Radix dialog: hide
  // every outside tree from AT (Tab containment is the surface's own keydown
  // handler) and move stray focus into the surface — the covered chat subtree
  // drops focus to body when it goes display:none.
  useLayoutEffect(() => {
    const surface = artifactPanelFullscreenSurfaceRef.current;
    if (!dockedFullscreenActive || !surface) return;
    const hidden: Array<{ element: Element; previous: string | null }> = [];
    let node: Element | null = surface;
    while (node && node !== document.body) {
      const root = node.getRootNode();
      const parent: Element | null =
        node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) continue;
        // The elevated toast host shares this portal root and must stay
        // announced (and dismissible) while the surface is up.
        if (sibling.matches('[data-web-shell-toast-host]')) continue;
        hidden.push({
          element: sibling,
          // A live hideOthers lock (e.g. the floating drawer unmounting in
          // the same commit that mounts the surface) owns this value; its
          // unlock restores the true original itself.
          previous: sibling.hasAttribute('data-aria-hidden')
            ? null
            : sibling.getAttribute('aria-hidden'),
        });
        sibling.setAttribute('aria-hidden', 'true');
      }
      node = parent;
    }
    // document.activeElement retargets to the shadow host in shadow-DOM
    // portal mode; read the focused node from the surface's own root.
    const surfaceActive = getShadowAwareActiveElement(surface);
    if (!surface.contains(surfaceActive)) surface.focus();
    // Keydowns inside the sandboxed HTML preview iframe never reach the
    // surface's Tab-wrap handler or the window Escape handler, and a Tab
    // past the preview's last focusable lands focus natively outside the
    // surface. Pull stray focus back like the floating variant's Radix
    // focus trap, so the keyboard stays the surface's escape route.
    const pullStrayFocusIntoSurface = (event: FocusEvent) => {
      // focusin is composed: at this document-level listener the browser
      // retargets it to the shadow host, so resolve the real node.
      const target =
        (event.composedPath()[0] as Element | undefined) ??
        (event.target as Element | null);
      if (!target || surface.contains(target) || target.contains(surface)) {
        return;
      }
      // The elevated toast host and any Radix layer opened from the panel
      // share this portal root and stay actionable beside the surface.
      if (portalRoot?.contains(target)) return;
      surface.focus();
    };
    document.addEventListener('focusin', pullStrayFocusIntoSurface);
    return () => {
      document.removeEventListener('focusin', pullStrayFocusIntoSurface);
      for (const { element, previous } of hidden) {
        const restore = () => {
          if (previous === null) element.removeAttribute('aria-hidden');
          else element.setAttribute('aria-hidden', previous);
        };
        if (!element.hasAttribute('data-aria-hidden')) {
          restore();
          continue;
        }
        // A Radix hideOthers lock (a DialogShell opened over the surface)
        // owns this node now: it recorded the node as already hidden, so its
        // own unlock will not restore it, and restoring now would expose the
        // app behind the open modal. Wait for the lock's marker to drop.
        const observer = new MutationObserver(() => {
          if (element.hasAttribute('data-aria-hidden')) return;
          observer.disconnect();
          restore();
        });
        observer.observe(element, {
          attributes: true,
          attributeFilter: ['data-aria-hidden'],
        });
      }
    };
  }, [dockedFullscreenActive, portalRoot]);
  const handleArtifactPanelSurfaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!artifactPanelFullscreen) return;
      if (
        event.key !== 'Tab' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const [first, last] = getFullscreenSurfaceTabEdges(event.currentTarget);
      const focused = getShadowAwareActiveElement(event.currentTarget);
      if (!first || !last) {
        if (focused === event.currentTarget) event.preventDefault();
        return;
      }
      if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (focused === first || focused === event.currentTarget)
      ) {
        event.preventDefault();
        last.focus();
      }
    },
    [artifactPanelFullscreen],
  );
  // The drawer's Radix dismiss layer only checks `event.key === 'Escape'`
  // (no isComposing guard), so while composing in a panel input an Escape
  // that cancels the composition would close the drawer — and its
  // preventDefault would swallow the native cancel. Mask the key for the
  // capture-phase dismiss listener and restore it before the event reaches
  // the focused input, mirroring DialogShell.preserveImeEscape. The docked
  // fullscreen branch is covered by the window handler's IME guard.
  useEffect(() => {
    if (!artifactPanelOpen || !useFloatingArtifactPanel) return;
    const preserveImeEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!event.isComposing && event.keyCode !== 229)
      ) {
        return;
      }
      Object.defineProperty(event, 'key', {
        configurable: true,
        value: 'Process',
      });
      document.addEventListener(
        'keydown',
        (currentEvent) => {
          if (currentEvent === event) Reflect.deleteProperty(event, 'key');
        },
        { capture: true, once: true },
      );
    };
    window.addEventListener('keydown', preserveImeEscape, { capture: true });
    return () => {
      window.removeEventListener('keydown', preserveImeEscape, {
        capture: true,
      });
    };
  }, [artifactPanelOpen, useFloatingArtifactPanel]);
  // Sessions to seed the split view with (e.g. the selection from the overview).
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>([]);
  // Latest pane list, readable from the shrink-close effect without making it a
  // dependency (it changes on every pane add/remove).
  const splitSessionIdsRef = useRef<string[]>(splitSessionIds);
  const splitClassificationGenerationRef = useRef(0);
  splitSessionIdsRef.current = splitSessionIds;
  const previousSplitSessionIdsRef = useRef<string[]>(splitSessionIds);
  useEffect(() => {
    const nextIds = new Set(splitSessionIds);
    closeTokenUsageTabs(
      previousSplitSessionIdsRef.current.filter((id) => !nextIds.has(id)),
      true,
    );
    previousSplitSessionIdsRef.current = splitSessionIds;
  }, [closeTokenUsageTabs, splitSessionIds]);
  useEffect(() => {
    if (mainView !== 'split') closeTokenUsageTabs(undefined, true);
  }, [closeTokenUsageTabs, mainView]);
  const [mcpDialogMessage, setMcpDialogMessage] =
    useState<SerializedMcpStatusMessage | null>(null);
  // Settings and Daemon Status are shown as an in-place panel that replaces the
  // chat view (message list + composer), not as a modal overlay. Only one may be
  // active at a time; null means the normal chat view is shown.
  const [activePanel, setActivePanel] = useState<
    | 'settings'
    | 'status'
    | 'sessions'
    | 'extensions'
    | 'mcp'
    | 'skills'
    | 'plugins'
    | 'agents'
    | 'channels'
    | 'workspaces'
    | null
  >(null);
  const activePanelRef = useRef(activePanel);
  // Deep-link target for the Settings panel (e.g. 'Daemon' from the Local
  // Control QR popover). Cleared on any panel close/switch, not just
  // closePanel — several paths call setActivePanel directly (approval
  // overlay auto-close, openScheduledTasks, openSplitView, ...).
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<
    string | undefined
  >();
  useEffect(() => {
    if (activePanel !== 'settings') {
      setSettingsInitialCategory(undefined);
    }
  }, [activePanel]);
  const closePanel = useCallback(() => {
    splitClassificationGenerationRef.current += 1;
    setActivePanel(null);
  }, []);
  useEffect(() => {
    if (workspaceContextActive) return;
    splitClassificationGenerationRef.current += 1;
    setSplitSessionIds([]);
    if (
      activePanel === 'settings' ||
      activePanel === 'sessions' ||
      activePanel === 'extensions' ||
      activePanel === 'mcp' ||
      activePanel === 'skills' ||
      activePanel === 'agents' ||
      activePanel === 'plugins' ||
      activePanel === 'channels'
    ) {
      setActivePanel(null);
    }
    setShowResumeDialog(false);
    setShowDeleteDialog(false);
    setShowReleaseDialog(false);
    setShowMemoryDialog(false);
    setShowAddWorkspaceDialog(false);
    setGitDialog(undefined);
    if (modelDialogMode && modelDialogMode !== 'main') {
      setModelDialogMode(null);
    }
    setShowFallbacksDialog(false);
    if (
      mainView === 'scheduledTasks' ||
      mainView === 'goals' ||
      mainView === 'cockpit' ||
      mainView === 'split'
    ) {
      setMainView('chat');
    }
  }, [activePanel, mainView, modelDialogMode, workspaceContextActive]);
  const handleUseSkill = useCallback(
    (name: string) => {
      closePanel();
      window.setTimeout(() => {
        editorRef.current?.setText(`/${name} `);
        editorRef.current?.focus();
      }, 0);
    },
    [closePanel],
  );
  // The Settings/Status panel (activePanel) and the Scheduled Tasks page
  // (mainView) are mutually-exclusive full-pane views — the latter is a
  // position:absolute overlay that would otherwise cover the former — so opening
  // one closes the other. Without this, opening Scheduled Tasks then Daemon
  // Status left the panel rendered behind the Scheduled Tasks overlay, looking
  // like the button did nothing.
  const openPanel = useCallback(
    (
      panel:
        | 'settings'
        | 'status'
        | 'sessions'
        | 'extensions'
        | 'mcp'
        | 'skills'
        | 'plugins'
        | 'agents'
        | 'channels'
        | 'workspaces',
    ) => {
      splitClassificationGenerationRef.current += 1;
      showChat();
      setActivePanel(panel);
    },
    [showChat],
  );
  const loadMcpManagerMessage = useCallback(async () => {
    const status = await workspaceActions.loadMcpStatus();
    setMcpDialogMessage({
      status,
      toolsByServer: {},
      resourcesByServer: {},
      showDescriptions: false,
      showSchema: false,
      showTips: false,
    });
  }, [workspaceActions]);
  const openScheduledTasks = useCallback(() => {
    splitClassificationGenerationRef.current += 1;
    setActivePanel(null);
    // Route through showChat so leaving the cockpit strips its ?view=cockpit
    // deep link — the URL-sync removal branch only fires when the feature is
    // disabled, and a stale deep link would reopen the cockpit on reload or
    // Forward navigation instead of the view actually on screen.
    showChat();
    setMainView('scheduledTasks');
  }, [showChat]);
  const openWorkflows = useCallback(() => {
    if (!workspaceContextActive || !workflowsEnabled) return;
    splitClassificationGenerationRef.current += 1;
    setActivePanel(null);
    showChat();
    setMainView('workflows');
  }, [showChat, workflowsEnabled, workspaceContextActive]);
  useEffect(() => {
    if (
      mainView === 'workflows' &&
      (!workspaceContextActive || !workflowsEnabled)
    ) {
      showChat();
    }
  }, [mainView, showChat, workflowsEnabled, workspaceContextActive]);
  const openGoals = useCallback(() => {
    splitClassificationGenerationRef.current += 1;
    setActivePanel(null);
    // See openScheduledTasks: leaving the cockpit must strip its deep link.
    showChat();
    setMainView('goals');
  }, [showChat]);
  const openSessionDrawer = useCallback(() => {
    if (!sidebarOptions.enabled) return;
    splitClassificationGenerationRef.current += 1;
    setActivePanel(null);
    showChat();
    setForceMobileDrawer(true);
    setMobileDrawerOpen(true);
  }, [showChat, sidebarOptions.enabled]);
  const sanitizeSplitSessionIds = useCallback(
    async (sessionIds: readonly string[]): Promise<string[]> => {
      const requested = Array.from(new Set(sessionIds.filter(Boolean))).slice(
        0,
        MAX_SPLIT_PANES,
      );
      if (requested.length === 0) return [];
      return keepWorkspaceSplitSessionIds(
        workspace.client,
        workspace.capabilities,
        requested,
      );
    },
    [workspace.capabilities, workspace.client],
  );
  // Open the in-window split view showing 2+ sessions side by side. `splitSessionIds`
  // is the live pane set — SplitView mirrors add/remove back into it via
  // onPanesChange — so it must be preserved across entries, not blindly reset.
  const openSplitView = useCallback(
    (sessionIds?: readonly string[]) => {
      if (!workspaceContextActive) return;
      setActivePanel(null);
      // See openScheduledTasks: leaving the cockpit must strip its deep link.
      showChat();
      const requested = Array.from(
        new Set((sessionIds ?? []).filter(Boolean)),
      ).slice(0, MAX_SPLIT_PANES);
      const generation = splitClassificationGenerationRef.current + 1;
      splitClassificationGenerationRef.current = generation;
      if (requested.length === 0) {
        const currentWorkspaceSessionId =
          connection.sessionId !== undefined &&
          (connection.sessionContext?.kind === 'workspace' ||
            (connection.sessionContext === undefined &&
              connection.workspaceCwd !== undefined))
            ? connection.sessionId
            : undefined;
        setSplitSessionIds((previous) =>
          previous.length > 0
            ? previous
            : currentWorkspaceSessionId
              ? [currentWorkspaceSessionId]
              : [],
        );
        setMainView('split');
        return;
      }
      void sanitizeSplitSessionIds(requested).then((sanitized) => {
        if (
          splitClassificationGenerationRef.current !== generation ||
          sanitized.length === 0
        ) {
          return;
        }
        setSplitSessionIds(sanitized);
        setMainView('split');
      });
    },
    [
      connection.sessionContext,
      connection.sessionId,
      connection.workspaceCwd,
      sanitizeSplitSessionIds,
      showChat,
      workspaceContextActive,
    ],
  );
  const externalSplitSignature = useMemo(() => {
    const requested = Array.from(
      new Set((externalSplitSessionIds ?? []).filter(Boolean)),
    ).slice(0, MAX_SPLIT_PANES);
    return requested.join('\0');
  }, [externalSplitSessionIds]);
  const externalSplitControlled = externalSplitSessionIds !== undefined;
  const onSplitSessionIdsChangeRef = useRef(onSplitSessionIdsChange);
  onSplitSessionIdsChangeRef.current = onSplitSessionIdsChange;
  const requestOpenSplitView = useCallback(() => {
    if (!workspaceContextActive) return;
    if (!externalSplitControlled) {
      openSplitView();
      return;
    }
    const requested =
      splitSessionIds.length > 0
        ? splitSessionIds
        : connection.sessionId
          ? [connection.sessionId]
          : [];
    onSplitSessionIdsChangeRef.current?.(requested);
  }, [
    connection.sessionId,
    externalSplitControlled,
    openSplitView,
    splitSessionIds,
    workspaceContextActive,
  ]);
  useEffect(() => {
    if (!externalSplitControlled) return;
    const requested = externalSplitSignature
      ? externalSplitSignature.split('\0')
      : [];
    const generation = splitClassificationGenerationRef.current + 1;
    splitClassificationGenerationRef.current = generation;
    if (requested.length > 0 && cockpitViewRequested()) {
      updateCockpitLocation(false, true);
    }
    if (requested.length === 0) {
      setSplitSessionIds([]);
      setMainView((previous) => (previous === 'split' ? 'chat' : previous));
      return;
    }
    if (!workspaceContextActive) {
      if (pendingNonWorkspaceNavigation) return;
      if (
        effectiveSessionContext === undefined &&
        !workspaceCapabilitiesReady
      ) {
        return;
      }
      setSplitSessionIds([]);
      setMainView((previous) => (previous === 'split' ? 'chat' : previous));
      onSplitSessionIdsChangeRef.current?.([]);
      return;
    }
    if (!workspaceCapabilitiesReady) return;
    void sanitizeSplitSessionIds(requested).then((sanitized) => {
      if (splitClassificationGenerationRef.current !== generation) return;
      setSplitSessionIds((previous) =>
        areSessionIdsEqual(previous, sanitized) ? previous : sanitized,
      );
      if (!areSessionIdsEqual(requested, sanitized)) {
        onSplitSessionIdsChangeRef.current?.(sanitized);
      }
      if (sanitized.length > 0) {
        setActivePanel((previous) => (previous === null ? previous : null));
        setMainView((previous) => (previous === 'split' ? previous : 'split'));
      } else {
        setMainView((previous) => (previous === 'split' ? 'chat' : previous));
      }
    });
  }, [
    externalSplitControlled,
    externalSplitSignature,
    effectiveSessionContext,
    pendingNonWorkspaceNavigation,
    sanitizeSplitSessionIds,
    workspaceCapabilitiesReady,
    workspaceContextActive,
  ]);
  const handleSplitPanesChange = useCallback(
    (sessionIds: string[]) => {
      const nextIds = new Set(sessionIds);
      closeTokenUsageTabs(
        splitSessionIdsRef.current.filter((id) => !nextIds.has(id)),
        true,
      );
      if (!externalSplitControlled) {
        setSplitSessionIds(sessionIds);
      }
      onSplitSessionIdsChangeRef.current?.(sessionIds);
    },
    [closeTokenUsageTabs, externalSplitControlled],
  );
  const notifyControlledSplitClose = useCallback(() => {
    if (externalSplitControlled) {
      onSplitSessionIdsChangeRef.current?.([]);
    }
  }, [externalSplitControlled]);
  // Stable so SplitView's onExit-dependent effect (auto-exit on last pane
  // close) doesn't re-fire on every App re-render. Back from the split returns
  // to the Session Overview — the hub the split is launched from.
  const handleSplitExit = useCallback(() => {
    splitClassificationGenerationRef.current += 1;
    notifyControlledSplitClose();
    // The user left the split of their own accord, so a refresh must not bring
    // it back. (A shrink-fold is transient and deliberately doesn't clear it.)
    clearSplitSessions();
    // Explicit exit also cancels any pending shrink-fold restore.
    splitFoldedByShrinkRef.current = false;
    openPanel('sessions');
  }, [notifyControlledSplitClose, openPanel]);
  const handleOpenLocalControlSettings = useCallback(() => {
    setSettingsInitialCategory('Daemon');
    openPanel('settings');
  }, [openPanel]);
  // Built-in pane actions: Local Control QR entry is always shown; the token
  // usage action follows the same tokenUsage opt-in as the chat header.
  // Hosts can override via `renderPaneHeaderActions` to replace or extend it.
  const defaultPaneHeaderActions = useCallback<PaneHeaderActionsRenderer>(
    ({ sessionId, sessionActions }) => (
      <>
        <LocalControlQrButton onOpenSettings={handleOpenLocalControlSettings} />
        {tokenUsageHeaderItemVisible && (
          <button
            type="button"
            className={styles.tokenUsageHeaderButton}
            aria-label={t('tokenUsage.open')}
            title={t('tokenUsage.open')}
            disabled={!sessionActions}
            onClick={() =>
              sessionActions &&
              openTokenUsagePanel(sessionId, sessionActions, true)
            }
          >
            <GaugeIcon size={16} aria-hidden="true" />
          </button>
        )}
      </>
    ),
    [
      handleOpenLocalControlSettings,
      openTokenUsagePanel,
      t,
      tokenUsageHeaderItemVisible,
    ],
  );
  const resolvedPaneHeaderActions =
    renderPaneHeaderActions ?? defaultPaneHeaderActions;
  const splitBootstrapHandledRef = useRef(false);
  // A `?split=a,b` URL (opened in a new tab from the overview) enters the split
  // view with those sessions on load. Consume the param once so a later reload
  // or exit doesn't force the split back on.
  useEffect(() => {
    if (!workspace.capabilities || splitBootstrapHandledRef.current) return;
    splitBootstrapHandledRef.current = true;
    const ids = parseSplitSessionIds(window.location.search);
    if (ids.length > 0) {
      const url = new URL(window.location.href);
      url.searchParams.delete('split');
      window.history.replaceState(null, '', url);
      if (!externalSplitControlled) {
        openSplitView(ids);
      }
      return;
    }
    // No `?split=` deep link: restore the in-window split the user had before a
    // refresh, when one was persisted for this tab. sessionStorage is per-tab,
    // so a fresh tab (or a controlled host, which owns its own lifecycle)
    // restores nothing.
    if (externalSplitControlled) return;
    const saved = loadSplitSessions();
    if (saved.length > 0) openSplitView(saved);
  }, [externalSplitControlled, openSplitView, workspace.capabilities]);
  // Mirror the live split session set to per-tab storage while the split is the
  // active view, so a refresh restores exactly these panes. Not written when the
  // split is merely folded by a shrink (mainView flips to 'chat' transiently) —
  // the saved set is kept so growing back, or refreshing mid-fold, still restores.
  useEffect(() => {
    if (externalSplitControlled) return;
    if (mainView === 'split' && splitSessionIds.length > 0) {
      saveSplitSessions(splitSessionIds);
    }
  }, [mainView, splitSessionIds, externalSplitControlled]);
  // If the viewport shrinks below the large-screen breakpoint, fold away the
  // split view. It is only folded, not discarded: growing back past the
  // breakpoint restores it, so a transient resize is lossless. When a shrink
  // folds the split, its panes unmount and take keyboard focus with them; flag
  // the composer to be refocused once the chat is shown again.
  const focusComposerAfterSplitCloseRef = useRef(false);
  // True while the split view is only *temporarily* folded away because the
  // window is narrower than the large-screen breakpoint. Growing back past the
  // breakpoint restores it, so a transient resize doesn't drop the user's panes.
  const splitFoldedByShrinkRef = useRef(false);
  useEffect(() => {
    if (isLargeScreen) {
      // Grew back above the breakpoint: restore a split that a shrink folded
      // away. Standalone/uncontrolled only — a controlled host owns its split
      // lifecycle and re-opens it itself.
      if (splitFoldedByShrinkRef.current && !activePanel) {
        splitFoldedByShrinkRef.current = false;
        if (!externalSplitControlled && splitSessionIdsRef.current.length > 0) {
          setMainView((prev) => (prev === 'chat' ? 'split' : prev));
        }
      }
      return;
    }
    if (mainView === 'split') {
      notifyControlledSplitClose();
      setMainView('chat');
      focusComposerAfterSplitCloseRef.current = true;
      // Fold, don't discard: remember to restore the same split once the screen
      // grows back, so a transient shrink is lossless. The chat's own connection
      // (its session, git branch, URL, …) is left untouched — restoring the
      // split, or dropping back to that chat, is exactly what it was before.
      if (!externalSplitControlled) {
        splitFoldedByShrinkRef.current = true;
        // …except when the chat has no session of its own — the common case
        // when the split was entered from the Session Overview or a `?split=a,b`
        // link. A bare fold would then strand the user on an empty "new chat",
        // so land on the split's first (leftmost) pane instead. Guarded on the
        // *empty* chat so it never re-points a chat that already has a session
        // (which would wipe its git branch / change the session+URL it drops
        // back to). Best-effort: a load failure (e.g. a non-primary-workspace
        // pane the single connection can't own) just leaves the empty chat.
        const firstPane = splitSessionIdsRef.current[0];
        if (firstPane && !currentSessionIdRef.current) {
          void sessionActions.loadSession(firstPane).catch(() => undefined);
        }
      }
    }
  }, [
    activePanel,
    isLargeScreen,
    mainView,
    notifyControlledSplitClose,
    externalSplitControlled,
    sessionActions,
  ]);
  // Land focus on the composer after a shrink-driven split close so keyboard
  // users aren't dropped onto <body> — but not when the chat now shows an
  // approval overlay (it owns the keyboard) or a panel (it manages focus).
  useEffect(() => {
    if (mainView !== 'chat' || !focusComposerAfterSplitCloseRef.current) return;
    focusComposerAfterSplitCloseRef.current = false;
    if (!activePanel && !approvalOverlayActive) editorRef.current?.focus();
  }, [mainView, activePanel, approvalOverlayActive]);
  // The Settings / Daemon Status panel is a view, not a modal, so it lacks
  // DialogShell's focus trap/restore. Move focus into a panel when it opens (or
  // when switching directly between panels) and back to the composer when it
  // closes, so keyboard users aren't stranded on an element that is hidden.
  const panelBackRef = useRef<HTMLButtonElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pluginTabRef = useRef<HTMLButtonElement | null>(null);
  const prevActivePanelRef = useRef(activePanel);
  const prevApprovalOverlayRef = useRef(approvalOverlayActive);
  useEffect(() => {
    const prev = prevActivePanelRef.current;
    const wasApprovalActive = prevApprovalOverlayRef.current;
    prevActivePanelRef.current = activePanel;
    prevApprovalOverlayRef.current = approvalOverlayActive;
    if (activePanel) {
      if (
        activePanel === 'extensions' ||
        activePanel === 'channels' ||
        // The Workspaces panel renders its own header; the generic Back
        // button (panelBackRef) is excluded for it, so the fallback below
        // would focus nothing.
        activePanel === 'workspaces'
      ) {
        panelHeadingRef.current?.focus();
        return;
      }
      if (activePanel === 'plugins') {
        pluginTabRef.current?.focus();
        return;
      }
      // Covers null→panel and panel→panel: the Back button lives outside the
      // keyed panel body so it survives a switch, but refocus explicitly rather
      // than depending on that DOM coincidence.
      panelBackRef.current?.focus();
    } else if (prev) {
      // Panel just closed. Return focus to the composer — unless an approval
      // overlay is what forced it closed (see the effect below): that overlay
      // drives its own keyboard handling and ToolApproval ignores keys from
      // editable targets, so focusing the composer here would swallow its
      // shortcuts and leave the user unable to respond by keyboard.
      if (!approvalOverlayActive) {
        editorRef.current?.focus();
      }
    } else if (wasApprovalActive && !approvalOverlayActive) {
      // The panel was auto-closed for an approval (prev was consumed to null on
      // that render, editor focus skipped). Now the approval has resolved with
      // no panel to return to, so restore the composer here. (useComposerCore's
      // dialogOpen effect also refocuses on this transition; this keeps the
      // panel focus effect self-contained instead of relying on that.)
      editorRef.current?.focus();
    }
  }, [activePanel, approvalOverlayActive]);
  // A pending approval (a gated tool call or an AskUserQuestion) renders its
  // overlay in the chat footer, which is hidden (display:none) while a panel is
  // shown. Left alone, the turn would hang behind Settings/Status with no
  // visible prompt. Close the panel so the approval surfaces. Only actionable
  // approvals count — pendingToolApproval/pendingAskUserApproval already gate on
  // canActOnPendingApproval, so a non-owner in a shared session isn't yanked out
  // of Settings by someone else's prompt.
  useEffect(() => {
    if (!approvalOverlayActive) return;
    // The approval overlay renders in the chat footer; dismiss anything layered
    // over it so it's visible and actionable instead of trapped behind a
    // backdrop — the panel itself and any DialogShell sub-dialog opened from it
    // (model picker, approval-mode picker). Leaving the approval-mode picker up
    // is also a security hole: the user could pick "yolo" and silently
    // auto-approve a tool call they never saw (handleSetMode auto-approves
    // pendingApprovalRef.current).
    if (activePanel) setActivePanel(null);
    if (modelDialogMode) setModelDialogMode(null);
    if (showApprovalModeDialog) setShowApprovalModeDialog(false);
    // The fullscreen artifact panel hides the chat (display:none +
    // aria-hidden), and the approval overlay renders inside the chat footer —
    // shrink the panel back to its dock/drawer so the approval surfaces.
    // Split-view pane approvals deliberately do not shrink the panel: each
    // pane renders its own approval banner, and surfacing them here would
    // need a pending-approval signal plumbed up through SplitView. Escape or
    // the toolbar exits fullscreen and reveals them.
    if (artifactPanelFullscreen) setArtifactPanelFullscreen(false);
    // Workflow, Scheduled Tasks, and Goals are full-pane overlays
    // (position:absolute) that cover the chat footer too, so dismiss them for
    // the same reason. The split view is deliberately NOT dismissed: each pane
    // owns and renders its own session's approval, so an approval on the (outer)
    // main session must not yank the user out of the panes they are working in.
    if (cockpitViewRequested()) updateCockpitLocation(false, true);
    if (
      mainView === 'cockpit' ||
      mainView === 'scheduledTasks' ||
      mainView === 'workflows' ||
      mainView === 'goals'
    ) {
      setMainView('chat');
    }
  }, [
    approvalOverlayActive,
    activePanel,
    modelDialogMode,
    showApprovalModeDialog,
    mainView,
    artifactPanelFullscreen,
  ]);
  // Whether each approval overlay is the topmost (visible, uncovered) one. The
  // overlay components consume this as `keyboardActive`: when it flips true — on
  // appearance, or once a panel/dialog that was covering it closes — they pull
  // keyboard focus to their own safe-default option. Focus handling now lives in
  // ToolApproval/AskUserQuestion (their keyboard handling is focus-scoped), so
  // the app no longer focuses the wrapper element directly.
  const toolApprovalOverlayVisible =
    pendingToolApproval !== null &&
    !activePanel &&
    modelDialogMode === null &&
    !showApprovalModeDialog &&
    mainView === 'chat' &&
    !artifactPanelFullscreen;
  const askUserOverlayVisible =
    pendingAskUserApproval !== null &&
    !activePanel &&
    modelDialogMode === null &&
    !showApprovalModeDialog &&
    mainView === 'chat' &&
    !artifactPanelFullscreen;
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const showAuthDialogRef = useRef(showAuthDialog);
  const [memoryRefreshSignal, setMemoryRefreshSignal] = useState(0);
  const [memoryAddSignal, setMemoryAddSignal] = useState(0);
  const [externalInteractionBlockCount, setExternalInteractionBlockCount] =
    useState(0);
  const registerInteractionBlocker = useCallback(() => {
    let released = false;
    setExternalInteractionBlockCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setExternalInteractionBlockCount((count) => Math.max(0, count - 1));
    };
  }, []);

  // Refresh commands when extensions change (install/uninstall/update).
  const extensionsVersionRef = useRef(
    workspaceEventSignals?.extensionsVersion ?? 0,
  );
  useEffect(() => {
    const current = workspaceEventSignals?.extensionsVersion ?? 0;
    if (current !== extensionsVersionRef.current) {
      extensionsVersionRef.current = current;
      const change = workspaceEventSignals?.lastExtensionChange;
      if (change?.status === 'failed') {
        store.dispatch([
          {
            type: 'error',
            text: t('extensions.action.failed', {
              name: change.name ?? '',
              source: change.source ?? '',
              error: change.error ?? t('error.unknown'),
            }),
          },
        ]);
        return;
      }
      if (change?.status === 'installed') {
        const name = change.name ?? change.source ?? t('extensions.label');
        store.dispatch([
          {
            type: 'status',
            text: change.version
              ? t('extensions.install.installedWithVersion', {
                  name,
                  version: change.version,
                })
              : t('extensions.install.installed', { name }),
          },
        ]);
      } else if (change?.status) {
        const name = change.name ?? change.source ?? t('extensions.label');
        const key =
          change.status === 'updated' && change.version
            ? 'extensions.manage.updatedWithVersion'
            : `extensions.manage.${change.status}`;
        store.dispatch([
          {
            type: 'status',
            text: t(key, { name, version: change.version ?? '' }),
          },
        ]);
      }
      sessionActions.refreshCommands().catch(() => {
        store.dispatch([
          {
            type: 'error',
            text: t('extensions.commands.refreshFailed'),
          },
        ]);
      });
    }
  }, [
    workspaceEventSignals?.extensionsVersion,
    workspaceEventSignals?.lastExtensionChange,
    sessionActions,
    store,
    t,
  ]);
  const [memoryAddScope, setMemoryAddScope] = useState<'workspace' | 'global'>(
    'workspace',
  );
  const [agentsCreateScope, setAgentsCreateScope] = useState<
    'workspace' | 'global' | null
  >(null);
  const [escapeHintVisible, setEscapeHintVisible] = useState(false);
  // Whether the first Esc has armed a stream cancellation; the composer's send
  // button shows an "Esc again to stop" affordance while true.
  const [cancelArmed, setCancelArmed] = useState(false);
  // Which action the pending second Esc would perform, or null when idle.
  const escArmedActionRef = useRef<'cancel' | 'clear' | null>(null);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tasksDialogMessage, setTasksDialogMessage] =
    useState<SerializedTasksMessage | null>(null);
  const handleOpenMonitorDetails = useCallback(
    (task: DaemonSessionMonitorTaskStatus) => {
      setTasksDialogMessage(null);
      setBackgroundTasksRefreshTrigger((value) => value + 1);
      openMonitorPanel(task);
    },
    [openMonitorPanel],
  );
  const handleOpenShellDetails = useCallback(
    (task: DaemonSessionShellTaskStatus) => {
      setTasksDialogMessage(null);
      setBackgroundTasksRefreshTrigger((value) => value + 1);
      openShellPanel(task);
    },
    [openShellPanel],
  );
  const [selectedTheme, setSelectedTheme] = useState<WebShellTheme>(
    providedTheme ?? WebShellThemeId.Dark,
  );
  const [currentModel, setCurrentModel] = useState('');
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const setPendingModel = useCallback((modelId: string) => {
    currentModelRef.current = modelId;
    setCurrentModel(modelId);
  }, []);
  const [pendingReasoningIntent, setPendingReasoningIntentState] = useState<
    PendingReasoningIntent | undefined
  >(undefined);
  const pendingReasoningIntentRef = useRef(pendingReasoningIntent);
  const setPendingReasoningIntent = useCallback(
    (intent: PendingReasoningIntent | undefined) => {
      pendingReasoningIntentRef.current = intent;
      setPendingReasoningIntentState(intent);
    },
    [],
  );
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const selectWelcomeModel = useCallback(
    (modelId: string) => {
      const models = connectionRef.current.models;
      const reasoningIntent = pendingReasoningIntentRef.current;
      const sourceReasoningIntent =
        reasoningIntent?.modelId === currentModelRef.current
          ? reasoningIntent
          : undefined;
      const sourceReasoningPreview = models?.find(
        (model) => model.id === currentModelRef.current,
      )?.reasoningPreview;
      const sourceReasoningSelection =
        sourceReasoningIntent?.value ??
        (sourceReasoningPreview
          ? getReasoningSelection(sourceReasoningPreview)
          : undefined);
      const reasoningPreview = models?.find(
        (model) => model.id === modelId,
      )?.reasoningPreview;
      const keepReasoningIntent =
        sourceReasoningSelection &&
        reasoningPreview &&
        reasoningPreviewSupports(reasoningPreview, sourceReasoningSelection);
      setPendingReasoningIntent(
        sourceReasoningIntent && keepReasoningIntent
          ? { modelId, value: sourceReasoningIntent.value }
          : sourceReasoningSelection && !keepReasoningIntent
            ? { modelId, value: 'default' }
            : undefined,
      );
      setPendingModel(modelId);
    },
    [setPendingModel, setPendingReasoningIntent],
  );
  /**
   * Whether a local action must be held back because a Goal owns the session.
   * Reads the latest connection through the ref so callers get the gate as of
   * call time. Commands and run guards fail closed during Goal hydration;
   * ordinary chat submissions do not consult this gate.
   */
  const isGoalGateBlocked = useCallback(
    () => isGoalGateBlockedFor(connectionRef.current),
    [],
  );
  const refreshActiveSessionDisplayName = useCallback(async () => {
    const activeConnection = connectionRef.current;
    if (
      !activeConnection.sessionId ||
      !activeConnection.workspaceCwd ||
      (activeConnection.sessionContext &&
        activeConnection.sessionContext.kind !== 'workspace')
    ) {
      return;
    }
    const owner = sessionOwnerGuard.capture();
    try {
      const page = await loadSessionCatalogOnce(
        workspace.client,
        {
          routeKind: 'legacy',
          workspaceCwd: activeConnection.workspaceCwd,
          options: { pageSize: 200 },
        },
        { fresh: true },
      );
      if (
        !owner.isCurrent() ||
        connectionRef.current.sessionId !== activeConnection.sessionId ||
        connectionRef.current.workspaceCwd !== activeConnection.workspaceCwd ||
        connectionRef.current.displayName
      ) {
        return;
      }
      const displayName = page.sessions.find(
        (session) => session.sessionId === activeConnection.sessionId,
      )?.displayName;
      if (displayName?.trim()) setSessionStatusDisplayName(displayName);
    } catch {
      // The live session_metadata_updated event remains the primary path.
    }
  }, [sessionOwnerGuard, workspace.client]);
  const refreshActiveSessionDisplayNameRef = useRef(
    refreshActiveSessionDisplayName,
  );
  refreshActiveSessionDisplayNameRef.current = refreshActiveSessionDisplayName;
  const delayedDisplayNameRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const pendingDisplayNameRefreshRef = useRef<
    { sessionId: string; workspaceCwd: string } | undefined
  >(undefined);
  const refreshDisplayNameIfCurrent = useCallback(
    (sessionId: string, workspaceCwd: string) => {
      const activeConnection = connectionRef.current;
      if (
        activeConnection.sessionId !== sessionId ||
        activeConnection.workspaceCwd !== workspaceCwd ||
        activeConnection.displayName
      ) {
        return;
      }
      void refreshActiveSessionDisplayNameRef.current();
    },
    [],
  );
  const scheduleDelayedActiveSessionDisplayNameRefresh = useCallback(
    (sessionId: string, workspaceCwd: string) => {
      pendingDisplayNameRefreshRef.current = undefined;
      if (delayedDisplayNameRefreshTimerRef.current !== null) {
        clearTimeout(delayedDisplayNameRefreshTimerRef.current);
      }
      delayedDisplayNameRefreshTimerRef.current = setTimeout(() => {
        delayedDisplayNameRefreshTimerRef.current = null;
        if (typeof document !== 'undefined' && document.hidden) {
          pendingDisplayNameRefreshRef.current = { sessionId, workspaceCwd };
          return;
        }
        refreshDisplayNameIfCurrent(sessionId, workspaceCwd);
      }, SESSION_CATALOG_TRAILING_REFRESH_MS);
    },
    [refreshDisplayNameIfCurrent],
  );
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) return;
      const pending = pendingDisplayNameRefreshRef.current;
      if (!pending) return;
      pendingDisplayNameRefreshRef.current = undefined;
      refreshDisplayNameIfCurrent(pending.sessionId, pending.workspaceCwd);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (delayedDisplayNameRefreshTimerRef.current !== null) {
        clearTimeout(delayedDisplayNameRefreshTimerRef.current);
      }
    };
  }, [refreshDisplayNameIfCurrent]);
  const requireActiveSessionForLocalCommand = useCallback((): boolean => {
    if (connectionRef.current.sessionId) return true;
    pushToast('info', t('localCommand.noSession'));
    return false;
  }, [pushToast, t]);
  const sessionDisplayName =
    connection.sessionContext?.kind === 'standalone'
      ? (sessionStatusDisplayName ?? connection.displayName)
      : (connection.displayName ?? sessionStatusDisplayName);
  useEffect(() => {
    onSessionInfoChange?.({
      sessionId: connection.sessionId,
      sessionName: sessionDisplayName,
    });
  }, [connection.sessionId, onSessionInfoChange, sessionDisplayName]);
  const [currentMode, setCurrentMode] = useState('default');
  const currentModeRef = useRef(currentMode);
  currentModeRef.current = currentMode;
  const sessionSourceTypeRef = useRef(sessionSourceType);
  sessionSourceTypeRef.current = sessionSourceType;
  const setPendingMode = useCallback((modeId: string) => {
    currentModeRef.current = modeId;
    setCurrentMode(modeId);
  }, []);
  const [isPreparingPrompt, setIsPreparingPrompt] = useState(false);
  const promptPreparationOwnerRef = useRef<symbol | null>(null);
  const beginPromptPreparation = useCallback(() => {
    const owner = Symbol('prompt-preparation');
    promptPreparationOwnerRef.current = owner;
    setIsPreparingPrompt(true);
    return owner;
  }, []);
  const finishPromptPreparation = useCallback((owner: symbol | undefined) => {
    if (!owner || promptPreparationOwnerRef.current !== owner) return;
    promptPreparationOwnerRef.current = null;
    setIsPreparingPrompt(false);
  }, []);
  const planPreparationTokenRef = useRef(0);
  useLayoutEffect(() => {
    planPreparationTokenRef.current += 1;
    promptPreparationOwnerRef.current = null;
    setIsPreparingPrompt(false);
  }, [logicalSessionKey]);
  const createSessionPromiseRef = useRef<Promise<string | undefined> | null>(
    null,
  );
  const preparingSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      connection.sessionId &&
      connection.sessionId !== preparingSessionIdRef.current
    ) {
      setPendingReasoningIntent(undefined);
    }
  }, [connection.sessionId, setPendingReasoningIntent]);
  const allocatedSessionCatalogOwnerRef = useRef<
    | {
        sessionId: string;
        workspaceCwd: string;
      }
    | undefined
  >(undefined);
  const newSessionSuggestionSubmitTokenRef = useRef(0);
  const pendingNewSessionSuggestionSubmitRef = useRef<{
    token: number;
    sourceSessionId: string | undefined;
    mode: 'cleared' | 'live';
    newSessionReady: boolean;
    submitScheduled: boolean;
  } | null>(null);
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  /**
   * The session a failed Goal creation left behind.
   *
   * Creating a Goal from the Goals page allocates a fresh session and then
   * installs the Goal in it; the daemon session is created lazily, so an
   * attempt that fails leaves a session that exists but never got its Goal.
   *
   * The form keeps the condition and lets the user retry. Without this ref
   * every retry would abandon that session and create another, piling up blank
   * chats in the sidebar. Remembering it lets the retry reuse it — no session
   * is ever deleted.
   *
   * Only valid while the Goals page stays mounted. The moment the user leaves,
   * that session is reachable from the composer and may stop being a scratch
   * session, so the effect below forgets it: a later Goal then starts a fresh
   * session rather than landing on top of a conversation.
   */
  const strandedGoalSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mainView !== 'goals') strandedGoalSessionRef.current = undefined;
  }, [mainView]);
  const ensureSessionForPrompt = useCallback(() => {
    const currentSessionId = connectionRef.current.sessionId;
    if (createSessionPromiseRef.current) {
      if (
        !currentSessionId ||
        currentSessionId === preparingSessionIdRef.current
      ) {
        return createSessionPromiseRef.current;
      }
      return Promise.resolve(undefined);
    }
    if (currentSessionId) return Promise.resolve(undefined);
    const promise = (async () => {
      let allocatedSessionId: string | undefined;
      const modelId =
        currentModelRef.current || connectionRef.current.currentModel;
      const reasoningIntent = pendingReasoningIntentRef.current;
      const reasoningPreview = connectionRef.current.models?.find(
        (model) => model.id === modelId,
      )?.reasoningPreview;
      const reasoningEffort =
        reasoningIntent &&
        reasoningIntent.modelId === modelId &&
        reasoningPreview &&
        reasoningPreviewSupports(reasoningPreview, reasoningIntent.value)
          ? reasoningIntent.value
          : undefined;
      const modeId =
        currentModeRef.current || connectionRef.current.currentMode;
      const requestedSessionContext =
        pendingSessionContextRef.current ??
        connectionRef.current.sessionContext;
      const availableWorkspaces = workspacesRef.current;
      const primaryWorkspaceCwd = availableWorkspaces.find(
        (entry) => entry.primary && entry.trusted !== false,
      )?.cwd;
      const requestedWorkspaceCwd = selectedWorkspaceCwdRef.current;
      const acceptedWorkspaceCwd = requestedWorkspaceCwd
        ? availableWorkspaces.find(
            (entry) =>
              entry.cwd === requestedWorkspaceCwd && entry.trusted !== false,
          )?.cwd
        : undefined;
      const targetWorkspaceCwd =
        requestedSessionContext?.kind === 'workspace'
          ? (availableWorkspaces.find(
              (entry) =>
                entry.cwd === requestedSessionContext.cwd &&
                entry.trusted !== false,
            )?.cwd ??
            (requestedSessionContext.cwd ===
              connectionRef.current.workspaceCwd &&
            availableWorkspaces.find(
              (entry) => entry.cwd === requestedSessionContext.cwd,
            )?.trusted !== false
              ? requestedSessionContext.cwd
              : undefined))
          : requestedSessionContext?.kind === 'standalone'
            ? undefined
            : (availableWorkspaces.find(
                (entry) => entry.cwd === lockedWorkspaceCwd,
              )?.cwd ??
              acceptedWorkspaceCwd ??
              primaryWorkspaceCwd);
      if (
        requestedSessionContext?.kind === 'workspace' &&
        !targetWorkspaceCwd
      ) {
        throw new Error('The selected workspace is unavailable or untrusted');
      }
      const creationSessionContext: DaemonProductSessionContext | undefined =
        requestedSessionContext ??
        (targetWorkspaceCwd
          ? { kind: 'workspace', cwd: targetWorkspaceCwd }
          : undefined);
      const catalogWorkspaceCwd =
        creationSessionContext?.kind === 'workspace'
          ? creationSessionContext.cwd
          : undefined;
      try {
        await createAndAttachSessionForPrompt({
          sessionActions: sessionActions as typeof sessionActions &
            SessionActionsWithCreate,
          modelId,
          reasoningEffort,
          modeId,
          workspaceCwd: targetWorkspaceCwd,
          sessionContext: creationSessionContext,
          worktree:
            creationSessionContext?.kind === 'workspace' &&
            gitModeIntentRef.current.mode === 'worktree'
              ? { slug: gitModeIntentRef.current.slug }
              : undefined,
          branch:
            creationSessionContext?.kind === 'workspace' &&
            gitModeIntentRef.current.mode === 'branch'
              ? { name: gitModeIntentRef.current.name }
              : undefined,
          sessionSourceType: sessionSourceTypeRef.current,
          onSessionCreated: onSessionCreatedRef.current,
          onSessionAllocated: (sessionId) => {
            preparingSessionIdRef.current = sessionId;
            allocatedSessionId = sessionId;
            if (catalogWorkspaceCwd) {
              allocatedSessionCatalogOwnerRef.current = {
                sessionId,
                workspaceCwd: catalogWorkspaceCwd,
              };
              sessionCatalogController.sessionCreated(
                catalogWorkspaceCwd,
                sessionId,
              );
            }
          },
          getCurrentSessionId: () => connectionRef.current.sessionId,
        }).then((result) => {
          if (result.worktree) {
            setSessionWorktree(result.worktree);
          }
          if (result.branch) {
            setSessionBranch(result.branch);
          }
          // Clear the pending intent only on success. On failure the
          // composer chip stays in the selected mode so the user knows
          // the intent was not fulfilled and can retry.
          setGitModeIntent({ mode: 'current' });
          if (pendingReasoningIntentRef.current === reasoningIntent) {
            setPendingReasoningIntent(undefined);
          }
          if (pendingSessionContextRef.current === requestedSessionContext) {
            setPendingSessionContext(undefined);
          }
        });
      } catch (error) {
        if (allocatedSessionId && catalogWorkspaceCwd) {
          sessionCatalogController.invalidateWorkspace(catalogWorkspaceCwd);
        }
        throw error;
      }
      // One-shot: the picker targets only the *next* new session, so clear
      // it after creation. The next new chat defaults back to the primary
      // workspace unless the user picks one again.
      if (creationSessionContext?.kind === 'workspace') {
        setSelectedWorkspaceCwd(undefined);
      }
      return allocatedSessionId;
    })();
    createSessionPromiseRef.current = promise;
    const clearPreparation = () => {
      if (createSessionPromiseRef.current === promise) {
        createSessionPromiseRef.current = null;
        preparingSessionIdRef.current = null;
      }
    };
    void promise.then(clearPreparation, clearPreparation);
    return promise;
  }, [
    lockedWorkspaceCwd,
    sessionActions,
    sessionCatalogController,
    setPendingSessionContext,
    setPendingReasoningIntent,
  ]);
  const onSubmitBeforeRef = useRef(onSubmitBefore);
  onSubmitBeforeRef.current = onSubmitBefore;
  const prepareSubmitRef = useRef(prepareSubmit);
  prepareSubmitRef.current = prepareSubmit;
  const onSlashCommandRef = useRef(onSlashCommand);
  onSlashCommandRef.current = onSlashCommand;
  const getComposerWorkspaceCwd = useCallback(() => {
    const productContext =
      pendingSessionContextRef.current ?? connectionRef.current.sessionContext;
    if (productContext && productContext.kind !== 'workspace') {
      return undefined;
    }
    if (connectionRef.current.sessionId) {
      return productContext?.kind === 'workspace'
        ? productContext.cwd
        : connectionRef.current.workspaceCwd;
    }
    return (
      workspacesRef.current.find((entry) => entry.cwd === lockedWorkspaceCwd)
        ?.cwd ??
      selectedWorkspaceCwdRef.current ??
      workspacesRef.current.find((entry) => entry.primary)?.cwd
    );
  }, [lockedWorkspaceCwd]);
  const retryOwnerIsCurrent = useCallback(
    (owner: CancelledRetryOwner) =>
      retryOwnerMatchesCurrent(
        owner,
        connectionRef.current.sessionId,
        getComposerWorkspaceCwd(),
        composerSourceVersionRef.current,
      ),
    [getComposerWorkspaceCwd],
  );
  const dispatchSessionChange = useCallback(
    (event: SessionChangeEvent) => {
      onSessionChange?.(event);
    },
    [onSessionChange],
  );
  // Ref-stable handle so that useCallback hooks (sendPrompt, enqueuePrompt,
  // turn_complete effect) don't need dispatchSessionChange in their dep arrays.
  // Without this, an unstable onSessionChange prop would cause those callbacks
  // to be recreated on every render, cascading into downstream effect chains.
  const dispatchSessionChangeRef = useRef(dispatchSessionChange);
  dispatchSessionChangeRef.current = dispatchSessionChange;
  const sendPrompt = useCallback(
    async (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      opts?: {
        optimisticUserMessage?: boolean;
        retry?: boolean;
        // Skips prepareSubmit without daemon retry semantics; used
        // by the failed-prompt retry, whose user message was never
        // recorded.
        skipPrepareSubmit?: boolean;
        inputAnnotations?: DaemonInputAnnotation[];
        clearComposerOnPromptStart?: boolean;
        commitComposerAccepted?: ComposerSubmitCommit;
        onAdmissionStarted?: (sessionId: string | undefined) => void;
        onAdmitted?: () => void;
        onCancelledBeforeAdmission?: () => void;
        onOptimisticUserMessage?: (message: OptimisticUserMessage) => void;
        onPreparedSubmit?: (prepared: WebShellPreparedSubmit) => void;
        ownerRef?: { current: DaemonSessionOwnerSnapshot };
      },
    ) => {
      if (sessionWriteBlockedRef.current) {
        throw new DOMException(
          'Session switch is still preparing',
          'InvalidStateError',
        );
      }
      let preparedPrompt = text;
      let preparedInputAnnotations = opts?.inputAnnotations
        ? [...opts.inputAnnotations]
        : [];
      let promptPreparationOwner: symbol | undefined;
      const startPreparing = () => {
        promptPreparationOwner ??= beginPromptPreparation();
      };
      const finishPreparing = () => {
        finishPromptPreparation(promptPreparationOwner);
      };
      const restoreCancelledSubmitState = () => {
        finishPreparing();
        opts?.onCancelledBeforeAdmission?.();
      };
      const shouldShowPreparing = !connectionRef.current.sessionId;
      const prepare =
        opts?.retry || opts?.skipPrepareSubmit
          ? undefined
          : prepareSubmitRef.current;
      const submitBefore = onSubmitBeforeRef.current;
      const hasAsyncPreflight = Boolean(prepare || submitBefore);
      const admissionSource = {
        owner: sessionOwnerGuard.capture(),
        sessionId: connectionRef.current.sessionId,
        workspaceCwd: getComposerWorkspaceCwd(),
        sourceVersion: composerSourceVersionRef.current,
        writeBlockGeneration: sessionWriteBlockGenerationRef.current,
      };
      const admissionOwnerIsCurrent = (allocatedSessionId?: string) => {
        if (!appMountedRef.current) return false;
        const currentSessionId = connectionRef.current.sessionId;
        const sessionMatches =
          currentSessionId === admissionSource.sessionId ||
          (admissionSource.sessionId === undefined &&
            (currentSessionId === undefined ||
              (allocatedSessionId !== undefined &&
                currentSessionId === allocatedSessionId)));
        const ownAllocationSucceeded =
          admissionSource.sessionId === undefined &&
          allocatedSessionId !== undefined &&
          (currentSessionId === undefined ||
            currentSessionId === allocatedSessionId);
        return (
          (admissionSource.owner.isCurrent() || ownAllocationSucceeded) &&
          sessionMatches &&
          (ownAllocationSucceeded ||
            getComposerWorkspaceCwd() === admissionSource.workspaceCwd) &&
          composerSourceVersionRef.current === admissionSource.sourceVersion
        );
      };
      const admissionSourceIsCurrent = (allocatedSessionId?: string) =>
        admissionOwnerIsCurrent(allocatedSessionId) &&
        !sessionWriteBlockedRef.current &&
        sessionWriteBlockGenerationRef.current ===
          admissionSource.writeBlockGeneration;
      if (hasAsyncPreflight) {
        startPreparing();
        try {
          if (prepare) {
            const prepared = await prepare({
              sessionId: admissionSource.sessionId,
              prompt: preparedPrompt,
              inputAnnotations: preparedInputAnnotations,
            });
            const resolved = resolvePreparedSubmit(
              preparedPrompt,
              preparedInputAnnotations,
              prepared,
            );
            preparedPrompt = resolved.prompt;
            preparedInputAnnotations = [...(resolved.inputAnnotations ?? [])];
          }
          if (!admissionSourceIsCurrent()) {
            restoreCancelledSubmitState();
            return;
          }
          if (submitBefore) {
            await submitBefore({
              sessionId: admissionSource.sessionId,
              prompt: preparedPrompt,
            });
          }
        } catch (err) {
          if (!appMountedRef.current) return;
          console.warn(
            '[web-shell] prompt preflight rejected, prompt cancelled',
            err,
          );
          // Restore retry-critical refs so Ctrl+Y doesn't resend the
          // cancelled prompt.
          restoreCancelledSubmitState();
          return;
        }
        if (!appMountedRef.current) return;
        if (!admissionSourceIsCurrent()) {
          restoreCancelledSubmitState();
          return;
        }
      }
      if (
        !preparedPrompt.trim() &&
        (images?.length ?? 0) === 0 &&
        (files?.length ?? 0) === 0
      ) {
        restoreCancelledSubmitState();
        return;
      }
      opts?.onPreparedSubmit?.({
        prompt: preparedPrompt,
        inputAnnotations: preparedInputAnnotations,
      });
      if (!hasAsyncPreflight && shouldShowPreparing) {
        startPreparing();
      }
      const existingSessionWorkspaceCwd = getComposerWorkspaceCwd();
      let allocatedSessionId: string | undefined;
      try {
        allocatedSessionId = await ensureSessionForPrompt();
      } finally {
        if (appMountedRef.current && shouldShowPreparing) {
          finishPreparing();
        }
      }
      if (!appMountedRef.current) return;
      if (!admissionSourceIsCurrent(allocatedSessionId)) {
        restoreCancelledSubmitState();
        return;
      }
      const sessionIdAfterEnsure =
        connectionRef.current.sessionId ?? allocatedSessionId;
      const allocatedOwner = allocatedSessionCatalogOwnerRef.current;
      const promptWorkspaceCwd = allocatedSessionId
        ? allocatedOwner?.sessionId === allocatedSessionId
          ? allocatedOwner.workspaceCwd
          : undefined
        : existingSessionWorkspaceCwd;
      const isSlashPreparedSubmit = preparedPrompt.trimStart().startsWith('/');
      if (
        !opts?.retry &&
        opts?.optimisticUserMessage !== false &&
        !isSlashPreparedSubmit
      ) {
        lastSubmittedPromptRef.current = preparedPrompt;
        lastSubmittedImagesRef.current = images;
        lastSubmittedFilesRef.current = files;
        lastSubmittedInputAnnotationsRef.current =
          preparedInputAnnotations.length > 0
            ? preparedInputAnnotations
            : undefined;
        lastSubmittedSourceVersionRef.current =
          composerSourceVersionRef.current;
        retryableTurnErrorIdRef.current = null;
        retryableTurnErrorIdentityRef.current = undefined;
        retriedTurnErrorIdRef.current = null;
        failedTurnErrorRetryRef.current = null;
        retryOwnerRef.current = {
          sessionId: sessionIdAfterEnsure,
          workspaceCwd: promptWorkspaceCwd,
          sessionKey: getLogicalSessionKey(
            sessionIdAfterEnsure,
            promptWorkspaceCwd,
          ),
          sourceVersion: composerSourceVersionRef.current,
          snapshot: sessionOwnerGuard.capture(),
        };
      } else if (
        !opts?.retry &&
        opts?.optimisticUserMessage !== false &&
        isSlashPreparedSubmit
      ) {
        // A slash submit is never retried; disarm the previous submit's
        // recorded retry state so a turn error on the slash turn cannot
        // resend the already-succeeded earlier prompt.
        lastSubmittedPromptRef.current = '';
        lastSubmittedImagesRef.current = undefined;
        lastSubmittedFilesRef.current = undefined;
        lastSubmittedInputAnnotationsRef.current = undefined;
        retryableTurnErrorIdRef.current = null;
        retryableTurnErrorIdentityRef.current = undefined;
        retriedTurnErrorIdRef.current = null;
        failedTurnErrorRetryRef.current = null;
      }
      setShowRetryHint(false);
      finishPreparing();
      if (opts?.ownerRef) opts.ownerRef.current = sessionOwnerGuard.capture();
      clearFollowup();
      if (opts?.commitComposerAccepted) {
        opts.commitComposerAccepted();
      } else if (opts?.clearComposerOnPromptStart) {
        editorRef.current?.clear();
      }
      let admissionStarted = false;
      let admitted = false;
      const promptOptions: SendPromptOptionsWithRetry = {
        images,
        files,
        inputAnnotations:
          preparedInputAnnotations.length > 0
            ? preparedInputAnnotations
            : undefined,
        optimisticUserMessage: opts?.optimisticUserMessage,
        retry: opts?.retry,
        onAdmissionStarted: () => {
          admissionStarted = true;
          opts?.onAdmissionStarted?.(
            connectionRef.current.sessionId ?? allocatedSessionId,
          );
        },
        onAdmitted: () => {
          admitted = true;
          if (sessionIdAfterEnsure && promptWorkspaceCwd) {
            sessionCatalogController.promptAdmitted(
              promptWorkspaceCwd,
              sessionIdAfterEnsure,
            );
          }
          opts?.onAdmitted?.();
        },
      };
      if (
        sessionIdAfterEnsure &&
        (preparedPrompt.trim() ||
          (images?.length ?? 0) > 0 ||
          (files?.length ?? 0) > 0)
      ) {
        dispatchSessionChangeRef.current?.({
          type: 'submit',
          sessionId: sessionIdAfterEnsure,
          prompt: preparedPrompt,
          queued: false,
        });
      }
      const previousUserMessage = opts?.onOptimisticUserMessage
        ? getLatestUserBlock(store.getSnapshot().blocks)
        : undefined;
      const resultPromise = (
        sessionActions.sendPrompt as (
          promptText: string,
          options?: SendPromptOptionsWithRetry,
        ) => ReturnType<typeof sessionActions.sendPrompt>
      )(preparedPrompt, promptOptions);
      if (
        sessionIdAfterEnsure &&
        opts?.optimisticUserMessage !== false &&
        opts?.onOptimisticUserMessage
      ) {
        const message = getLatestUserBlock(store.getSnapshot().blocks);
        if (message && message !== previousUserMessage) {
          opts.onOptimisticUserMessage({
            sessionId: sessionIdAfterEnsure,
            messageId: message.id,
            identity: { block: message },
            owner: retryOwnerRef.current,
            ...(previousUserMessage
              ? { previousIdentity: { block: previousUserMessage } }
              : {}),
          });
        }
      }
      try {
        return await resultPromise;
      } catch (error) {
        if (
          admissionStarted &&
          !admitted &&
          !isDefinitelyRejectedPromptAdmission(error) &&
          promptWorkspaceCwd
        ) {
          sessionCatalogController.promptAdmissionUncertain(promptWorkspaceCwd);
        }
        throw error;
      }
    },
    [
      beginPromptPreparation,
      clearFollowup,
      ensureSessionForPrompt,
      finishPromptPreparation,
      getComposerWorkspaceCwd,
      sessionCatalogController,
      sessionActions,
      sessionOwnerGuard,
      store,
    ],
  );

  const resolveSessionForWorkspace = useCallback(
    async (cwd: string, forceCreate?: boolean): Promise<string | undefined> => {
      try {
        if (!forceCreate) {
          // Reuse the connected session only when it owns the target checkout.
          // For a linked-worktree session the owned checkout is the worktree
          // path, not the base workspace (activeWorkspaceCwd), so a Commit
          // opened on the base workspace must not borrow the worktree session.
          const sessionOwnerCwd = sessionWorktree?.path ?? activeWorkspaceCwd;
          if (connection.sessionId && sessionOwnerCwd === cwd) {
            return connection.sessionId;
          }
          // Fetch the most recent session for this workspace.
          const page = await loadSessionCatalogOnce(
            workspace.client,
            {
              routeKind: 'qualified',
              workspaceCwd: cwd,
              options: { pageSize: 1, archiveState: 'active' },
            },
            { fresh: true },
          );
          if (page.sessions.length > 0) return page.sessions[0].sessionId;
        }
        // No session exists or forced: create one.
        const result = await (
          sessionActions as typeof sessionActions & SessionActionsWithCreate
        ).createSession({ workspaceCwd: cwd });
        sessionCatalogController.sessionCreated(cwd, result.sessionId);
        return result.sessionId;
      } catch {
        return undefined;
      }
    },
    [
      connection.sessionId,
      activeWorkspaceCwd,
      sessionCatalogController,
      workspace.client,
      sessionActions,
      sessionWorktree,
    ],
  );

  const availableModels = useMemo(
    () =>
      (connection.models ?? []).filter(isVisibleComposerModel).map((m) => ({
        id: m.id,
        label: getModelDisplayName(m.label || m.id),
      })),
    [connection.models],
  );
  const hasAuthoritativeReasoningContext = Boolean(
    connection.sessionId &&
      connection.context?.sessionId === connection.sessionId,
  );
  const welcomeReasoningPreview =
    !connection.sessionId && !connection.context
      ? connection.models?.find((model) => model.id === currentModel)
          ?.reasoningPreview
      : undefined;
  useEffect(() => {
    if (
      pendingReasoningIntent?.modelId === currentModel &&
      pendingReasoningIntent.value === 'none' &&
      welcomeReasoningPreview?.canDisable === false
    ) {
      setPendingReasoningIntent({
        modelId: currentModel,
        value: 'default',
      });
    }
  }, [
    currentModel,
    pendingReasoningIntent,
    setPendingReasoningIntent,
    welcomeReasoningPreview,
  ]);
  const validPendingReasoningIntent =
    pendingReasoningIntent?.modelId === currentModel &&
    welcomeReasoningPreview &&
    reasoningPreviewSupports(
      welcomeReasoningPreview,
      pendingReasoningIntent.value,
    )
      ? pendingReasoningIntent
      : undefined;
  const displayedReasoning = hasAuthoritativeReasoningContext
    ? connection.reasoning
    : welcomeReasoningPreview
      ? {
          ...welcomeReasoningPreview,
          enabled: validPendingReasoningIntent
            ? validPendingReasoningIntent.value !== 'none'
            : welcomeReasoningPreview.enabled,
          effort:
            validPendingReasoningIntent?.value === 'none' ||
            validPendingReasoningIntent?.value === 'default'
              ? (welcomeReasoningPreview.defaultEffort ?? 'default')
              : (validPendingReasoningIntent?.value ??
                welcomeReasoningPreview.effort),
        }
      : undefined;
  // The workspace the Changes dialog reads — the same active workspace the
  // git-status effect targets (computed once above), so the chip and the
  // dialog always target the same repo.
  const gitDiffWorkspaceCwd = isKnownLiveWorkspaceCwd(activeWorkspaceCwd)
    ? undefined
    : activeWorkspaceCwd;
  const activeWorkspaceTrusted = ordinaryWorkspaces.find(
    (entry) => entry.cwd === activeWorkspaceCwd,
  )?.trusted;
  const gitModeEligible = Boolean(
    !connection.sessionId &&
      activeWorkspaceTrusted &&
      selectedWorkspaceGitStatus?.branch,
  );
  // An armed branch/worktree intent survives a transient status gap (a
  // failed poll round, a refetch still in flight); only a definitive answer
  // clears it. The chip stays hidden meanwhile because it keys on
  // `gitModeEligible`.
  // The status is keyed by workspace: right after a draft re-target the
  // state still holds the previous workspace's answer (the git-status effect
  // clears it only after this commit), and a definitive no-branch answer for
  // the workspace being left must not clear an intent armed for the new one.
  // Same cwd-keying as the `git_status_changed` mirror effect above.
  const gitModeIntentInvalid = gitModeIntentMustReset({
    sessionId: connection.sessionId,
    workspaceTrusted: activeWorkspaceTrusted,
    gitStatus:
      selectedWorkspaceGitStatus?.workspaceCwd === activeWorkspaceCwd
        ? selectedWorkspaceGitStatus
        : undefined,
  });
  // Re-run on intent changes as well: an intent set while a session already
  // exists (or the workspace is untrusted / not a repo) has nothing to apply
  // to and must not survive into the next draft.
  useEffect(() => {
    if (gitModeIntentInvalid && gitModeIntent.mode !== 'current') {
      setGitModeIntent({ mode: 'current' });
    }
  }, [gitModeIntentInvalid, gitModeIntent]);
  const handleOpenGitDiff = useCallback(() => {
    if (!gitDiffWorkspaceCwd) return;
    setGitDialog({
      workspaceCwd: gitDiffWorkspaceCwd,
      gitCwd: sessionWorktree?.path,
      view: 'diff',
    });
  }, [gitDiffWorkspaceCwd, sessionWorktree?.path]);
  const handleOpenCommit = useCallback(() => {
    if (!gitDiffWorkspaceCwd) return;
    setGitDialog({
      workspaceCwd: gitDiffWorkspaceCwd,
      gitCwd: sessionWorktree?.path,
      view: 'commit',
    });
  }, [gitDiffWorkspaceCwd, sessionWorktree?.path]);
  const dialogOpen =
    showResumeDialog ||
    showDeleteDialog ||
    showReleaseDialog ||
    showRewindDialog ||
    showHelpDialog ||
    showThemeDialog ||
    showToolsDialog ||
    gitDialog !== undefined ||
    modelDialogMode !== null ||
    showApprovalModeDialog ||
    tasksDialogMessage !== null ||
    // mcpDialogMessage survives closing the Plugins panel; MCP surfaces are
    // already blocked by activePanel below, so including it would lock chat.
    showMemoryDialog ||
    showAuthDialog ||
    showAddWorkspaceDialog ||
    scratchOutcomeUnknown !== 'clear' ||
    externalInteractionBlockCount > 0 ||
    // The Settings / Daemon Status panel replaces the chat surface, so — like a
    // modal — it must suppress chat-only global shortcuts (Ctrl+L/O/Y, the
    // Shift+Tab mode cycle, the btw hotkey). Escape is intercepted earlier and
    // returns to the chat instead of falling through to those handlers.
    activePanel !== null;
  // Block chat interaction (composer, chat keyboard shortcuts) both when a modal
  // is open (dialogOpen, which already includes the Settings/Status panel) and
  // while a covering surface hides the chat — a full-pane view (the Scheduled
  // Tasks page) or the fullscreen artifact panel — so keystrokes/Escape can't
  // reach the hidden composer underneath. The fullscreen gate also keeps the
  // btw capture-phase Escape handler from dismissing hidden content and
  // swallowing the Escape that shrinks the panel.
  const interactionBlocked =
    dialogOpen || mainView !== 'chat' || artifactPanelFullscreen;
  const mainVoiceTarget = useMemo(
    () =>
      workspaceContextActive
        ? resolveVoiceWorkspaceTarget({
            capabilities: workspace.capabilities,
            intendedCwd: activeWorkspaceCwd,
            sessionId: connection.sessionId,
            workspaces:
              workspace.capabilities?.workspaces || lockedWorkspaceCapability
                ? ordinaryWorkspaces
                : undefined,
          })
        : undefined,
    [
      activeWorkspaceCwd,
      connection.sessionId,
      lockedWorkspaceCapability,
      workspace.capabilities,
      ordinaryWorkspaces,
      workspaceContextActive,
    ],
  );
  const [voiceUserRevision, setVoiceUserRevision] = useState(0);
  const [voiceWorkspaceRevisions, setVoiceWorkspaceRevisions] = useState<
    Record<string, number>
  >({});
  const mainVoiceStatusRevision: VoiceStatusRevision = useMemo(
    () => ({
      user: voiceUserRevision,
      workspace: mainVoiceTarget
        ? (voiceWorkspaceRevisions[mainVoiceTarget.workspaceKey] ?? 0)
        : 0,
    }),
    [mainVoiceTarget, voiceUserRevision, voiceWorkspaceRevisions],
  );
  const voiceModelSettingsSupported = supportsVoiceModelSettings(
    mainVoiceTarget,
    workspace.capabilities?.features ?? [],
  );
  const matchingVoiceSettingsVersion =
    mainVoiceTarget?.sessionId === connection.sessionId &&
    (!mainVoiceTarget?.cwd || mainVoiceTarget.cwd === connection.workspaceCwd)
      ? workspaceEventSignals?.settingsVersion
      : undefined;
  const {
    descriptor: qualifiedVoiceSetting,
    reload: reloadQualifiedVoiceSettings,
  } = useVoiceWorkspaceSettings(
    workspace.client,
    mainVoiceTarget,
    voiceModelSettingsSupported && mainView !== 'split',
    JSON.stringify([
      voiceUserRevision,
      mainVoiceStatusRevision.workspace,
      matchingVoiceSettingsVersion ?? null,
    ]),
  );

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      if (isAbortError(error)) return;
      if (isDaemonTurnError(error)) {
        return;
      }
      if (isAlreadyDispatched(error)) {
        return;
      }
      const message = formatError(error, fallback);
      console.error('[web-shell]', message, error);
      pushToast('error', message);
    },
    [pushToast],
  );
  const handleFailedPromptRetry = useCallback(() => {
    if (
      sessionWriteBlockedRef.current ||
      promptPreparationOwnerRef.current ||
      streamingStateRef.current !== 'idle' ||
      sessionHasActivePromptRef.current
    ) {
      return;
    }
    let failed = failedPromptRef.current;
    if (!failed || failed.sessionId !== connectionRef.current.sessionId) {
      updateFailedPrompt(null);
      return;
    }
    const retryOwner = failed.owner;
    if (!retryOwnerIsCurrent(retryOwner)) {
      updateFailedPrompt(null);
      return;
    }
    const currentFailedBlock = getLatestUserBlock(store.getSnapshot().blocks);
    if (
      !currentFailedBlock ||
      !matchesUserMessageIdentity(
        currentFailedBlock,
        failed.identity,
        retryOwner.snapshot.isCurrent(),
      )
    ) {
      updateFailedPrompt(null);
      return;
    }
    if (
      currentFailedBlock !== failed.identity.block ||
      currentFailedBlock.id !== failed.messageId
    ) {
      failed = {
        ...failed,
        messageId: currentFailedBlock.id,
        identity: { block: currentFailedBlock },
      };
    }
    updateFailedPrompt(null);
    const retryStartedAt = Date.now();
    const retryAttemptId = ++cancelledRetryAttemptRef.current;
    const retryTranscriptIdentity: FailedPromptRetry['transcriptIdentity'] = {
      kind: 'failed-prompt',
      identity: failed.identity,
    };
    const retryTranscriptIsCurrent = () =>
      retryTranscriptIdentityMatches(
        store.getSnapshot().blocks,
        retryTranscriptIdentity,
        retryOwner.snapshot.isCurrent(),
      );
    setFailedPromptRetry({
      sessionId: failed.sessionId,
      messageId: failed.messageId,
      startedAt: retryStartedAt,
      admitted: false,
      settled: false,
      owner: retryOwner,
      transcriptIdentity: retryTranscriptIdentity,
    });
    let admitted = false;
    let admissionStarted = false;
    sendPrompt(failed.text, failed.images, failed.files, {
      optimisticUserMessage: false,
      skipPrepareSubmit: true,
      inputAnnotations: failed.inputAnnotations,
      onAdmissionStarted: () => {
        admissionStarted = true;
      },
      onAdmitted: () => {
        admitted = true;
        if (!retryOwnerIsCurrent(retryOwner)) return;
        setFailedPromptRetry((current) =>
          current?.transcriptIdentity === retryTranscriptIdentity
            ? retryTranscriptIsCurrent()
              ? { ...current, admitted: true }
              : null
            : current,
        );
      },
      onCancelledBeforeAdmission: () => {
        restoreOrDeferCancelledRetry(retryOwner, {
          kind: 'failed-prompt',
          attemptId: retryAttemptId,
          failed,
        });
      },
    })
      .catch((error: unknown) => {
        if (!retryOwnerIsCurrent(retryOwner)) return;
        const definitelyRejected = isDefinitelyRejectedPromptAdmission(error);
        if (admissionStarted && !admitted && !definitelyRejected) {
          if (!retryTranscriptIsCurrent()) return;
          updateUnknownPromptAdmission({
            sessionId: failed.sessionId,
            messageId: failed.messageId,
            text: failed.text,
            images: failed.images ? [...failed.images] : undefined,
            files: failed.files ? [...failed.files] : undefined,
            inputAnnotations: failed.inputAnnotations,
            payloadAvailable: true,
          });
          pushToast('warning', t('queue.admissionUnknown'));
          console.warn(
            '[WebShell] prompt retry admission outcome is unknown',
            error,
          );
          return;
        }
        if (!admitted) {
          restoreOrDeferCancelledRetry(retryOwner, {
            kind: 'failed-prompt',
            attemptId: retryAttemptId,
            failed,
          });
        }
        if (retryTranscriptIsCurrent()) {
          reportError(error, 'Failed to resend message');
        }
      })
      .finally(() => {
        if (!retryOwnerIsCurrent(retryOwner)) return;
        setFailedPromptRetry((current) =>
          current?.transcriptIdentity === retryTranscriptIdentity
            ? retryTranscriptIsCurrent()
              ? { ...current, settled: true }
              : null
            : current,
        );
      });
  }, [
    pushToast,
    reportError,
    restoreOrDeferCancelledRetry,
    retryOwnerIsCurrent,
    sendPrompt,
    store,
    t,
    updateFailedPrompt,
    updateUnknownPromptAdmission,
  ]);
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
    enqueuePrompt: rawEnqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  } = useQueuedPrompts({
    connected,
    writeBlocked: sessionWriteBlocked,
    sessionId: connection.sessionId,
    workspaceCwd: connection.workspaceCwd,
    clientId: connection.clientId,
    canMutateMidTurn,
    canQueryMidTurn,
    canInjectMidTurnMedia,
    workspaceFileActions: artifactWorkspaceActions,
    streamingState,
    sessionHasActivePrompt,
    sessionActions,
    store,
    editorRef,
    reportError,
    t,
  });

  const enqueuePrompt = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      onComplete?: () => void,
      commitComposerAccepted?: ComposerSubmitCommit,
      inputAnnotations?: DaemonInputAnnotation[],
    ) => {
      const normalizedInputAnnotations = inputAnnotations
        ? [...inputAnnotations]
        : [];
      const enqueuePreparedPrompt = (
        prepared: WebShellPreparedSubmit,
        sessionId: string | undefined,
        workspaceCwd: string | undefined,
      ) => {
        if (
          !prepared.prompt.trim() &&
          (images?.length ?? 0) === 0 &&
          (files?.length ?? 0) === 0
        ) {
          return false;
        }
        const annotations =
          prepared.inputAnnotations && prepared.inputAnnotations.length > 0
            ? [...prepared.inputAnnotations]
            : undefined;
        const result = rawEnqueuePrompt(
          prepared.prompt,
          images,
          files,
          onComplete,
          annotations,
        );
        if (result !== false) {
          if (commitComposerAccepted) {
            commitComposerAccepted();
          } else {
            editorRef.current?.clear();
          }
        }
        if (
          sessionId &&
          (prepared.prompt.trim() ||
            (images?.length ?? 0) > 0 ||
            (files?.length ?? 0) > 0)
        ) {
          dispatchSessionChangeRef.current?.({
            type: 'submit',
            sessionId,
            prompt: prepared.prompt,
            queued: true,
          });
          if (workspaceCwd) {
            sessionCatalogController.invalidateWorkspace(workspaceCwd);
          }
        }
        return result;
      };
      const prepare = prepareSubmitRef.current;
      const submitBefore = onSubmitBeforeRef.current;
      if (prepare || submitBefore) {
        const sourceOwner = sessionOwnerGuard.capture();
        const sourceSessionId = connectionRef.current.sessionId;
        const sourceWorkspaceCwd = getComposerWorkspaceCwd();
        const sourceVersion = composerSourceVersionRef.current;
        const writeBlockGeneration = sessionWriteBlockGenerationRef.current;
        const submissionOwnerIsCurrent = () =>
          appMountedRef.current &&
          sourceOwner.isCurrent() &&
          !sessionWriteBlockedRef.current &&
          sessionWriteBlockGenerationRef.current === writeBlockGeneration &&
          connectionRef.current.sessionId === sourceSessionId &&
          getComposerWorkspaceCwd() === sourceWorkspaceCwd &&
          composerSourceVersionRef.current === sourceVersion;
        void (async () => {
          let preparedPrompt = text;
          let preparedInputAnnotations = normalizedInputAnnotations;
          try {
            if (prepare) {
              const prepared = await prepare({
                sessionId: sourceSessionId,
                prompt: preparedPrompt,
                inputAnnotations: preparedInputAnnotations,
              });
              const resolved = resolvePreparedSubmit(
                preparedPrompt,
                preparedInputAnnotations,
                prepared,
              );
              preparedPrompt = resolved.prompt;
              preparedInputAnnotations = [...(resolved.inputAnnotations ?? [])];
            }
            if (!submissionOwnerIsCurrent()) return;
            if (submitBefore) {
              await submitBefore({
                sessionId: sourceSessionId,
                prompt: preparedPrompt,
              });
            }
            if (!submissionOwnerIsCurrent()) return;
            enqueuePreparedPrompt(
              {
                prompt: preparedPrompt,
                inputAnnotations: preparedInputAnnotations,
              },
              sourceSessionId,
              sourceWorkspaceCwd,
            );
          } catch (err) {
            console.warn(
              '[web-shell] queued prompt preflight rejected, cancelled',
              err,
            );
          }
        })();
        return false;
      }
      return enqueuePreparedPrompt(
        {
          prompt: text,
          inputAnnotations: normalizedInputAnnotations,
        },
        connectionRef.current.sessionId,
        getComposerWorkspaceCwd(),
      );
    },
    [
      getComposerWorkspaceCwd,
      rawEnqueuePrompt,
      sessionCatalogController,
      sessionOwnerGuard,
    ],
  );

  useEffect(() => {
    for (const notice of notices) {
      if (shouldToastNotice(notice)) {
        pushToast(toastToneFromNotice(notice), notice.message);
      } else if (notice.category !== 'lifecycle') {
        console.warn('[web-shell] daemon notice', notice);
      }
      dismissNotice(notice.id);
    }
  }, [dismissNotice, notices, pushToast]);

  const onBugReportRef = useRef(onBugReport);
  onBugReportRef.current = onBugReport;

  useEffect(() => {
    currentSessionIdRef.current = connection.sessionId;
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setRecapMessage(null);
    setBtwMessage(null);
    setTasksDialogMessage(null);
    lastRecapBlockCountRef.current = 0;
  }, [connection.sessionId, connection.workspaceCwd]);

  const runVisibleRecap = useCallback(() => {
    if (sessionWriteBlocked) return;
    if (!requireActiveSessionForLocalCommand()) return;
    const messageId = `local-recap-${nextRecapMessageIdRef.current++}`;
    const currentMessages = messagesRef.current;
    const anchorIndex = currentMessages.length;
    const anchorAfterId = currentMessages.at(-1)?.id;
    const sessionId = connection.sessionId;
    const workspaceCwd = connection.workspaceCwd;
    setRecapMessage({
      anchorAfterId,
      anchorIndex,
      message: {
        id: messageId,
        role: 'system',
        content: `※ ${t('recap.label')}: ${t('recap.loading')}`,
        variant: 'info',
        source: 'recap',
      },
    });
    sessionActions.recapSession().then(
      (result) => {
        if (
          currentSessionIdRef.current !== sessionId ||
          connectionRef.current.workspaceCwd !== workspaceCwd
        )
          return;
        setRecapMessage({
          anchorAfterId,
          anchorIndex,
          message: {
            id: messageId,
            role: 'system',
            content: result.recap
              ? `※ ${t('recap.label')}: ${result.recap}`
              : t('recap.empty'),
            variant: 'info',
            source: 'recap',
          },
        });
      },
      (error: unknown) => {
        if (
          currentSessionIdRef.current !== sessionId ||
          connectionRef.current.workspaceCwd !== workspaceCwd
        )
          return;
        setRecapMessage(null);
        if (!isAbortError(error) && !isAlreadyDispatched(error)) {
          console.warn('[web-shell] unhandled recap failure', error);
        }
      },
    );
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    requireActiveSessionForLocalCommand,
    sessionWriteBlocked,
    sessionActions,
    t,
  ]);

  const runVisibleBtw = useCallback(
    (rawQuestion: string) => {
      if (sessionWriteBlocked) return;
      const question = rawQuestion.trim();
      if (!question) {
        pushToast('error', t('btw.empty'));
        return;
      }
      if (!requireActiveSessionForLocalCommand()) return;

      const messageId = `local-btw-${nextBtwMessageIdRef.current++}`;
      const sessionId = connection.sessionId;
      const workspaceCwd = connection.workspaceCwd;
      btwAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      btwAbortControllerRef.current = abortController;
      setBtwMessage({
        id: messageId,
        role: 'btw',
        question,
        answer: '',
        isPending: true,
      });

      sessionActions
        .btwSession(question, { signal: abortController.signal })
        .then(
          (result) => {
            if (
              currentSessionIdRef.current !== sessionId ||
              connectionRef.current.workspaceCwd !== workspaceCwd
            )
              return;
            if (btwAbortControllerRef.current !== abortController) return;
            btwAbortControllerRef.current = null;
            setBtwMessage({
              id: messageId,
              role: 'btw',
              question,
              answer: result.answer || t('btw.emptyAnswer'),
              isPending: false,
            });
          },
          (error: unknown) => {
            if (
              currentSessionIdRef.current !== sessionId ||
              connectionRef.current.workspaceCwd !== workspaceCwd
            )
              return;
            if (btwAbortControllerRef.current !== abortController) return;
            btwAbortControllerRef.current = null;
            setBtwMessage(null);
            if (!isAbortError(error) && !isAlreadyDispatched(error)) {
              console.warn('[web-shell] unhandled btw failure', error);
            }
          },
        );
    },
    [
      connection.sessionId,
      connection.workspaceCwd,
      pushToast,
      requireActiveSessionForLocalCommand,
      sessionWriteBlocked,
      sessionActions,
      t,
    ],
  );

  const dismissBtwMessage = useCallback(() => {
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setBtwMessage(null);
  }, []);

  useEffect(() => {
    const onBtwShortcut = (e: KeyboardEvent) => {
      if (interactionBlocked || pendingApproval || isWebTerminalTarget(e))
        return;
      const message = btwMessage;
      if (!message || message.role !== 'btw') return;

      const key = e.key.toLowerCase();
      const isPlainEscape =
        e.key === 'Escape' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey;
      const isCtrlCancel =
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (key === 'c' || key === 'd');

      if (message.isPending) {
        if (!isPlainEscape && !isCtrlCancel) return;
      } else {
        const editorHasText = editorRef.current?.hasInput() ?? false;
        const isPlainDismiss =
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          (e.key === 'Escape' ||
            (!editorHasText && (e.key === 'Enter' || e.key === ' ')));
        if (!isPlainDismiss) return;
      }

      e.preventDefault();
      e.stopPropagation();
      dismissBtwMessage();
    };

    window.addEventListener('keydown', onBtwShortcut, true);
    return () => window.removeEventListener('keydown', onBtwShortcut, true);
  }, [interactionBlocked, btwMessage, dismissBtwMessage, pendingApproval]);

  // Echo a local command into the transcript, or suppress it while a turn is
  // streaming so the injected user row can't split the active turn (see
  // appendOrDeferLocalUserMessage). Returns true when suppressed — callers must
  // then stop and not run the command's inline side effects. Exception:
  // read-only display commands wrap this in echoLocalCommandIfIdle and
  // intentionally ignore the suppression signal — their status-block output
  // does not split the active turn.
  const echoOrDeferLocalCommand = useCallback(
    (text: string, images?: PromptImage[]): boolean =>
      appendOrDeferLocalUserMessage(
        streamingStateRef.current !== 'idle',
        text,
        images,
        {
          append: (value: string) => store.appendLocalUserMessage(value),
        },
      ),
    [store],
  );

  // Echo a local command when idle, but never block it. Read-only display
  // commands (/stats, /about, /context) render their result as a status
  // block, which does not split the active turn, so they run immediately
  // mid-turn with only the echo skipped.
  const echoLocalCommandIfIdle = useCallback(
    (text: string): void => {
      void echoOrDeferLocalCommand(text);
    },
    [echoOrDeferLocalCommand],
  );

  // Shared result dispatch for those read-only commands: `clearActiveText:
  // false` keeps the status block from finalizing the in-flight assistant
  // block mid-stream, which would split the streaming answer and orphan its
  // usage frames.
  const dispatchReadOnlyStatus = useCallback(
    (text: string) => {
      store.dispatch([{ type: 'status', text, clearActiveText: false }]);
      resumeChatBottomFollow('smooth');
    },
    [store, resumeChatBottomFollow],
  );

  const blockCommand = useCallback((): false => {
    pushToast(
      'error',
      t(
        isGoalGateBlocked()
          ? 'queue.commandGoalBlocked'
          : 'queue.commandBlocked',
      ),
    );
    return false;
  }, [isGoalGateBlocked, pushToast, t]);

  const handleThemeChange = useCallback(
    (nextTheme: WebShellTheme) => {
      setSelectedTheme(nextTheme);
      onThemeChange?.(nextTheme);
    },
    [onThemeChange],
  );

  const handleLanguageChange = useCallback(
    (nextLanguage: WebShellLanguage) => {
      setSelectedLanguage(nextLanguage);
      onLanguageChange?.(nextLanguage);
    },
    [onLanguageChange],
  );

  const handleToggleShortcuts = useCallback(() => {
    setShowHelpDialog(true);
  }, []);

  const workspaceSettingsState = useSettings({
    autoLoad: workspaceContextActive,
    enabled: workspaceContextActive,
  });
  const providersState = useProviders({
    autoLoad: workspaceContextActive,
    enabled: workspaceContextActive,
  });
  // useProviders returns a fresh object each render, but its `reload` identity is
  // stable — pull it out so callbacks can depend on the function alone without
  // re-creating on every render (and without an exhaustive-deps warning).
  const reloadProviders = providersState.reload;
  const [modelActionBusy, setModelActionBusy] = useState(false);
  const modelActionTokenRef = useRef(0);
  useLayoutEffect(() => {
    modelActionTokenRef.current += 1;
    setModelActionBusy(false);
  }, [logicalSessionKey]);
  const {
    settings: loadedWorkspaceSettings,
    setValue: setWorkspaceSetting,
    reload: reloadWorkspaceSettings,
  } = workspaceSettingsState;
  const workspaceSettings = useMemo(
    () => (workspaceContextActive ? loadedWorkspaceSettings : []),
    [loadedWorkspaceSettings, workspaceContextActive],
  );
  const liveSetup = useLiveVoiceSetup(
    workspaceSettings.some(
      (setting) => setting.key === 'experimental.liveVoice.enabled',
    ),
  );
  // Do not expose workflow surfaces until settings have loaded successfully.
  // The resource keeps stale data when a reload fails, so the error check is
  // required to fail closed in that case too. `loading` is deliberately NOT
  // part of the gate: a background revalidation (any client of this workspace
  // saving any setting bumps settingsVersion) sets loading:true while keeping
  // the last-known-good data, and gating on it would evict the user from an
  // established Workflow view and delete its deep link. The initial load still
  // fails closed via `status === undefined`.
  const sessionWorkflowEnabled =
    !workspaceSettingsState.error &&
    workspaceSettingsState.status !== undefined &&
    workspaceSettings.find(
      (setting) => setting.key === 'experimental.sessionWorkflow',
    )?.values.effective === true;
  const sessionWorkflowSettingsResolved =
    workspaceSettingsState.status !== undefined ||
    workspaceSettingsState.error !== undefined;
  const sessionWorkflowTodosState = useMemo(
    () =>
      sessionWorkflowEnabled
        ? getSessionWorkflowTodos(messages)
        : EMPTY_SESSION_WORKFLOW_TODOS,
    [messages, sessionWorkflowEnabled],
  );
  const sessionWorkflowTodos = useStableArray(
    sessionWorkflowTodosState.todos,
    (todo) =>
      JSON.stringify([
        todo.id,
        todo.status,
        todo.content,
        todo.blockedBy ?? [],
      ]),
  );
  const floatingTodosUseSessionWorkflow =
    sessionWorkflowEnabled &&
    floatingTodosState.sourceMessageId !== null &&
    floatingTodosState.sourceMessageId ===
      sessionWorkflowTodosState.sourceMessageId;
  const [selectedWorkflowTodoId, setSelectedWorkflowTodoId] = useState<
    string | undefined
  >();
  useEffect(() => {
    setSelectedWorkflowTodoId(undefined);
  }, [logicalSessionKey]);
  useEffect(() => {
    if (
      approvalOverlayActive ||
      sessionWorkflowEnabled ||
      !sessionWorkflowSettingsResolved ||
      !artifactPanelTabs.some((tab) => tab.kind === 'workflow')
    ) {
      return;
    }
    closeArtifactPanelTab('workflow');
  }, [
    artifactPanelTabs,
    approvalOverlayActive,
    closeArtifactPanelTab,
    sessionWorkflowEnabled,
    sessionWorkflowSettingsResolved,
  ]);
  const environmentAgentTasks = useMemo(
    () => getEnvironmentAgentTasks(messages, sessionTasks),
    [messages, sessionTasks],
  );
  const lastReportedAgentTasksRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!onAgentTasksChange) {
      lastReportedAgentTasksRef.current = undefined;
      return;
    }
    const snapshot = JSON.stringify(
      environmentAgentTasks.map(
        ({
          runtimeMs: _runtimeMs,
          stats: _stats,
          recentActivities: _recentActivities,
          prompt: _prompt,
          ...stable
        }) => stable,
      ),
    );
    if (snapshot === lastReportedAgentTasksRef.current) return;
    lastReportedAgentTasksRef.current = snapshot;
    onAgentTasksChange(environmentAgentTasks);
  }, [environmentAgentTasks, onAgentTasksChange]);
  const planAgentTools = useMemo(() => {
    if (
      !sessionWorkflowEnabled ||
      (mainView !== 'cockpit' &&
        !artifactPanelTabs.some((tab) => tab.kind === 'workflow'))
    ) {
      return [];
    }
    return getAgentToolsForPlan(messages, sessionWorkflowTodosState);
  }, [
    artifactPanelTabs,
    mainView,
    messages,
    sessionWorkflowEnabled,
    sessionWorkflowTodosState,
  ]);
  // The tasks dialog renders the floating (latest) plan, so its agent tools
  // anchor to floatingTodosState. That anchoring must stay out of
  // planAgentTools: the cockpit and workflow inspector stay mounted behind
  // the dialog and would lose (or re-anchor) the session-workflow plan's
  // linked tools whenever the dialog opens after a user message emptied the
  // floating plan.
  const tasksDialogAgentTools = useMemo(
    () =>
      tasksDialogMessage
        ? getAgentToolsForPlan(messages, floatingTodosState)
        : [],
    [floatingTodosState, messages, tasksDialogMessage],
  );
  const reloadTargetedWorkspaceSettings = useCallback(async () => {
    const status = await reloadWorkspaceSettings();
    if (mainVoiceTarget?.route === 'workspace-qualified') {
      await reloadQualifiedVoiceSettings();
    }
    return status;
  }, [
    mainVoiceTarget?.route,
    reloadQualifiedVoiceSettings,
    reloadWorkspaceSettings,
  ]);
  const targetedWorkspaceSettings = useMemo(() => {
    const withoutVoice = workspaceSettings.filter(
      (setting) => setting.key !== 'voiceModel',
    );
    if (mainView === 'split') return withoutVoice;
    if (mainVoiceTarget?.route === 'legacy-primary') return workspaceSettings;
    if (!voiceModelSettingsSupported || !qualifiedVoiceSetting) {
      return withoutVoice;
    }
    const voiceIndex = workspaceSettings.findIndex(
      (setting) => setting.key === 'voiceModel',
    );
    if (voiceIndex < 0) {
      return [...withoutVoice, qualifiedVoiceSetting];
    }
    return workspaceSettings.map((setting) =>
      setting.key === 'voiceModel' ? qualifiedVoiceSetting : setting,
    );
  }, [
    mainView,
    mainVoiceTarget?.route,
    qualifiedVoiceSetting,
    voiceModelSettingsSupported,
    workspaceSettings,
  ]);
  const targetedWorkspaceSettingsState = {
    ...workspaceSettingsState,
    settings: targetedWorkspaceSettings,
    reload: reloadTargetedWorkspaceSettings,
    liveSetup,
  };
  const themeSetting = workspaceSettings.find(
    (setting) => setting.key === THEME_SETTING_KEY,
  );
  const hideTipsSetting = workspaceSettings.find(
    (setting) => setting.key === HIDE_TIPS_SETTING_KEY,
  );
  const languageSetting = workspaceSettings.find(
    (setting) => setting.key === LANGUAGE_SETTING_KEY,
  );
  const currentVoiceModel = (() => {
    const value = readScopedModelSetting(
      targetedWorkspaceSettings,
      modelSettingScope,
      'voiceModel',
    );
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
  const currentVisionModel = (() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'visionModel',
    );
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return decodeVisionModelForPicker(value.trim());
  })();
  const currentFastModel = (() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'fastModel',
    );
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
  const currentModelFallbacks = useMemo(() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'modelFallbacks',
    );
    return typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  }, [workspaceSettings, modelSettingScope]);
  const bumpVoiceRevision = useCallback(
    (target: typeof mainVoiceTarget, scope: 'workspace' | 'user') => {
      if (!target) return;
      if (scope === 'user') {
        setVoiceUserRevision((revision) => revision + 1);
        return;
      }
      setVoiceWorkspaceRevisions((revisions) => ({
        ...revisions,
        [target.workspaceKey]: (revisions[target.workspaceKey] ?? 0) + 1,
      }));
    },
    [],
  );
  const writeVoiceModelForTarget = useCallback(
    async (
      value: string,
      scope: 'workspace' | 'user',
      target = mainVoiceTarget,
    ) => {
      if (
        !target ||
        !supportsVoiceModelSettings(
          target,
          workspace.capabilities?.features ?? [],
        )
      ) {
        throw new Error(
          'Voice model settings are unavailable for this workspace.',
        );
      }
      try {
        if (target.route === 'legacy-primary' || scope === 'user') {
          await setWorkspaceSetting(scope, 'voiceModel', value);
        } else {
          await setVoiceModelSetting(workspace.client, target, scope, value);
        }
      } catch (error) {
        bumpVoiceRevision(target, scope);
        if (target.route === 'legacy-primary') {
          await reloadWorkspaceSettings().catch(() => undefined);
        } else {
          await reloadQualifiedVoiceSettings().catch(() => undefined);
        }
        throw error;
      }
      bumpVoiceRevision(target, scope);
      if (target.route === 'legacy-primary') {
        await reloadWorkspaceSettings().catch(() => undefined);
      } else {
        await reloadQualifiedVoiceSettings().catch(() => undefined);
      }
    },
    [
      bumpVoiceRevision,
      mainVoiceTarget,
      reloadQualifiedVoiceSettings,
      reloadWorkspaceSettings,
      setWorkspaceSetting,
      workspace.capabilities?.features,
      workspace.client,
    ],
  );
  const mainVoiceTargetRef = useRef(mainVoiceTarget);
  const voiceFeaturesRef = useRef(workspace.capabilities?.features ?? []);
  useLayoutEffect(() => {
    modelDialogModeRef.current = modelDialogMode;
    showFallbacksDialogRef.current = showFallbacksDialog;
    mainViewRef.current = mainView;
    activePanelRef.current = activePanel;
    showAuthDialogRef.current = showAuthDialog;
    mainVoiceTargetRef.current = mainVoiceTarget;
    voiceFeaturesRef.current = workspace.capabilities?.features ?? [];
  }, [
    activePanel,
    mainView,
    mainVoiceTarget,
    modelDialogMode,
    showAuthDialog,
    showFallbacksDialog,
    workspace.capabilities?.features,
  ]);
  const voicePickerRequestRef = useRef(0);
  const pendingVoicePickerSourceRef = useRef<
    'command' | 'settings' | undefined
  >(undefined);
  const pendingVoicePickerOwnerRef = useRef<string | undefined>(undefined);
  const voicePickerTargetRef = useRef(mainVoiceTarget);
  useEffect(
    () => () => {
      voicePickerRequestRef.current++;
      pendingVoicePickerSourceRef.current = undefined;
    },
    [],
  );
  const openVoiceModelPicker = useCallback(
    async (scope: 'workspace' | 'user', source: 'command' | 'settings') => {
      const target = mainVoiceTargetRef.current;
      if (
        !target ||
        !supportsVoiceModelSettings(
          target,
          workspace.capabilities?.features ?? [],
        )
      ) {
        reportError(
          new Error('Voice model settings are unavailable for this workspace.'),
          t('model.setVoice'),
        );
        return;
      }
      const request = ++voicePickerRequestRef.current;
      pendingVoicePickerSourceRef.current = source;
      pendingVoicePickerOwnerRef.current = target.ownerKey;
      const intentIsCurrent = () =>
        request === voicePickerRequestRef.current &&
        mainVoiceTargetRef.current?.ownerKey === target.ownerKey &&
        supportsVoiceModelSettings(
          mainVoiceTargetRef.current,
          voiceFeaturesRef.current,
        ) &&
        (source === 'settings'
          ? activePanelRef.current === 'settings'
          : activePanelRef.current === null) &&
        mainViewRef.current === 'chat' &&
        modelDialogModeRef.current === null &&
        !showFallbacksDialogRef.current &&
        !showAuthDialogRef.current;
      try {
        const status = await loadVoiceProviders(workspace.client, target);
        if (!intentIsCurrent()) {
          if (request === voicePickerRequestRef.current) {
            pendingVoicePickerSourceRef.current = undefined;
          }
          return;
        }
        pendingVoicePickerSourceRef.current = undefined;
        voicePickerTargetRef.current = target;
        setVoiceModels(extractVoiceModels(status));
        setModelSettingScope(scope);
        setModelDialogMode('voice');
      } catch (error) {
        if (!intentIsCurrent()) {
          if (request === voicePickerRequestRef.current) {
            pendingVoicePickerSourceRef.current = undefined;
          }
          return;
        }
        pendingVoicePickerSourceRef.current = undefined;
        reportError(error, t('model.setVoice'));
      }
    },
    [reportError, t, workspace.capabilities?.features, workspace.client],
  );
  useEffect(() => {
    if (
      pendingVoicePickerSourceRef.current &&
      (pendingVoicePickerOwnerRef.current !== mainVoiceTarget?.ownerKey ||
        !voiceModelSettingsSupported)
    ) {
      voicePickerRequestRef.current++;
      pendingVoicePickerSourceRef.current = undefined;
    }
  }, [mainVoiceTarget?.ownerKey, voiceModelSettingsSupported]);
  useEffect(() => {
    const source = pendingVoicePickerSourceRef.current;
    const sourceSurfaceIsCurrent =
      source === 'settings' ? activePanel === 'settings' : activePanel === null;
    if (source && !sourceSurfaceIsCurrent) {
      voicePickerRequestRef.current++;
      pendingVoicePickerSourceRef.current = undefined;
    }
  }, [activePanel]);
  useEffect(() => {
    if (
      pendingVoicePickerSourceRef.current &&
      (mainView !== 'chat' ||
        modelDialogMode !== null ||
        showFallbacksDialog ||
        showAuthDialog)
    ) {
      voicePickerRequestRef.current++;
      pendingVoicePickerSourceRef.current = undefined;
    }
  }, [mainView, modelDialogMode, showAuthDialog, showFallbacksDialog]);
  useEffect(() => {
    const pickerTarget = voicePickerTargetRef.current;
    if (
      modelDialogMode === 'voice' &&
      (pickerTarget?.ownerKey !== mainVoiceTarget?.ownerKey ||
        !voiceModelSettingsSupported ||
        mainView !== 'chat')
    ) {
      setModelDialogMode(null);
    }
  }, [
    mainView,
    mainVoiceTarget?.ownerKey,
    modelDialogMode,
    voiceModelSettingsSupported,
  ]);
  // Fallback candidates are the selectable (non-runtime) models, keyed by their
  // base id — the same value shape the modelFallbacks setting stores.
  const fallbackModelOptions = useMemo(() => {
    // modelFallbacks stores bare ids and the dialog keys rows by baseId, so
    // dedupe here — multiple endpoints can expose the same base model id.
    const seen = new Set<string>();
    const options: Array<{ baseId: string; label: string }> = [];
    for (const m of (connection.models ?? [])
      .filter(isVisibleComposerModel)
      .filter((m) => !m.isRuntime)) {
      const baseId = m.baseModelId ?? extractBareModelId(m.id);
      if (seen.has(baseId)) continue;
      seen.add(baseId);
      options.push({
        baseId,
        label: getModelDisplayName(m.label || m.baseModelId || m.id),
      });
    }
    return options;
  }, [connection.models]);

  useEffect(() => {
    if (providedTheme) {
      setSelectedTheme(providedTheme);
      return;
    }
    const settingTheme = themeSettingToWebShellTheme(
      themeSetting?.values.effective,
    );
    if (settingTheme) {
      setSelectedTheme(settingTheme);
    }
  }, [providedTheme, themeSetting?.values.effective]);

  useEffect(() => {
    if (providedLanguage !== undefined) {
      setSelectedLanguage(normalizeLanguage(providedLanguage));
      return;
    }
    const settingLanguage = languageSettingToWebShellLanguage(
      languageSetting?.values.effective,
    );
    if (settingLanguage) {
      setSelectedLanguage(settingLanguage);
    }
  }, [providedLanguage, languageSetting?.values.effective]);

  const handleSettingsLanguageChange = useCallback(
    (nextLanguage: WebShellLanguage, scope: 'user' | 'workspace' = 'user') => {
      if (sessionWriteBlocked) return;
      const owner = { current: sessionOwnerGuard.capture() };
      const previousLanguage = selectedLanguage;
      // Forward the settings tab's scope to the command so a Workspace-tab edit
      // persists to workspace settings instead of always writing user scope
      // (the /language command otherwise defaults to user). The command still
      // switches the daemon's live locale so command descriptions re-localize —
      // which a plain scoped settings write wouldn't do.
      const scopeFlag = scope === 'workspace' ? ' --project' : ' --global';
      const command = `/language ui ${nextLanguage}${scopeFlag}`;
      handleLanguageChange(nextLanguage);
      const refreshSettings = async () => {
        if (!owner.current.isCurrent()) return;
        await Promise.all([
          sessionActions.refreshCommands(),
          reloadWorkspaceSettings(),
        ]);
      };
      if (
        streamingStateRef.current !== 'idle' ||
        sessionHasActivePromptRef.current ||
        isGoalGateBlocked()
      ) {
        handleLanguageChange(previousLanguage);
        blockCommand();
        return;
      }
      sendPrompt(command, undefined, undefined, { ownerRef: owner })
        .then(refreshSettings)
        .catch((error: unknown) => {
          if (!owner.current.isCurrent()) return;
          handleLanguageChange(previousLanguage);
          reportError(error, 'Failed to sync /language command');
        });
    },
    [
      blockCommand,
      handleLanguageChange,
      reloadWorkspaceSettings,
      reportError,
      sessionWriteBlocked,
      sendPrompt,
      selectedLanguage,
      sessionActions,
      sessionOwnerGuard,
      isGoalGateBlocked,
    ],
  );

  const handleClearScreen = useCallback(() => {
    if (streamingStateRef.current !== 'idle') {
      store.dispatch([{ type: 'status', text: t('clear.blocked') }]);
      return;
    }
    autoRecapVersionRef.current += 1;
    lastRecapBlockCountRef.current = 0;
    store.reset();
  }, [store, t]);

  const handleSetMode = useCallback(
    (modeId: string) => {
      if (sessionWriteBlocked) return;
      if (!isDaemonApprovalMode(modeId)) {
        reportError(
          new Error(`Unsupported approval mode: ${modeId}`),
          t('local.approvalMode'),
        );
        return;
      }
      if (!connectionRef.current.sessionId) {
        setPendingMode(modeId);
        return;
      }
      const owner = sessionOwnerGuard.capture();
      sessionActions
        .setApprovalMode(modeId)
        .then((result) => {
          if (!owner.isCurrent()) return;
          const effectiveMode = result.mode || modeId;
          setCurrentMode(effectiveMode);
          const approval = pendingApprovalRef.current;
          if (!approval) return;
          const shouldAutoApprove =
            modeId === 'yolo' ||
            (modeId === 'auto-edit' && isEditToolPermission(approval));
          if (shouldAutoApprove) {
            const allowOnce = approval.options.find(
              (o) => o.kind === 'allow_once',
            );
            if (allowOnce) {
              const toolDesc = approval.title || '';
              store.dispatch([
                {
                  type: 'status',
                  text: t('mode.autoApproved', { tool: toolDesc }),
                },
              ]);
              sessionActions
                .submitPermission(approval.id, allowOnce.id)
                .catch((error: unknown) => {
                  reportError(error, 'Failed to auto-approve tool call');
                });
            }
          }
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          reportError(error, t('local.approvalMode'));
        });
    },
    [
      sessionWriteBlocked,
      reportError,
      sessionActions,
      sessionOwnerGuard,
      setPendingMode,
      store,
      t,
    ],
  );

  // Drop queued commands on a session switch so the drain never runs a
  // command against a different workspace's daemon (mirrors useQueuedPrompts).
  const prevQueueSessionIdRef = useRef(logicalSessionKey);
  useEffect(() => {
    if (prevQueueSessionIdRef.current === logicalSessionKey) return;
    prevQueueSessionIdRef.current = logicalSessionKey;
    const dropped = queuedShellCommandsRef.current.length;
    queuedShellCommandsRef.current = [];
    // Skip the bump when the transition is into the session that
    // ensureSessionForPrompt is preparing — that is the submit's own lazy
    // creation, not a user-initiated switch.
    if (connection.sessionId !== preparingSessionIdRef.current) {
      drainGenerationRef.current++;
      isDrainingRef.current = false;
    }
    if (dropped > 0) {
      pushToast('warning', t('queue.shellDropped', { count: dropped }));
    }
  }, [connection.sessionId, logicalSessionKey, pushToast, t]);

  // Declared after the session-switch wipe effect above: React runs effects in
  // declaration order, so the queue is already cleared before this drain sees it.
  const prevShellDrainStreamingStateRef = useRef(streamingState);
  useEffect(() => {
    const prev = prevShellDrainStreamingStateRef.current;
    prevShellDrainStreamingStateRef.current = streamingState;
    // Only start a drain on the transition into idle. sendShellCommand drives
    // streamingState non-idle while each command runs, so cancelling the drain
    // on every streamingState change would drop every command after the first.
    if (prev === 'idle' || streamingState !== 'idle') return;
    // A running drain re-reads the queue after each batch, so commands queued
    // mid-drain are picked up by it. Starting a second drain here would bump the
    // generation and cancel the in-flight batch, silently dropping commands.
    if (isDrainingRef.current) return;
    const cmds = queuedShellCommandsRef.current;
    if (cmds.length === 0) return;
    queuedShellCommandsRef.current = [];
    isDrainingRef.current = true;
    const generation = ++drainGenerationRef.current;
    const drainSessionId = connectionRef.current.sessionId;
    const drainWorkspaceCwd = getComposerWorkspaceCwd();
    const drainOwner = sessionOwnerGuard.capture();
    void (async () => {
      try {
        let batch = cmds;
        while (batch.length > 0) {
          for (let i = 0; i < batch.length; i++) {
            const generationChanged = drainGenerationRef.current !== generation;
            if (
              generationChanged ||
              !drainOwner.isCurrent() ||
              connectionRef.current.sessionId !== drainSessionId ||
              connectionRef.current.status !== 'connected'
            ) {
              let dropped = batch.length - i;
              if (!generationChanged) {
                // The two generation-bump sites (session switch, cancel) wipe
                // the queue themselves, so anything parked here was queued
                // after the drop and is fresh user intent. A disconnect has no
                // such wipe — clear it so a reconnect cannot resurrect a newer
                // command behind an already-dropped older one.
                dropped += queuedShellCommandsRef.current.length;
                queuedShellCommandsRef.current = [];
              }
              console.warn(
                '[web-shell] dropping %d queued shell command(s)',
                dropped,
              );
              pushToast('warning', t('queue.shellDropped', { count: dropped }));
              return;
            }
            try {
              await sessionActions.sendShellCommand(batch[i]);
            } catch (error: unknown) {
              reportError(
                error,
                `Failed to execute shell command: !${batch[i]}`,
              );
            } finally {
              if (drainWorkspaceCwd) {
                sessionCatalogController.invalidateWorkspace(drainWorkspaceCwd);
              }
            }
          }
          batch = queuedShellCommandsRef.current;
          queuedShellCommandsRef.current = [];
        }
      } finally {
        // Release the lock only if this IIFE is still the active drainer; a
        // cancel or session switch may have bumped the generation and handed
        // the lock to a newer drain that must not be unblocked prematurely.
        if (drainGenerationRef.current === generation) {
          isDrainingRef.current = false;
        }
      }
    })();
  }, [
    getComposerWorkspaceCwd,
    pushToast,
    reportError,
    sessionActions,
    sessionCatalogController,
    sessionOwnerGuard,
    streamingState,
    t,
  ]);

  useEffect(() => {
    const lastTurnError = getRetryableTurnError(blocks);
    // Loop-detected turn errors still surface through turn_complete below,
    // but resubmitting a prompt the daemon stopped for loop protection
    // tends to re-loop, so no retry affordance is offered for them.
    const retryableTurnError =
      lastTurnError &&
      lastTurnError.kind === 'error' &&
      isRetryableTurnErrorKind(lastTurnError.errorKind)
        ? lastTurnError
        : undefined;
    if (retryableTurnError) {
      rearmFailedTurnErrorRetry(retryableTurnError, blocks);
    }
    const previousIdentity = retryableTurnErrorIdentityRef.current;
    const identityMatches =
      previousIdentity === undefined ||
      (retryableTurnError !== undefined &&
        matchesTurnErrorIdentity(retryableTurnError, previousIdentity));
    if (
      retryableTurnError &&
      previousIdentity &&
      identityMatches &&
      retriedTurnErrorIdRef.current !== null
    ) {
      retriedTurnErrorIdRef.current = retryableTurnError.id;
    }
    // Same walk as the retry decision above, so turn_complete and the
    // retry affordance never disagree about whether the current turn has
    // a turn error (e.g. across a trailing background notification). An
    // error the user already retried stays suppressed, mirroring the
    // retry affordance; loop-detected errors are never retried, so they
    // always surface.
    lastTurnErrorIdRef.current =
      lastTurnError && lastTurnError.id !== retriedTurnErrorIdRef.current
        ? lastTurnError.id
        : null;
    const canRetry =
      connected &&
      retryableTurnError !== undefined &&
      identityMatches &&
      retryableTurnError.id !== retriedTurnErrorIdRef.current &&
      failedPromptRetry === null &&
      lastSubmittedSourceVersionRef.current ===
        composerSourceVersionRef.current &&
      (lastSubmittedPromptRef.current.length > 0 ||
        (lastSubmittedImagesRef.current?.length ?? 0) > 0 ||
        (lastSubmittedFilesRef.current?.length ?? 0) > 0);
    if (retryableTurnError && previousIdentity && !identityMatches) {
      lastSubmittedPromptRef.current = '';
      lastSubmittedImagesRef.current = undefined;
      lastSubmittedFilesRef.current = undefined;
      lastSubmittedInputAnnotationsRef.current = undefined;
      lastSubmittedSourceVersionRef.current = -1;
      retryableTurnErrorIdentityRef.current = undefined;
      retriedTurnErrorIdRef.current = null;
      failedTurnErrorRetryRef.current = null;
    } else if (canRetry) {
      retryableTurnErrorIdentityRef.current = { block: retryableTurnError };
    }
    retryableTurnErrorIdRef.current = canRetry ? retryableTurnError.id : null;
    setShowRetryHint(canRetry);
  }, [blocks, connected, failedPromptRetry, rearmFailedTurnErrorRetry]);

  useEffect(() => {
    onStreamingStateChange?.(streamingState);
  }, [streamingState, onStreamingStateChange]);

  // Reads lastTurnErrorIdRef which is set by the blocks effect above.
  // Declaration order matters: this effect must run after the blocks effect
  // so that within the same render, the ref is already updated before we read it.
  const prevStreamingForTurnCompleteRef = useRef(streamingState);
  const streamingSessionIdRef = useRef<string | undefined>(undefined);
  const streamingWorkspaceCwdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStreamingForTurnCompleteRef.current;
    prevStreamingForTurnCompleteRef.current = streamingState;
    if (streamingState !== 'idle') {
      if (prev === 'idle' || streamingSessionIdRef.current === undefined) {
        streamingSessionIdRef.current = connection.sessionId;
        streamingWorkspaceCwdRef.current = connection.workspaceCwd;
      } else if (
        connection.sessionId === streamingSessionIdRef.current &&
        streamingWorkspaceCwdRef.current === undefined
      ) {
        streamingWorkspaceCwdRef.current = connection.workspaceCwd;
      }
    }
    if (prev !== 'idle' && streamingState === 'idle') {
      const sessionId = connectionRef.current.sessionId;
      const workspaceCwd = connectionRef.current.workspaceCwd;
      // Only fire if the session that was streaming is still the active one.
      // Session switches reset streamingState to idle, which must not produce
      // a spurious turn_complete for the new session.
      if (
        !sessionId ||
        sessionId !== streamingSessionIdRef.current ||
        workspaceCwd !== streamingWorkspaceCwdRef.current
      ) {
        return;
      }
      const turnError =
        lastTurnErrorIdRef.current != null
          ? new Error(`Turn error (block ${lastTurnErrorIdRef.current})`)
          : undefined;
      const productContext = connectionRef.current.sessionContext;
      if (
        workspaceCwd &&
        (!productContext || productContext.kind === 'workspace')
      ) {
        sessionCatalogController.turnCompleted(workspaceCwd, sessionId);
        if (!sessionDisplayName) {
          scheduleDelayedActiveSessionDisplayNameRefresh(
            sessionId,
            workspaceCwd,
          );
          if (typeof document !== 'undefined' && document.hidden) {
            pendingDisplayNameRefreshRef.current = {
              sessionId,
              workspaceCwd,
            };
          } else {
            void refreshActiveSessionDisplayNameRef.current();
          }
        }
      }
      dispatchSessionChangeRef.current?.({
        type: 'turn_complete',
        sessionId,
        error: turnError,
      });
    }
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    scheduleDelayedActiveSessionDisplayNameRefresh,
    sessionCatalogController,
    sessionDisplayName,
    streamingState,
  ]);

  useEffect(() => {
    onConnectionChange?.(connection.status);
  }, [connection.status, onConnectionChange]);

  // Report each distinct connection.error value only once. Hosts may pass an
  // inline onError (or one whose identity changes) and update their own state
  // when it fires; the resulting re-render then hands this effect a fresh
  // callback identity, which would re-notify the same persistent error
  // forever (#10406).
  const lastReportedConnectionErrorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!connection.error) {
      lastReportedConnectionErrorRef.current = undefined;
      return;
    }
    if (lastReportedConnectionErrorRef.current === connection.error) return;
    if (!onError) return;
    lastReportedConnectionErrorRef.current = connection.error;
    onError(new Error(connection.error));
  }, [connection.error, onError]);

  useLayoutEffect(() => {
    setCurrentModel(connection.currentModel ?? '');
  }, [connection.currentModel, logicalSessionKey]);

  useLayoutEffect(() => {
    setCurrentMode(connection.currentMode ?? 'default');
  }, [connection.currentMode, logicalSessionKey]);

  useEffect(() => {
    if (connection.loadingTranscript) return;
    if (connection.standaloneSession?.creationRecovery) {
      return;
    }
    if (!connection.sessionId && connection.missingSession) {
      // Keep the dead-session route visible until the user explicitly starts a
      // new chat; clearing it here would immediately hide the recovery state.
      lastNotifiedSessionIdRef.current = connection.sessionId;
      lastNotifiedWorkspaceIdRef.current = undefined;
      lastNotifiedWorkspaceCwdRef.current = undefined;
      lastNotifiedNonWorkspaceContextRef.current = undefined;
      return;
    }
    const reportedWorkspaceCwd = connection.sessionId
      ? connection.workspaceCwd
      : activeWorkspaceCwd;
    const activeWorkspace = workspaces.find(
      (entry) => entry.cwd === reportedWorkspaceCwd,
    );
    if (connection.sessionId && !workspace.capabilities) return;
    const workspaceId =
      activeWorkspace && !activeWorkspace.primary
        ? activeWorkspace.id
        : undefined;
    const reportedSessionContext = connection.sessionId
      ? connection.sessionContext
      : (pendingSessionContext ?? connection.sessionContext);
    const nonWorkspaceContext =
      reportedSessionContext?.kind === 'standalone' ||
      reportedSessionContext?.kind === 'live'
        ? reportedSessionContext.kind
        : undefined;
    if (
      lastNotifiedSessionIdRef.current === connection.sessionId &&
      lastNotifiedWorkspaceIdRef.current === workspaceId &&
      lastNotifiedWorkspaceCwdRef.current === reportedWorkspaceCwd &&
      lastNotifiedNonWorkspaceContextRef.current === nonWorkspaceContext
    ) {
      return;
    }
    lastNotifiedSessionIdRef.current = connection.sessionId;
    lastNotifiedWorkspaceIdRef.current = workspaceId;
    lastNotifiedWorkspaceCwdRef.current = reportedWorkspaceCwd;
    lastNotifiedNonWorkspaceContextRef.current = nonWorkspaceContext;
    if (nonWorkspaceContext) {
      onSessionIdChange?.(connection.sessionId, undefined, undefined, {
        kind: nonWorkspaceContext,
      });
    } else {
      onSessionIdChange?.(
        connection.sessionId,
        workspaceId,
        reportedWorkspaceCwd,
      );
    }
  }, [
    connection.missingSession,
    connection.loadingTranscript,
    connection.sessionId,
    connection.sessionContext,
    connection.standaloneSession?.creationRecovery,
    connection.workspaceCwd,
    onSessionIdChange,
    activeWorkspaceCwd,
    pendingSessionContext,
    workspace.capabilities,
    workspaces,
  ]);

  const lastRenameSessionRef = useRef<string | undefined>(undefined);
  const lastRenameNameRef = useRef<string | undefined>(undefined);
  const lastReconciledRenameRef = useRef<
    | {
        workspaceCwd?: string;
        sessionId: string;
        displayName: string;
      }
    | undefined
  >(undefined);
  const reconcileCatalogRename = useCallback(
    (
      workspaceCwd: string | undefined,
      sessionId: string,
      displayName: string,
    ) => {
      lastReconciledRenameRef.current = {
        workspaceCwd,
        sessionId,
        displayName,
      };
      if (workspaceCwd) {
        sessionCatalogController.renamed(workspaceCwd, sessionId, displayName);
      } else if (
        connectionRef.current.sessionId === sessionId &&
        connectionRef.current.sessionContext?.kind === 'standalone'
      ) {
        setSessionStatusDisplayName(displayName);
      }
    },
    [sessionCatalogController],
  );
  useEffect(() => {
    const sessionId = connection.sessionId;
    const displayName = connection.displayName;
    if (!sessionId || !displayName) return;
    if (logicalSessionKey !== lastRenameSessionRef.current) {
      lastRenameSessionRef.current = logicalSessionKey;
      lastRenameNameRef.current = displayName;
      lastReconciledRenameRef.current = undefined;
      return;
    }
    if (displayName === lastRenameNameRef.current) return;
    lastRenameNameRef.current = displayName;
    const reconciled = lastReconciledRenameRef.current;
    lastReconciledRenameRef.current = undefined;
    const alreadyReconciled =
      reconciled !== undefined &&
      reconciled.workspaceCwd === connection.workspaceCwd &&
      reconciled.sessionId === sessionId &&
      reconciled.displayName === displayName;
    if (!alreadyReconciled) {
      if (
        connection.workspaceCwd &&
        (!connection.sessionContext ||
          connection.sessionContext.kind === 'workspace')
      ) {
        sessionCatalogController.renamed(
          connection.workspaceCwd,
          sessionId,
          displayName,
        );
      }
    }
    dispatchSessionChangeRef.current?.({
      type: 'rename',
      sessionId,
      newName: displayName,
    });
  }, [
    connection.displayName,
    connection.sessionId,
    connection.sessionContext,
    connection.workspaceCwd,
    logicalSessionKey,
    sessionCatalogController,
  ]);

  useEffect(() => {
    setGoalSnapshot(connection.goalState ?? null);
  }, [connection.goalState, connection.sessionId, logicalSessionKey]);

  const connectionGoalComplete =
    connection.goalState?.goal?.status === 'complete';
  useEffect(() => {
    setGoalEditOpen(false);
    setGoalEditError(null);
  }, [
    connection.goalState?.goal?.goalId,
    connection.sessionId,
    connectionGoalComplete,
  ]);

  const activeGoal =
    goalSnapshot?.goal && goalSnapshot.goal.status !== 'complete'
      ? {
          condition: goalSnapshot.goal.objective,
          setAt: goalSnapshot.goal.createdAt,
        }
      : null;
  const liveGoalSnapshot =
    goalSnapshot?.goal?.status === 'complete' ? null : goalSnapshot;

  // Auto-recap: fire when the user returns after being away ≥ 3 minutes
  const hiddenAtRef = useRef<number | null>(null);
  const lastRecapBlockCountRef = useRef(0);
  const autoRecapVersionRef = useRef(0);
  useEffect(() => {
    lastRecapBlockCountRef.current = 0;
    autoRecapVersionRef.current += 1;
  }, [logicalSessionKey]);
  useEffect(() => {
    const AWAY_THRESHOLD_MS = 3 * 60 * 1000;
    const MIN_NEW_BLOCKS = 4;
    function onVisibilityChange() {
      if (document.hidden) {
        if (hiddenAtRef.current === null) hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt === null) return;
      if (Date.now() - hiddenAt < AWAY_THRESHOLD_MS) return;
      if (sessionWriteBlocked) return;
      if (streamingStateRef.current !== 'idle') return;
      if (!connection.sessionId) return;
      const currentCount = store.getSnapshot().blocks.length;
      if (currentCount - lastRecapBlockCountRef.current < MIN_NEW_BLOCKS)
        return;
      lastRecapBlockCountRef.current = currentCount;
      const sessionId = connection.sessionId;
      const version = autoRecapVersionRef.current;
      const owner = sessionOwnerGuard.capture();
      // Local-only commands also append user blocks. Treat any new visible user
      // activity as invalidating the recap rather than risk placing it too late.
      const userBlockId = getLatestUserBlockId(store.getSnapshot().blocks);
      sessionActions.recapSession().then(
        (result) => {
          const currentUserBlockId = getLatestUserBlockId(
            store.getSnapshot().blocks,
          );
          // result.sessionId only pins the daemon wire contract (the daemon
          // echoes the id back), not a real race; the epoch/connection checks
          // catch those. Kept so it is not simplified away as redundant.
          if (
            autoRecapVersionRef.current !== version ||
            !owner.isCurrent() ||
            connectionRef.current.sessionId !== sessionId ||
            result.sessionId !== sessionId ||
            currentUserBlockId !== userBlockId ||
            streamingStateRef.current !== 'idle'
          ) {
            console.warn('[auto-recap] discarding stale recap', {
              captured: { sessionId, version, userBlockId },
              current: {
                sessionId: connectionRef.current.sessionId,
                version: autoRecapVersionRef.current,
                userBlockId: currentUserBlockId,
                streamingState: streamingStateRef.current,
              },
              result: result.sessionId,
            });
            return;
          }
          if (result.recap) {
            store.dispatch([
              {
                type: 'status',
                text: `※ ${t('recap.label')}: ${result.recap}`,
                source: 'recap',
              },
            ]);
          }
        },
        (error: unknown) => {
          console.error('[auto-recap] failed:', error);
        },
      );
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [
    connection.sessionId,
    sessionActions,
    sessionOwnerGuard,
    sessionWriteBlocked,
    store,
    t,
  ]);

  const handleCycleMode = useCallback(() => {
    // findIndex, not indexOf: narrowing currentMode to the tuple member type
    // silently degrades when the SDK's declaration bundle leaves its
    // permission-mode import dangling, and the build must survive both states.
    const idx = MODES_CYCLE.findIndex((mode) => mode === currentMode);
    const next = MODES_CYCLE[(idx + 1) % MODES_CYCLE.length];
    handleSetMode(next);
  }, [currentMode, handleSetMode]);

  // Shared by the /context slash command and the status-bar context
  // indicator. Echoes the command when idle — that also makes the transcript
  // follow the tail (MessageList Rule 4). Mid-turn the echo is skipped and
  // dispatchReadOnlyStatus's resumeChatBottomFollow resumes bottom-follow,
  // so the panel is revealed even when the click comes while scrolled up.
  const showContextUsage = useCallback(
    (commandText: string, detail: boolean) => {
      // Read-only: every entry point (keyboard, status-bar button, in-chat
      // "context detail" click) runs immediately, even mid-turn — only the
      // echo is skipped while streaming so the active turn is not split.
      if (!requireActiveSessionForLocalCommand()) return;
      const owner = sessionOwnerGuard.capture();
      echoLocalCommandIfIdle(commandText);
      sessionActions
        .getContextUsage({ detail })
        .then((result) => {
          if (!owner.isCurrent()) return;
          dispatchReadOnlyStatus(serializeContextUsageMessage(result));
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          reportError(error, 'Failed to load context usage');
        });
    },
    [
      echoLocalCommandIfIdle,
      dispatchReadOnlyStatus,
      requireActiveSessionForLocalCommand,
      sessionActions,
      sessionOwnerGuard,
      reportError,
    ],
  );
  // Stable identity: ChatEditor is memoized and an inline closure would
  // re-render it on every app render.
  const handleShowContextUsage = useCallback(
    () => showContextUsage('/context', false),
    [showContextUsage],
  );

  // Stable reference: this travels through the memoized MessageList →
  // MessageItem chain, so an inline closure would defeat their memo.
  const handleShowContextDetail = useCallback(() => {
    showContextUsage('/context detail', true);
  }, [showContextUsage]);

  const pendingBranchRequestsRef = useRef(new Map<string, Promise<void>>());
  const branchCurrentSession = useCallback(
    (name?: string, atRecordId?: string) => {
      if (!workspaceContextActive) {
        pushToast('info', t('session.workspaceActionUnavailable'));
        return;
      }
      if (sessionWriteBlocked) return;
      if (!requireActiveSessionForLocalCommand()) return;
      const sourceSessionId = connectionRef.current.sessionId;
      const requestKey = JSON.stringify([
        sourceSessionId,
        name ?? null,
        atRecordId ?? null,
      ]);
      const pending = pendingBranchRequestsRef.current.get(requestKey);
      if (pending) return pending;

      const request = sessionActions
        .branchSession(name || undefined, atRecordId)
        .then((result) => {
          if (!result.switchStarted) return;
          store.dispatch([
            {
              type: 'status',
              text: t('branch.success', {
                name: result.displayName,
              }),
            },
          ]);
        })
        .catch(async (error: unknown) => {
          if (
            error instanceof DOMException &&
            error.name === 'InvalidStateError' &&
            error.message === 'A branch request is already in progress'
          ) {
            return;
          }
          if (isStaleBranchPointError(error)) {
            if (!transcriptReloadSupported) {
              pushToast('error', t('branch.staleUnsupported'));
              return;
            }
            // The recovery reload targets whatever session is selected when
            // the branch call returns. If the user switched away in flight,
            // report the failure without refreshing the unrelated session.
            if (connectionRef.current.sessionId !== sourceSessionId) {
              pushToast('error', t('branch.failed'));
              return;
            }
            let refreshed = false;
            try {
              await sessionActions.reloadSession(new AbortController().signal);
              refreshed = true;
            } catch (reloadError) {
              refreshed = isAbortError(reloadError);
            }
            // A switch landing while the recovery reload is in flight
            // supersedes it; the outcome toast belongs to the source session.
            if (connectionRef.current.sessionId !== sourceSessionId) return;
            pushToast(
              'error',
              t(refreshed ? 'branch.stale' : 'branch.staleRefreshFailed'),
            );
            return;
          }
          reportError(error, t('branch.failed'));
        })
        .finally(() => {
          if (pendingBranchRequestsRef.current.get(requestKey) === request) {
            pendingBranchRequestsRef.current.delete(requestKey);
          }
        });
      pendingBranchRequestsRef.current.set(requestKey, request);
      return request;
    },
    [
      reportError,
      pushToast,
      requireActiveSessionForLocalCommand,
      sessionWriteBlocked,
      sessionActions,
      store,
      t,
      transcriptReloadSupported,
      workspaceContextActive,
    ],
  );
  const handleBranchCurrentSession = useCallback(
    (atRecordId?: string) => {
      return branchCurrentSession(undefined, atRecordId);
    },
    [branchCurrentSession],
  );

  const composerFocusRequestRef = useRef(0);
  const sessionOpenInvocationRef = useRef(0);
  const scheduleComposerFocus = useCallback((sessionId?: string) => {
    const request = ++composerFocusRequestRef.current;
    window.setTimeout(() => {
      if (
        request !== composerFocusRequestRef.current ||
        approvalOverlayActiveRef.current ||
        (sessionId !== undefined &&
          connectionRef.current.sessionId !== sessionId)
      ) {
        return;
      }
      editorRef.current?.focus();
    }, 0);
    return request;
  }, []);
  const createNewSession = useCallback(
    async (
      intent: NewSessionIntent,
      /** Preserve the current full-page view and/or active panel while clearing. */
      opts?: {
        keepView?: boolean;
        keepPanel?: boolean;
        allowRecoveryReset?: boolean;
        /**
         * Git mode the new workspace draft starts with. Set here, in the same
         * synchronous step that resets the previous intent, so the first
         * prompt sees it even while the clear is still in flight.
         */
        gitIntent?: SessionGitIntent;
      },
    ) => {
      if (
        connectionRef.current.standaloneSession?.creationRecovery &&
        !opts?.allowRecoveryReset
      ) {
        pushToast('warning', t('session.recoveryBlocksAction'));
        return false;
      }
      splitClassificationGenerationRef.current += 1;
      const invocation = ++sessionOpenInvocationRef.current;
      let nextContext: DaemonProductSessionContext | undefined;
      let availableWorkspaces = workspacesRef.current;
      if (intent.kind === 'workspace') {
        nextContext = { kind: 'workspace', cwd: intent.cwd };
      } else if (lockedWorkspaceCwd) {
        nextContext = { kind: 'workspace', cwd: lockedWorkspaceCwd };
      } else if (intent.kind === 'inherit') {
        nextContext =
          pendingSessionContextRef.current ??
          connectionRef.current.sessionContext ??
          (connectionRef.current.workspaceCwd
            ? {
                kind: 'workspace',
                cwd: connectionRef.current.workspaceCwd,
              }
            : undefined);
        if (nextContext?.kind === 'live') {
          gitModeIntentRef.current = { mode: 'current' };
          setGitModeIntent({ mode: 'current' });
          try {
            await workspace.client.startLive('new');
            return sessionOpenInvocationRef.current === invocation;
          } catch (error) {
            if (sessionOpenInvocationRef.current !== invocation) return false;
            reportError(error, 'Failed to start a new Live chat');
            return false;
          }
        }
      } else {
        let capabilities = workspaceCapabilitiesRef.current;
        if (workspace.status === 'error') {
          if (!refreshWorkspaceCapabilities) {
            pushToast('info', t('session.capabilitiesFailed'));
            return false;
          }
          try {
            capabilities = await refreshWorkspaceCapabilities();
          } catch (error) {
            reportError(error, t('session.capabilitiesFailed'));
            return false;
          }
        } else if (!workspaceCapabilitiesReady) {
          pushToast('info', t('common.loading'));
          return false;
        }
        if (!capabilities) {
          pushToast('info', t('session.capabilitiesFailed'));
          return false;
        }
        availableWorkspaces = (capabilities.workspaces ?? []).filter(
          (entry) => entry.kind !== 'live',
        );
        if (
          capabilities.features?.includes(STANDALONE_SESSIONS_CAPABILITY) ===
          true
        ) {
          nextContext = { kind: 'standalone' };
        } else {
          const primaryCwd = availableWorkspaces.find(
            (entry) => entry.primary && entry.trusted !== false,
          )?.cwd;
          nextContext = primaryCwd
            ? { kind: 'workspace', cwd: primaryCwd }
            : undefined;
        }
      }
      if (sessionOpenInvocationRef.current !== invocation) return false;
      const targetWorkspaceCwd =
        nextContext?.kind === 'workspace' ? nextContext.cwd : undefined;
      const previousPendingContext = pendingSessionContextRef.current;
      setPendingSessionContext(nextContext);
      setSidebarSwitchingSessionId(null);
      composerSourceVersionRef.current += 1;
      selectedWorkspaceCwdRef.current = targetWorkspaceCwd;
      setSelectedWorkspaceCwd(targetWorkspaceCwd);
      // Starting a fresh chat drops any pending git mode intent so it never
      // leaks into the next created session; a caller-supplied intent takes
      // its place. The ref is written too so a prompt admitted before the
      // next render reads the same answer.
      const nextGitIntent: SessionGitIntent =
        nextContext?.kind === 'workspace'
          ? (opts?.gitIntent ?? { mode: 'current' })
          : { mode: 'current' };
      gitModeIntentRef.current = nextGitIntent;
      setGitModeIntent(nextGitIntent);
      // Close the drawer before awaiting so a failed createSession() doesn't leave
      // it stuck open with the page scroll still locked, matching loadSidebarSession.
      closeMobileDrawer();
      // Starting a new chat means the user wants to see it — leave any open
      // Settings/Status panel so the fresh chat is visible (no-op when closed).
      if (!opts?.keepPanel) {
        // Explicit navigation cancels any pending shrink-fold split restore.
        splitFoldedByShrinkRef.current = false;
        closePanel();
      }
      if (!opts?.keepView) showChat();
      let focusRequest: number | undefined;
      try {
        autoRecapVersionRef.current += 1;
        const clearPromise = (
          sessionActions as typeof sessionActions & SessionActionsWithCreate
        ).clearSession();
        focusRequest = scheduleComposerFocus();
        await Promise.all([
          clearPromise,
          nextContext?.kind === 'workspace'
            ? reloadLoadedSkills(targetWorkspaceCwd)
            : Promise.resolve(undefined),
        ]);
        // Clear after successful clearSession — if it rejects, the old
        // session's worktree/branch state is preserved.
        setSessionWorktree(undefined);
        setSessionBranch(undefined);
        return true;
      } catch (error) {
        if (
          sessionOpenInvocationRef.current === invocation &&
          pendingSessionContextRef.current === nextContext
        ) {
          setPendingSessionContext(previousPendingContext);
        }
        if (composerFocusRequestRef.current === focusRequest) {
          composerFocusRequestRef.current += 1;
        }
        reportError(error, 'Failed to start a new chat');
        return false;
      }
    },
    [
      closeMobileDrawer,
      closePanel,
      lockedWorkspaceCwd,
      pushToast,
      reportError,
      refreshWorkspaceCapabilities,
      reloadLoadedSkills,
      scheduleComposerFocus,
      setPendingSessionContext,
      sessionActions,
      showChat,
      t,
      workspaceCapabilitiesReady,
      workspace.client,
      workspace.status,
    ],
  );
  /**
   * Serializes workspace intent. An active session keeps its owner and is
   * replaced by a fresh chat; a draft only changes its next-session target.
   */
  // The Workspaces panel's rows always name a workspace; a stable identity
  // matters because the panel keys its column definitions on this handler.
  const handlePanelNewSession = useCallback(
    (workspaceCwd: string) =>
      createNewSession({ kind: 'workspace', cwd: workspaceCwd }),
    [createNewSession],
  );

  const switchWorkspace = useCallback(
    async (
      workspaceCwd: string | undefined,
      acceptedWorkspaces: readonly DaemonWorkspaceCapability[] = workspacesRef.current,
    ) => {
      if (workspaceSwitchTokenRef.current) return;
      const token = Symbol('workspace-switch');
      workspaceSwitchTokenRef.current = token;
      try {
        const primaryCwd = acceptedWorkspaces.find(
          (entry) => entry.primary,
        )?.cwd;
        const targetCwd = workspaceCwd ?? primaryCwd;
        if (workspaceCwd) {
          const target = acceptedWorkspaces.find(
            (entry) => entry.cwd === workspaceCwd,
          );
          if (!target?.trusted) return;
        }
        splitClassificationGenerationRef.current += 1;
        if (connectionRef.current.sessionId) {
          if (connectionRef.current.workspaceCwd === targetCwd) return;
          if (!targetCwd) return;
          await createNewSession({ kind: 'workspace', cwd: targetCwd });
          return;
        }
        // The composer picker fires for its checked row too; re-selecting
        // the draft's own workspace changes nothing and must keep an armed
        // intent. Compared before the ref is overwritten below. `undefined`
        // is the primary selection on both sides.
        const sameTarget = workspaceCwd === selectedWorkspaceCwdRef.current;
        composerSourceVersionRef.current += 1;
        selectedWorkspaceCwdRef.current = workspaceCwd;
        setSelectedWorkspaceCwd(workspaceCwd);
        setPendingSessionContext(
          targetCwd ? { kind: 'workspace', cwd: targetCwd } : undefined,
        );
        // The intent was armed for the previous draft workspace; a switch
        // must not carry a branch/worktree request over to another repo.
        if (!sameTarget) {
          gitModeIntentRef.current = { mode: 'current' };
          setGitModeIntent({ mode: 'current' });
        }
      } finally {
        if (workspaceSwitchTokenRef.current === token) {
          workspaceSwitchTokenRef.current = null;
        }
      }
    },
    [createNewSession, setPendingSessionContext],
  );

  /** Refreshes once and switches only from the accepted capability snapshot. */
  const reconcileAddedWorkspace = useCallback(
    async (canonicalCwd: string): Promise<boolean> => {
      try {
        const capabilities = await refreshWorkspaceCapabilities?.();
        const acceptedWorkspaces = capabilities?.workspaces ?? [];
        const added = acceptedWorkspaces.find(
          (entry) => entry.cwd === canonicalCwd,
        );
        if (added?.trusted) {
          await switchWorkspace(
            added.primary ? undefined : added.cwd,
            acceptedWorkspaces,
          );
        }
        return capabilities !== undefined;
      } catch (error) {
        reportError(error, 'Failed to refresh the workspace list');
        return false;
      }
    },
    [refreshWorkspaceCapabilities, reportError, switchWorkspace],
  );

  /** Registers an existing directory through the shared mutation lane. */
  const handleAddWorkspace = useCallback(
    async (cwd: string, persist: boolean, displayName?: string) => {
      if (workspaceMutationTokenRef.current) {
        throw new Error(t('sidebar.addWorkspaceBusyError'));
      }
      const token = Symbol('workspace-mutation');
      workspaceMutationTokenRef.current = token;
      setWorkspaceMutationBusy(true);
      try {
        const effectivePersist =
          persistentWorkspaceRegistrationSupported === true && persist;
        const effectiveDisplayName = workspaceDisplayNameSupported
          ? displayName
          : undefined;
        const result = await workspaceActions.addWorkspace(cwd, {
          persist: effectivePersist,
          ...(effectiveDisplayName
            ? { displayName: effectiveDisplayName }
            : {}),
        });
        if (effectivePersist && result.persisted !== true) {
          throw new Error(t('sidebar.addWorkspacePersistenceError'));
        }
        const reconciled = await reconcileAddedWorkspace(result.cwd);
        if (!reconciled) {
          throw new Error(t('sidebar.addWorkspaceRefreshError'));
        }
      } finally {
        if (workspaceMutationTokenRef.current === token) {
          workspaceMutationTokenRef.current = null;
          setWorkspaceMutationBusy(false);
        }
      }
    },
    [
      persistentWorkspaceRegistrationSupported,
      reconcileAddedWorkspace,
      t,
      workspaceDisplayNameSupported,
      workspaceActions,
    ],
  );

  /**
   * Reconciles either a known committed cwd or an unknown POST outcome. Known
   * commits may switch; unknown outcomes require explicit user acknowledgement.
   */
  const refreshScratchOutcome = useCallback(async () => {
    setScratchOutcome('refreshing');
    try {
      const capabilities = await refreshWorkspaceCapabilities?.();
      if (!capabilities) return;
      const acceptedWorkspaces = capabilities.workspaces ?? [];
      const committedCwd = committedScratchCwdRef.current;
      if (committedCwd) {
        const added = acceptedWorkspaces.find(
          (entry) => entry.cwd === committedCwd,
        );
        if (added?.trusted) {
          await switchWorkspace(
            added.primary ? undefined : added.cwd,
            acceptedWorkspaces,
          );
        }
        committedScratchCwdRef.current = undefined;
        setScratchOutcome('clear');
      } else {
        setScratchOutcome('awaiting-ack');
      }
    } catch (error) {
      reportError(error, 'Failed to refresh the workspace list');
    }
  }, [
    reportError,
    setScratchOutcome,
    switchWorkspace,
    refreshWorkspaceCapabilities,
  ]);

  /**
   * Creates at most one scratch directory per intent and locks further POSTs
   * whenever timeout, transport failure, or refresh leaves the result unclear.
   */
  const handleCreateScratchWorkspace = useCallback(async () => {
    if (
      scratchOutcomeUnknownRef.current !== 'clear' ||
      workspaceMutationTokenRef.current
    ) {
      return;
    }
    const token = Symbol('workspace-mutation');
    workspaceMutationTokenRef.current = token;
    setWorkspaceMutationBusy(true);
    try {
      const result = await workspaceActions.addScratchWorkspace();
      const reconciled = await reconcileAddedWorkspace(result.cwd);
      if (!reconciled) {
        committedScratchCwdRef.current = result.cwd;
        setScratchOutcome('refreshing');
      }
    } catch (error) {
      const definitelyRejected =
        error instanceof DaemonHttpError &&
        (error.status < 500 || error.status === 501);
      if (definitelyRejected) {
        reportError(error, t('sidebar.addWorkspaceError'));
      } else {
        committedScratchCwdRef.current = undefined;
        setScratchOutcome('refreshing');
        await refreshScratchOutcome();
      }
    } finally {
      if (workspaceMutationTokenRef.current === token) {
        workspaceMutationTokenRef.current = null;
        setWorkspaceMutationBusy(false);
      }
    }
  }, [
    reconcileAddedWorkspace,
    refreshScratchOutcome,
    reportError,
    setScratchOutcome,
    t,
    workspaceActions,
  ]);
  const handleSelectComposerWorkspace = useCallback(
    (cwd: string | undefined) => {
      void switchWorkspace(cwd);
    },
    [switchWorkspace],
  );
  const handleCreateComposerScratchWorkspace = useCallback(() => {
    void handleCreateScratchWorkspace();
  }, [handleCreateScratchWorkspace]);
  const handleOpenExistingWorkspace = useCallback(() => {
    setShowAddWorkspaceDialog(true);
  }, []);

  const handleComposerAttachmentsChange = useCallback(
    (hasAttachments: boolean) => {
      setHasComposerAttachments(hasAttachments);
    },
    [],
  );
  const generateSuggestionContent = useCallback(
    (prompt: string, options?: { signal?: AbortSignal }) => {
      void logicalSessionKey;
      return sessionActions.generateSessionContent(prompt, options);
    },
    [logicalSessionKey, sessionActions],
  );

  const {
    suggestion: newSessionSuggestion,
    updateInput: updateNewSessionSuggestionInput,
    dismiss: dismissNewSessionSuggestion,
    suppress: suppressNewSessionSuggestion,
  } = useNewSessionSuggestion({
    enabled:
      connection.capabilities?.features.includes('session_generation') === true,
    messages,
    sessionId: connection.sessionId,
    contextUsageRatio:
      (connection.contextWindow ?? 0) > 0
        ? (connection.tokenCount ?? 0) / (connection.contextWindow ?? 0)
        : 0,
    isRunning: streamingState !== 'idle',
    dialogOpen: interactionBlocked || approvalOverlayActive,
    hasAttachments: hasComposerAttachments,
    generateContent: generateSuggestionContent,
  });

  const handleComposerTextChange = useCallback(
    (text: string) => {
      composerTextRef.current = text;
      updateNewSessionSuggestionInput(text);
    },
    [updateNewSessionSuggestionInput],
  );

  const flushPendingNewSessionSuggestionSubmit = useCallback(
    (expectedToken?: number) => {
      const pending = pendingNewSessionSuggestionSubmitRef.current;
      if (!pending) return;
      if (expectedToken !== undefined && pending.token !== expectedToken)
        return;

      const activeSessionId = connectionRef.current.sessionId;
      if (
        (pending.mode === 'cleared' &&
          pending.sourceSessionId !== undefined &&
          activeSessionId !== undefined &&
          activeSessionId !== pending.sourceSessionId) ||
        (pending.mode === 'live' &&
          activeSessionId !== undefined &&
          activeSessionId !== pending.sourceSessionId &&
          connectionRef.current.sessionContext?.kind !== 'live')
      ) {
        pendingNewSessionSuggestionSubmitRef.current = null;
        setIsStartingNewSessionSuggestion(false);
        return;
      }

      if (!pending.newSessionReady) {
        return;
      }

      if (
        pending.mode === 'live'
          ? activeSessionId === undefined ||
            activeSessionId === pending.sourceSessionId ||
            connectionRef.current.sessionContext?.kind !== 'live'
          : activeSessionId !== undefined
      ) {
        return;
      }

      if (pending.submitScheduled) {
        return;
      }

      pendingNewSessionSuggestionSubmitRef.current = {
        ...pending,
        submitScheduled: true,
      };
      window.setTimeout(() => {
        const latestPending = pendingNewSessionSuggestionSubmitRef.current;
        if (!latestPending || latestPending.token !== pending.token) {
          return;
        }
        const latestSessionId = connectionRef.current.sessionId;
        if (
          latestPending.mode === 'live'
            ? latestSessionId === undefined ||
              latestSessionId === latestPending.sourceSessionId ||
              connectionRef.current.sessionContext?.kind !== 'live'
            : latestSessionId !== undefined
        ) {
          pendingNewSessionSuggestionSubmitRef.current = null;
          setIsStartingNewSessionSuggestion(false);
          return;
        }
        pendingNewSessionSuggestionSubmitRef.current = null;
        editorRef.current?.submit();
        editorRef.current?.focus();
        setIsStartingNewSessionSuggestion(false);
      }, 0);
    },
    [],
  );

  useEffect(() => {
    flushPendingNewSessionSuggestionSubmit();
  }, [connection.sessionId, flushPendingNewSessionSuggestionSubmit]);

  const handleAcceptNewSessionSuggestion = useCallback(() => {
    const draft = composerTextRef.current.trim();
    if (!draft || isStartingNewSessionSuggestion) return;
    if (
      newSessionSuggestion?.suggestion !== 'new_session' ||
      newSessionSuggestion.classifiedInput !== draft ||
      newSessionSuggestion.sourceSessionId !== connectionRef.current.sessionId
    ) {
      dismissNewSessionSuggestion();
      return;
    }
    suppressNewSessionSuggestion();
    setIsStartingNewSessionSuggestion(true);
    const token = newSessionSuggestionSubmitTokenRef.current + 1;
    newSessionSuggestionSubmitTokenRef.current = token;
    const mode =
      !lockedWorkspaceCwd &&
      (pendingSessionContextRef.current ?? connectionRef.current.sessionContext)
        ?.kind === 'live'
        ? 'live'
        : 'cleared';
    pendingNewSessionSuggestionSubmitRef.current = {
      token,
      sourceSessionId: connectionRef.current.sessionId,
      mode,
      newSessionReady: false,
      submitScheduled: false,
    };
    void createNewSession({ kind: 'inherit' }).then((created) => {
      const pending = pendingNewSessionSuggestionSubmitRef.current;
      if (!created || pending?.token !== token) {
        if (pending?.token === token) {
          pendingNewSessionSuggestionSubmitRef.current = null;
        }
        setIsStartingNewSessionSuggestion(false);
        return;
      }
      pendingNewSessionSuggestionSubmitRef.current = {
        ...pending,
        newSessionReady: true,
      };
      if (mode === 'cleared') {
        const nextContext = pendingSessionContextRef.current;
        if (nextContext?.kind === 'standalone') {
          onSessionIdChange?.(undefined, undefined, undefined, nextContext);
        } else {
          onSessionIdChange?.(undefined);
        }
      }
      flushPendingNewSessionSuggestionSubmit(token);
    });
  }, [
    createNewSession,
    dismissNewSessionSuggestion,
    flushPendingNewSessionSuggestionSubmit,
    isStartingNewSessionSuggestion,
    lockedWorkspaceCwd,
    newSessionSuggestion,
    onSessionIdChange,
    suppressNewSessionSuggestion,
  ]);

  const handleAcceptBtwSuggestion = useCallback(() => {
    const draft = composerTextRef.current.trim();
    if (
      !draft ||
      newSessionSuggestion?.suggestion !== 'btw' ||
      newSessionSuggestion.classifiedInput !== draft ||
      newSessionSuggestion.sourceSessionId !==
        connectionRef.current.sessionId ||
      editorRef.current?.hasAttachments() !== false
    ) {
      dismissNewSessionSuggestion();
      return;
    }
    dismissNewSessionSuggestion();
    editorRef.current?.submit({ text: `/btw ${draft}` });
    editorRef.current?.focus();
  }, [dismissNewSessionSuggestion, newSessionSuggestion]);

  const respondToPendingPermission = useCallback(
    async (
      requestIdOrDecision: string,
      exactDecision?: 'allow' | 'reject',
    ): Promise<boolean> => {
      const request = pendingApprovalRef.current;
      const decision = exactDecision ?? requestIdOrDecision;
      if (
        !request ||
        isAskUserPermission(request) ||
        (decision !== 'allow' && decision !== 'reject')
      ) {
        return false;
      }
      const requestId = exactDecision ? requestIdOrDecision : undefined;
      if (
        requestId !== undefined &&
        (!requestId ||
          request.id !== requestId ||
          !hostOwnsEditDiffPreview ||
          request.hasDiffPreview !== true)
      ) {
        return false;
      }
      const preferredKind = decision === 'allow' ? 'allow_once' : 'reject_once';
      const fallbackKind =
        decision === 'allow' ? 'allow_always' : 'reject_always';
      const option = requestId
        ? request.options.find((candidate) => candidate.kind === preferredKind)
        : (request.options.find(
            (candidate) => candidate.kind === preferredKind,
          ) ??
          request.options.find(
            (candidate) => candidate.kind === fallbackKind,
          ) ??
          request.options.find((candidate) => {
            const id = candidate.id.toLowerCase();
            return decision === 'allow'
              ? id.includes('allow') || id.includes('proceed')
              : id.includes('reject') || id.includes('cancel');
          }));
      if (!option) {
        return false;
      }
      await sessionActions.submitPermission(request.id, option.id);
      return true;
    },
    [hostOwnsEditDiffPreview, sessionActions],
  );

  const shellApi = useMemo<WebShellApi>(
    () => ({
      openSplitView: () => {
        closeMobileDrawer();
        requestOpenSplitView();
      },
      openSessionOverview: () => {
        if (!workspaceContextActive) return;
        closeMobileDrawer();
        openPanel('sessions');
      },
      openSessionDrawer,
      createNewSession: () => createNewSession({ kind: 'global' }),
      createSideTask,
      respondToPendingPermission,
    }),
    [
      closeMobileDrawer,
      createNewSession,
      createSideTask,
      openPanel,
      openSessionDrawer,
      requestOpenSplitView,
      respondToPendingPermission,
      workspaceContextActive,
    ],
  );
  useEffect(() => {
    assignShellRef(shellRef, shellApi);
  }, [shellApi, shellRef]);
  useEffect(
    () => () => {
      assignShellRef(shellRef, null);
    },
    [shellRef],
  );
  const handleMissingSessionNewSession = useCallback(async () => {
    if (creatingMissingSessionRef.current) return;
    creatingMissingSessionRef.current = true;
    setIsCreatingMissingSession(true);
    try {
      const success = await createNewSession({ kind: 'global' });
      if (success) {
        const nextContext = pendingSessionContextRef.current;
        if (nextContext?.kind === 'standalone') {
          onSessionIdChange?.(undefined, undefined, undefined, nextContext);
        } else {
          onSessionIdChange?.(undefined);
        }
      }
    } finally {
      creatingMissingSessionRef.current = false;
      setIsCreatingMissingSession(false);
    }
  }, [createNewSession, onSessionIdChange]);

  const loadSidebarSession = useCallback(
    async (
      sessionId: string,
      workspaceCwd?: string,
      sessionContext?: DaemonProductSessionContext,
    ) => {
      splitClassificationGenerationRef.current += 1;
      const invocation = ++sessionOpenInvocationRef.current;
      const previousPendingContext = pendingSessionContextRef.current;
      const targetContext =
        sessionContext ??
        (workspaceCwd
          ? isKnownLiveWorkspaceCwd(workspaceCwd)
            ? ({ kind: 'live' } as const)
            : ({ kind: 'workspace', cwd: workspaceCwd } as const)
          : undefined);
      setPendingSessionContext(targetContext);
      composerFocusRequestRef.current += 1;
      setSidebarSwitchingSessionId(sessionId);
      closeMobileDrawer();
      // Loading another session should reveal its chat, not stay on the
      // Settings/Status panel (no-op when the panel is closed).
      closePanel();
      // Explicit navigation cancels any pending shrink-fold split restore.
      splitFoldedByShrinkRef.current = false;
      try {
        await sessionActions.loadSession(sessionId, {
          workspaceCwd:
            targetContext?.kind === 'workspace'
              ? targetContext.cwd
              : targetContext
                ? undefined
                : workspaceCwd,
          sessionContext: targetContext,
        });
        if (
          sessionOpenInvocationRef.current === invocation &&
          pendingSessionContextRef.current === targetContext
        ) {
          composerSourceVersionRef.current += 1;
          setPendingSessionContext(undefined);
        }
      } catch (error) {
        if (
          sessionOpenInvocationRef.current === invocation &&
          pendingSessionContextRef.current === targetContext
        ) {
          setSidebarSwitchingSessionId(null);
          setPendingSessionContext(previousPendingContext);
        }
        throw error;
      }
    },
    [
      closeMobileDrawer,
      closePanel,
      isKnownLiveWorkspaceCwd,
      sessionActions,
      setPendingSessionContext,
    ],
  );

  const handleCheckStandaloneRecovery = useCallback(async () => {
    const recovery = connectionRef.current.standaloneSession?.creationRecovery;
    const sessionId = getStandaloneRecoverySessionId(recovery);
    if (!sessionId || standaloneRecoveryResolution === 'checking') return;
    const owner = sessionOwnerGuard.capture();
    const isCurrent = () =>
      owner.isCurrent() &&
      connectionRef.current.sessionId === sessionId &&
      getStandaloneRecoverySessionId(
        connectionRef.current.standaloneSession?.creationRecovery,
      ) === sessionId;
    setStandaloneRecoveryResolution('checking');
    try {
      for (let attempt = 0; ; attempt += 1) {
        let lookup: DaemonStandaloneSessionLookup;
        try {
          lookup = await workspace.client.getStandaloneSession(sessionId);
        } catch (error) {
          if (!isCurrent()) return;
          if (isStandaloneSessionNotFoundError(error)) {
            setStandaloneRecoveryResolution('absent');
            return;
          }
          setStandaloneRecoveryResolution('unknown');
          reportError(error, t('session.recoveryCheckFailed'));
          return;
        }
        if (!isCurrent()) return;
        if (!('state' in lookup)) {
          if (lookup.isArchived) {
            setStandaloneRecoveryResolution('archived');
            return;
          }
          await loadSidebarSession(sessionId, undefined, {
            kind: 'standalone',
          });
          return;
        }
        const delay = STANDALONE_RECOVERY_POLL_DELAYS_MS[attempt];
        if (delay === undefined) {
          setStandaloneRecoveryResolution('creating');
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
        if (!isCurrent()) return;
      }
    } catch (error) {
      if (!isCurrent()) return;
      setStandaloneRecoveryResolution('unknown');
      reportError(error, t('session.recoveryCheckFailed'));
    }
  }, [
    loadSidebarSession,
    reportError,
    sessionOwnerGuard,
    standaloneRecoveryResolution,
    t,
    workspace.client,
  ]);

  const handleUnarchiveRecoveredStandalone = useCallback(async () => {
    const sessionId = getStandaloneRecoverySessionId(
      connectionRef.current.standaloneSession?.creationRecovery,
    );
    if (!sessionId || standaloneRecoveryResolution === 'checking') return;
    const request = ++standaloneRecoveryRequestRef.current;
    const isCurrent = () =>
      standaloneRecoveryRequestRef.current === request &&
      connectionRef.current.sessionId === sessionId;
    setStandaloneRecoveryResolution('checking');
    try {
      const result = await workspace.client.unarchiveStandaloneSessions([
        sessionId,
      ]);
      if (!isCurrent()) return;
      if (
        !result.unarchived.includes(sessionId) &&
        !result.alreadyActive.includes(sessionId)
      ) {
        if (result.notFound.includes(sessionId)) {
          setStandaloneRecoveryResolution('absent');
          return;
        }
        const failure = result.errors.find(
          (entry) => entry.sessionId === sessionId,
        );
        throw new Error(failure?.message ?? t('session.unarchiveFailed'));
      }
    } catch (error) {
      if (!isCurrent()) return;
      setStandaloneRecoveryResolution('archived');
      reportError(error, t('session.unarchiveFailed'));
      return;
    }
    try {
      await loadSidebarSession(sessionId, undefined, { kind: 'standalone' });
    } catch (error) {
      if (!isCurrent()) return;
      setStandaloneRecoveryResolution('unknown');
      reportError(error, t('session.recoveryCheckFailed'));
    }
  }, [
    loadSidebarSession,
    reportError,
    standaloneRecoveryResolution,
    t,
    workspace.client,
  ]);

  const handleRetryStandaloneCreation = useCallback(() => {
    void createNewSession({ kind: 'inherit' }, { allowRecoveryReset: true });
  }, [createNewSession]);

  const handleRepairStandaloneDirectory = useCallback(async () => {
    const current = connectionRef.current;
    const sessionId = current.sessionId;
    if (
      !sessionId ||
      current.sessionContext?.kind !== 'standalone' ||
      current.standaloneSession?.errorCode !== 'working_directory_missing' ||
      standaloneRepairBusy
    ) {
      return;
    }
    const owner = sessionOwnerGuard.capture();
    const request = ++standaloneRepairRequestRef.current;
    setStandaloneRepairBusy(true);
    try {
      await workspace.client.repairStandaloneSessionDirectory(sessionId);
      if (!owner.isCurrent() || connectionRef.current.sessionId !== sessionId) {
        return;
      }
      await sessionActions.reloadSession(new AbortController().signal);
      if (
        standaloneRepairRequestRef.current === request &&
        connectionRef.current.sessionId === sessionId
      ) {
        pushToast('info', t('session.repairSucceeded'));
      }
    } catch (error) {
      if (
        standaloneRepairRequestRef.current === request &&
        connectionRef.current.sessionId === sessionId
      ) {
        reportError(error, t('session.repairFailed'));
      }
    } finally {
      if (standaloneRepairRequestRef.current === request) {
        setStandaloneRepairBusy(false);
      }
    }
  }, [
    pushToast,
    reportError,
    sessionActions,
    sessionOwnerGuard,
    standaloneRepairBusy,
    t,
    workspace.client,
  ]);

  // Clicking a card in the Session Overview panel switches the current window
  // to that session. loadSidebarSession already closes the panel, so this just
  // returns to the chat view and reports load failures.
  const handleOpenSessionFromOverview = useCallback(
    (sessionId: string, workspaceCwd?: string) => {
      splitClassificationGenerationRef.current += 1;
      // Explicit navigation cancels any pending shrink-fold split restore.
      splitFoldedByShrinkRef.current = false;
      showChat();
      const currentContext =
        pendingSessionContextRef.current ??
        connectionRef.current.sessionContext;
      const inheritedContext =
        workspaceCwd === undefined && currentContext?.kind !== 'workspace'
          ? currentContext
          : undefined;
      void loadSidebarSession(sessionId, workspaceCwd, inheritedContext).catch(
        (error: unknown) => {
          reportError(error, 'Failed to open session');
        },
      );
    },
    [loadSidebarSession, reportError, showChat],
  );

  // Listen for `qwen:open-session` events dispatched by the markdown renderer
  // when a `qwen-session://<id>` link is clicked. Navigate to the session.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<
          string | { sessionId?: unknown; workspaceCwd?: unknown }
        >
      ).detail;
      const sessionId = typeof detail === 'string' ? detail : detail?.sessionId;
      const workspaceCwd =
        typeof detail === 'object' &&
        detail !== null &&
        typeof detail.workspaceCwd === 'string'
          ? detail.workspaceCwd
          : undefined;
      if (typeof sessionId === 'string' && sessionId) {
        handleOpenSessionFromOverview(sessionId, workspaceCwd);
      }
    };
    window.addEventListener('qwen:open-session', handler);
    return () => window.removeEventListener('qwen:open-session', handler);
  }, [handleOpenSessionFromOverview]);

  // Listen for toast requests from deeply nested components (markdown links
  // and artifact actions reporting a failed external open, for example).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastRequestDetail>).detail;
      if (detail && typeof detail.message === 'string' && detail.message) {
        pushToast(detail.tone, detail.message);
      }
    };
    window.addEventListener(TOAST_REQUEST_EVENT, handler);
    return () => window.removeEventListener(TOAST_REQUEST_EVENT, handler);
  }, [pushToast]);

  useEffect(() => {
    if (
      sidebarSwitchingSessionId !== null &&
      connection.sessionId === sidebarSwitchingSessionId &&
      !connection.loadingTranscript &&
      !connection.catchingUp &&
      !sessionWriteBlocked
    ) {
      setSidebarSwitchingSessionId(null);
      scheduleComposerFocus(sidebarSwitchingSessionId);
    }
  }, [
    connection.catchingUp,
    connection.loadingTranscript,
    connection.sessionId,
    scheduleComposerFocus,
    sessionWriteBlocked,
    sidebarSwitchingSessionId,
  ]);

  // Manual "run now" from the scheduled-tasks page. A bound task runs in its
  // own session (so manual and scheduled runs share one transcript); an unbound
  // task runs in the current session. Switching sessions is async, so a latch
  // holds the prompt until the target session is fully active before sending.
  //
  // Returns a promise that resolves once the prompt is actually ENQUEUED and
  // rejects if the bound session can't be opened (archived/deleted), supersedes,
  // or times out — so the caller only records the run after it truly happened,
  // never on a failed session switch. Only one bound run waits at a time.
  const pendingBoundRunRef = useRef<{
    sessionId: string;
    prompt: string;
    resolve: () => void;
    reject: (err: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
    owner?: { isCurrent(): boolean };
  } | null>(null);
  const clearPendingBoundRun = useCallback((sessionId: string) => {
    const cur = pendingBoundRunRef.current;
    if (cur && cur.sessionId === sessionId) {
      if (cur.timer !== undefined) clearTimeout(cur.timer);
      pendingBoundRunRef.current = null;
    }
  }, []);
  // Enqueue a manual-run prompt in the CURRENT session, resolving as soon as the
  // daemon ADMITS it — not when the whole turn finishes. sendPrompt resolves via
  // waitForAcceptedPromptCompletion (turn end), which is too late: a long or
  // permission-blocked run, or a closed tab, would execute in the session but
  // never get recorded. `onAdmitted` fires at submitPrompt acceptance.
  //
  // Deliberately NO pre-admission timeout here. `sendPrompt` isn't abortable, so
  // a timer that rejected while the send was still in flight could let a LATE
  // admission execute the prompt in the session AFTER the caller had already
  // handled the rejection and skipped recording — an unrecorded run the user
  // could retry into a duplicate. Staying tied to admission guarantees any
  // accepted prompt is recorded, and the run controls stay busy (not free to
  // re-fire) until the send admits or settles. The earlier "session never becomes
  // active" phase is still bounded by the switch timeout in runTaskManually. If
  // the send settles WITHOUT admitting (onSubmitBefore cancel) or throws before
  // admission, reject so the caller skips recording a run that never reached the
  // session.
  const enqueueManualRun = useCallback(
    (prompt: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        // Session-less means no Goal can exist (and `sendPrompt` allocates a
        // session itself), so gate on the shared predicate rather than on a
        // bare `goalState === undefined`, which also fires with no session.
        if (isGoalGateBlocked()) {
          reject(new Error(t('scheduledTasks.error.goalActive')));
          return;
        }
        let admitted = false;
        const admit = () => {
          if (admitted) return;
          admitted = true;
          resolve();
        };
        sendPrompt(prompt, undefined, undefined, { onAdmitted: admit }).then(
          () => {
            if (!admitted) {
              reject(new Error('Run was cancelled before it started'));
            }
          },
          (error: unknown) => {
            if (!admitted) reject(error);
          },
        );
      }),
    [isGoalGateBlocked, sendPrompt, t],
  );
  // Enqueue the pending bound run once its session is the current, fully-loaded
  // one — driven both by the effect below (when the session switch changes a
  // dep) AND directly after loadSidebarSession resolves (when the session was
  // ALREADY active, so no dep changes and the effect never re-runs — otherwise
  // the run would hang until the switch timeout and falsely report a failure).
  // Whoever fires first nulls the latch, so it runs exactly once.
  const tryFireBoundRun = useCallback(() => {
    const pending = pendingBoundRunRef.current;
    const conn = connectionRef.current;
    if (
      !pending ||
      conn.sessionId !== pending.sessionId ||
      conn.loadingTranscript ||
      conn.goalState === undefined
    ) {
      return;
    }
    if (conn.catchingUp) {
      if (pending.timer === undefined) {
        pending.timer = setTimeout(() => {
          clearPendingBoundRun(pending.sessionId);
          pending.reject(new Error('Timed out waiting for session replay'));
        }, BOUND_RUN_SWITCH_TIMEOUT_MS);
      }
      return;
    }
    if (pending.owner && !pending.owner.isCurrent()) {
      clearPendingBoundRun(pending.sessionId);
      pending.reject(
        new DOMException('Bound run session was replaced', 'AbortError'),
      );
      return;
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pendingBoundRunRef.current = null;
    // Resolves at prompt admission (see enqueueManualRun); the switch-timeout was
    // cleared above, so a long turn can't trip it. Recording happens in the
    // dialog once this resolves.
    enqueueManualRun(pending.prompt).then(
      () => pending.resolve(),
      (error: unknown) => pending.reject(error),
    );
  }, [clearPendingBoundRun, enqueueManualRun]);
  const runTaskManually = useCallback(
    (prompt: string, sessionId: string | null): Promise<void> => {
      showChat();
      if (!sessionId) {
        // Unbound: runs in the current session — resolves at admission.
        return enqueueManualRun(prompt);
      }
      // A newer bound run supersedes an older one still waiting on the latch;
      // reject the old promise so its caller doesn't record a dropped run.
      const prev = pendingBoundRunRef.current;
      if (prev) {
        if (prev.timer !== undefined) clearTimeout(prev.timer);
        pendingBoundRunRef.current = null;
        prev.reject(new Error('superseded by another run'));
      }
      return new Promise<void>((resolve, reject) => {
        const pending: NonNullable<typeof pendingBoundRunRef.current> = {
          sessionId,
          prompt,
          resolve,
          reject,
        };
        pendingBoundRunRef.current = pending;
        loadSidebarSession(sessionId)
          // Fire immediately when the session was already active (no dep change
          // to trigger the effect); a no-op if the load is still settling, in
          // which case the effect picks it up.
          .then(() => {
            if (pendingBoundRunRef.current !== pending) return;
            pending.owner = sessionOwnerGuard.capture();
            tryFireBoundRun();
          })
          .catch((error: unknown) => {
            if (pendingBoundRunRef.current !== pending) return;
            clearPendingBoundRun(sessionId);
            reject(error);
          });
      });
    },
    [
      enqueueManualRun,
      loadSidebarSession,
      clearPendingBoundRun,
      showChat,
      sessionOwnerGuard,
      tryFireBoundRun,
    ],
  );
  useEffect(() => {
    tryFireBoundRun();
  }, [
    connection.sessionId,
    connection.loadingTranscript,
    connection.catchingUp,
    connection.goalState,
    tryFireBoundRun,
  ]);

  const openTasksPanel = useCallback(() => {
    if (!requireActiveSessionForLocalCommand()) return;
    const owner = sessionOwnerGuard.capture();
    const request = workflowsEnabled
      ? sessionActions.getWorkflowTasks()
      : sessionActions.getTasks();
    request
      .then((snapshot) => {
        if (!owner.isCurrent()) return;
        setTasksDialogMessage({ snapshot });
      })
      .catch((error: unknown) => {
        if (!owner.isCurrent()) return;
        if (isSessionDisconnectedError(error)) return;
        reportError(error, 'Failed to load tasks');
      });
  }, [
    reportError,
    requireActiveSessionForLocalCommand,
    sessionActions,
    sessionOwnerGuard,
    workflowsEnabled,
  ]);
  const openCockpit = useCallback((): boolean => {
    if (!sessionWorkflowEnabled || approvalOverlayActive) return false;
    if (!requireActiveSessionForLocalCommand()) return false;
    if (!cockpitViewRequested()) updateCockpitLocation(true);
    setActivePanel(null);
    setTasksDialogMessage(null);
    setMainView('cockpit');
    return true;
  }, [
    approvalOverlayActive,
    requireActiveSessionForLocalCommand,
    sessionWorkflowEnabled,
  ]);
  const openWorkflowInspector = useCallback(() => {
    if (!sessionWorkflowEnabled || approvalOverlayActive) return;
    if (!requireActiveSessionForLocalCommand()) return;
    rememberArtifactPanelTrigger();
    const tab: ArtifactPanelTab = {
      id: 'workflow',
      kind: 'workflow',
      title: t('workflow.title'),
    };
    setArtifactPanelTabs((tabs) =>
      tabs.some((item) => item.id === tab.id) ? tabs : [...tabs, tab],
    );
    setActiveArtifactPanelTabId(tab.id);
    setArtifactPanelWidth((width) =>
      artifactPanelOpenRef.current
        ? width
        : Math.min(440, getDefaultReviewPanelWidth()),
    );
    setArtifactPanelOpen(true);
  }, [
    approvalOverlayActive,
    getDefaultReviewPanelWidth,
    rememberArtifactPanelTrigger,
    requireActiveSessionForLocalCommand,
    sessionWorkflowEnabled,
    t,
  ]);
  const keepWorkflowDrawerClosedForCanvasRef = useRef(false);
  const workflowCanvasEntryHandledRef = useRef(false);
  const expandWorkflowGraph = useCallback(() => {
    // Only close the floating inspector drawer when the cockpit actually
    // opened: openCockpit() silently aborts on the approval-overlay and
    // active-session guards, and closing the drawer anyway would drop the
    // interactive workflow surface without delivering the expand action.
    if (!openCockpit()) return;
    if (artifactPanelFullscreen) setArtifactPanelFullscreen(false);
    if (useFloatingArtifactPanel) {
      keepWorkflowDrawerClosedForCanvasRef.current = true;
      setArtifactPanelOpen(false);
    }
  }, [artifactPanelFullscreen, openCockpit, useFloatingArtifactPanel]);
  useEffect(() => {
    if (mainView !== 'cockpit') {
      keepWorkflowDrawerClosedForCanvasRef.current = false;
      workflowCanvasEntryHandledRef.current = false;
      return;
    }
    if (workflowCanvasEntryHandledRef.current) return;
    workflowCanvasEntryHandledRef.current = true;
    if (
      keepWorkflowDrawerClosedForCanvasRef.current ||
      artifactPanelTabs.some((tab) => tab.kind === 'workflow')
    ) {
      return;
    }
    openWorkflowInspector();
  }, [artifactPanelTabs, mainView, openWorkflowInspector]);
  const focusComposerAfterCockpitCloseRef = useRef(false);
  const closeCockpit = useCallback(() => {
    focusComposerAfterCockpitCloseRef.current = true;
    showChat();
  }, [showChat]);
  useEffect(() => {
    if (mainView !== 'chat' || !focusComposerAfterCockpitCloseRef.current) {
      return;
    }
    focusComposerAfterCockpitCloseRef.current = false;
    if (!activePanel && !approvalOverlayActive) editorRef.current?.focus();
  }, [activePanel, approvalOverlayActive, mainView]);
  useEffect(() => {
    if (!sessionWorkflowEnabled) {
      if (mainView !== 'cockpit') return;
      if (cockpitViewRequested()) {
        if (sessionWorkflowSettingsResolved) {
          updateCockpitLocation(false, true);
        }
      }
      focusComposerAfterCockpitCloseRef.current = true;
      setMainView('chat');
      return;
    }
    if (
      mainView === 'chat' &&
      cockpitViewRequested() &&
      !approvalOverlayActive
    ) {
      setMainView('cockpit');
    }
  }, [
    approvalOverlayActive,
    mainView,
    sessionWorkflowEnabled,
    sessionWorkflowSettingsResolved,
  ]);
  useEffect(() => {
    const handlePopState = () => {
      if (cockpitViewRequested()) {
        if (sessionWorkflowEnabled && !approvalOverlayActive) {
          setMainView('cockpit');
        } else {
          setMainView('chat');
          if (approvalOverlayActive || sessionWorkflowSettingsResolved) {
            updateCockpitLocation(false, true);
          }
        }
      } else if (mainViewRef.current === 'cockpit') {
        if (!approvalOverlayActive) {
          focusComposerAfterCockpitCloseRef.current = true;
        }
        setMainView('chat');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [
    approvalOverlayActive,
    sessionWorkflowEnabled,
    sessionWorkflowSettingsResolved,
  ]);
  useEffect(() => {
    if (
      mainView === 'cockpit' &&
      sessionWorkflowEnabled &&
      !cockpitViewRequested()
    ) {
      updateCockpitLocation(true, true);
    } else if (
      mainView !== 'cockpit' &&
      cockpitViewRequested() &&
      !sessionWorkflowEnabled &&
      sessionWorkflowSettingsResolved
    ) {
      updateCockpitLocation(false, true);
    }
  }, [mainView, sessionWorkflowEnabled, sessionWorkflowSettingsResolved]);
  const openEnvironmentTasksPanel = useCallback(() => {
    if (!requireActiveSessionForLocalCommand()) return;
    setEnvironmentPanelOpen(true);
    setBackgroundTasksRefreshTrigger((value) => value + 1);
  }, [requireActiveSessionForLocalCommand]);
  const openEnvironmentTask = useCallback(
    (task: DaemonSessionTaskWithWorkflowStatus) => {
      if (task.kind === 'monitor' || task.kind === 'shell') {
        if (!artifactPanelOpenRef.current) {
          preserveEnvironmentPanelOnArtifactOpenRef.current = true;
        }
        if (task.kind === 'monitor') {
          handleOpenMonitorDetails(task);
        } else {
          handleOpenShellDetails(task);
        }
        return;
      }
      openTasksPanel();
    },
    [handleOpenMonitorDetails, handleOpenShellDetails, openTasksPanel],
  );

  const refreshGoal = useCallback(async () => {
    const owner = sessionOwnerGuard.capture();
    const response = await sessionActions.getGoal();
    if (owner.isCurrent()) setGoalSnapshot(response.snapshot);
    return response.snapshot;
  }, [sessionActions, sessionOwnerGuard]);

  const controlCurrentGoal = useCallback(
    async (
      action: 'create' | 'replace' | 'edit' | 'pause' | 'resume' | 'clear',
      objective?: string,
    ) => {
      const busyOwner = sessionOwnerGuard.capture();
      const busySessionId = connectionRef.current.sessionId;
      const expectedGoalId = goalSnapshotRef.current?.goal?.goalId;
      const opId = ++goalControlOpSeqRef.current;
      goalControlOwnerRef.current = { opId, sessionId: busySessionId };
      setGoalControlBusy(true);
      try {
        const snapshot = await refreshGoal();
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
        const owner = sessionOwnerGuard.capture();
        try {
          const response = await sessionActions.controlGoal(request);
          if (owner.isCurrent()) setGoalSnapshot(response.snapshot);
          return response.snapshot;
        } catch (error) {
          if (owner.isCurrent()) await refreshGoal().catch(() => undefined);
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
    [refreshGoal, sessionActions, sessionOwnerGuard, t],
  );

  const createGoalForAllocatedSession = useCallback(
    async (sessionId: string, objective: string) => {
      const opId = ++goalControlOpSeqRef.current;
      goalControlOwnerRef.current = { opId, sessionId };
      setGoalControlBusy(true);
      try {
        const response = await workspaceActions.controlGoal(sessionId, {
          action: 'create',
          objective,
        });
        // The workspace-scoped control does not write `connection.goalState`
        // the way `sessionActions.controlGoal` does, so install the create
        // response directly to keep the Goal strip and controls authoritative.
        sessionActions.applyGoalSnapshot(sessionId, response.snapshot);
        if (
          !connectionRef.current.sessionId ||
          connectionRef.current.sessionId === sessionId
        ) {
          setGoalSnapshot(response.snapshot);
        }
        if (connectionRef.current.sessionId === sessionId) {
          await refreshGoal();
        }
        return response.snapshot;
      } finally {
        // Same ownership rule as `controlCurrentGoal`: a create that settles
        // after the user switched sessions must not release a latch a newer
        // control now holds, or the strip re-enables mid-control and a second
        // dispatch loses the daemon's CAS with a 409.
        if (goalControlOwnerRef.current?.opId === opId) {
          goalControlOwnerRef.current = undefined;
          setGoalControlBusy(false);
        }
      }
    },
    [refreshGoal, sessionActions, workspaceActions],
  );

  const loadRewindSnapshots = useCallback(
    () => sessionActions.getRewindSnapshots(),
    [sessionActions],
  );

  const rewindConversationOnly = useCallback(
    (promptId: string) =>
      sessionActions
        .rewindSession(promptId, { rewindFiles: false })
        .then(() => undefined),
    [sessionActions],
  );

  const editUserMessage = useCallback(
    async (turnIndex: number, content: string) => {
      if (onUserMessageEditRequest?.(turnIndex, content) === true) return;

      const restoreComposer = () => {
        editorRef.current?.setText(content);
        editorRef.current?.focus();
      };

      restoreComposer();
      window.setTimeout(restoreComposer, 0);
      try {
        const { snapshots } = await sessionActions.getRewindSnapshots();
        const snapshot = snapshots.find(
          (entry) => entry.turnIndex === turnIndex,
        );
        if (!snapshot) throw new Error(t('rewind.empty'));
        await sessionActions.rewindSession(snapshot.promptId, {
          rewindFiles: false,
        });
      } catch (error) {
        reportError(error, t('rewind.failed', { reason: String(error) }));
      } finally {
        restoreComposer();
      }
    },
    [onUserMessageEditRequest, reportError, sessionActions, t],
  );

  const handleRewindError = useCallback(
    (error: unknown) => {
      if (isAlreadyDispatched(error)) return;
      const reason = error instanceof Error ? error.message : String(error);
      pushToast('error', t('rewind.failed', { reason }));
    },
    [pushToast, t],
  );

  const handleGoalSlashCommand = useCallback(
    (text: string, hasAttachments: boolean) => {
      if (hasAttachments) {
        pushToast('error', t('goals.error.attachmentsUnsupported'));
        return false;
      }
      const operation = parseWebShellGoalCommand(text);
      if (operation.kind === 'status') {
        openGoals();
        return true;
      }
      if (operation.kind === 'error') {
        pushToast(
          'error',
          t('goals.error.requiresObjective', { keyword: operation.keyword }),
        );
        return false;
      }
      // Returning true wipes the composer, so the preconditions that can be
      // checked here must be checked before that happens — a control typed
      // without a session would otherwise lose its text to a toast.
      if (!connectionRef.current.sessionId && operation.kind !== 'set') {
        pushToast('error', t('localCommand.noSession'));
        return false;
      }
      // The strip disables its buttons while a control is in flight; the
      // composer has no disabled state, so it has to refuse here. Two controls
      // read the same snapshot and stamp the same `expectedGoalId`/
      // `expectedRevision`, and the daemon rejects the loser with a 409.
      if (goalControlOwnerRef.current) {
        pushToast('error', t('goals.error.controlBusy'));
        return false;
      }

      void (async () => {
        const sourceOwner = sessionOwnerGuard.capture();
        const sourceSessionId = connectionRef.current.sessionId;
        let allocatedSessionId: string | undefined;
        if (!connectionRef.current.sessionId) {
          if (operation.kind !== 'set') {
            throw new Error(t('localCommand.noSession'));
          }
          allocatedSessionId = await ensureSessionForPrompt();
        }
        const currentSessionId = connectionRef.current.sessionId;
        const ownAllocationSucceeded =
          sourceSessionId === undefined &&
          allocatedSessionId !== undefined &&
          (currentSessionId === undefined ||
            currentSessionId === allocatedSessionId);
        if (
          (!sourceOwner.isCurrent() && !ownAllocationSucceeded) ||
          (sourceSessionId !== undefined
            ? currentSessionId !== sourceSessionId
            : currentSessionId !== undefined &&
              currentSessionId !== allocatedSessionId)
        ) {
          return;
        }
        if (!connectionRef.current.sessionId && !allocatedSessionId) {
          throw new Error(t('localCommand.noSession'));
        }
        store.appendLocalUserMessage(text);
        const action = operation.kind === 'set' ? 'replace' : operation.kind;
        const objective =
          operation.kind === 'set' || operation.kind === 'edit'
            ? operation.objective
            : undefined;
        if (allocatedSessionId && operation.kind === 'set') {
          await createGoalForAllocatedSession(
            allocatedSessionId,
            operation.objective,
          );
        } else {
          await controlCurrentGoal(action, objective);
        }
      })().catch((error: unknown) => {
        reportError(error, `Failed to ${operation.kind} /goal`);
      });
      return true;
    },
    [
      controlCurrentGoal,
      createGoalForAllocatedSession,
      ensureSessionForPrompt,
      openGoals,
      pushToast,
      reportError,
      sessionOwnerGuard,
      store,
      t,
    ],
  );

  const runGoalControl = useCallback(
    (action: 'pause' | 'resume' | 'clear') => {
      void controlCurrentGoal(action).catch((error: unknown) => {
        reportError(error, t(`goals.error.${action}Failed`));
      });
    },
    [controlCurrentGoal, reportError, t],
  );

  const handleGoalEditSave = useCallback(
    (objective: string) => {
      const owner = sessionOwnerGuard.capture();
      setGoalEditError(null);
      void controlCurrentGoal('edit', objective)
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
    [controlCurrentGoal, reportError, sessionOwnerGuard, t],
  );

  const hiddenCommands = useMemo(
    () =>
      new Set(
        (hiddenSlashCommands ?? []).map(normalizeHiddenCommand).filter(Boolean),
      ),
    [hiddenSlashCommands],
  );
  const hideSettings = hiddenCommands.has('settings');

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      commitComposerAccepted?: ComposerSubmitCommit,
      metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
    ) => {
      if (sessionWriteBlockedRef.current) return false;
      if (
        !workspaceContextActive &&
        ((images?.length ?? 0) > 0 || (files?.length ?? 0) > 0)
      ) {
        pushToast('warning', t('composerAdd.file.attachDisabled'));
        return false;
      }
      if (
        connectionRef.current.standaloneSession?.creationRecovery ||
        connectionRef.current.standaloneSession?.errorCode ===
          'working_directory_missing' ||
        connectionRef.current.standaloneSession?.errorCode ===
          'working_directory_compromised'
      ) {
        pushToast('warning', t('session.recoveryBlocksAction'));
        return false;
      }
      if (
        unknownPromptAdmissionRef.current?.payloadAvailable &&
        unknownPromptAdmissionRef.current.sessionId ===
          connectionRef.current.sessionId
      ) {
        return false;
      }
      if (
        invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError)
      ) {
        return true;
      }
      if (connectionRef.current.loadingTranscript) {
        pushToast('warning', t('editor.sessionLoading'));
        return false;
      }
      if (
        shouldBlockComposerSubmit({
          connectionStatus: connectionRef.current.status,
          hasSession: Boolean(connectionRef.current.sessionId),
        })
      ) {
        pushToast('warning', t('editor.connectionDisconnected'));
        return false;
      }
      const goalBlocked = isGoalGateBlocked();
      const sessionActive =
        streamingStateRef.current !== 'idle' ||
        sessionHasActivePromptRef.current;
      const commandBlocked = sessionActive || goalBlocked;
      const enqueueBlockedCommand = (commandText: string) => {
        if (goalBlocked) return blockCommand();
        return enqueuePrompt(
          commandText,
          images,
          files,
          undefined,
          commitComposerAccepted,
          metadata?.inputAnnotations,
        );
      };
      const submitPromptFromEditor = (
        promptText: string,
        promptImages: PromptImage[] | undefined,
        promptFiles: PromptFile[] | undefined,
        errorMessage: string,
        opts?: {
          optimisticUserMessage?: boolean;
          retry?: boolean;
          inputAnnotations?: DaemonInputAnnotation[];
          trackSendFailure?: boolean;
        },
      ) => {
        const admissionAttachment = {
          current: sessionOwnerGuard.capture(),
        };
        const admissionOwner = {
          sourceVersion: composerSourceVersionRef.current,
          sessionId: connectionRef.current.sessionId,
          workspaceCwd: getComposerWorkspaceCwd(),
        };
        const admissionOwnerIsCurrent = () =>
          admissionAttachment.current.isCurrent() &&
          composerSourceVersionRef.current === admissionOwner.sourceVersion &&
          (admissionOwner.sessionId === undefined ||
            (connectionRef.current.sessionId === admissionOwner.sessionId &&
              getComposerWorkspaceCwd() === admissionOwner.workspaceCwd));
        const { trackSendFailure = false, ...sendOptions } = opts ?? {};
        const startedWithoutSession = !connectionRef.current.sessionId;
        const deferComposerCommit =
          Boolean(prepareSubmitRef.current || onSubmitBeforeRef.current) ||
          createSessionPromiseRef.current !== null;
        const clearComposerOnPromptStart =
          startedWithoutSession || deferComposerCommit;
        let optimisticUserMessage: OptimisticUserMessage | undefined;
        let submittedPromptText = promptText;
        let submittedInputAnnotations = sendOptions.inputAnnotations;
        let admitted = false;
        let admissionStarted = false;
        let admissionSessionId: string | undefined;
        sendPrompt(promptText, promptImages, promptFiles, {
          ownerRef: admissionAttachment,
          ...sendOptions,
          clearComposerOnPromptStart,
          onPreparedSubmit: (prepared) => {
            submittedPromptText = prepared.prompt;
            const annotations = prepared.inputAnnotations ?? [];
            submittedInputAnnotations =
              annotations.length > 0 ? [...annotations] : undefined;
          },
          commitComposerAccepted: clearComposerOnPromptStart
            ? commitComposerAccepted
            : undefined,
          onAdmissionStarted: (sessionId) => {
            admissionStarted = true;
            admissionSessionId = sessionId;
          },
          onAdmitted: () => {
            admitted = true;
          },
          ...(trackSendFailure
            ? {
                onOptimisticUserMessage: (message: OptimisticUserMessage) => {
                  optimisticUserMessage = message;
                },
              }
            : {}),
        }).catch((error: unknown) => {
          if (!admissionOwnerIsCurrent()) return;
          const failedMessage = optimisticUserMessage;
          const definitelyRejected = isDefinitelyRejectedPromptAdmission(error);
          if (admissionStarted && !admitted && !definitelyRejected) {
            updateFailedPrompt(null);
            const uncertainSessionId =
              failedMessage?.sessionId ??
              admissionSessionId ??
              connectionRef.current.sessionId;
            if (uncertainSessionId) {
              updateUnknownPromptAdmission({
                sessionId: uncertainSessionId,
                messageId: failedMessage?.messageId,
                text: submittedPromptText,
                images: promptImages ? [...promptImages] : undefined,
                files: promptFiles ? [...promptFiles] : undefined,
                inputAnnotations: submittedInputAnnotations,
                payloadAvailable: true,
              });
            }
            pushToast('warning', t('queue.admissionUnknown'));
            console.warn(
              '[WebShell] prompt admission outcome is unknown',
              error,
            );
            return;
          }
          if (
            trackSendFailure &&
            !admitted &&
            failedMessage &&
            failedMessage.sessionId === connectionRef.current.sessionId &&
            matchesUserMessageIdentity(
              store
                .getSnapshot()
                .blocks.find(
                  (block) =>
                    block.kind === 'user' &&
                    block.id === failedMessage.messageId,
                ),
              failedMessage.identity,
              failedMessage.owner.snapshot.isCurrent(),
            )
          ) {
            updateFailedPrompt({
              ...failedMessage,
              text: submittedPromptText,
              images: promptImages,
              files: promptFiles,
              inputAnnotations: submittedInputAnnotations,
            });
          }
          if (startedWithoutSession && !admissionStarted) {
            const editor = editorRef.current;
            if (editor && !editor.hasInput()) {
              editor.setText(submittedPromptText);
              if (promptImages?.length) editor.restoreImages(promptImages);
              if (promptFiles?.length) editor.restoreFiles(promptFiles);
              if (submittedInputAnnotations?.length) {
                editor.restoreInputAnnotations?.(submittedInputAnnotations);
              }
            }
          }
          reportError(error, errorMessage);
        });
        return clearComposerOnPromptStart ? false : true;
      };
      if (text.startsWith('/')) {
        const match = text.match(SLASH_COMMAND_PATTERN);
        if (match) {
          const cmd = match[1];
          const standaloneResumeSessionId =
            cmd === 'resume' && effectiveSessionContext?.kind === 'standalone'
              ? text.slice(match[0].length).trim()
              : '';
          if (
            !workspaceContextActive &&
            NON_WORKSPACE_BLOCKED_COMMANDS.has(cmd) &&
            !standaloneResumeSessionId
          ) {
            pushToast('info', t('session.workspaceActionUnavailable'));
            return true;
          }
          if (hiddenCommands.has(normalizeHiddenCommand(cmd))) {
            if (commandBlocked) {
              return enqueueBlockedCommand(text);
            }
            return submitPromptFromEditor(
              text,
              images,
              files,
              'Failed to send hidden slash command',
              { inputAnnotations: metadata?.inputAnnotations },
            );
          }
          if (cmd === 'help') {
            setShowHelpDialog(true);
            return true;
          }
          if (cmd === 'diff') {
            if (!gitDiffWorkspaceCwd) {
              pushToast('info', t('localCommand.diffNoWorkspace'));
              return true;
            }
            setGitDialog({
              workspaceCwd: gitDiffWorkspaceCwd,
              gitCwd: sessionWorktree?.path,
              view: 'diff',
            });
            return true;
          }
          if (cmd === 'log') {
            if (!gitDiffWorkspaceCwd) {
              pushToast('info', t('localCommand.logNoWorkspace'));
              return true;
            }
            setGitDialog({
              workspaceCwd: gitDiffWorkspaceCwd,
              gitCwd: sessionWorktree?.path,
              view: 'log',
            });
            return true;
          }
          if (cmd === 'prs') {
            if (!gitDiffWorkspaceCwd) {
              pushToast('info', t('localCommand.prsNoWorkspace'));
              return true;
            }
            if (!gitHubPrsSupported) {
              pushToast('info', t('localCommand.prsUnsupported'));
              return true;
            }
            setGitDialog({ workspaceCwd: gitDiffWorkspaceCwd, view: 'prs' });
            return true;
          }
          if (cmd === 'tasks') {
            openEnvironmentTasksPanel();
            return true;
          }
          if (
            cmd === 'workflows' &&
            workflowsEnabled &&
            text.slice(match[0].length).trim().length === 0
          ) {
            openWorkflows();
            return true;
          }
          if (cmd === 'goal') {
            return handleGoalSlashCommand(
              text,
              (images?.length ?? 0) > 0 ||
                (files?.length ?? 0) > 0 ||
                (metadata?.inputAnnotations?.length ?? 0) > 0,
            );
          }
          if (cmd === 'theme') {
            const themeArg = text.slice(match[0].length).trim().toLowerCase();
            if (themeArg === 'dark' || themeArg === 'light') {
              handleThemeChange(themeArg);
            } else if (!themeArg) {
              setShowThemeDialog(true);
            } else {
              pushToast('error', t('error.unsupportedTheme'));
            }
            return true;
          }
          if (cmd === 'language') {
            const args = text.slice(match[0].length).trim();
            const [subCommand, languageArg] = args.split(/\s+/);
            if (!args) {
              store.dispatch([
                {
                  type: 'status',
                  text: [
                    t('language.current', {
                      language: languageLabel(selectedLanguage),
                    }),
                    t('language.usage'),
                    t('language.options'),
                    '  - en: English',
                    '  - zh-CN: 中文',
                  ].join('\n'),
                },
              ]);
              return true;
            }
            if (subCommand?.toLowerCase() === 'ui') {
              if (!languageArg) {
                store.dispatch([
                  {
                    type: 'status',
                    text: [
                      t('language.set'),
                      '',
                      t('language.usage'),
                      '',
                      t('language.options'),
                      '  - en: English',
                      '  - zh-CN: 中文',
                    ].join('\n'),
                  },
                ]);
                return true;
              }
              const normalizedArg = languageArg.toLowerCase();
              const valid = ['en', 'zh', 'zh-cn', 'zh_cn'].includes(
                normalizedArg,
              );
              if (!valid) {
                pushToast('error', t('language.invalid'));
                return true;
              }
              const nextLanguage = normalizeLanguage(languageArg);
              const owner = { current: sessionOwnerGuard.capture() };
              // The daemon sync is what keeps the agent answering in the
              // language the chrome just switched to, so when it cannot run
              // (turn in flight, or a Goal owning the session) refuse the
              // command instead of switching the UI alone — the language
              // picker treats the identical condition the same way.
              if (commandBlocked) return blockCommand();
              handleLanguageChange(nextLanguage);
              {
                const deferComposerCommit =
                  Boolean(
                    prepareSubmitRef.current || onSubmitBeforeRef.current,
                  ) || createSessionPromiseRef.current !== null;
                const clearComposerOnPromptStart =
                  !connectionRef.current.sessionId || deferComposerCommit;
                sendPrompt(
                  `/language ui ${nextLanguage}`,
                  undefined,
                  undefined,
                  {
                    ownerRef: owner,
                    clearComposerOnPromptStart,
                    commitComposerAccepted: clearComposerOnPromptStart
                      ? commitComposerAccepted
                      : undefined,
                  },
                )
                  .then(() => {
                    if (!owner.current.isCurrent()) return;
                    return sessionActions.refreshCommands();
                  })
                  .catch((error: unknown) => {
                    if (!owner.current.isCurrent()) return;
                    reportError(error, 'Failed to sync /language command');
                  });
                return clearComposerOnPromptStart ? false : true;
              }
              return true;
            }
          }
          if (cmd === 'copy') {
            const copyArg = text.slice(match[0].length).trim();
            copyFromLastAssistantMessage(messagesRef.current, copyArg)
              .then((result) => {
                store.dispatch([
                  {
                    type: result.status === 'error' ? 'error' : 'status',
                    text: translateCopyMessage(result.message, t),
                  },
                ]);
              })
              .catch((error: unknown) => {
                reportError(error, t('copy.failedFallback'));
              });
            return true;
          }
          if (cmd === 'delete') {
            setShowDeleteDialog(true);
            return true;
          }
          if (cmd === 'release') {
            setShowReleaseDialog(true);
            return true;
          }
          if (cmd === 'rewind') {
            if (!requireActiveSessionForLocalCommand()) return false;
            setShowRewindDialog(true);
            return true;
          }
          if (cmd === 'branch') {
            if (commandBlocked) return blockCommand();
            const branchName = text.slice(match[0].length).trim();
            branchCurrentSession(branchName || undefined);
            return true;
          }
          if (cmd === 'fork') {
            if (commandBlocked) return blockCommand();
            if (!requireActiveSessionForLocalCommand()) return false;
            const directive = text.slice(match[0].length).trim();
            if (!directive) {
              pushToast('error', t('fork.empty'));
              return true;
            }
            const owner = sessionOwnerGuard.capture();
            sessionActions
              .forkSession(directive)
              .then((result) => {
                if (!owner.isCurrent()) return;
                if (!result.launched) {
                  pushToast('warning', t('fork.notStarted'));
                  return;
                }
                setBackgroundTasksRefreshTrigger((value) => value + 1);
                pushToast(
                  'success',
                  t('fork.started', { name: result.description }),
                );
              })
              .catch((error: unknown) => {
                if (!owner.isCurrent()) return;
                const reason =
                  error instanceof Error ? error.message : String(error);
                reportError(error, t('fork.failed', { reason }));
              });
            return true;
          }
          if (cmd === 'auth') {
            setShowAuthDialog(true);
            return true;
          }
          if (cmd === 'model') {
            const modelArg = text.slice(match[0].length).trim();
            if (
              !workspaceContextActive &&
              /^(?:--fast|--voice|--vision)(?:\s|$)/.test(modelArg)
            ) {
              pushToast('info', t('session.workspaceActionUnavailable'));
              return true;
            }
            if (modelArg === '--fast') {
              setModelDialogMode('fast');
              return true;
            }
            if (modelArg.startsWith('--fast ')) {
              if (commandBlocked) {
                return enqueueBlockedCommand(text);
              }
              return submitPromptFromEditor(
                text,
                images,
                files,
                'Failed to send /model --fast',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            if (modelArg === '--voice') {
              if (echoOrDeferLocalCommand(text, images)) return true;
              void openVoiceModelPicker('workspace', 'command');
              return true;
            }
            if (modelArg.startsWith('--voice ')) {
              const voiceModelId = modelArg.replace(/^--voice\s+/, '');
              void writeVoiceModelForTarget(voiceModelId, 'workspace').catch(
                (error: unknown) => reportError(error, t('model.setVoice')),
              );
              return true;
            }
            if (modelArg === '--vision') {
              setModelDialogMode('vision');
              return true;
            }
            if (modelArg.startsWith('--vision ')) {
              const visionModelId = modelArg.replace(/^--vision\s+/, '');
              setWorkspaceSetting(
                'workspace',
                'visionModel',
                visionModelId,
              ).catch((error: unknown) =>
                reportError(error, t('model.setVision')),
              );
              return true;
            }
            if (modelArg) {
              if (!connectionRef.current.sessionId) {
                selectWelcomeModel(modelArg);
                return true;
              }
              const owner = sessionOwnerGuard.capture();
              sessionActions
                .setModel(modelArg)
                .then(() => {
                  if (!owner.isCurrent()) return;
                  setPendingModel(modelArg);
                })
                .catch((error: unknown) => {
                  if (!owner.isCurrent()) return;
                  reportError(error, t('model.switch'));
                });
            } else {
              setModelDialogMode('main');
            }
            return true;
          }
          if (cmd === 'plan') {
            if (commandBlocked) return blockCommand();
            const prompt = text.slice(match[0].length).trim();
            if (!connectionRef.current.sessionId) {
              setPendingMode('plan');
              if (prompt) {
                return submitPromptFromEditor(
                  prompt,
                  images,
                  files,
                  'Failed to send plan prompt',
                  { inputAnnotations: metadata?.inputAnnotations },
                );
              }
              return true;
            }
            const planPreparationToken = prompt
              ? ++planPreparationTokenRef.current
              : undefined;
            const planPromptPreparationOwner = prompt
              ? beginPromptPreparation()
              : undefined;
            const owner = sessionOwnerGuard.capture();
            const writeBlockGeneration = sessionWriteBlockGenerationRef.current;
            sessionActions
              .setApprovalMode('plan')
              .then(() => {
                if (!owner.isCurrent()) return;
                setPendingMode('plan');
                if (
                  prompt &&
                  !sessionWriteBlockedRef.current &&
                  sessionWriteBlockGenerationRef.current ===
                    writeBlockGeneration
                ) {
                  return sendPrompt(prompt, images, files, {
                    clearComposerOnPromptStart: true,
                    inputAnnotations: metadata?.inputAnnotations,
                  }).catch((error: unknown) =>
                    reportError(error, 'Failed to send plan prompt'),
                  );
                }
              })
              .catch((error: unknown) => {
                if (!owner.isCurrent()) return;
                reportError(error, t('mode.plan'));
              })
              .finally(() => {
                if (
                  prompt &&
                  planPreparationTokenRef.current === planPreparationToken
                ) {
                  finishPromptPreparation(planPromptPreparationOwner);
                }
              });
            return prompt ? false : true;
          }
          if (cmd === 'approval-mode') {
            const modeArg = text.slice(match[0].length).trim();
            if (modeArg) {
              handleSetMode(modeArg);
            } else {
              setShowApprovalModeDialog(true);
            }
            return true;
          }
          if (cmd === 'mcp') {
            const mcpArg = text.slice(match[0].length).trim().toLowerCase();
            workspaceActions
              .loadMcpStatus()
              .then((status) => {
                setMcpDialogMessage({
                  status,
                  toolsByServer: {},
                  resourcesByServer: {},
                  showDescriptions: mcpArg === 'desc',
                  showSchema: mcpArg === 'schema',
                  showTips: !mcpArg,
                });
                openPanel('mcp');
              })
              .catch((error: unknown) => {
                reportError(error, 'Failed to load MCP status');
              });
            return true;
          }
          if (cmd === 'skills') {
            const skillArg = text.slice(match[0].length).trim();
            if (!skillArg || skillArg === 'detail' || skillArg === 'details') {
              openPanel('skills');
            } else {
              const skillPrompt = `/${skillArg}`;
              if (commandBlocked) {
                return enqueueBlockedCommand(skillPrompt);
              }
              return submitPromptFromEditor(
                skillPrompt,
                images,
                files,
                'Failed to send /skills command',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            return true;
          }
          if (cmd === 'tools') {
            const toolsArg = text.slice(match[0].length).trim().toLowerCase();
            if (toolsArg === 'desc' || toolsArg === 'descriptions') {
              setShowToolsDialog(true);
            } else {
              if (echoOrDeferLocalCommand(text, images)) return true;
              workspaceActions
                .loadToolsStatus()
                .then((status) => {
                  const tools = status?.tools ?? [];
                  if (tools.length === 0) {
                    store.dispatch([{ type: 'status', text: t('tools.none') }]);
                  } else {
                    const list = tools
                      .map((tool) => `- ${tool.displayName || tool.name}`)
                      .join('\n');
                    store.dispatch([
                      {
                        type: 'status',
                        text: `${t('tools.available')}\n\n${list}`,
                      },
                    ]);
                  }
                  resumeChatBottomFollow('smooth');
                })
                .catch((error: unknown) => {
                  reportError(error, 'Failed to load tools');
                });
            }
            return true;
          }
          if (cmd === 'settings') {
            openPanel('settings');
            return true;
          }
          if (cmd === 'schedule') {
            openScheduledTasks();
            return true;
          }
          if (cmd === 'context') {
            const contextArg = text.slice(match[0].length).trim().toLowerCase();
            if (
              contextArg === '' ||
              contextArg === 'detail' ||
              contextArg === '-d'
            ) {
              showContextUsage(
                text,
                contextArg === 'detail' || contextArg === '-d',
              );
              return true;
            }
          }
          if (cmd === 'memory') {
            const memoryArg = text.slice(match[0].length).trim().toLowerCase();
            if (memoryArg === 'refresh') {
              setMemoryRefreshSignal((signal) => signal + 1);
            } else if (memoryArg === 'add' || memoryArg.startsWith('add ')) {
              const addTarget = memoryArg.slice('add'.length).trim();
              setMemoryAddScope(
                addTarget === 'user' || addTarget === 'global'
                  ? 'global'
                  : 'workspace',
              );
              setMemoryAddSignal((signal) => signal + 1);
            }
            setShowMemoryDialog(true);
            return true;
          }
          if (cmd === 'agents') {
            const subCommand = text.slice(match[0].length).trim().toLowerCase();
            if (subCommand === 'create') {
              setAgentsCreateScope('global');
            } else if (
              subCommand === 'create user' ||
              subCommand === 'create global'
            ) {
              setAgentsCreateScope('global');
            } else if (
              subCommand === 'create project' ||
              subCommand === 'create workspace'
            ) {
              setAgentsCreateScope('workspace');
            } else {
              setAgentsCreateScope(null);
            }
            openPanel('agents');
            return true;
          }
          if (cmd === 'extensions') {
            const args = text.slice(match[0].length).trim();
            const subCommand = args.split(/\s+/)[0]?.toLowerCase();
            if (!subCommand || subCommand === 'manage') {
              openPanel('extensions');
              return true;
            }
            if (subCommand === 'install') {
              // Install echoes into the transcript (and its error/usage replies
              // do too); block it mid-turn so it can't split the active turn.
              if (commandBlocked) return blockCommand();
              const tokens = args.slice('install'.length).trim().split(/\s+/);
              let source = '';
              let ref: string | undefined;
              let registry: string | undefined;
              let autoUpdate: boolean | undefined;
              let allowPreRelease: boolean | undefined;
              let parseError: string | null = null;
              for (let index = 0; index < tokens.length; index++) {
                const token = tokens[index];
                if (!token) continue;
                if (token === '--auto-update') {
                  autoUpdate = true;
                } else if (
                  token === '--pre-release' ||
                  token === '--allow-pre-release'
                ) {
                  allowPreRelease = true;
                } else if (token === '--ref' || token === '--registry') {
                  const value = tokens[index + 1];
                  if (!value || value.startsWith('--')) {
                    parseError = t('extensions.install.missingOptionValue', {
                      option: token,
                    });
                    break;
                  }
                  if (token === '--ref') {
                    ref = value;
                  } else {
                    registry = value;
                  }
                  index += 1;
                } else if (token.startsWith('--')) {
                  parseError = t('extensions.install.unknownOption', {
                    option: token,
                  });
                  break;
                } else if (!source) {
                  source = token;
                } else {
                  parseError = t('extensions.install.usage');
                  break;
                }
              }
              if (parseError) {
                store.appendLocalUserMessage(text);
                store.dispatch([{ type: 'error', text: parseError }]);
                return true;
              }
              if (!source) {
                store.appendLocalUserMessage(text);
                store.dispatch([
                  {
                    type: 'error',
                    text: t('extensions.install.usage'),
                  },
                ]);
                return true;
              }
              const clientId = connectionRef.current.clientId;
              if (!clientId) {
                pushToast('warning', t('extensions.install.waitForSession'));
                return true;
              }
              store.appendLocalUserMessage(text);
              store.dispatch([
                {
                  type: 'status',
                  text: t('extensions.install.started', { source }),
                },
              ]);
              workspaceActions
                .installExtension(
                  {
                    source,
                    ...(ref ? { ref } : {}),
                    ...(registry ? { registry } : {}),
                    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
                    ...(allowPreRelease !== undefined
                      ? { allowPreRelease }
                      : {}),
                    consent: true,
                  },
                  clientId,
                )
                .then(() => undefined)
                .catch((error: unknown) => {
                  reportError(error, t('extensions.install.requestFailed'));
                });
              return true;
            }
            if (echoOrDeferLocalCommand(text, images)) return true;
            store.dispatch([
              {
                type: 'error',
                text: t('extensions.install.usage'),
              },
            ]);
            return true;
          }
          if (cmd === 'clear') {
            void createNewSession({ kind: 'inherit' });
            return true;
          }
          if (cmd === 'new' || cmd === 'reset') {
            void createNewSession({ kind: 'inherit' });
            return true;
          }
          if (cmd === 'rename') {
            const renameArg = parseRenameArgument(text.slice(match[0].length));
            if (renameArg.type === 'auto' || renameArg.type === 'delegate') {
              if (commandBlocked) {
                return enqueueBlockedCommand(text);
              }
              return submitPromptFromEditor(
                text,
                images,
                files,
                'Failed to send /rename command',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            const displayName = renameArg.displayName;
            if (!displayName) {
              pushToast('error', t('rename.empty'));
              return true;
            }
            if (!requireActiveSessionForLocalCommand()) return false;
            const renamedSessionId = connectionRef.current.sessionId;
            const renamedWorkspaceCwd = connectionRef.current.workspaceCwd;
            const owner = sessionOwnerGuard.capture();
            const renamePromise =
              effectiveSessionContext?.kind === 'standalone' && renamedSessionId
                ? workspace.client.renameStandaloneSession(
                    renamedSessionId,
                    displayName,
                  )
                : sessionActions.renameSession(displayName);
            renamePromise
              .then(() => {
                if (renamedSessionId) {
                  reconcileCatalogRename(
                    workspaceContextActive ? renamedWorkspaceCwd : undefined,
                    renamedSessionId,
                    displayName,
                  );
                }
                if (!owner.isCurrent()) return;
                store.dispatch([
                  {
                    type: 'status',
                    text: t('rename.success', { name: displayName }),
                  },
                ]);
              })
              .catch((error: unknown) => {
                if (workspaceContextActive && renamedWorkspaceCwd) {
                  sessionCatalogController.invalidateWorkspace(
                    renamedWorkspaceCwd,
                  );
                }
                if (!owner.isCurrent()) return;
                reportError(error, 'Failed to rename session');
              });
            return true;
          }
          if (cmd === 'resume') {
            const sessionId = text.slice(match[0].length).trim();
            if (sessionId) {
              loadSidebarSession(
                sessionId,
                undefined,
                effectiveSessionContext?.kind === 'standalone'
                  ? { kind: 'standalone' }
                  : undefined,
              ).catch((error: unknown) => {
                reportError(error, 'Failed to load session');
              });
            } else {
              closeMobileDrawer();
              setShowResumeDialog(true);
            }
            return true;
          }
          if (cmd === 'recap') {
            runVisibleRecap();
            return true;
          }
          if (cmd === 'btw') {
            const rawQuestion = text.slice(match[0].length).trim();
            const sideTaskMatch = /^side(?:\s+|$)/i.exec(rawQuestion);
            if (sideTasksAvailable && sideTaskMatch) {
              const question = rawQuestion
                .slice(sideTaskMatch[0].length)
                .trim();
              if (!question) {
                pushToast('error', t('btw.side.empty'));
                return true;
              }
              createSideTask(question);
              return true;
            }
            runVisibleBtw(rawQuestion);
            return true;
          }
          if (cmd === 'stats') {
            const statsArg = text.slice(match[0].length).trim().toLowerCase();
            let statsView: StatsView = 'overview';
            if (statsArg === 'model') statsView = 'model';
            else if (statsArg === 'tools') statsView = 'tools';
            if (!requireActiveSessionForLocalCommand()) return false;
            const owner = sessionOwnerGuard.capture();
            echoLocalCommandIfIdle(text);
            sessionActions
              .getStats()
              .then((result) => {
                if (!owner.isCurrent()) return;
                dispatchReadOnlyStatus(
                  serializeStatsMessage(result, statsView),
                );
              })
              .catch((error: unknown) => {
                if (!owner.isCurrent()) return;
                reportError(error, 'Failed to load stats');
              });
            return true;
          }
          if (cmd === 'status' || cmd === 'about') {
            echoLocalCommandIfIdle(text);
            (workspaceContextActive
              ? Promise.all([
                  workspaceActions.loadPreflight().catch(() => null),
                  workspaceActions.loadProviders().catch(() => null),
                  workspaceActions.loadEnv().catch(() => null),
                ])
              : Promise.resolve([null, null, null] as const)
            )
              .then(([preflight, providers, env]) => {
                const sys = collectSystemInfo(preflight, env);

                let authSource = sys.authSource;
                if (!authSource && providers?.current?.authType) {
                  authSource = providers.current.authType;
                }

                const runtimeParts: string[] = [];
                if (sys.nodeVersion)
                  runtimeParts.push(`Node.js v${sys.nodeVersion}`);
                if (sys.npmVersion) runtimeParts.push(`npm ${sys.npmVersion}`);

                let formattedAuth = '';
                if (authSource) {
                  if (
                    authSource.startsWith('oauth') ||
                    authSource === 'qwen-oauth'
                  ) {
                    formattedAuth = 'Qwen OAuth';
                  } else {
                    formattedAuth = `API Key - ${authSource}`;
                  }
                }

                const platformStr = `${sys.platform} ${sys.arch}`.trim();
                const curModel = currentModelRef.current;
                const conn = connectionRef.current;
                const qwenCodeVersion =
                  conn.capabilities?.qwenCodeVersion || '';
                const info: StatusInfo = {
                  cliVersion: qwenCodeVersion,
                  runtime: runtimeParts.join(' / '),
                  platform: platformStr,
                  auth: formattedAuth,
                  baseUrl: providers?.current?.baseUrl || '',
                  model:
                    curModel ||
                    conn.currentModel ||
                    providers?.current?.modelId ||
                    '',
                  fastModel:
                    providers?.current?.fastModelId ||
                    curModel ||
                    conn.currentModel ||
                    providers?.current?.modelId ||
                    '',
                  sessionId: conn.sessionId || '',
                  sandbox: sys.sandbox,
                  proxy: sys.proxy,
                  memoryUsage: sys.memoryUsage,
                };

                dispatchReadOnlyStatus(serializeStatusMessage(info));
              })
              .catch((error: unknown) => {
                reportError(error, 'Failed to load status info');
              });
            return true;
          }
          if (cmd === 'bug') {
            const bugTitle = text.slice(match[0].length).trim();
            if (echoOrDeferLocalCommand(text, images)) return true;
            (workspaceContextActive
              ? Promise.all([
                  workspaceActions.loadPreflight().catch(() => null),
                  workspaceActions.loadEnv().catch(() => null),
                ])
              : Promise.resolve([null, null] as const)
            )
              .then(([preflight, env]) => {
                const sys = collectSystemInfo(preflight, env);
                const qwenCodeVersion =
                  connectionRef.current.capabilities?.qwenCodeVersion || '';
                const sysInfo: Record<string, string> = {};
                if (qwenCodeVersion) sysInfo.cliVersion = qwenCodeVersion;
                if (sys.nodeVersion) sysInfo.nodeVersion = sys.nodeVersion;
                if (sys.npmVersion) sysInfo.npmVersion = sys.npmVersion;
                if (sys.platform) sysInfo.platform = sys.platform;
                if (sys.arch) sysInfo.arch = sys.arch;
                if (sys.sandbox) sysInfo.sandbox = sys.sandbox;
                if (sys.memoryUsage) sysInfo.memoryUsage = sys.memoryUsage;
                if (onBugReportRef.current) {
                  onBugReportRef.current({
                    title: bugTitle,
                    systemInfo: sysInfo,
                  });
                  store.dispatch([
                    { type: 'status', text: t('bug.submitted') },
                  ]);
                } else {
                  const fields = Object.entries(sysInfo)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n');
                  const url =
                    `https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml` +
                    `&title=${encodeURIComponent(bugTitle)}` +
                    `&info=${encodeURIComponent('\n' + fields + '\n')}`;
                  const win = window.open(url, '_blank');
                  if (win) {
                    win.opener = null;
                    store.dispatch([
                      { type: 'status', text: t('bug.submitted') },
                    ]);
                  } else {
                    pushToast('error', t('bug.popupBlocked'));
                  }
                }
              })
              .catch((error: unknown) => {
                reportError(error, t('bug.failed'));
              });
            return true;
          }
        }
        // Forward slash commands as prompts
        if (commandBlocked) {
          return enqueueBlockedCommand(text);
        }
        return submitPromptFromEditor(
          text,
          images,
          files,
          'Failed to send command',
          {
            inputAnnotations: metadata?.inputAnnotations,
          },
        );
      } else if (text.startsWith('!')) {
        const cmd = text.slice(1).trim();
        if (!cmd) return false;
        if (streamingStateRef.current !== 'idle') {
          queuedShellCommandsRef.current.push(cmd);
          pushToast('info', t('queue.shellQueued'));
          return true;
        }
        const needsSession = !connectionRef.current.sessionId;
        let shellPromptPreparationOwner: symbol | undefined;
        if (needsSession) {
          if (shellSubmitInFlightRef.current) return false;
          shellSubmitInFlightRef.current = true;
          shellPromptPreparationOwner = beginPromptPreparation();
        }
        let sessionCreated = false;
        const generationAtSubmit = drainGenerationRef.current;
        void ensureSessionForPrompt()
          .finally(() => {
            if (needsSession) {
              finishPromptPreparation(shellPromptPreparationOwner);
              shellSubmitInFlightRef.current = false;
            }
          })
          .then((createdSessionId) => {
            if (drainGenerationRef.current !== generationAtSubmit) return;
            if (needsSession && createdSessionId) {
              sessionCreated = true;
              if (commitComposerAccepted) {
                commitComposerAccepted();
              } else {
                editorRef.current?.clear();
              }
              dispatchSessionChangeRef.current?.({
                type: 'submit',
                sessionId: createdSessionId,
                prompt: `!${cmd}`,
                queued: false,
              });
            }
            const allocatedOwner = allocatedSessionCatalogOwnerRef.current;
            const workspaceCwd = createdSessionId
              ? allocatedOwner?.sessionId === createdSessionId
                ? allocatedOwner.workspaceCwd
                : undefined
              : getComposerWorkspaceCwd();
            return sessionActions.sendShellCommand(cmd).finally(() => {
              if (workspaceCwd) {
                sessionCatalogController.invalidateWorkspace(workspaceCwd);
              }
            });
          })
          .catch((error: unknown) => {
            reportError(
              error,
              needsSession && !sessionCreated
                ? 'Failed to create session for shell command'
                : 'Failed to execute shell command',
            );
          });
        return !needsSession;
      } else {
        if (sessionActive) {
          return enqueuePrompt(
            text,
            images,
            files,
            undefined,
            commitComposerAccepted,
            metadata?.inputAnnotations,
          );
        }
        return submitPromptFromEditor(
          text,
          images,
          files,
          'Failed to send message',
          {
            inputAnnotations: metadata?.inputAnnotations,
            trackSendFailure: true,
          },
        );
      }
    },
    [
      beginPromptPreparation,
      sendPrompt,
      sessionActions,
      sessionOwnerGuard,
      store,
      enqueuePrompt,
      echoOrDeferLocalCommand,
      echoLocalCommandIfIdle,
      dispatchReadOnlyStatus,
      branchCurrentSession,
      closeMobileDrawer,
      openPanel,
      openScheduledTasks,
      openWorkflows,
      workflowsEnabled,
      createNewSession,
      ensureSessionForPrompt,
      finishPromptPreparation,
      getComposerWorkspaceCwd,
      sessionCatalogController,
      gitDiffWorkspaceCwd,
      sessionWorktree,
      gitHubPrsSupported,
      handleGoalSlashCommand,
      handleThemeChange,
      handleSetMode,
      handleLanguageChange,
      blockCommand,
      createSideTask,
      sideTasksAvailable,
      openEnvironmentTasksPanel,
      hiddenCommands,
      loadSidebarSession,
      pushToast,
      reportError,
      runVisibleRecap,
      runVisibleBtw,
      reconcileCatalogRename,
      requireActiveSessionForLocalCommand,
      resumeChatBottomFollow,
      selectedLanguage,
      setPendingModel,
      selectWelcomeModel,
      setPendingMode,
      setWorkspaceSetting,
      openVoiceModelPicker,
      writeVoiceModelForTarget,
      showContextUsage,
      t,
      workspaceActions,
      workspace.client,
      workspaceContextActive,
      effectiveSessionContext,
      updateFailedPrompt,
      updateUnknownPromptAdmission,
      isGoalGateBlocked,
    ],
  );

  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const handleEditorSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      commitComposerAccepted?: ComposerSubmitCommit,
      metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
    ) => {
      const accepted = handleSubmitRef.current(
        text,
        images,
        files,
        commitComposerAccepted,
        metadata,
      );
      if (accepted !== false) {
        resumeChatBottomFollow('smooth');
      }
      return accepted;
    },
    [resumeChatBottomFollow],
  );

  const handleConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) => {
      const owner = sessionOwnerGuard.capture();
      // Return the submission promise (and rethrow a rejection) so the
      // ToolApproval re-arm contract engages: its confirm() resets the
      // double-submit guard only when the returned promise rejects.
      // Swallowing the rejection here would leave submittedRef latched on a
      // transient daemon/WS failure, blocking every retry for this request.
      // Same shape as ChatPane.handleConfirm.
      return sessionActions
        .submitPermission(id, selectedOption, answers)
        .then(() => undefined)
        .catch((error: unknown) => {
          if (owner.isCurrent()) {
            reportError(error, 'Failed to submit permission choice');
          }
          throw error;
        });
    },
    [sessionActions, reportError, sessionOwnerGuard],
  );
  const handleAskUserConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) =>
      sessionActions.submitPermission(id, selectedOption, answers),
    [sessionActions],
  );

  const handleCancel = useCallback(() => {
    const owner = sessionOwnerGuard.capture();
    const dropped = queuedShellCommandsRef.current.length;
    queuedShellCommandsRef.current = [];
    drainGenerationRef.current++;
    isDrainingRef.current = false;
    shellSubmitInFlightRef.current = false;
    if (dropped > 0) {
      pushToast('warning', t('queue.shellDropped', { count: dropped }));
    }
    sessionActions.cancel().catch((error: unknown) => {
      if (!owner.isCurrent()) return;
      reportError(error, 'Failed to cancel request');
    });
  }, [sessionActions, reportError, pushToast, sessionOwnerGuard, t]);

  const handleFocusTaskPill = useCallback((): boolean => {
    if (interactionBlocked) return false;
    return statusBarRef.current?.focusTaskPill() ?? false;
  }, [interactionBlocked]);

  const handleReturnToEditor = useCallback((text?: string) => {
    if (text) {
      editorRef.current?.insertText(text);
      return;
    }
    editorRef.current?.focus();
  }, []);
  const discardUnknownPromptPayload = useCallback(() => {
    const current = unknownPromptAdmissionRef.current;
    if (
      !current?.payloadAvailable ||
      current.sessionId !== connectionRef.current.sessionId
    ) {
      return;
    }
    updateUnknownPromptAdmission({
      sessionId: current.sessionId,
      messageId: current.messageId,
      payloadAvailable: false,
    });
  }, [updateUnknownPromptAdmission]);
  const restoreUnknownPromptPayload = useCallback(() => {
    const current = unknownPromptAdmissionRef.current;
    const editor = editorRef.current;
    if (
      !current?.payloadAvailable ||
      current.sessionId !== connectionRef.current.sessionId ||
      !editor
    ) {
      return;
    }
    if (!window.confirm(t('queue.continueEditingConfirm'))) return;
    const draft = editor.getText();
    const restoredText = current.text?.trim()
      ? draft.trim()
        ? `${current.text}\n${draft}`
        : current.text
      : draft;
    if (restoredText !== draft) editor.setText(restoredText);
    if (current.images?.length) editor.restoreImages(current.images);
    if (current.files?.length) editor.restoreFiles(current.files);
    if (current.inputAnnotations?.length) {
      editor.restoreInputAnnotations?.(current.inputAnnotations);
    }
    editor.focus();
    updateUnknownPromptAdmission({
      sessionId: current.sessionId,
      messageId: current.messageId,
      payloadAvailable: false,
    });
  }, [t, updateUnknownPromptAdmission]);
  const handleCanScrollToBottomChange = useCallback(
    (canScrollToBottom: boolean) => {
      setCanScrollMessageListToBottom(canScrollToBottom);
    },
    [],
  );

  const handleRetry = useCallback(() => {
    if (sessionWriteBlockedRef.current || promptPreparationOwnerRef.current) {
      return;
    }
    if (
      showRetryHintRef.current &&
      connected &&
      streamingStateRef.current === 'idle' &&
      !sessionHasActivePromptRef.current &&
      retryableTurnErrorIdRef.current &&
      retryableTurnErrorIdentityRef.current &&
      connectionRef.current.sessionId &&
      (lastSubmittedPromptRef.current ||
        (lastSubmittedImagesRef.current?.length ?? 0) > 0 ||
        (lastSubmittedFilesRef.current?.length ?? 0) > 0)
    ) {
      const savedRetryErrorIdentity = retryableTurnErrorIdentityRef.current;
      const currentRetryError = getRetryableTurnError(
        store.getSnapshot().blocks,
      );
      if (
        !savedRetryErrorIdentity ||
        !currentRetryError ||
        !matchesTurnErrorIdentity(currentRetryError, savedRetryErrorIdentity)
      ) {
        lastSubmittedPromptRef.current = '';
        lastSubmittedImagesRef.current = undefined;
        lastSubmittedFilesRef.current = undefined;
        lastSubmittedInputAnnotationsRef.current = undefined;
        lastSubmittedSourceVersionRef.current = -1;
        retryableTurnErrorIdRef.current = null;
        retryableTurnErrorIdentityRef.current = undefined;
        retriedTurnErrorIdRef.current = null;
        setShowRetryHint(false);
        return;
      }
      const retryErrorId = currentRetryError.id;
      const retryErrorIdentity = { block: currentRetryError };
      const retrySessionId = connectionRef.current.sessionId;
      const retryText = lastSubmittedPromptRef.current;
      const retryImages = lastSubmittedImagesRef.current;
      const retryFiles = lastSubmittedFilesRef.current;
      const retryInputAnnotations = lastSubmittedInputAnnotationsRef.current;
      const previousRetriedTurnErrorId = retriedTurnErrorIdRef.current;
      const previousShowRetryHint = showRetryHintRef.current;
      const retryAttemptId = ++cancelledRetryAttemptRef.current;
      const retryOwner = retryOwnerRef.current;
      if (!retryOwnerIsCurrent(retryOwner)) {
        setShowRetryHint(false);
        return;
      }
      retriedTurnErrorIdRef.current = retryErrorId;
      setShowRetryHint(false);
      const retryTranscriptIdentity: FailedPromptRetry['transcriptIdentity'] = {
        kind: 'turn-error',
        identity: retryErrorIdentity,
      };
      const retryTranscriptIsCurrent = () =>
        retryTranscriptIdentityMatches(
          store.getSnapshot().blocks,
          retryTranscriptIdentity,
        );
      setFailedPromptRetry({
        sessionId: retrySessionId,
        messageId: retryErrorId,
        startedAt: Date.now(),
        admitted: false,
        settled: false,
        owner: retryOwner,
        transcriptIdentity: retryTranscriptIdentity,
      });
      let admissionStarted = false;
      let admitted = false;
      sendPrompt(retryText, retryImages, retryFiles, {
        optimisticUserMessage: false,
        retry: true,
        inputAnnotations: retryInputAnnotations,
        onAdmissionStarted: () => {
          admissionStarted = true;
        },
        onAdmitted: () => {
          admitted = true;
          if (!retryOwnerIsCurrent(retryOwner)) return;
          setFailedPromptRetry((current) =>
            current?.transcriptIdentity === retryTranscriptIdentity
              ? retryTranscriptIsCurrent()
                ? { ...current, admitted: true }
                : null
              : current,
          );
        },
        onCancelledBeforeAdmission: () => {
          restoreOrDeferCancelledRetry(retryOwner, {
            kind: 'turn-error',
            attemptId: retryAttemptId,
            errorId: retryErrorId,
            identity: retryErrorIdentity,
            text: retryText,
            images: retryImages,
            files: retryFiles,
            inputAnnotations: retryInputAnnotations,
            previousRetriedTurnErrorId,
            previousShowRetryHint,
          });
        },
      })
        .catch((error: unknown) => {
          if (!retryOwnerIsCurrent(retryOwner)) return;
          const definitelyRejected = isDefinitelyRejectedPromptAdmission(error);
          if (admissionStarted && !admitted && !definitelyRejected) {
            if (!retryTranscriptIsCurrent()) return;
            updateUnknownPromptAdmission({
              sessionId: retrySessionId,
              messageId: retryErrorId,
              text: retryText,
              images: retryImages ? [...retryImages] : undefined,
              files: retryFiles ? [...retryFiles] : undefined,
              inputAnnotations: retryInputAnnotations,
              payloadAvailable: true,
            });
            pushToast('warning', t('queue.admissionUnknown'));
            console.warn(
              '[WebShell] post-turn retry admission outcome is unknown',
              error,
            );
            return;
          }
          if (!admitted) {
            restoreOrDeferCancelledRetry(retryOwner, {
              kind: 'turn-error',
              attemptId: retryAttemptId,
              errorId: retryErrorId,
              identity: retryErrorIdentity,
              text: retryText,
              images: retryImages,
              files: retryFiles,
              inputAnnotations: retryInputAnnotations,
              previousRetriedTurnErrorId,
              previousShowRetryHint,
            });
          }
          if (isDaemonTurnError(error)) {
            // A loop-detected rejection ends the retry lineage: the
            // retried turn itself was stopped for loop protection, so
            // the stashed prompt must not be re-offered — resubmitting
            // it tends to re-loop.
            if (error.body !== 'LOOP_DETECTED') {
              failedTurnErrorRetryRef.current = {
                errorId: retryErrorId,
                text: retryText,
                images: retryImages,
                files: retryFiles,
                inputAnnotations: retryInputAnnotations,
                owner: retryOwner,
              };
            }
            const nextTurnError = getRetryableTurnError(
              store.getSnapshot().blocks,
            );
            if (
              nextTurnError &&
              nextTurnError.kind === 'error' &&
              isRetryableTurnErrorKind(nextTurnError.errorKind)
            ) {
              rearmFailedTurnErrorRetry(
                nextTurnError,
                store.getSnapshot().blocks,
              );
            }
          }
          if (retryTranscriptIsCurrent()) {
            reportError(error, 'Failed to retry prompt');
          }
        })
        .finally(() => {
          if (!retryOwnerIsCurrent(retryOwner)) return;
          setFailedPromptRetry((current) =>
            current?.transcriptIdentity === retryTranscriptIdentity
              ? retryTranscriptIsCurrent()
                ? { ...current, settled: true }
                : null
              : current,
          );
        });
    } else {
      store.dispatch([{ type: 'status', text: t('retry.none') }]);
    }
  }, [
    connected,
    pushToast,
    reportError,
    rearmFailedTurnErrorRetry,
    restoreOrDeferCancelledRetry,
    retryOwnerIsCurrent,
    sendPrompt,
    store,
    t,
    updateUnknownPromptAdmission,
  ]);

  useEffect(() => {
    const onGlobalShortcut = (e: KeyboardEvent) => {
      if (interactionBlocked || isWebTerminalTarget(e)) return;
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'l') {
          e.preventDefault();
          handleClearScreen();
          return;
        }
        if (e.key === 'o') {
          // The compact toggle is gone; keep Ctrl+O suppressed everywhere so
          // the key never falls through to the browser's Open File dialog.
          e.preventDefault();
          return;
        }
        if (e.key === 'y') {
          e.preventDefault();
          handleRetry();
          return;
        }
      }
    };
    window.addEventListener('keydown', onGlobalShortcut, true);
    return () => window.removeEventListener('keydown', onGlobalShortcut, true);
  }, [interactionBlocked, handleClearScreen, handleRetry, store, t]);

  const resetEscapeState = useCallback(() => {
    escArmedActionRef.current = null;
    setEscapeHintVisible(false);
    setCancelArmed(false);
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = null;
    }
  }, []);

  // The Esc handler reads live state, but its global keydown listener must mount
  // ONCE: streamingState flips among 'waiting'/'responding'/'thinking' mid-turn,
  // and if it were an effect dep each flip would tear the listener down and run
  // resetEscapeState(), wiping a half-armed two-press cancel. Read live values
  // through a ref so the listener stays put across re-renders.
  const escLiveRef = useRef({
    streamingState,
    sessionHasActivePrompt,
    pendingApproval,
    interactionBlocked,
    activePanel,
    closePanel,
    handleCancel,
    handleCycleMode,
    artifactPanelFullscreen,
  });
  escLiveRef.current = {
    streamingState,
    sessionHasActivePrompt,
    pendingApproval,
    interactionBlocked,
    activePanel,
    closePanel,
    handleCancel,
    handleCycleMode,
    artifactPanelFullscreen,
  };

  // Clear a half-armed two-press whenever the streaming/idle boundary flips — the
  // relevant action (cancel vs clear) changes with it, so a leftover arm is now
  // stale. Keyed on the boolean, so intra-turn sub-state flips don't reset it.
  const escStreamingBoundary =
    streamingState !== 'idle' || sessionHasActivePrompt;
  useEffect(() => {
    resetEscapeState();
  }, [escStreamingBoundary, resetEscapeState]);

  useEffect(() => {
    // Arm a two-press action: the first Esc shows the affordance and starts a
    // confirm window; a second Esc within it confirms, any other key resets it.
    const ESC_CANCEL_CONFIRM_WINDOW_MS = 2000;
    const ESC_CLEAR_CONFIRM_WINDOW_MS = 500;
    const armEscape = (action: 'cancel' | 'clear', windowMs: number) => {
      escArmedActionRef.current = action;
      if (action === 'cancel') setCancelArmed(true);
      else setEscapeHintVisible(true);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = setTimeout(resetEscapeState, windowMs);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // keyCode 229: WebKit marks IME-owned keys this way while isComposing
      // is still false; the IME owns them exactly like composing keys.
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.keyCode === 229 ||
        isWebTerminalTarget(e)
      )
        return;
      const live = escLiveRef.current;

      // The fullscreen right panel (artifacts/subagents) is the topmost
      // surface; Escape shrinks it back to its dock/drawer. Modals opened on
      // top are DialogShells, whose own handler stops Escape before this
      // listener, so this only fires when the panel itself is topmost.
      if (e.key === 'Escape' && live.artifactPanelFullscreen) {
        // Mirror the activePanel branch below: the sidebar search input
        // clears on Escape without stopping the event, so don't also shrink
        // the panel when Escape is being handled inside the sidebar.
        const target = e.target as HTMLElement | null;
        if (!target?.closest('[data-sidebar-shell]')) {
          e.preventDefault();
          setArtifactPanelFullscreen(false);
        }
        return;
      }

      // A full-view panel (Settings / Daemon Status) replaces the chat rather
      // than overlaying it; Escape returns to the chat. Any modal opened on top
      // of the panel is a DialogShell, whose own handler stops Escape from
      // reaching this window listener, so this only fires when the panel itself
      // is the topmost surface.
      if (e.key === 'Escape' && live.activePanel) {
        // The sidebar stays usable beside the panel and its search input clears
        // on Escape without stopping the event; don't also close the panel when
        // Escape is being handled inside the sidebar. Scope the panel close to
        // Escape originating outside the sidebar drawer.
        const target = e.target as HTMLElement | null;
        if (!target?.closest('[data-sidebar-shell]')) {
          e.preventDefault();
          live.closePanel();
        }
        return;
      }

      if (e.key !== 'Escape') {
        if (escArmedActionRef.current !== null) {
          resetEscapeState();
        }
        if (e.key === 'Tab' && e.shiftKey && !live.interactionBlocked) {
          e.preventDefault();
          live.handleCycleMode();
        }
        return;
      }

      // Streaming takes priority over clearing text (queued prompts stay intact
      // and drain after the turn settles); see decideEscapeIntent for the rules.
      const intent = decideEscapeIntent({
        blocked: !!live.pendingApproval || live.interactionBlocked,
        streaming:
          live.streamingState !== 'idle' || live.sessionHasActivePrompt,
        hasInput: !!editorRef.current?.hasInput(),
        armed: escArmedActionRef.current,
      });
      if (intent.kind === 'ignore') return;
      e.preventDefault();
      switch (intent.kind) {
        case 'cancel':
          live.handleCancel();
          resetEscapeState();
          break;
        case 'clear':
          editorRef.current?.clear();
          resetEscapeState();
          break;
        case 'arm':
          armEscape(
            intent.action,
            intent.action === 'cancel'
              ? ESC_CANCEL_CONFIRM_WINDOW_MS
              : ESC_CLEAR_CONFIRM_WINDOW_MS,
          );
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      resetEscapeState();
    };
  }, [resetEscapeState]);

  const standaloneInteractionBlocked = Boolean(
    standaloneCreationRecovery ||
      standaloneDirectoryErrorCode === 'working_directory_missing' ||
      standaloneDirectoryErrorCode === 'working_directory_compromised',
  );
  const isDisabled =
    sessionWriteBlocked ||
    standaloneInteractionBlocked ||
    shouldDisableComposerInput({
      pendingApproval: pendingApproval !== null,
      isPreparingPrompt,
    });
  const retryableTurnErrorIdentity = retryableTurnErrorIdentityRef.current;
  const showCurrentRetryHint = Boolean(
    showRetryHint &&
      !isPreparingPrompt &&
      !sessionHasActivePrompt &&
      retryableTurnErrorIdentity &&
      matchesTurnErrorIdentity(
        getRetryableTurnError(blocks),
        retryableTurnErrorIdentity,
      ) &&
      retryOwnerIsCurrent(retryOwnerRef.current),
  );
  const latestUserBlock = getLatestUserBlock(blocks);
  const visibleFailedPromptBlock =
    failedPrompt &&
    latestUserBlock &&
    matchesUserMessageIdentity(
      latestUserBlock,
      failedPrompt.identity,
      failedPrompt.owner.snapshot.isCurrent(),
    ) &&
    retryOwnerIsCurrent(failedPrompt.owner)
      ? latestUserBlock
      : undefined;
  const composerPlaceholderInputState = {
    isPreparingPrompt,
    isStreaming: streamingState !== 'idle',
  };
  const composerPlaceholderState = getComposerPlaceholderState(
    composerPlaceholderInputState,
  );
  const customComposerPlaceholder =
    composerPlaceholders?.[composerPlaceholderState];
  const composerPlaceholderText = customComposerPlaceholder?.trim()
    ? customComposerPlaceholder
    : t(getComposerPlaceholderKey(composerPlaceholderInputState));

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (sessionWriteBlocked) return;
      if (!connectionRef.current.sessionId) {
        selectWelcomeModel(modelId);
        return;
      }
      // Drive the shared busy flag so the model-management rows disable while a
      // selection is in flight — rapid Set current clicks would otherwise launch
      // concurrent setModel calls that can resolve out of order and leave a
      // model other than the user's last click active.
      const owner = sessionOwnerGuard.capture();
      const modelActionToken = ++modelActionTokenRef.current;
      setModelActionBusy(true);
      sessionActions
        .setModel(modelId)
        .then((result) => {
          if (!owner.isCurrent()) return;
          const summary = getModelSwitchSummary(result);
          setPendingModel(summary?.modelId ?? modelId);
          if (summary) {
            store.dispatch({
              type: 'debug',
              text: serializeModelSwitchSummary(summary, t),
              source: 'model_switch_summary',
              data: summary,
            });
          }
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          reportError(error, t('model.switch'));
        })
        .finally(() => {
          if (modelActionTokenRef.current === modelActionToken) {
            setModelActionBusy(false);
          }
        });
    },
    [
      sessionWriteBlocked,
      reportError,
      sessionActions,
      sessionOwnerGuard,
      setPendingModel,
      selectWelcomeModel,
      store,
      t,
    ],
  );

  const handleReasoningEffort = useCallback(
    (value: ReasoningSelection) => {
      if (sessionWriteBlocked || !connectionRef.current.sessionId) {
        return Promise.resolve();
      }
      return sessionActions
        .setReasoningEffort(value, {
          persist: connectionRef.current.sessionContext?.kind !== 'standalone',
        })
        .catch((error: unknown) =>
          reportError(error, t('reasoning.updateFailed')),
        );
    },
    [reportError, sessionActions, sessionWriteBlocked, t],
  );

  const handleWelcomeReasoningEffort = useCallback(
    (value: ReasoningSelection) => {
      const activeConnection = connectionRef.current;
      if (
        sessionWriteBlockedRef.current ||
        activeConnection.sessionId ||
        activeConnection.context
      ) {
        return;
      }
      const modelId = currentModelRef.current;
      const preview = activeConnection.models?.find(
        (model) => model.id === modelId,
      )?.reasoningPreview;
      if (!preview) return;
      if (value === 'none') {
        if (preview.canDisable === false) return;
        setPendingReasoningIntent({ modelId, value });
        return;
      }
      if (value === 'default') {
        setPendingReasoningIntent({ modelId, value });
        return;
      }
      if (!preview.efforts.includes(value)) return;
      setPendingReasoningIntent({ modelId, value });
    },
    [setPendingReasoningIntent],
  );

  const handleDeleteModel = useCallback(
    (target: { authType: string; modelId: string; baseUrl?: string }) => {
      const owner = sessionOwnerGuard.capture();
      const modelActionToken = ++modelActionTokenRef.current;
      setModelActionBusy(true);
      workspaceActions
        .deleteModel(target)
        .then((result) => {
          if (owner.isCurrent() && result?.runtimeSync?.status === 'failed') {
            store.dispatch([
              {
                type: 'status',
                text: t('settings.models.runtimeSyncFailed'),
              },
            ]);
          }
          // A scrubbed fallback requires a restart — surface it like the
          // settings panel does.
          if (owner.isCurrent() && result?.requiresRestart) {
            store.dispatch([
              { type: 'status', text: t('settings.requiresRestart') },
            ]);
          }
          // A transient reload failure shouldn't surface as "delete failed" —
          // the model was already removed. Just log it. Reload settings too so a
          // cleared active model / scrubbed fallback isn't shown stale.
          reloadProviders().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload providers after delete',
              err,
            );
          });
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload settings after delete',
              err,
            );
          });
        })
        .catch((error: unknown) => {
          if (!owner.isCurrent()) return;
          reportError(error, t('settings.models.deleteFailed'));
        })
        .finally(() => {
          if (modelActionTokenRef.current === modelActionToken) {
            setModelActionBusy(false);
          }
        });
    },
    // Depend on the stable `reload` fn, not the whole providersState object,
    // which useProviders returns fresh each render (would defeat the memo).
    [
      workspaceActions,
      reloadProviders,
      reloadWorkspaceSettings,
      reportError,
      sessionOwnerGuard,
      store,
      t,
    ],
  );

  const handleCloseAuthDialog = useCallback(() => {
    setShowAuthDialog(false);
    if (!workspaceContextActive) return;
    // The provider install flow doesn't broadcast a settings change, so refresh
    // the model list on close to surface any newly added models. Log a failed
    // reload (leaves stale model data) rather than swallowing it.
    reloadProviders().catch((err: unknown) => {
      console.warn(
        '[web-shell] failed to reload providers after auth dialog close',
        err,
      );
    });
  }, [reloadProviders, workspaceContextActive]);

  const handleFallbacksConfirm = useCallback(
    (baseIds: string[]) => {
      setShowFallbacksDialog(false);
      if (!workspaceContextActive) return;
      setWorkspaceSetting(
        modelSettingScope,
        'modelFallbacks',
        baseIds.join(','),
      )
        .then((result) => {
          // modelFallbacks requiresRestart — tell the user, like the settings
          // panel does for restart-required edits.
          if (result?.requiresRestart) {
            store.dispatch([
              { type: 'status', text: t('settings.requiresRestart') },
            ]);
          }
          // A reload failure shouldn't surface as "save failed" — the value
          // was already persisted. Just log it.
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload settings after fallbacks save',
              err,
            );
          });
        })
        .catch((error: unknown) =>
          reportError(error, t('settings.models.fallbacks.saveFailed')),
        );
    },
    [
      modelSettingScope,
      setWorkspaceSetting,
      reloadWorkspaceSettings,
      reportError,
      store,
      t,
      workspaceContextActive,
    ],
  );

  const handleFastModelSelect = useCallback(
    (modelId: string) => {
      if (!workspaceContextActive) return;
      if (
        streamingState !== 'idle' ||
        sessionHasActivePromptRef.current ||
        isGoalGateBlocked()
      ) {
        blockCommand();
        return;
      }
      // Model IDs from the picker arrive as bare model IDs (baseModelId), not
      // ACP format. The model picker strips the (authType) suffix before
      // calling this handler.
      //
      // Close the panel before sending: unlike the vision/voice pickers (silent
      // setWorkspaceSetting), `/model --fast` runs a real turn whose response
      // lands in the message list. With the panel open the chat is hidden, so
      // that response would pile up behind it and surprise the user on close.
      // Closing first returns them to the chat to see it in context (matching
      // the pre-panel modal behavior).
      closePanel();
      // Persist to the scope the picker was opened for (matching the silent
      // vision/voice pickers). `/model` parses --global/--project as the persist
      // scope; without a flag the command would default to its own scope logic
      // and ignore the user's User-vs-Workspace choice.
      const scopeFlag =
        modelSettingScope === 'user' ? ' --global' : ' --project';
      const owner = { current: sessionOwnerGuard.capture() };
      sendPrompt(`/model --fast ${modelId}${scopeFlag}`, undefined, undefined, {
        ownerRef: owner,
      })
        .then(() => {
          if (!owner.current.isCurrent()) return;
          // sendPrompt resolves only after the `/model --fast` turn *completes*
          // (actions.ts → waitForAcceptedPromptCompletion), so the change is
          // already applied here — this reload reads the new value, not a stale
          // one. It keeps the workspace-settings state fresh for the next time
          // Settings is opened (the command path, unlike setWorkspaceSetting,
          // doesn't bump the settingsVersion signal). Guard its own rejection —
          // the .catch below only covers sendPrompt — and log it so a failed
          // reload (leaving stale settings on next open) leaves a trace.
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload workspace settings after fast-model switch',
              err,
            );
          });
        })
        .catch((error: unknown) => {
          if (!owner.current.isCurrent()) return;
          reportError(error, 'Failed to switch fast model');
        });
    },
    [
      blockCommand,
      closePanel,
      sendPrompt,
      streamingState,
      reportError,
      reloadWorkspaceSettings,
      modelSettingScope,
      sessionOwnerGuard,
      isGoalGateBlocked,
      workspaceContextActive,
    ],
  );

  const handleVoiceModelSelect = useCallback(
    (modelId: string) => {
      // Model IDs from the voice picker arrive as bare model IDs (baseModelId),
      // not ACP format. extractVoiceModels() sets id to the baseModelId.
      const bareModelId = extractBareModelId(modelId);
      const target = voicePickerTargetRef.current;
      if (!target || target.ownerKey !== mainVoiceTargetRef.current?.ownerKey) {
        reportError(
          new Error(
            'The Voice workspace changed before the selection applied.',
          ),
          t('model.setVoice'),
        );
        return;
      }
      void writeVoiceModelForTarget(
        bareModelId,
        modelSettingScope,
        target,
      ).catch((error: unknown) => reportError(error, t('model.setVoice')));
    },
    [modelSettingScope, reportError, t, writeVoiceModelForTarget],
  );

  const handleVisionModelSelect = useCallback(
    (modelId: string) => {
      if (!workspaceContextActive) return;
      // Model IDs from the picker arrive in ACP format: `modelId(authType)`.
      // Core's resolveVisionModelSelection() expects `authType:modelId`.
      const encoded = encodeVisionModelForSetting(modelId);
      setWorkspaceSetting(modelSettingScope, 'visionModel', encoded).catch(
        (error: unknown) => reportError(error, t('model.setVision')),
      );
    },
    [
      modelSettingScope,
      reportError,
      setWorkspaceSetting,
      t,
      workspaceContextActive,
    ],
  );

  const modelHandlers: Record<ModelDialogMode, (id: string) => void> = {
    main: handleModelSelect,
    fast: handleFastModelSelect,
    voice: handleVoiceModelSelect,
    vision: handleVisionModelSelect,
  };

  // Once every settings-launched model surface is closed (the model picker via
  // modelDialogMode, the fallbacks dialog, or the Add Model / auth dialog),
  // reset the persist scope so a later command-launched picker defaults back
  // to workspace.
  useEffect(() => {
    if (!modelDialogMode && !showFallbacksDialog && !showAuthDialog) {
      setModelSettingScope('workspace');
    }
  }, [modelDialogMode, showFallbacksDialog, showAuthDialog]);

  const useWorkspaceSkillSnapshot =
    workspaceContextActive &&
    loadedSkillsReady &&
    (!connection.sessionId ||
      connection.skills === undefined ||
      (loadedSkillsFallback?.sessionId === connection.sessionId &&
        loadedSkillsFallback.workspaceCwd === connection.workspaceCwd));
  const composerSkills = useMemo(() => {
    if (!workspaceContextActive) {
      return pendingSessionContext === undefined && connection.sessionId
        ? availableSessionSkillInfos(
            connection.skills ?? [],
            connection.commands ?? [],
          )
        : [];
    }
    return useWorkspaceSkillSnapshot
      ? loadedSkills
      : availableSessionSkillInfos(
          connection.skills ?? [],
          connection.commands ?? [],
        );
  }, [
    connection.commands,
    connection.sessionId,
    connection.skills,
    loadedSkills,
    pendingSessionContext,
    useWorkspaceSkillSnapshot,
    workspaceContextActive,
  ]);
  const commands = useMemo(() => {
    const previousSkillNames = new Set(
      (connection.skills ?? []).map((skill) => skill.toLowerCase()),
    );
    const connectionCommands =
      !workspaceContextActive &&
      (pendingSessionContext !== undefined || !connection.sessionId)
        ? []
        : (connection.commands ?? []);
    const retainedCommands = useWorkspaceSkillSnapshot
      ? connectionCommands.filter(
          (command) =>
            command.source !== 'skill' &&
            !previousSkillNames.has(command.name.toLowerCase()),
        )
      : connectionCommands;
    const refreshedSkillCommands = useWorkspaceSkillSnapshot
      ? loadedSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
          source: 'skill',
          displayCategory: 'skill' as const,
        }))
      : [];
    return localizeBuiltinDescriptions(
      mergeCommands(
        retainedCommands,
        refreshedSkillCommands,
        getLocalCommands(t, { sideTaskAvailable: sideTasksAvailable }),
        [...additionalSlashCommands],
      ),
      t,
    )
      .filter(
        (command) =>
          workspaceContextActive ||
          !NON_WORKSPACE_BLOCKED_COMMANDS.has(command.name.toLowerCase()),
      )
      .filter(
        (command) => !hiddenCommands.has(normalizeHiddenCommand(command.name)),
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
    additionalSlashCommands,
    connection.commands,
    connection.sessionId,
    connection.skills,
    hiddenCommands,
    loadedSkills,
    pendingSessionContext,
    sideTasksAvailable,
    t,
    useWorkspaceSkillSnapshot,
    workspaceContextActive,
  ]);

  const welcomeHeaderProps = useMemo(
    () => ({
      version: connection.capabilities?.qwenCodeVersion || '',
      cwd: workspaceContextActive ? connection.workspaceCwd || '' : '',
      currentModel,
      currentMode,
      hideTips: hideTipsSetting?.values.effective === true,
    }),
    [
      connection.capabilities?.qwenCodeVersion,
      connection.workspaceCwd,
      currentModel,
      currentMode,
      hideTipsSetting?.values.effective,
      workspaceContextActive,
    ],
  );

  const welcomeHeader = useMemo(
    () => (
      <>
        {renderWelcomeHeader ? (
          renderWelcomeHeader(welcomeHeaderProps)
        ) : (
          <WelcomeHeader {...welcomeHeaderProps} />
        )}
      </>
    ),
    [renderWelcomeHeader, welcomeHeaderProps],
  );
  const welcomeFooter = useMemo(
    () => renderWelcomeFooter?.(welcomeHeaderProps),
    [renderWelcomeFooter, welcomeHeaderProps],
  );
  const isChatEmptyState =
    !connection.sessionId &&
    displayMessages.length === 0 &&
    !showFloatingTodos &&
    !pendingApproval &&
    !btwMessage;
  const visibleComposerToolbarActions = useMemo<
    readonly ComposerToolbarAction[]
  >(() => {
    if (composerToolbarActions) return composerToolbarActions;
    const defaults =
      isChatEmptyState || !environmentGitReplacementEnabled
        ? DEFAULT_EMPTY_COMPOSER_TOOLBAR_ACTIONS
        : DEFAULT_COMPOSER_TOOLBAR_ACTIONS;
    return composerToolbarAdditionalActions?.length
      ? [...defaults, ...composerToolbarAdditionalActions]
      : defaults;
  }, [
    composerToolbarActions,
    composerToolbarAdditionalActions,
    environmentGitReplacementEnabled,
    isChatEmptyState,
  ]);
  const useMobileWelcomeMiddleLayout =
    isChatEmptyState && mobileWelcomeFooterMiddle;
  const showMobileWelcomeFooterMiddle =
    useMobileWelcomeMiddleLayout && Boolean(welcomeFooter);
  const hasWelcomeMiddle = isChatEmptyState && showMobileWelcomeFooterMiddle;
  const hasMobileComposerBottom =
    isChatEmptyState && useMobileWelcomeMiddleLayout;
  const missingSession =
    connection.status !== 'connecting' &&
    !connection.sessionId &&
    connection.missingSession === true;
  const showMissingSessionState =
    missingSession && !activePanel && mainView === 'chat';
  const effectiveChatWidthMode: ChatWidthMode = isChatEmptyState
    ? getDefaultChatWidthMode()
    : chatWidthMode;
  const activeGitBranch = sessionWorktree
    ? (selectedWorkspaceGitStatus?.branch ?? sessionWorktree.branch)
    : sessionBranch
      ? (selectedWorkspaceGitStatus?.branch ?? sessionBranch.name)
      : connection.sessionId
        ? connection.gitBranch
        : (selectedWorkspaceGitStatus?.branch ?? undefined);
  const environmentPanelCanDock =
    contextBodyWidth === null ||
    contextBodyWidth >=
      MIN_DOCKED_MESSAGE_AREA_WIDTH + DOCKED_ENVIRONMENT_PANEL_WIDTH;
  const environmentPanelFits =
    chatWidthMode !== 'wide' && environmentPanelCanDock;
  const environmentPanelVisible =
    environmentPanelOpen &&
    !isChatEmptyState &&
    !activePanel &&
    mainView === 'chat';
  const handleEnvironmentPanelOpenChange = useCallback((open: boolean) => {
    if (!open) {
      preserveEnvironmentPanelOnArtifactOpenRef.current = false;
      setEnvironmentPanelOpen(false);
      return;
    }
    setEnvironmentPanelOpen(true);
  }, []);
  const dismissEnvironmentPanel = useCallback(() => {
    preserveEnvironmentPanelOnArtifactOpenRef.current = false;
    setEnvironmentPanelOpen(false);
  }, []);
  const handleRightPanelOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setArtifactPanelOpen(true);
      } else {
        closeArtifactPanel();
      }
    },
    [closeArtifactPanel],
  );
  useLayoutEffect(() => {
    const body = contextBodyRef.current;
    if (!body) return;
    const updateWidth = () => {
      const availableWidth = body.getBoundingClientRect().width;
      if (availableWidth <= 0) return;
      setContextBodyWidth((current) =>
        current === availableWidth ? current : availableWidth,
      );
    };
    const handleWindowResize = () => {
      preserveEnvironmentPanelOnArtifactOpenRef.current = false;
      updateWidth();
    };
    updateWidth();
    window.addEventListener('resize', handleWindowResize);
    const observer = new ResizeObserver(updateWidth);
    observer.observe(body);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
      observer.disconnect();
    };
  }, []);
  const previousEnvironmentCanDockRef = useRef(environmentPanelCanDock);
  useLayoutEffect(() => {
    const crossedDockBreakpoint =
      previousEnvironmentCanDockRef.current && !environmentPanelCanDock;
    previousEnvironmentCanDockRef.current = environmentPanelCanDock;
    if (
      crossedDockBreakpoint &&
      !preserveEnvironmentPanelOnArtifactOpenRef.current
    ) {
      setEnvironmentPanelOpen(false);
    }
  }, [environmentPanelCanDock]);
  const previousArtifactPanelOpenForEnvironmentRef = useRef(artifactPanelOpen);
  useLayoutEffect(() => {
    const artifactPanelJustOpened =
      !previousArtifactPanelOpenForEnvironmentRef.current && artifactPanelOpen;
    previousArtifactPanelOpenForEnvironmentRef.current = artifactPanelOpen;
    if (!artifactPanelOpen) {
      preserveEnvironmentPanelOnArtifactOpenRef.current = false;
      return;
    }
    if (!artifactPanelJustOpened) return;
    const preserveEnvironmentPanel =
      preserveEnvironmentPanelOnArtifactOpenRef.current;
    if (!preserveEnvironmentPanel && !environmentPanelFits) {
      setEnvironmentPanelOpen(false);
    }
  }, [artifactPanelOpen, environmentPanelFits]);
  const environmentPanelMounted =
    !isChatEmptyState && !activePanel && mainView === 'chat';
  const chatWidthToggleMin = getChatMaxWidth(chatMaxWidth);

  const appClassName = [
    styles.app,
    styles.appChat,
    isChatEmptyState ? styles.appChatEmpty : undefined,
    sidebarOptions.enabled ? styles.appWithSidebar : undefined,
    selectedTheme === WebShellThemeId.Light
      ? styles.themeLight
      : styles.themeDark,
    selectedTheme === WebShellThemeId.Dark ? 'dark' : undefined,
    externalClassName,
  ]
    .filter(Boolean)
    .join(' ');
  const appStyle = useMemo(
    () => ({
      ...externalStyle,
      ...getChatWidthStyle(effectiveChatWidthMode, chatMaxWidth),
    }),
    [chatMaxWidth, effectiveChatWidthMode, externalStyle],
  );
  const handleChatWidthModeChange = useCallback((mode: ChatWidthMode) => {
    setChatWidthMode(mode);
    writeChatWidthMode(mode);
  }, []);

  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;

    const previousRect = previousFooterRectRef.current;
    const wasEmpty = previousEmptyStateRef.current;
    const nextRect = footer.getBoundingClientRect();

    if (wasEmpty && !isChatEmptyState && previousRect) {
      const offsetY = previousRect.top - nextRect.top;
      if (Math.abs(offsetY) > 1) {
        footer.style.transition = 'width 320ms ease';
        footer.style.transform = `translateY(${offsetY}px)`;
        requestAnimationFrame(() => {
          footer.style.transition = 'width 320ms ease, transform 280ms ease';
          footer.style.transform = '';
        });
        window.setTimeout(() => {
          footer.style.transition = '';
        }, 320);
      }
    }

    previousFooterRectRef.current = nextRect;
    previousEmptyStateRef.current = isChatEmptyState;
  }, [isChatEmptyState]);

  useLayoutEffect(() => {
    const host = shadowDomOptions.portals
      ? document.createElement('div')
      : null;
    const shadowRoot = host?.attachShadow({ mode: 'open' }) ?? null;
    const root = document.createElement('div');
    root.dataset.webShellPortalRoot = '';
    root.dataset.webShellShadcn = '';
    if (host && shadowRoot) {
      host.dataset.webShellShadowHost = 'portals';
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('inset', '0', 'important');
      host.style.setProperty('width', '0', 'important');
      host.style.setProperty('height', '0', 'important');
      host.style.setProperty(
        'z-index',
        'var(--web-shell-portal-root-z-index, 1000)',
        'important',
      );
      const removeStyles = installWebShellShadowStyles(
        shadowRoot,
        shadowDomOptions.styles,
      );
      shadowRoot.appendChild(root);
      document.body.appendChild(host);
      setPortalRoot(root);
      return () => {
        host.remove();
        removeStyles();
        setPortalRoot(null);
      };
    } else {
      document.body.appendChild(root);
      setPortalRoot(root);
      return () => {
        root.remove();
        setPortalRoot(null);
      };
    }
  }, [shadowDomOptions.portals, shadowDomOptions.styles]);

  useLayoutEffect(() => {
    const root = appRootRef.current;
    if (!root || !portalRoot) return;
    const portalRootNode = portalRoot.getRootNode();
    const portalHost =
      portalRootNode instanceof ShadowRoot
        ? (portalRootNode.host as HTMLElement)
        : null;
    let frameId: number | null = null;
    const syncVariables = () => {
      frameId = null;
      const computedStyle = getComputedStyle(root);
      const nextNames = new Set<string>();
      portalRoot.dataset.webShellShadcn = '';
      portalRoot.classList.toggle(
        'dark',
        selectedTheme === WebShellThemeId.Dark,
      );
      portalRoot.lang = selectedLanguage;
      for (let index = 0; index < computedStyle.length; index += 1) {
        const name = computedStyle[index];
        if (!name.startsWith('--')) continue;
        nextNames.add(name);
        const value = computedStyle.getPropertyValue(name);
        portalRoot.style.setProperty(name, value);
        portalHost?.style.setProperty(name, value);
      }
      for (const name of portalRootVariableNamesRef.current) {
        if (!nextNames.has(name)) {
          portalRoot.style.removeProperty(name);
          portalHost?.style.removeProperty(name);
        }
      }
      portalRootVariableNamesRef.current = nextNames;
    };
    const scheduleSync = () => {
      if (frameId === null) frameId = requestAnimationFrame(syncVariables);
    };
    syncVariables();
    const observer = new MutationObserver(scheduleSync);
    let element: HTMLElement | null = root;
    while (element) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'lang'],
      });
      element = element.parentElement;
    }
    window.addEventListener('resize', scheduleSync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleSync);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [appClassName, appStyle, portalRoot, selectedLanguage, selectedTheme]);

  // Shared by the drawer and docked render sites below; only the genuine
  // per-variant props (variant / panelWidth) stay at each site.
  const artifactPanelSharedProps = {
    artifacts: artifactPanelArtifacts,
    tabs: artifactPanelTabs,
    activeTabId: activeArtifactPanelTabId,
    reviewChanges,
    selectedReviewPath,
    workspaceCwd: connection.workspaceCwd || '',
    loading: artifactsLoading,
    error: artifactsError,
    onSelectTab: setActiveArtifactPanelTabId,
    onCloseTab: closeArtifactPanelTab,
    onOpenFilePreview: openFilePreview,
    latestReviewAvailable: latestReviewChanges.length > 0,
    onOpenLatestReview: openLatestReviewPanel,
    items: rightPanelItems,
    sideTaskAvailable: sideTasksAvailable,
    sideTasks: visibleSideTasks,
    sideTasksLoading,
    onCreateSideTask: createEmptySideTask,
    onOpenSideTask: openSideTask,
    onCreateSideTaskSession: createSideTaskSession,
    onSideTaskCreated: handleSideTaskCreated,
    onSideTaskTitleChange: handleSideTaskTitleChange,
    onNestedRightPanelOpen: handleTurnOutputOpen,
    onNestedArtifactsChange: handlePaneArtifactsChange,
    onError: reportError,
    sessionWorkflowEnabled,
    workflow: sessionWorkflowEnabled
      ? {
          todos: sessionWorkflowTodos,
          tools: planAgentTools,
          tasks: environmentAgentTasks,
          artifacts,
          selectedTodoId: selectedWorkflowTodoId,
          onSelectedTodoIdChange: setSelectedWorkflowTodoId,
          onExpandGraph: expandWorkflowGraph,
          onOpenSubagent: openSubagentPanel,
          onOpenArtifact: openArtifactPanel,
          canvasMode: mainView === 'cockpit',
        }
      : undefined,
    onImageIngestionNotice: pushToast,
    deferSubagentMount,
    onClose: closeArtifactPanel,
    fullscreen: artifactPanelFullscreen,
    onToggleFullscreen: toggleArtifactPanelFullscreen,
  };

  return (
    <ThemeProvider value={selectedTheme}>
      <I18nProvider language={selectedLanguage}>
        <McpAppHostContext.Provider value={workspace.baseUrl}>
          {/* prettier-ignore */}
          <WebShellPortalRootContext.Provider value={portalRoot}>
          {/* Compact view is fixed on for every message surface (main chat,
              split panes, subagent detail, drawer) — no toggle remains. */}
          <CompactModeContext.Provider value={true}>
        <div
          ref={appRootRef}
          className={appClassName}
          style={appStyle}
          data-web-shell-root
          data-web-shell-shadcn
          lang={selectedLanguage}
        >
          {!onToast && (
            <ToastHost
              toasts={toasts}
              onDismiss={dismissToast}
              elevated={artifactPanelFullscreen}
            />
          )}
          {workspaceContextActive && showResumeDialog && (
            <DialogShell
              title={t('resume.title')}
              size="lg"
              onClose={() => setShowResumeDialog(false)}
            >
              <ResumeDialog
                workspaceCwd={lockedWorkspaceCwd}
                onSelect={(sessionId) => {
                  loadSidebarSession(sessionId).catch((error: unknown) => {
                    reportError(error, 'Failed to load session');
                  });
                }}
                onClose={() => setShowResumeDialog(false)}
              />
            </DialogShell>
          )}
          {modelDialogMode &&
            (workspaceContextActive || modelDialogMode === 'main') && (
            <DialogShell
              title={t(MODE_TITLE_KEY[modelDialogMode])}
              size="lg"
              onClose={() => setModelDialogMode(null)}
            >
              <ModelDialog
                mode={modelDialogMode}
                models={modelDialogMode === 'voice' ? voiceModels : undefined}
                filterModel={
                  modelDialogMode === 'main' ? mainModelFilter : undefined
                }
                currentModelId={
                  modelDialogMode === 'voice'
                    ? currentVoiceModel
                    : modelDialogMode === 'vision'
                      ? currentVisionModel
                      : modelDialogMode === 'fast'
                        ? currentFastModel
                        : undefined
                }
                onSelect={(modelId) => {
                  if (modelDialogMode) {
                    modelHandlers[modelDialogMode](modelId);
                  }
                  setModelDialogMode(null);
                }}
              />
            </DialogShell>
          )}
          {showApprovalModeDialog && (
            <DialogShell
              title={t('mode.select')}
              size="sm"
              onClose={() => setShowApprovalModeDialog(false)}
            >
              <ApprovalModeDialog
                currentMode={currentMode}
                sessionWorkflowEnabled={sessionWorkflowEnabled}
                onSelect={(modeId) => {
                  handleSetMode(modeId);
                  setShowApprovalModeDialog(false);
                }}
              />
            </DialogShell>
          )}
          {showToolsDialog && (
            <DialogShell
              title={t('tools.title')}
              size="lg"
              onClose={() => setShowToolsDialog(false)}
            >
              <ToolsDialog />
            </DialogShell>
          )}
          {workspaceContextActive && gitDialog && (
            <GitDialog
              key={`${gitDialog.workspaceCwd}:${gitDialog.gitCwd ?? ''}:${gitDialog.view}`}
              workspaceCwd={gitDialog.workspaceCwd}
              gitCwd={gitDialog.gitCwd}
              initialView={gitDialog.view}
              sessionId={connection.sessionId}
              resolveSessionForWorkspace={resolveSessionForWorkspace}
              onClose={() => setGitDialog(undefined)}
            />
          )}
          {tasksDialogMessage && (
            <DialogShell
              title={
                sessionWorkflowEnabled && floatingTodos.length > 0
                  ? t('planExecution.dialogTitle')
                  : t('tasks.title')
              }
              size="auto"
              onClose={() => setTasksDialogMessage(null)}
            >
              <TasksStatusMessage
                message={tasksDialogMessage}
                embedded
                manageActiveEvent={false}
                includeWorkflows={workflowsEnabled}
                onClose={() => setTasksDialogMessage(null)}
                planTodos={sessionWorkflowEnabled ? floatingTodos : []}
                agentTools={
                  sessionWorkflowEnabled ? tasksDialogAgentTools : []
                }
                onOpenSubagent={(tool) => {
                  setTasksDialogMessage(null);
                  openSubagentPanel(tool);
                }}
                onOpenMonitor={handleOpenMonitorDetails}
              />
            </DialogShell>
          )}
          {workspaceContextActive && showMemoryDialog && (
            <DialogShell
              title={t('memory.menu')}
              size="lg"
              onClose={() => setShowMemoryDialog(false)}
            >
              <MemoryMessage
                refreshSignal={memoryRefreshSignal}
                addSignal={memoryAddSignal}
                addScope={memoryAddScope}
                onMessage={(text, type = 'status') => {
                  store.dispatch([{ type, text }]);
                }}
              />
            </DialogShell>
          )}
          {showHelpDialog && (
            <DialogShell
              title={t('help.title')}
              size="md"
              onClose={() => setShowHelpDialog(false)}
            >
              <HelpDialog commands={commands} />
            </DialogShell>
          )}
          {showThemeDialog && (
            <DialogShell
              title={t('theme.title')}
              size="sm"
              onClose={() => setShowThemeDialog(false)}
            >
              <ThemeDialog
                currentTheme={selectedTheme}
                onSelect={handleThemeChange}
                onClose={() => setShowThemeDialog(false)}
              />
            </DialogShell>
          )}
          {goalEditOpen && goalSnapshot?.goal && (
            <GoalEditDialog
              objective={goalSnapshot.goal.objective}
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
          {showAuthDialog && (
            <DialogShell
              title={t('auth.title')}
              size="lg"
              onClose={handleCloseAuthDialog}
            >
              <AuthMessage
                onMessage={(text, type = 'status') => {
                  store.dispatch([
                    type === 'error'
                      ? { type: 'error', text }
                      : { type: 'status', text },
                  ]);
                }}
                onClose={handleCloseAuthDialog}
              />
            </DialogShell>
          )}
          {workspaceContextActive && showFallbacksDialog && (
            <DialogShell
              title={t('settings.models.fallbacks.title')}
              size="md"
              onClose={() => setShowFallbacksDialog(false)}
            >
              <ModelFallbacksDialog
                models={fallbackModelOptions}
                current={currentModelFallbacks}
                max={3}
                onConfirm={handleFallbacksConfirm}
                onClose={() => setShowFallbacksDialog(false)}
              />
            </DialogShell>
          )}
          {workspaceContextActive && showDeleteDialog && (
            <DialogShell
              title={t('delete.title')}
              size="lg"
              onClose={() => setShowDeleteDialog(false)}
            >
              <DeleteSessionDialog
                workspaceCwd={lockedWorkspaceCwd}
                onDeleted={(sessionIds) => {
                  closeTokenUsageTabs(sessionIds);
                  store.dispatch([
                    {
                      type: 'status',
                      text:
                        sessionIds.length === 1
                          ? `${t('delete.deleted')} (${sessionIds[0]!.slice(0, 8)})`
                          : t('delete.deletedCount', {
                              count: sessionIds.length,
                            }),
                    },
                  ]);
                }}
                onError={(error) => {
                  if (isAlreadyDispatched(error)) return;
                  const reason =
                    error instanceof Error ? error.message : String(error);
                  pushToast('error', t('delete.failed', { reason }));
                }}
                onClose={() => setShowDeleteDialog(false)}
              />
            </DialogShell>
          )}
          {workspaceContextActive && showReleaseDialog && (
            <DialogShell
              title={t('release.title')}
              size="lg"
              onClose={() => setShowReleaseDialog(false)}
            >
              <ReleaseSessionDialog
                workspaceCwd={lockedWorkspaceCwd}
                onReleased={(sessionId) => {
                  store.dispatch([
                    {
                      type: 'status',
                      text: `${t('release.released')} (${sessionId.slice(0, 8)})`,
                    },
                  ]);
                }}
                onError={(error) => {
                  if (isAlreadyDispatched(error)) return;
                  const reason =
                    error instanceof Error ? error.message : String(error);
                  pushToast('error', t('release.failed', { reason }));
                }}
                onClose={() => setShowReleaseDialog(false)}
              />
            </DialogShell>
          )}
          {showRewindDialog && (
            <DialogShell
              title={t('rewind.title')}
              subtitle={t('rewind.subtitle')}
              size="lg"
              onClose={() => setShowRewindDialog(false)}
            >
              <RewindDialog
                blocks={blocks}
                loadSnapshots={loadRewindSnapshots}
                rewind={rewindConversationOnly}
                onError={handleRewindError}
                onClose={() => setShowRewindDialog(false)}
              />
            </DialogShell>
          )}
          {workspaceContextActive &&
            !lockedWorkspaceCwd &&
            showAddWorkspaceDialog && (
            <AddWorkspaceDialog
              onClose={() => setShowAddWorkspaceDialog(false)}
              onAdd={handleAddWorkspace}
              onSuggest={workspaceActions.suggestWorkspacePaths}
              onPick={
                nativeDirectoryPickerSupported
                  ? async () => {
                      const result =
                        await workspaceActions.pickWorkspaceDirectory();
                      return result.selected ? result.path : undefined;
                    }
                  : undefined
              }
              persistenceSupported={
                persistentWorkspaceRegistrationSupported
              }
              displayNameEnabled={workspaceDisplayNameSupported}
            />
          )}
          {scratchOutcomeUnknown !== 'clear' && (
            <DialogShell
              title={t('sidebar.scratchOutcomeUnknownTitle')}
              size="md"
              dismissible={false}
              onClose={() => undefined}
            >
              <div className="flex flex-col gap-4">
                <p>{t('sidebar.scratchOutcomeUnknown')}</p>
                <ul className="max-h-48 overflow-y-auto text-sm text-muted-foreground">
                  {ordinaryWorkspaces.map((entry) => (
                    <li key={entry.id}>{entry.cwd}</li>
                  ))}
                </ul>
                <div className="flex justify-end">
                  {scratchOutcomeUnknown === 'refreshing' ? (
                    <Button
                      type="button"
                      onClick={() => void refreshScratchOutcome()}
                    >
                      {t('sidebar.scratchOutcomeRefresh')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onClick={() => setScratchOutcome('clear')}
                    >
                      {t('sidebar.scratchOutcomeAcknowledge')}
                    </Button>
                  )}
                </div>
              </div>
            </DialogShell>
          )}

          <div className={styles.appShell}>
            {sidebarOptions.enabled && (
              <div
                data-sidebar-shell=""
                {...(mobileDrawerOpen
                  ? { role: 'dialog', 'aria-modal': 'true' as const }
                  : {})}
                aria-label={t('sidebar.label')}
                aria-hidden={artifactPanelFullscreen || undefined}
                className={[
                  styles.mobileDrawer,
                  mobileDrawerOpen ? styles.mobileDrawerOpen : undefined,
                  forceMobileDrawer ? styles.mobileDrawerForced : undefined,
                  artifactPanelFullscreen ? styles.chatViewHidden : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div
                  className={styles.mobileBackdrop}
                  onClick={closeMobileDrawer}
                  aria-hidden="true"
                />
                <WebShellSidebar
                  collapsed={
                    (sidebarCollapsed ||
                      (mainView === 'split' && !splitSidebarHasRoom)) &&
                    !mobileDrawerOpen
                  }
                  onCollapsedChange={handleSidebarCollapsedChange}
                  onOpenSettings={() => {
                    closeMobileDrawer();
                    openPanel('settings');
                  }}
                  onOpenPlugins={() => {
                    closeMobileDrawer();
                    openPanel('plugins');
                  }}
                  onOpenChannels={() => {
                    closeMobileDrawer();
                    openPanel('channels');
                  }}
                  onOpenDaemonStatus={() => {
                    closeMobileDrawer();
                    openPanel('status');
                  }}
                  onOpenScheduledTasks={() => {
                    closeMobileDrawer();
                    openScheduledTasks();
                  }}
                  onOpenWorkflows={() => {
                    closeMobileDrawer();
                    openWorkflows();
                  }}
                  onOpenGoals={() => {
                    closeMobileDrawer();
                    openGoals();
                  }}
                  onOpenSessions={() => {
                    closeMobileDrawer();
                    openPanel('sessions');
                  }}
                  canOpenSessionsOverview={workspaceContextActive}
                  onOpenSplitView={() => {
                    closeMobileDrawer();
                    openSplitView();
                  }}
                  canOpenSplitView={isLargeScreen && workspaceContextActive}
                  theme={selectedTheme}
                  onThemeChange={(theme) => {
                    handleThemeChange(theme);
                    if (workspaceContextActive) {
                      void setWorkspaceSetting(
                        'workspace',
                        THEME_SETTING_KEY,
                        webShellThemeToSettingValue(theme),
                      );
                    }
                  }}
                  onNewSession={(workspaceCwd) =>
                    createNewSession(
                      typeof workspaceCwd === 'string'
                        ? { kind: 'workspace', cwd: workspaceCwd }
                        : { kind: 'global' },
                    )
                  }
                  globalNewSessionUsesStandalone={
                    standaloneSessionsSupported && !lockedWorkspaceCwd
                  }
                  onLoadSession={(sessionId, workspaceCwd) => {
                    showChat();
                    return loadSidebarSession(sessionId, workspaceCwd);
                  }}
                  onLoadStandaloneSession={(sessionId) => {
                    setMainView('chat');
                    return loadSidebarSession(
                      sessionId,
                      undefined,
                      { kind: 'standalone' },
                    );
                  }}
                  onStandaloneNotice={(message) =>
                    pushToast('info', message)
                  }
                  projectFeaturesEnabled={workspaceContextActive}
                  onSelectCurrentSession={() => {
                    closeMobileDrawer();
                    splitFoldedByShrinkRef.current = false;
                    showChat();
                    closePanel();
                  }}
                  onSessionRenameConfirmed={reconcileCatalogRename}
                  onSessionsDeleted={closeTokenUsageTabs}
                  onError={reportError}
                  mobileOpen={mobileDrawerOpen}
                  onMobileClose={closeMobileDrawer}
                  selectedWorkspaceCwd={selectedWorkspaceCwd}
                  onSelectWorkspace={(workspaceCwd) => {
                    splitClassificationGenerationRef.current += 1;
                    const targetWorkspaceCwd =
                      workspaceCwd ??
                      workspacesRef.current.find(
                        (entry) =>
                          entry.primary && entry.trusted !== false,
                      )?.cwd;
                    const sameTarget =
                      workspaceCwd === selectedWorkspaceCwdRef.current;
                    composerSourceVersionRef.current += 1;
                    selectedWorkspaceCwdRef.current = workspaceCwd;
                    setSelectedWorkspaceCwd(workspaceCwd);
                    setPendingSessionContext(
                      targetWorkspaceCwd
                        ? { kind: 'workspace', cwd: targetWorkspaceCwd }
                        : undefined,
                    );
                    if (!sameTarget) {
                      gitModeIntentRef.current = { mode: 'current' };
                      setGitModeIntent({ mode: 'current' });
                    }
                  }}
                  onOpenGitDiff={(workspaceCwd) =>
                    setGitDialog({
                      workspaceCwd,
                      gitCwd:
                        workspaceCwd === activeWorkspaceCwd
                          ? sessionWorktree?.path
                          : undefined,
                      view: 'diff',
                    })
                  }
                  onOpenCommit={(workspaceCwd) =>
                    setGitDialog({
                      workspaceCwd,
                      // A worktree session commits in the worktree checkout,
                      // not the base workspace cwd — but only for the active
                      // session's own workspace chip; another workspace's chip
                      // has no association with this session's worktree.
                      gitCwd:
                        workspaceCwd === activeWorkspaceCwd
                          ? sessionWorktree?.path
                          : undefined,
                      view: 'commit',
                    })
                  }
                  onOpenAddWorkspace={
                    dynamicWorkspaceRegistrationSupported
                      ? () => setShowAddWorkspaceDialog(true)
                      : undefined
                  }
                  workspaces={workspaces}
                  lockedWorkspaceCwd={lockedWorkspaceCwd}
                  lockedWorkspace={sidebarOptions.lockedWorkspace}
                  workspaceOverview={sidebarOptions.workspaceOverview}
                  onOpenWorkspaceManagement={(target) => {
                    closeMobileDrawer();
                    openPanel(target);
                  }}
                  onOpenWorkspacesOverview={() => {
                    closeMobileDrawer();
                    openPanel('workspaces');
                  }}
                  onNewWorktreeSession={(workspaceCwd) => {
                    // The intent travels with the draft it belongs to: set
                    // inside createNewSession's synchronous step, it is what
                    // the first prompt reads, and any later session start or
                    // workspace switch resets it like any other intent.
                    const targetWorkspaceCwd =
                      workspaceCwd ??
                      lockedWorkspaceCwd ??
                      workspacesRef.current.find(
                        (entry) =>
                          entry.primary && entry.trusted !== false,
                      )?.cwd;
                    if (!targetWorkspaceCwd) return false;
                    return createNewSession(
                      { kind: 'workspace', cwd: targetWorkspaceCwd },
                      {
                        gitIntent: { mode: 'worktree' },
                      },
                    );
                  }}
                  branding={sidebarOptions.branding}
                  primaryNav={sidebarOptions.primaryNav}
                  showSessionSourceSwitch={
                    sidebarOptions.showSessionSourceSwitch
                  }
                  hideProjectHeader={sidebarOptions.hideProjectHeader}
                  sessionActions={sidebarOptions.sessionActions}
                  footer={sidebarOptions.footer}
                />
              </div>
            )}
            <div
              className={[
                styles.contextShell,
                artifactPanelFullscreen ? styles.chatViewHidden : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden={artifactPanelFullscreen || undefined}
            >
              {chatHeaderEnabled &&
                !isChatEmptyState &&
                !activePanel &&
                (mainView === 'chat' || mainView === 'cockpit') && (
                <div className={styles.chatHeaderRow}>
                  {sidebarOptions.enabled &&
                    sidebarOptions.showCompactToggle && (
                      <button
                        type="button"
                        className={styles.hamburgerButton}
                        onClick={() => {
                          setForceMobileDrawer(false);
                          setMobileDrawerOpen((open) => !open);
                        }}
                        aria-label={t('sidebar.toggleMenu')}
                        aria-expanded={mobileDrawerOpen}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <line x1="3" y1="6" x2="21" y2="6" />
                          <line x1="3" y1="12" x2="21" y2="12" />
                          <line x1="3" y1="18" x2="21" y2="18" />
                        </svg>
                      </button>
                    )}
                  {renderChatHeader && mainView === 'chat' ? (
                    <div className={styles.customChatHeader}>
                      {renderChatHeader({
                        sessionId: connection.sessionId,
                        sessionName: sessionDisplayName,
                        workspaceCwd: workspaceContextActive
                          ? connection.workspaceCwd
                          : undefined,
                        items: chatHeaderItems,
                        environmentPanelOpen: environmentPanelVisible,
                        rightPanelOpen: artifactPanelOpen,
                        onEnvironmentPanelOpenChange:
                          handleEnvironmentPanelOpenChange,
                        onRightPanelOpenChange: handleRightPanelOpenChange,
                        ...(tokenUsageHeaderItemVisible && connection.sessionId
                          ? {
                              onOpenTokenUsage: () =>
                                openTokenUsagePanel(
                                  connection.sessionId!,
                                  sessionActions,
                                ),
                            }
                          : {}),
                        onOpenLocalControlSettings: workspaceContextActive
                          ? handleOpenLocalControlSettings
                          : undefined,
                      })}
                    </div>
                  ) : (
                    <ChatContextHeader
                      content={
                        titleHeaderItemVisible
                          ? (sessionDisplayName ?? t('session.new'))
                          : null
                      }
                      environmentOpen={environmentPanelVisible}
                      environmentAvailable={
                        mainView === 'chat' && environmentHeaderItemVisible
                      }
                      rightPanelOpen={artifactPanelOpen}
                      rightPanelAvailable={
                        mainView === 'chat' &&
                        rightPanelHeaderItemVisible &&
                        !artifactPanelOpen
                      }
                      onToggleEnvironment={() =>
                        handleEnvironmentPanelOpenChange(
                          !environmentPanelVisible,
                        )
                      }
                      onToggleRightPanel={() =>
                        handleRightPanelOpenChange(!artifactPanelOpen)
                      }
                      onOpenTokenUsage={
                        tokenUsageHeaderItemVisible && connection.sessionId
                          ? () =>
                              openTokenUsagePanel(
                                connection.sessionId!,
                                sessionActions,
                              )
                          : undefined
                      }
                      onOpenLocalControlSettings={
                        workspaceContextActive
                          ? handleOpenLocalControlSettings
                          : undefined
                      }
                    />
                  )}
                  {sessionWorkflowEnabled &&
                    (sessionWorkflowTodos.length > 0 ||
                      mainView === 'cockpit') && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mr-3"
                        data-testid="open-workflow"
                        disabled={approvalOverlayActive}
                        onClick={openWorkflowInspector}
                      >
                        {t('workflow.title')}
                      </Button>
                    )}
                </div>
              )}
              <div
                ref={contextBodyRef}
                data-testid="context-body"
                className={[
                  styles.contextBody,
                  environmentPanelVisible && environmentPanelFits
                    ? styles.contextBodyWithEnvironmentPanel
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
            <div
              ref={chatPaneRef}
              data-testid="chat-pane-container"
              className={[
                styles.chatPane,
                mainView !== 'chat' ? styles.chatPaneShowingPage : undefined,
                hasMobileComposerBottom
                  ? styles.chatPaneWithMobileComposerBottom
                  : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {sidebarOptions.enabled &&
                sidebarOptions.showCompactToggle &&
                (!chatHeaderEnabled || isChatEmptyState) &&
                !activePanel &&
                mainView === 'chat' && (
                  <button
                    type="button"
                    className={[
                      styles.hamburgerButton,
                      !chatHeaderEnabled || isChatEmptyState
                        ? styles.hamburgerButtonFloating
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      setForceMobileDrawer(false);
                      setMobileDrawerOpen((open) => !open);
                    }}
                    aria-label={t('sidebar.toggleMenu')}
                    aria-expanded={mobileDrawerOpen}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="3" y1="6" x2="21" y2="6" />
                      <line x1="3" y1="12" x2="21" y2="12" />
                      <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  </button>
                )}
              {activePanel &&
                (workspaceContextActive || activePanel === 'status') && (
                <section
                  className={styles.panelHost}
                  role="region"
                  data-testid="inline-panel"
                  aria-label={
                    activePanel === 'settings'
                      ? t('settings.title')
                      : activePanel === 'status'
                        ? t('daemon.title')
                        : activePanel === 'extensions'
                          ? t('extensions.manage.title')
                        : activePanel === 'mcp'
                          ? t('mcp.title')
                          : activePanel === 'skills'
                            ? t('skills.title')
                          : activePanel === 'agents'
                              ? t('agents.title')
                          : activePanel === 'plugins'
                              ? t('plugins.title')
                            : activePanel === 'channels'
                              ? t('channels.title')
                            : activePanel === 'workspaces'
                              ? t('workspacesOverview.title')
                              : t('sessionsOverview.title')
                  }
                >
                  {activePanel !== 'extensions' &&
                    activePanel !== 'mcp' &&
                    activePanel !== 'skills' &&
                    activePanel !== 'agents' &&
                    activePanel !== 'plugins' &&
                    activePanel !== 'channels' &&
                    activePanel !== 'workspaces' && (
                    <div className={styles.panelHeader}>
                    <button
                      ref={panelBackRef}
                      type="button"
                      className={styles.panelBack}
                      data-testid="panel-back"
                      onClick={() => {
                        if (activePanel !== 'sessions') {
                          closePanel();
                          return;
                        }
                        // Explicit navigation cancels any pending shrink-fold
                        // split restore.
                        splitFoldedByShrinkRef.current = false;
                        const current = connectionRef.current;
                        const currentSessionId = current.sessionId;
                        const currentWorkspaceCwd =
                          current.workspaceCwd ||
                          lockedWorkspaceCwd ||
                          workspacesRef.current.find(
                            (entry) => entry.primary,
                          )?.cwd;
                        if (!currentWorkspaceCwd) {
                          closePanel();
                          return;
                        }
                        const creation = createNewSession({
                          kind: 'workspace',
                          cwd: currentWorkspaceCwd,
                        });
                        const openInvocation = sessionOpenInvocationRef.current;
                        void creation.then(
                          (created) => {
                            const latest = connectionRef.current;
                            const latestWorkspaceCwd =
                              latest.workspaceCwd ||
                              lockedWorkspaceCwd ||
                              workspacesRef.current.find(
                                (entry) => entry.primary,
                              )?.cwd;
                            if (
                              created &&
                              sessionOpenInvocationRef.current ===
                                openInvocation &&
                              (latest.sessionId === undefined ||
                                (latest.sessionId === currentSessionId &&
                                  latestWorkspaceCwd === currentWorkspaceCwd))
                            ) {
                              onSessionIdChange?.(undefined);
                            }
                          },
                        );
                      }}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M15 5l-7 7 7 7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <div className={styles.panelTitle}>
                      {activePanel === 'settings'
                        ? t('settings.title')
                        : activePanel === 'status'
                          ? t('daemon.title')
                          : t('sessionsOverview.title')}
                    </div>
                    </div>
                  )}
                  <div className={styles.panelBody} key={activePanel}>
                    <ShadowDomBoundary
                      enabled={
                        shadowDomOptions.plugins &&
                        isPluginShadowPanel(activePanel)
                      }
                      language={selectedLanguage}
                      themeClassName={[
                        selectedTheme === WebShellThemeId.Light
                          ? styles.themeLight
                          : styles.themeDark,
                        selectedTheme === WebShellThemeId.Dark
                          ? 'dark'
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      styles={shadowDomOptions.styles}
                      initialFocusRef={
                        activePanel === 'plugins'
                          ? pluginTabRef
                          : activePanel === 'extensions' ||
                              activePanel === 'channels' ||
                              activePanel === 'workspaces'
                            ? panelHeadingRef
                            : undefined
                      }
                    >
                      {activePanel === 'settings' ? (
                      <SettingsMessage
                        settingsState={targetedWorkspaceSettingsState}
                        embedded
                        initialCategory={settingsInitialCategory}
                        onLanguageChange={handleSettingsLanguageChange}
                        onThemeChange={handleThemeChange}
                        chatWidthMode={chatWidthMode}
                        onChatWidthModeChange={handleChatWidthModeChange}
                        modelManagement={{
                          providers: providersState.providers,
                          currentModelId:
                            connection.currentModel ?? undefined,
                          loading: providersState.loading,
                          error: providersState.error,
                          busy: modelActionBusy,
                          onSelectModel: handleModelSelect,
                          onDeleteModel: handleDeleteModel,
                          onAddModel: () => setShowAuthDialog(true),
                        }}
                        onSubDialog={(key, scope) => {
                          // Record the persist scope only for model settings —
                          // the reset effect is gated on the dialog/fallback/auth
                          // flags, so it never runs for the approvalMode dialog
                          // and would leave a stale scope behind.
                          if (key === 'fastModel') {
                            setModelSettingScope(scope);
                            setModelDialogMode('fast');
                          } else if (key === 'visionModel') {
                            setModelSettingScope(scope);
                            setModelDialogMode('vision');
                          } else if (key === 'voiceModel') {
                            void openVoiceModelPicker(scope, 'settings');
                          } else if (key === 'modelFallbacks') {
                            setModelSettingScope(scope);
                            setShowFallbacksDialog(true);
                          } else if (key === 'tools.approvalMode') {
                            // Not a model setting — leave modelSettingScope alone.
                            setShowApprovalModeDialog(true);
                          }
                        }}
                      />
                    ) : activePanel === 'status' ? (
                      <DaemonStatusDialog />
                    ) : activePanel === 'extensions' ? (
                      <ExtensionsManagerPage
                        onClose={closePanel}
                        initialFocusRef={panelHeadingRef}
                      />
                    ) : activePanel === 'mcp' && mcpDialogMessage ? (
                      <McpManagerPage
                        message={mcpDialogMessage}
                        onClose={() => {
                          setMcpDialogMessage(null);
                          closePanel();
                        }}
                      />
                    ) : activePanel === 'skills' ? (
                      <SkillsManagerPage
                        onClose={closePanel}
                        onUseSkill={handleUseSkill}
                      />
                    ) : activePanel === 'agents' ? (
                      <AgentsManagerPage
                        onClose={() => {
                          setAgentsCreateScope(null);
                          closePanel();
                        }}
                        initialCreateScope={agentsCreateScope}
                      />
                    ) : activePanel === 'plugins' ? (
                      <PluginManagerPage
                        mcpMessage={mcpDialogMessage}
                        loadMcpMessage={async () => {
                          try {
                            await loadMcpManagerMessage();
                          } catch (error) {
                            reportError(error, 'Failed to load MCP status');
                            throw error;
                          }
                        }}
                        onClose={closePanel}
                        onUseSkill={handleUseSkill}
                        initialFocusRef={pluginTabRef}
                      />
                    ) : activePanel === 'channels' ? (
                      <ChannelsManagerPage
                        onClose={closePanel}
                        initialFocusRef={panelHeadingRef}
                      />
                    ) : activePanel === 'workspaces' ? (
                      <WorkspacesOverviewPanel
                        onClose={closePanel}
                        // A new draft replaces the panel with the chat view;
                        // createNewSession's default (no keepPanel) does that.
                        onNewSession={handlePanelNewSession}
                        onAddWorkspace={
                          dynamicWorkspaceRegistrationSupported
                            ? () => setShowAddWorkspaceDialog(true)
                            : undefined
                        }
                        onError={reportError}
                        initialFocusRef={panelHeadingRef}
                      />
                    ) : (
                      <SessionOverviewPanel
                        onOpenSession={handleOpenSessionFromOverview}
                        // Split view cannot exist below the breakpoint; the
                        // panel hides the action when the prop is absent.
                        onOpenSplit={isLargeScreen ? openSplitView : undefined}
                        onCurrentSessionRemoved={async (removed) => {
                          const current = connectionRef.current;
                          const currentWorkspaceCwd =
                            current.workspaceCwd ||
                            lockedWorkspaceCwd ||
                            workspacesRef.current.find(
                              (entry) => entry.primary,
                            )?.cwd;
                          if (
                            current.sessionId !== removed.sessionId ||
                            (currentWorkspaceCwd &&
                              currentWorkspaceCwd !== removed.workspaceCwd)
                          ) {
                            return;
                          }
                          const cleared = await createNewSession(
                            {
                              kind: 'workspace',
                              cwd: removed.workspaceCwd,
                            },
                            {
                              keepView: true,
                              keepPanel: true,
                            },
                          );
                          const latest = connectionRef.current;
                          const latestWorkspaceCwd =
                            latest.workspaceCwd ||
                            lockedWorkspaceCwd ||
                            workspacesRef.current.find(
                              (entry) => entry.primary,
                            )?.cwd;
                          if (
                            cleared &&
                            (!latestWorkspaceCwd ||
                              latestWorkspaceCwd === removed.workspaceCwd) &&
                            (latest.sessionId === removed.sessionId ||
                              latest.sessionId === undefined)
                          ) {
                            onSessionIdChange?.(undefined);
                          }
                          return cleared;
                        }}
                        includeOtherWorkspaces={!lockedWorkspaceCwd}
                        workspaceCwd={lockedWorkspaceCwd}
                        manageLiveState={!sidebarOptions.enabled}
                      />
                    )}
                    </ShadowDomBoundary>
                  </div>
                </section>
              )}
              {workspaceContextActive && mainView === 'scheduledTasks' && (
                <div
                  className={styles.fullPage}
                  data-testid="scheduled-tasks-page"
                >
                  <div className={styles.fullPageHeader}>
                    <button
                      type="button"
                      className={styles.fullPageBack}
                      onClick={showChat}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <div className={styles.fullPageTitle}>
                      {t('scheduledTasks.title')}
                    </div>
                  </div>
                  <div className={styles.fullPageBody}>
                    <ScheduledTasksDialog
                      onRunPrompt={runTaskManually}
                      // Registered workspaces (multi-workspace daemons only) so
                      // the page aggregates every project's schedule and the New
                      // form can target one; absent/single → primary-only view.
                      workspaces={
                        lockedWorkspaceCwd
                          ? visibleWorkspaces
                          : ordinaryWorkspaces
                      }
                      lockedWorkspace={lockedWorkspaceCapability}
                      currentSession={
                        currentSessionSummary
                          ? {
                              ...currentSessionSummary,
                              hasActivePrompt:
                                currentSessionSummary.hasActivePrompt === true ||
                                sessionHasActivePrompt,
                            }
                          : undefined
                      }
                      currentSessionSchedulingAvailable={workspace.capabilities?.features?.includes(
                        'scheduled_task_session_reuse',
                      )}
                      onCreateViaChat={() => {
                        // Start a FRESH session and jump to it so the task-
                        // creation chat doesn't pile onto the current
                        // conversation, then prime the composer so the user can
                        // describe the task in natural language; the agent
                        // creates it via its cron_create tool. Focus is deferred
                        // so the new session's composer is mounted/visible first.
                        const targetCwd =
                          resolveWorkspaceMaintenanceTargetCwd();
                        if (!targetCwd) return;
                        void createNewSession({
                          kind: 'workspace',
                          cwd: targetCwd,
                        }).then((created) => {
                          // If the new session couldn't be started,
                          // createNewSession already surfaced the error — do NOT
                          // prime the (still-current) session with the task
                          // starter, which would land in the wrong conversation.
                          if (!created) return;
                          onSessionIdChange?.(undefined);
                          window.setTimeout(() => {
                            editorRef.current?.insertText(
                              t('scheduledTasks.chatStarter'),
                              { mode: 'replace' },
                            );
                            editorRef.current?.focus();
                          }, 0);
                        });
                      }}
                      onOpenSession={(sessionId) => {
                        // The task's bound session IS its run history — switch
                        // to the chat view and load that session's transcript.
                        showChat();
                        loadSidebarSession(sessionId).catch(
                          (error: unknown) => {
                            reportError(error, 'Failed to open session');
                          },
                        );
                      }}
                      onError={reportError}
                    />
                  </div>
                </div>
              )}
              {workspaceContextActive &&
                mainView === 'workflows' &&
                workflowsEnabled && (
                <div
                  className={styles.fullPage}
                  data-testid="workflow-runs-page"
                >
                  <div className={styles.fullPageHeader}>
                    <button
                      type="button"
                      className={styles.fullPageBack}
                      onClick={showChat}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <div className={styles.fullPageTitle}>
                      {t('workflowRuns.title')}
                    </div>
                  </div>
                  <div className={styles.fullPageBody}>
                    <WorkflowRunsPage
                      onWorkflowRunStarted={() =>
                        setBackgroundTasksRefreshTrigger((value) => value + 1)
                      }
                      onCreateViaChat={() => {
                        const targetCwd =
                          resolveWorkspaceMaintenanceTargetCwd();
                        if (!targetCwd) return;
                        void createNewSession({
                          kind: 'workspace',
                          cwd: targetCwd,
                        }).then((created) => {
                          if (!created) return;
                          onSessionIdChange?.(undefined);
                          window.setTimeout(() => {
                            editorRef.current?.insertText(
                              '/workflow-creator ',
                              { mode: 'replace' },
                            );
                            editorRef.current?.focus();
                          }, 0);
                        });
                      }}
                    />
                  </div>
                </div>
              )}
              {workspaceContextActive && mainView === 'goals' && (
                <div className={styles.fullPage} data-testid="goals-page">
                  <div className={styles.fullPageHeader}>
                    <button
                      type="button"
                      className={styles.fullPageBack}
                      onClick={showChat}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <div className={styles.fullPageTitle}>
                      {t('goals.title')}
                    </div>
                  </div>
                  <div className={styles.fullPageBody}>
                    <GoalsDialog
                      onCreateGoal={async (condition) => {
                        const stranded = strandedGoalSessionRef.current;
                        const canReuseStranded =
                          stranded !== undefined &&
                          connectionRef.current.sessionId === stranded;
                        if (!canReuseStranded) {
                          strandedGoalSessionRef.current = undefined;
                          const targetCwd =
                            resolveWorkspaceMaintenanceTargetCwd();
                          if (!targetCwd) return false;
                          const created = await createNewSession(
                            { kind: 'workspace', cwd: targetCwd },
                            { keepView: true },
                          );
                          if (!created) return false;
                        }
                        const allocationOwner = sessionOwnerGuard.capture();
                        const sourceSessionId =
                          connectionRef.current.sessionId;
                        const allocatedSessionId =
                          await ensureSessionForPrompt();
                        const currentSessionId =
                          connectionRef.current.sessionId;
                        const ownAllocationSucceeded =
                          sourceSessionId === undefined &&
                          allocatedSessionId !== undefined &&
                          (currentSessionId === undefined ||
                            currentSessionId === allocatedSessionId);
                        if (
                          (!allocationOwner.isCurrent() &&
                            !ownAllocationSucceeded) ||
                          (sourceSessionId !== undefined
                            ? currentSessionId !== sourceSessionId
                            : currentSessionId !== undefined &&
                              currentSessionId !== allocatedSessionId)
                        ) {
                          return false;
                        }
                        if (
                          !connectionRef.current.sessionId &&
                          !allocatedSessionId
                        ) {
                          return false;
                        }
                        const owner = sessionOwnerGuard.capture();
                        try {
                          if (allocatedSessionId) {
                            await createGoalForAllocatedSession(
                              allocatedSessionId,
                              condition,
                            );
                          } else {
                            await controlCurrentGoal('create', condition);
                          }
                        } catch (error) {
                          if (
                            owner.isCurrent() &&
                            mainViewRef.current === 'goals'
                          ) {
                            strandedGoalSessionRef.current =
                              allocatedSessionId ??
                              connectionRef.current.sessionId;
                          }
                          throw error;
                        }
                        if (!owner.isCurrent()) return false;
                        strandedGoalSessionRef.current = undefined;
                        showChat();
                      }}
                      onOpenSession={(sessionId) => {
                        // The goal's session transcript IS its history.
                        showChat();
                        loadSidebarSession(sessionId).catch(
                          (error: unknown) => {
                            reportError(error, 'Failed to open session');
                          },
                        );
                      }}
                      onError={reportError}
                    />
                  </div>
                </div>
              )}
              {workspaceContextActive && mainView === 'cockpit' && (
                <div className={styles.fullPage} data-testid="cockpit-page">
                  <SessionWorkflowCockpit
                    sessionId={connection.sessionId ?? ''}
                    connected={connected}
                    todos={sessionWorkflowTodos}
                    tools={planAgentTools}
                    tasks={environmentAgentTasks}
                    selectedTodoId={selectedWorkflowTodoId}
                    onSelectedTodoIdChange={setSelectedWorkflowTodoId}
                    onBackToChat={closeCockpit}
                    onOpenSubagent={openSubagentPanel}
                    {...(sessionDisplayName
                      ? { sessionName: sessionDisplayName }
                      : {})}
                    {...(connection.workspaceCwd
                      ? { workspaceCwd: connection.workspaceCwd }
                      : {})}
                  />
                </div>
              )}
              {workspaceContextActive && mainView === 'split' && (
                <div className={styles.fullPage} data-testid="split-view-page">
                  {/* The outer session's approval overlay is suppressed under the
                      split (it would own ghost keyboard shortcuts). If that
                      session isn't one of the panes, the approval would be
                      invisible — surface a notice with a way back to it. */}
                  {approvalOverlayActive && (
                    <div
                      className={styles.splitApprovalNotice}
                      role="status"
                      data-testid="split-approval-notice"
                    >
                      <span>{t('splitView.outerApprovalPending')}</span>
                      <button type="button" onClick={showChat}>
                        {t('splitView.goToApproval')}
                      </button>
                    </div>
                  )}
                  {/* Share the app-level customization so split panes render
                      markdown/tool-headers/thinking the same way the single-
                      session chat does (todo contexts stay chat-only — they
                      belong to the outer session, not the panes). */}
                  <WebShellCustomizationProvider value={customization}>
                      <SplitView
                        sessionIds={splitSessionIds}
                        // Mirror live pane add/remove back up so switching away
                        // and re-entering restores the same panes. Keep this
                        // callback stable to avoid looping SplitView's reporting
                        // effect.
                        onPanesChange={handleSplitPanesChange}
                        includeOtherWorkspaces={!lockedWorkspaceCwd}
                        workspaceCwd={lockedWorkspaceCwd}
                        // Back returns to the Session Overview (the hub the split
                        // is launched from), not the single-session chat.
                        onExit={handleSplitExit}
                        onError={reportError}
                        onImageIngestionNotice={pushToast}
                        onSlashCommand={onSlashCommand}
                        onOpenGoals={openGoals}
                        onRightPanelOpen={handleTurnOutputOpen}
                        onOpenMonitor={openMonitorPanel}
                        onPaneArtifactsChange={handlePaneArtifactsChange}
                        messageTurnOutputs={messageTurnOutputs}
                        restartSseOnPrompt={restartSseOnPrompt}
                        historyPageSize={historyPageSize}
                        renderPaneHeaderActions={resolvedPaneHeaderActions}
                        voiceUserRevision={voiceUserRevision}
                        voiceWorkspaceRevisions={voiceWorkspaceRevisions}
                        voiceWorkspaces={
                          workspace.capabilities?.workspaces ||
                          lockedWorkspaceCapability
                            ? ordinaryWorkspaces
                            : undefined
                        }
                        sessionWorkflowEnabled={sessionWorkflowEnabled}
                      />
                  </WebShellCustomizationProvider>
                </div>
              )}
              <div
                className={[
                  styles.chatViewWrap,
                  hasMobileComposerBottom
                    ? styles.chatViewWithMobileComposerBottom
                    : undefined,
                  hasWelcomeMiddle
                    ? styles.chatViewWithWelcomeMiddle
                    : undefined,
                  // Positioning hook: completes the compound selector in
                  // App.module.css that keeps this wrap relative so the
                  // absolutely-positioned bottom panels keep their anchor.
                  CustomFooter ? styles.chatViewWithCustomFooter : undefined,
                  activePanel ||
                  mainView !== 'chat' ||
                  artifactPanelFullscreen
                    ? styles.chatViewHidden
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
                // Hide the outer chat whenever a panel, a full-page view (split
                // / scheduled tasks), or the fullscreen artifact panel covers
                // it. `display:none` drops the subtree from layout and the tab
                // order, and aria-hidden keeps AT out — so no keyboard/AT can
                // reach the outer composer/toolbar behind the covering surface.
                // State is preserved (the node stays mounted).
                aria-hidden={
                  activePanel ||
                  mainView !== 'chat' ||
                  artifactPanelFullscreen
                    ? true
                    : undefined
                }
              >
                {showMissingSessionState && (
                  <div className={styles.missingSessionState}>
                    <div className={styles.missingSessionMessage}>
                      {t('session.missing')}
                    </div>
                    <button
                      type="button"
                      className={styles.missingSessionButton}
                      disabled={isCreatingMissingSession}
                      onClick={handleMissingSessionNewSession}
                    >
                      {t('session.new')}
                    </button>
                  </div>
                )}
                <div
                  className={
                    showMissingSessionState
                      ? styles.chatSubtreeHidden
                      : styles.chatSubtree
                  }
                >
                  <WebShellCustomizationProvider value={mainChatCustomization}>
                      <TodoContextsProvider
                        timeline={todoTimeline}
                        details={todoDetails}
                      >
                        <InteractionBlockContext.Provider
                          value={registerInteractionBlocker}
                        >
                          {(() => {
                            const contentClassName = [
                              styles.content,
                              showFloatingTodos ||
                              displayMessages.length > 0 ||
                              pendingApproval
                                ? styles.contentHasMessages
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(' ');

                            const messageListContent = (
                              <LiveMessageList
                                ref={messageListRef}
                                sessionKey={connection.sessionId}
                                baselineBlocks={blocks}
                                baselineSummary={blockChangeSummary}
                                baselineMessages={messages}
                                recapMessage={recapMessage}
                                messagesRef={messagesRef}
                                onTranscriptChange={onTranscriptChange}
                                t={t}
                                terminalBackgroundShellTaskIds={
                                  terminalBackgroundShellTaskIds
                                }
                                pendingApproval={pendingToolApproval}
                                onShowContextDetail={handleShowContextDetail}
                                loadingTranscript={connection.loadingTranscript}
                                catchingUp={connection.catchingUp}
                                hasOlderHistory={transcriptHistory.hasMore}
                                loadingOlderHistory={transcriptHistory.loading}
                                historyCapacityReached={
                                  transcriptHistory.capacityReached
                                }
                                historyPaginationError={
                                  transcriptHistory.paginationError}
                                onLoadOlderHistory={transcriptHistory.loadMore}
                                transcriptActivity={store}
                                onReloadTranscript={
                                  transcriptReloadSupported
                                    ? reloadTranscript
                                    : undefined
                                }
                                isResponding={
                                  streamingState !== 'idle' &&
                                  !suppressFailedPromptRetryStreaming
                                }
                                transcriptReloadPaused={
                                  streamingState !== 'idle'
                                }
                                activeTurnStartedAt={
                                  suppressFailedPromptRetryStreaming
                                    ? undefined
                                    : (failedPromptRetry?.startedAt ??
                                      activeTurnStartedAt)
                                }
                                workspaceCwd={connection.workspaceCwd || ''}
                                hideSessionTimeline={
                                  effectiveChatWidthMode === 'wide'
                                }
                                showRetryHint={showCurrentRetryHint}
                                onRetryClick={handleRetry}
                                failedPromptMessageId={
                                  isPreparingPrompt ||
                                  streamingState !== 'idle' ||
                                  sessionHasActivePrompt
                                    ? undefined
                                    : visibleFailedPromptBlock?.id
                                }
                                onRetryFailedPrompt={handleFailedPromptRetry}
                                onEditUserMessage={
                                  userMessageEditing
                                    ? (turnIndex, content) =>
                                        void editUserMessage(
                                          turnIndex,
                                          content,
                                        )
                                    : undefined
                                }
                                onBranchSession={handleBranchCurrentSession}
                                bottomOverlayInset={bottomPanelInset}
                                welcomeHeader={
                                  isChatEmptyState ? welcomeHeader : undefined
                                }
                                centerWelcomeHeader={
                                  showMobileWelcomeFooterMiddle || undefined
                                }
                                tailContent={undefined}
                                tailKey={undefined}
                                onCanScrollToBottomChange={
                                  handleCanScrollToBottomChange
                                }
                                virtualScrollThreshold={virtualScrollThreshold}
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
                                onTurnOutputOpen={handleTurnOutputOpen}
                                onImagePreview={openImagePanel}
                                onAttachmentPreview={openAttachmentPanel}
                                onInsightReportOpen={onInsightReportOpen}
                                onReviewChanges={openReviewPanel}
                                onOpenArtifact={openArtifactPanel}
                                onOpenScheduledTask={openScheduledTaskPanel}
                                onError={reportError}
                                generateContent={
                                  connection.capabilities?.features.includes(
                                    'session_generation',
                                  )
                                    ? sessionActions.generateSessionContent
                                    : undefined
                                }
                              />
                            );
                            const messageListWithWorkflowDetails = (
                              <WorkflowDetailsProvider tasks={sessionTasks}>
                                {messageListContent}
                              </WorkflowDetailsProvider>
                            );
                            const messageListWithSubagentDetails = (
                              <SubagentDetailsProvider
                                onOpen={openSubagentPanel}
                              >
                                {messageListWithWorkflowDetails}
                              </SubagentDetailsProvider>
                            );
                            const messageList = monitorDetailsSupported ? (
                              <MonitorDetailsProvider
                                onOpen={openMonitorPanelFromTool}
                              >
                                {messageListWithSubagentDetails}
                              </MonitorDetailsProvider>
                            ) : (
                              messageListWithSubagentDetails
                            );

                            const btwPanel =
                              !showMobileWelcomeFooterMiddle &&
                              btwMessage?.role === 'btw' ? (
                                <div className={styles.btwPanel}>
                                  <BtwMessage
                                    question={btwMessage.question}
                                    answer={btwMessage.answer}
                                    isPending={btwMessage.isPending}
                                  />
                                </div>
                              ) : null;

                            if (showMobileWelcomeFooterMiddle) {
                              return (
                                <div className={styles.mobileWelcomeGroup}>
                                  <div
                                    style={contentStyle}
                                    className={contentClassName}
                                  >
                                    {messageList}
                                    {btwPanel}
                                  </div>
                                  <div
                                    className={styles.mobileWelcomeFooterMiddle}
                                  >
                                    {welcomeFooter}
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div
                                style={contentStyle}
                                className={contentClassName}
                              >
                                {messageList}
                                {btwPanel}
                              </div>
                            );
                          })()}
                        </InteractionBlockContext.Provider>
                      </TodoContextsProvider>

                    <div
                      ref={footerRef}
                      style={contentStyle}
                      className={
                        CustomFooter
                          ? `${styles.footer} ${styles.footerWithCustomFooter}`
                          : styles.footer
                      }
                    >
                      {canScrollMessageListToBottom && (
                        <div
                          className={
                            showBottomPanels
                              ? `${styles.scrollToBottomLayer} ${styles.scrollToBottomLayerWithTodos}`
                              : styles.scrollToBottomLayer
                          }
                        >
                          <button
                            type="button"
                            className={styles.scrollToBottomButton}
                            aria-label={t('chat.scrollToBottom')}
                            onClick={() => resumeChatBottomFollow('smooth')}
                          >
                            <svg
                              className={styles.scrollToBottomIcon}
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path
                                d="M12 5v13M6.5 12.5 12 18l5.5-5.5"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </div>
                      )}
                      {showBottomPanels && (
                        <div
                          ref={bottomPanelsRef}
                          className={styles.bottomPanels}
                        >
                          <TodoPanel
                            todos={showFloatingTodos ? floatingTodos : []}
                            statusItems={floatingBottomStatusItems}
                            onOpen={
                              showFloatingTodos
                                ? floatingTodosUseSessionWorkflow
                                  ? openWorkflowInspector
                                  : openTasksPanel
                                : undefined
                            }
                          />
                        </div>
                      )}
                      {/* Only render the outer session's approval on the chat
                          view. Under a full-page view (Workflow / split / scheduled tasks)
                          it would sit hidden and unreachable. Each split pane
                          surfaces its own approval. `keyboardActive` tells the
                          overlay to grab focus only when it's the topmost one. */}
                      {pendingToolApproval && mainView === 'chat' && (
                        <div
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <ToolApproval
                            request={pendingToolApproval}
                            onConfirm={handleConfirm}
                            variant="floating"
                            keyboardActive={toolApprovalOverlayVisible}
                            planTodos={
                              sessionWorkflowEnabled ? approvalPlanTodos : []
                            }
                          />
                        </div>
                      )}
                      {pendingAskUserApproval && mainView === 'chat' && (
                        <div
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <AskUserQuestion
                            request={pendingAskUserApproval}
                            onConfirm={handleAskUserConfirm}
                            onError={reportError}
                            variant="floating"
                            keyboardActive={askUserOverlayVisible}
                            customInputLabel={askUserFreeTextLabel}
                          />
                        </div>
                      )}
                      {/* A pending approval overlay owns the footer: drop the
                          composer out of layout (kept mounted so the draft
                          survives) instead of leaving a live input below the
                          dialog. */}
                      <div
                        className={
                          approvalOverlayActive && mainView === 'chat'
                            ? `${styles.composer} ${styles.composerHidden}`
                            : styles.composer
                        }
                      >
                        {standaloneCreationRecovery && (
                          <div
                            className={styles.composerActionTip}
                            role="alert"
                            data-testid="standalone-creation-recovery"
                          >
                            <span
                              className={styles.composerActionTipIcon}
                              aria-hidden="true"
                            >
                              !
                            </span>
                            <span className={styles.composerActionTipText}>
                              {standaloneRecoveryResolution === 'checking'
                                ? t('session.recoveryChecking')
                                : standaloneRecoveryResolution === 'creating'
                                  ? t('session.recoveryStillCreating')
                                  : standaloneRecoveryResolution === 'absent'
                                    ? t('session.recoveryAbsent')
                                    : standaloneRecoveryResolution ===
                                        'unknown'
                                      ? t('session.recoveryUnknown')
                                      : standaloneRecoveryResolution ===
                                          'archived'
                                        ? t('session.recoveryArchived')
                                        : t('session.recoveryPending')}
                            </span>
                            <div className={styles.composerActionTipActions}>
                              {standaloneRecoveryResolution === 'archived' ? (
                                <button
                                  type="button"
                                  className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                  onClick={() =>
                                    void handleUnarchiveRecoveredStandalone()
                                  }
                                >
                                  {t('session.unarchive')}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                  disabled={
                                    standaloneRecoveryResolution === 'checking'
                                  }
                                  onClick={() =>
                                    void handleCheckStandaloneRecovery()
                                  }
                                >
                                  {t('session.checkStatus')}
                                </button>
                              )}
                              {standaloneRecoveryResolution === 'absent' && (
                                <button
                                  type="button"
                                  className={styles.composerActionTipButton}
                                  onClick={handleRetryStandaloneCreation}
                                >
                                  {t('session.retryCreation')}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        {standaloneWorkingDirectory?.state === 'recreated' && (
                          <div
                            className={styles.composerActionTip}
                            role="status"
                            data-testid="standalone-directory-recreated"
                          >
                            <span
                              className={styles.composerActionTipIcon}
                              aria-hidden="true"
                            >
                              !
                            </span>
                            <span className={styles.composerActionTipText}>
                              {t('session.directoryRecreated')}
                            </span>
                          </div>
                        )}
                        {standaloneDirectoryErrorCode ===
                          'working_directory_missing' && (
                          <div
                            className={styles.composerActionTip}
                            role="alert"
                            data-testid="standalone-directory-missing"
                          >
                            <span className={styles.composerActionTipText}>
                              {t('session.directoryMissing')}
                            </span>
                            <div className={styles.composerActionTipActions}>
                              <button
                                type="button"
                                className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                disabled={standaloneRepairBusy}
                                onClick={() =>
                                  void handleRepairStandaloneDirectory()
                                }
                              >
                                {standaloneRepairBusy
                                  ? t('session.repairing')
                                  : t('session.repair')}
                              </button>
                            </div>
                          </div>
                        )}
                        {standaloneDirectoryErrorCode ===
                          'working_directory_compromised' && (
                          <div
                            className={styles.composerActionTip}
                            role="alert"
                            data-testid="standalone-directory-compromised"
                          >
                            <span className={styles.composerActionTipText}>
                              {t('session.directoryCompromised')}
                            </span>
                          </div>
                        )}
                        {streamingState !== 'idle' ||
                        sessionHasActivePrompt ? (
                          suppressFailedPromptRetryStreaming ? null : (
                            <StreamingStatus
                              startedAt={
                                failedPromptRetry?.startedAt ??
                                activeTurnStartedAt
                              }
                              hasActivePrompt={sessionHasActivePrompt}
                            />
                          )
                        ) : newSessionSuggestion ? (
                          <div
                            className={styles.composerActionTip}
                            role="status"
                            data-testid={
                              newSessionSuggestion.suggestion === 'btw'
                                ? 'btw-suggestion'
                                : 'new-session-suggestion'
                            }
                          >
                            <span
                              className={styles.composerActionTipIcon}
                              aria-hidden="true"
                            >
                              ✦
                            </span>
                            <span className={styles.composerActionTipText}>
                              {newSessionSuggestion.suggestion === 'btw'
                                ? t('editor.btwSuggestionTitle')
                                : t('editor.newSessionSuggestionTitle')}
                            </span>
                            <div className={styles.composerActionTipActions}>
                              <button
                                type="button"
                                className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                data-testid={
                                  newSessionSuggestion.suggestion === 'btw'
                                    ? 'btw-suggestion-send'
                                    : 'new-session-suggestion-start'
                                }
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={
                                  newSessionSuggestion.suggestion === 'btw'
                                    ? handleAcceptBtwSuggestion
                                    : handleAcceptNewSessionSuggestion
                                }
                              >
                                {newSessionSuggestion.suggestion === 'btw'
                                  ? t('editor.btwSuggestionSend')
                                  : t('editor.newSessionSuggestionStart')}
                              </button>
                            </div>
                          </div>
                        ) : escapeHintVisible && streamingState === 'idle' ? (
                          <div className={styles.escClearStatus} role="status">
                            {t('editor.escClearHint')}
                          </div>
                        ) : null}
                        {unknownPromptAdmission &&
                          unknownPromptAdmission.sessionId ===
                            connection.sessionId && (
                          <div
                            className={styles.composerActionTip}
                            role="status"
                            data-testid="prompt-admission-unknown"
                          >
                            <span
                              className={styles.composerActionTipIcon}
                              aria-hidden="true"
                            >
                              !
                            </span>
                            <span className={styles.composerActionTipText}>
                              {t('queue.admissionUnknown')}
                            </span>
                            {unknownPromptAdmission.payloadAvailable && (
                              <div
                                className={styles.composerActionTipActions}
                              >
                                <button
                                  type="button"
                                  className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                  onClick={restoreUnknownPromptPayload}
                                >
                                  {t('queue.restoreUnknown')}
                                </button>
                                <button
                                  type="button"
                                  className={styles.composerActionTipButton}
                                  onClick={discardUnknownPromptPayload}
                                >
                                  {t('queue.discardUnknown')}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {(queuedPrompts.length > 0 ||
                          liveGoalSnapshot?.goal) && (
                          <div
                            className={composerStatusStyles.root}
                            data-testid="composer-status-stack"
                          >
                            <QueuedPromptDisplay
                              prompts={queuedPrompts}
                              t={t}
                              canMutateMidTurn={canMutateMidTurn}
                              canInsertMidTurn={
                                streamingState !== 'idle' ||
                                sessionHasActivePrompt
                              }
                              onDelete={removeQueuedPrompt}
                              onInsert={insertQueuedPrompt}
                              onEdit={editQueuedPrompt}
                              onImagePreview={openImagePanel}
                              onAttachmentPreview={openAttachmentPanel}
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
                        {CustomComposerHeader && (
                          <div className={styles.composerHeader}>
                            <CustomComposerHeader
                              disabled={
                                isDisabled ||
                                unknownPromptAdmission?.payloadAvailable === true
                              }
                              isRunning={
                                streamingState !== 'idle' ||
                                sessionHasActivePrompt
                              }
                              currentMode={currentMode}
                              currentModel={currentModel}
                              sessionName={sessionDisplayName}
                            />
                          </div>
                        )}
                        <ChatEditor
                          ref={setEditorHandle}
                          compactOverlays={compactComposerOverlays}
                          onSubmit={handleEditorSubmit}
                          onInputTextChange={handleComposerTextChange}
                          onAttachmentsChange={
                            handleComposerAttachmentsChange
                          }
                          onImageIngestionNotice={pushToast}
                          onImagePreview={openImagePanel}
                          onAttachmentPreview={openAttachmentPanel}
                          onCycleMode={handleCycleMode}
                          cycleModeOnTab={cycleModeOnTab}
                          onToggleShortcuts={handleToggleShortcuts}
                          onCancel={handleCancel}
                          isRunning={
                            streamingState !== 'idle' ||
                            sessionHasActivePrompt
                          }
                          isPreparing={
                            isPreparingPrompt || isStartingNewSessionSuggestion
                          }
                          cancelArmed={cancelArmed}
                          disabled={
                            isDisabled ||
                            isStartingNewSessionSuggestion ||
                            interactionBlocked ||
                            approvalOverlayActive ||
                            unknownPromptAdmission?.payloadAvailable === true
                          }
                          commands={commands}
                          skills={composerSkills}
                          slashCommandCategoryOrder={slashCommandCategoryOrder}
                          autoSubmitSlashCommands={autoSubmitSlashCommands}
                          builtinAtProviders={
                            workspaceContextActive ? builtinAtProviders : false
                          }
                          atProviders={atProviders}
                          composerTagIcons={composerTagIcons}
                          voiceTarget={
                            activePanel !== null || mainView !== 'chat'
                              ? undefined
                              : mainVoiceTarget
                          }
                          voiceStatusRevision={mainVoiceStatusRevision}
                          queuedMessages={queuedTexts}
                          onFocusFooter={handleFocusTaskPill}
                          onPopQueuedMessages={editLastQueuedPrompt}
                          onClearQueuedMessages={clearQueuedPrompts}
                          currentMode={currentMode}
                          sessionWorkflowEnabled={sessionWorkflowEnabled}
                          currentModel={currentModel}
                          gitBranch={
                            workspaceContextActive
                              ? activeGitBranch
                              : undefined
                          }
                          gitWorktree={
                            workspaceContextActive && Boolean(sessionWorktree)
                          }
                          gitCwd={
                            workspaceContextActive
                              ? sessionWorktree?.path
                              : undefined
                          }
                          gitModeIntent={gitModeEligible ? gitModeIntent : undefined}
                          onGitModeIntentChange={gitModeEligible ? setGitModeIntent : undefined}
                          gitStatus={
                            workspaceContextActive
                              ? selectedWorkspaceGitStatus
                              : undefined
                          }
                          onOpenGitDiff={
                            gitDiffWorkspaceCwd
                              ? handleOpenGitDiff
                              : undefined
                          }
                          onOpenCommit={
                            gitDiffWorkspaceCwd
                              ? handleOpenCommit
                              : undefined
                          }
                          chatWidthMode={chatWidthMode}
                          showChatWidthToggle={!isChatEmptyState}
                          chatWidthToggleMin={chatWidthToggleMin}
                          visibleToolbarActions={visibleComposerToolbarActions}
                          tokenCount={connection.tokenCount ?? 0}
                          contextWindow={connection.contextWindow ?? 0}
                          contextUsageAlwaysVisible={
                            contextUsageAlwaysVisible
                          }
                          onShowContextUsage={handleShowContextUsage}
                          availableModels={availableModels}
                          onSelectMode={handleSetMode}
                          onSelectModel={handleModelSelect}
                          reasoning={displayedReasoning}
                          onSelectReasoningEffort={
                            hasAuthoritativeReasoningContext
                              ? handleReasoningEffort
                              : welcomeReasoningPreview && !sessionWriteBlocked
                                ? handleWelcomeReasoningEffort
                                : undefined
                          }
                          workspaces={
                            workspaceContextActive
                              ? composerWorkspaces
                              : undefined
                          }
                          selectedWorkspaceCwd={
                            workspaceContextActive
                              ? connection.sessionId
                                ? ordinaryWorkspaces.find(
                                    (entry) =>
                                      entry.cwd === connection.workspaceCwd &&
                                      !entry.primary,
                                  )?.cwd
                                : selectedWorkspaceCwd
                              : undefined
                          }
                          workspaceSelectionDisabled={!workspaceContextActive}
                          atWorkspaceCwd={
                            workspaceContextActive
                              ? (ordinaryWorkspaces.find(
                                  (entry) => entry.cwd === lockedWorkspaceCwd,
                                )?.cwd ??
                                (connection.sessionId
                                  ? connection.workspaceCwd
                                  : resolveWorkspaceMaintenanceTargetCwd()))
                              : undefined
                          }
                          composerScopeKey={
                            effectiveSessionContext?.kind === 'standalone'
                              ? 'standalone'
                              : effectiveSessionContext?.kind === 'live'
                                ? 'live'
                                : undefined
                          }
                          workspaceFeaturesEnabled={workspaceContextActive}
                          onSelectWorkspace={
                            workspaceContextActive
                              ? handleSelectComposerWorkspace
                              : undefined
                          }
                          scratchWorkspaceSupported={
                            workspaceContextActive &&
                            scratchWorkspaceRegistrationSupported
                          }
                          existingFolderWorkspaceSupported={
                            workspaceContextActive &&
                            dynamicWorkspaceRegistrationSupported
                          }
                          workspaceMutationBusy={workspaceMutationBusy}
                          onCreateScratchWorkspace={
                            workspaceContextActive
                              ? handleCreateComposerScratchWorkspace
                              : undefined
                          }
                          onOpenExistingWorkspace={
                            workspaceContextActive
                              ? handleOpenExistingWorkspace
                              : undefined
                          }
                          onChatWidthModeChange={handleChatWidthModeChange}
                          sessionId={connection.sessionId}
                          sessionName={sessionDisplayName}
                          dialogOpen={
                            interactionBlocked || approvalOverlayActive
                          }
                          followupState={followupState}
                          onAcceptFollowup={onAcceptFollowup}
                          onDismissFollowup={onDismissFollowup}
                          composerInput={composerInput}
                          composerInputVersion={composerInputVersion}
                          placeholderText={composerPlaceholderText}
                        />
                        {CustomComposerFooter && (
                          <CustomComposerFooter
                            disabled={isDisabled}
                            isRunning={
                              streamingState !== 'idle' ||
                              sessionHasActivePrompt
                            }
                            currentMode={currentMode}
                            currentModel={currentModel}
                            sessionName={sessionDisplayName}
                          />
                        )}
                      </div>
                      {CustomFooter ? (
                        hasMobileComposerBottom ? (
                          <div className={styles.customFooter}>
                            <CustomFooter
                              connected={connected}
                              mode={currentMode}
                              model={currentModel}
                              streamingState={streamingState}
                              contextUsageRatio={
                                (connection.contextWindow ?? 0) > 0
                                  ? (connection.tokenCount ?? 0) /
                                    (connection.contextWindow ?? 0)
                                  : 0
                              }
                              goalSnapshot={goalSnapshot}
                              activeGoal={activeGoal}
                              tasks={footerTasks}
                              availableModes={MODES_CYCLE}
                              availableModels={(connection.models ?? [])
                                .filter(isVisibleComposerModel)
                                .map((m) => ({
                                  id: m.id,
                                  label: getModelDisplayName(m.label || m.id),
                                  contextWindow: m.contextWindow,
                                }))}
                              skills={composerSkills}
                              onSelectMode={handleSetMode}
                              onSelectModel={handleModelSelect}
                            />
                          </div>
                        ) : (
                          <CustomFooter
                            connected={connected}
                            mode={currentMode}
                            model={currentModel}
                            streamingState={streamingState}
                            contextUsageRatio={
                              (connection.contextWindow ?? 0) > 0
                                ? (connection.tokenCount ?? 0) /
                                  (connection.contextWindow ?? 0)
                                : 0
                            }
                            goalSnapshot={goalSnapshot}
                            activeGoal={activeGoal}
                            tasks={footerTasks}
                            availableModes={MODES_CYCLE}
                            availableModels={(connection.models ?? [])
                              .filter(isVisibleComposerModel)
                              .map((m) => ({
                                id: m.id,
                                label: getModelDisplayName(m.label || m.id),
                                contextWindow: m.contextWindow,
                              }))}
                            skills={composerSkills}
                            onSelectMode={handleSetMode}
                            onSelectModel={handleModelSelect}
                          />
                        )
                      ) : (
                        <StatusBar
                          onSelectMode={() =>
                            setShowApprovalModeDialog((v) => !v)
                          }
                          onSelectModel={() =>
                            setModelDialogMode((v) => (v ? null : 'main'))
                          }
                          onShowContext={() =>
                            showContextUsage('/context', false)
                          }
                          onOpenSettings={() => openPanel('settings')}
                          ref={statusBarRef}
                          onOpenTasks={() => openTasksPanel()}
                          onReturnToInput={handleReturnToEditor}
                          tasks={
                            isChatEmptyState ||
                            !environmentTasksReplacementEnabled
                              ? backgroundTasks
                              : []
                          }
                          hideSettings={
                            hideSettings || !workspaceContextActive
                          }
                          onToggleShortcuts={handleToggleShortcuts}
                          compact={true}
                        />
                      )}
                      {isChatEmptyState && welcomeFooter && (
                        <div
                          className={[
                            styles.emptyWelcomeFooter,
                            showMobileWelcomeFooterMiddle
                              ? styles.desktopWelcomeFooter
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {welcomeFooter}
                        </div>
                      )}
                    </div>
                  </WebShellCustomizationProvider>
                </div>
              </div>
            </div>
            {environmentPanelMounted && (
              <EnvironmentPanel
                floating={!environmentPanelFits}
                hidden={!environmentPanelVisible || artifactPanelFullscreen}
                workspaceCwd={
                  workspaceContextActive
                    ? (sessionWorktree?.path ?? activeWorkspaceCwd)
                    : undefined
                }
                gitWorkspaceCwd={
                  workspaceContextActive && connection.sessionId
                    ? gitDiffWorkspaceCwd
                    : undefined
                }
                gitCwd={
                  workspaceContextActive ? sessionWorktree?.path : undefined
                }
                branch={workspaceContextActive ? activeGitBranch : undefined}
                gitStatus={
                  workspaceContextActive ? selectedWorkspaceGitStatus : undefined
                }
                tasks={sessionTasks}
                agentTasks={environmentAgentTasks}
                items={environmentPanelItems}
                onOpenGitDiff={
                  gitDiffWorkspaceCwd ? handleOpenGitDiff : undefined
                }
                onOpenGitCommit={
                  gitDiffWorkspaceCwd ? handleOpenCommit : undefined
                }
                onOpenAgent={openEnvironmentAgent}
                onOpenTask={openEnvironmentTask}
                onDismiss={dismissEnvironmentPanel}
              />
            )}
            {artifactPanelOpen && useFloatingArtifactPanel && (
              <Drawer
                open
                autoFocus={floatingArtifactDrawerAutoFocus}
                direction="right"
                shouldScaleBackground={false}
                onOpenChange={(open) => {
                  if (!open) closeArtifactPanel();
                }}
              >
                <DrawerContent
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) {
                      setWaitForSubagentPanelAnimation(false);
                    }
                  }}
                  className={
                    artifactPanelFullscreen
                      ? 'data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:sm:max-w-none data-[vaul-drawer-direction=right]:rounded-none data-[vaul-drawer-direction=right]:border-0 data-[vaul-drawer-direction=right]:pt-[env(safe-area-inset-top)] data-[vaul-drawer-direction=right]:pr-[env(safe-area-inset-right)] data-[vaul-drawer-direction=right]:pb-[env(safe-area-inset-bottom)] data-[vaul-drawer-direction=right]:pl-[env(safe-area-inset-left)]'
                      : 'shadow-2xl data-[vaul-drawer-direction=right]:w-[min(520px,calc(100vw-16px))] data-[vaul-drawer-direction=right]:sm:max-w-[520px]'
                  }
                  overlayProps={{ className: 'bg-black/35 backdrop-blur-[1px]' }}
                  onCloseAutoFocus={(event) => {
                    const trigger = artifactPanelTriggerRef.current;
                    artifactPanelTriggerRef.current = null;
                    if (!trigger?.isConnected) return;
                    event.preventDefault();
                    trigger.focus();
                  }}
                  onEscapeKeyDown={(event) => {
                    if (isWebTerminalTarget(event)) {
                      event.preventDefault();
                      return;
                    }
                    if (event.isComposing || event.keyCode === 229) {
                      // IME owns Escape; keep the dismiss layer from acting
                      // on it. The preserveImeEscape mask above normally
                      // hides composition Escapes from this handler entirely.
                      event.preventDefault();
                      return;
                    }
                    // Fullscreen is the topmost surface: Escape shrinks the
                    // panel back to its drawer width. Without this the
                    // drawer's dismiss layer would close the panel instead.
                    if (!artifactPanelFullscreen) return;
                    event.preventDefault();
                    setArtifactPanelFullscreen(false);
                  }}
                >
                  <DrawerTitle className="sr-only">Right panel</DrawerTitle>
                  <WebShellCustomizationProvider value={customization}>
                    <ArtifactPanel
                      {...artifactPanelSharedProps}
                      onOpenTerminal={
                        webTerminalAvailable ? openTerminalTab : undefined
                      }
                      variant="drawer"
                    />
                  </WebShellCustomizationProvider>
                </DrawerContent>
              </Drawer>
            )}
              </div>
            </div>
            {/* Stays mounted even when the panel is closed: the fullscreen
                effect moves it to the portal root, and React must never
                delete it while it is parked there. */}
            <div
              ref={setArtifactPanelSlotEl}
              className={styles.artifactPanelSlot}
            />
            {/* The wrapper portals into the slot above, and the fullscreen
                effect moves that slot to the portal root (and back), so the
                panel stays mounted across the mode change. While fullscreen
                it is the modal surface: dialog role/name plus Tab containment
                (what the floating variant gets from vaul's Radix dialog). */}
            {artifactPanelOpen &&
              !useFloatingArtifactPanel &&
              artifactPanelSlotEl &&
              createPortal(
                <div
                  ref={artifactPanelFullscreenSurfaceRef}
                  tabIndex={-1}
                  onKeyDown={handleArtifactPanelSurfaceKeyDown}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) {
                      setWaitForSubagentPanelAnimation(false);
                    }
                  }}
                  {...(artifactPanelFullscreen
                    ? { role: 'dialog' as const, 'aria-label': 'Right panel' }
                    : {})}
                  className={
                    artifactPanelFullscreen
                      ? styles.artifactPanelFullscreen
                      : [
                          styles.artifactPanelDock,
                          suppressArtifactDockOpenAnimation
                            ? styles.artifactPanelDockNoOpenAnimation
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(' ')
                  }
                  style={
                    {
                      '--artifact-panel-dock-width': `${artifactPanelWidth + 4}px`,
                    } as CSSProperties
                  }
                >
                  {!artifactPanelFullscreen && (
                    <div
                      className={styles.artifactResizeHandle}
                      role="separator"
                      aria-orientation="vertical"
                      aria-valuemin={MIN_ARTIFACT_PANEL_WIDTH}
                      aria-valuemax={getMaxArtifactPanelWidth()}
                      aria-valuenow={artifactPanelWidth}
                      onPointerDown={handleArtifactPanelResizeStart}
                    />
                  )}
                  <WebShellCustomizationProvider value={customization}>
                    <div className={styles.artifactPanelClip}>
                      <ArtifactPanel
                        {...artifactPanelSharedProps}
                        onOpenTerminal={
                          webTerminalAvailable ? openTerminalTab : undefined
                        }
                        panelWidth={artifactPanelWidth}
                      />
                    </div>
                  </WebShellCustomizationProvider>
                </div>,
                artifactPanelSlotEl,
              )}
          </div>
        </div>
        </CompactModeContext.Provider>
        </WebShellPortalRootContext.Provider>
        </McpAppHostContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  );
}
