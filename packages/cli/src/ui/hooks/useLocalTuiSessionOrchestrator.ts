/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createMcpResourceAttachmentSource } from '../../utils/mcpResourceAttachments.js';
import {
  PermissionModeUnavailableError,
  countRequestTokens,
  buildModelProjectionOptions,
} from '@qwen-code/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import * as nodePath from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { registerCleanup } from '../../utils/cleanup.js';
import {
  createQueryBusinessInfo,
  businessInfoContext,
  type BusinessInfo,
  CompressionPipeline,
  CompressionStatus,
  CoreEvent,
  DEFAULT_MAX_TURNS,
  DefaultHookCoordinator,
  FileHistoryManager,
  HookEventName,
  NoopHookCoordinator,
  SessionStateStore,
  setCwd,
  setOriginalCwd,
  SystemPromptAssembler,
  type TranscriptWriterHandle,
  applyPostCompact,
  applyMcpLazyLoad,
  buildStartupMemoryPrefix,
  clearSessionPromptCaches,
  createStartupMemoryContext,
  createTurnPromptResolver,
  type AiTitleOrigin,
  type TurnPromptResolver,
  type ApplyPostCompactCallbacks,
  type AttachmentExternalContext,
  restoreAttachment,
  type AttachmentToolUseContext,
  type CacheSafeQuerySnapshot,
  type HookAttachment,
  type Config,
  type ModelInputContentBlock,
  type ModelImageBlock,
  type ModelStreamUserContent,
  type EditorType,
  type Message,
  type PastedContent,
  type PendingHookOutput,
  type QueryEvent,
  type PromptBuildResult,
  type Terminal,
  createAttachmentContext,
  createCompactRequestResolver,
  createSystemMessage,
  createUserMessage,
  modelInputToTranscriptBlock,
  createSyntheticUserCaveatMessage,
  countAiTitleCadenceHumanPromptMessages,
  runLogger,
  TASK_UPDATE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  filterOrphanedImages,
  generateSessionTitleForCurrentSession,
  getAttachmentMessages,
  getSkillListingConfig,
  getModelVisibleSkillsForTools,
  getOriginalCwd,
  getSessionTranscriptPath,
  migrateLegacyWorktreeTranscript,
  recordInitialWorktreeTranscriptState,
  isChainParticipant,
  isContextAttachmentMessage,
  isCommandStyleUserPromptText,
  isAbortError,
  isTitleEligibleAssistantMessage,
  parseImagePlaceholderIds,
  resolveErrorPresentation,
  QODER_PROVIDER_ID,
  formatApiErrorDisplayMessage,
  findModelInferenceError,
  getResultErrorCode,
  parseAndFormatApiErrorMessage,
  parseReasoningEffortLevel,
  pickQueryOverrides,
  materializePastedContents,
  processPastedImages,
  query,
  createQueryEventBus,
  capturePromptSuggestionForkSource,
  canGeneratePromptSuggestionFork,
  tryGeneratePromptSuggestion,
  partToString,
  coreEvents,
  isSameOrChildPath,
  normalizePathForCompare,
  normalizeMessagesForAPI,
  restoreAttachmentTranscriptState,
  restoreInvokedSkillsFromTranscript,
  snapshotAttachmentDeltaState,
  enqueueHookOutput,
  recordSessionUsageInMemory,
  loadLatestSessionUsage,
  flushSessionUsage,
  sessionIdContext,
  seedStartupStaticMemoryFileReadState,
  uiTelemetryService,
  stripThoughtSignaturesFromMessages,
  ensureConfigReadyForRequest,
  getPromptSuggestionFeatureConfig,
  isPromptSuggestionPolicyCurrent,
  subscribePromptSuggestionFeatureGate,
  executeUserInput,
  type ProcessInputResult,
  type PlanStateChangedPayload,
  type QueuedCommand,
  runWithWorkspaceTransition,
  isVisionSupportedModel,
  IMAGE_EXTENSIONS,
  parseAtMentionedPaths,
  type PermissionMode,
  executeConversationRewind,
  isHumanTaskInputMessage,
  isTaskTriggeringPrompt,
  planHistoricalConversationRewind,
  TranscriptRepository,
  type ConversationRewindPlan,
  PROMPT_SECTION_ID,
} from '@qwen-code/core';
import { applyResumeWorktreeState } from '../../utils/applyResumeWorktreeState.js';
import type { PartListUnion } from '@google/genai';
import {
  appEvents,
  AppEvent,
  TransientMessageType,
} from '../../utils/events.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  bindSessionUsagePersistence,
  INTERACTIVE_USAGE_REQUEST_SETTLE_TIMEOUT_MS,
  type SessionUsagePersistenceDisposer,
} from './sessionUsagePersistence.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType, StreamingState } from '../types.js';
import type {
  HistoryItemCompression,
  HistoryItemWithoutId,
  ModelQueueProps,
  SlashCommandProcessorResult,
} from '../types.js';
import {
  buildStopHookSummaryHistoryItem,
  type StopHookSummaryProps,
} from '../components/messages/StopHookSummaryMessage.js';
import { buildTaskNotificationHistoryItem } from '../components/messages/TaskNotificationMessage.js';
import { buildTeammateMessageHistoryItem } from '../components/messages/TeammateMessage.js';
import {
  buildPeerMessageHistoryItem,
  type PeerOriginLike,
} from '../components/messages/PeerMessage.js';
import {
  buildHookAttachmentHistoryItem,
  isStopHookEvent,
} from '../components/messages/HookAttachmentMessage.js';
import {
  ExternalImportApprovalChoice,
  type ExternalImportApprovalResult,
} from '../components/ExternalImportApprovalDialog.js';
import { approveExternalImportsForProject } from '../../config/externalImportApproval.js';
import {
  EMPTY_EXTERNAL_IMPORT_STATE,
  type BashCommandOutcome,
  type ExternalImportApprovalState,
  type LocalTuiSessionOrchestratorResult,
  type ManualCompressResult,
  type ReplaceMessagesOptions,
  type LocalRewindOptions,
  type RuntimeProjectionController,
  type SubmitQueryOptions,
  type SubmitUserInputOptions,
} from './localSession.shared.js';

interface TuiSessionRuntimeState {
  targetDir: string;
  workingDir: string;
  shellOriginalCwd: string;
  workspaceDirectories: readonly string[];
  worktreeSettings: import('@qwen-code/core').WorktreeSettings | undefined;
  processCwd?: string;
  clearPromptAssemblerCache?: boolean;
  onWarning?: (stage: 'chdir' | 'workspace', error: unknown) => void;
}

function applyTuiSessionRuntimeState(
  config: Config,
  state: TuiSessionRuntimeState,
): void {
  config.setWorktreeSettings(state.worktreeSettings);
  config.setTargetDir(state.targetDir);
  config.setWorkingDir(state.workingDir);
  setCwd(state.workingDir);
  setOriginalCwd(state.shellOriginalCwd);
  try {
    config.getWorkspaceContext().setDirectories(state.workspaceDirectories);
  } catch (error) {
    if (state.onWarning) state.onWarning('workspace', error);
    else throw error;
  }
  if (state.processCwd && process.cwd() !== state.processCwd) {
    try {
      process.chdir(state.processCwd);
    } catch (error) {
      if (state.onWarning) state.onWarning('chdir', error);
      else throw error;
    }
  }
  config.refreshRuntimeWorkspaceServices();
  // 静默投影与失败回滚都要重绑监听；CwdChanged 只在恢复成功后发送。
  config.getHookSystem()?.updateFileWatcherCwd(state.workingDir);
  if (state.clearPromptAssemblerCache) clearSessionPromptCaches(config);
}
import { formatSupplementarySystemContent } from './useRuntimeProjection.js';
import {
  LocalTuiSessionAdapter,
  type LocalTuiSessionSource,
} from '../session/localTuiSessionAdapter.js';
import { useModel } from '../contexts/ConfigContext.js';
import type { PermissionQueueStore } from '../permissions/permissionQueueStore.js';
import type { SessionResumeData } from '@qwen-code/core';
import {
  formatBashInput,
  formatBashOutput,
  formatCommandOutput,
  formatRawCommandInput,
} from '../utils/commandFormat.js';
import { modelQueueFromStatusEvent } from '../utils/modelQueueProgress.js';
import type { AppFocusStateMachine } from '../state/AppFocusStateMachine.js';
import { extractText } from '../../session/messageInput.js';
import {
  commitAiTitleCadenceForTurn,
  planAiTitleCadenceForTurn,
  type AiTitleCheckOptions,
} from './aiTitleTrigger.js';
import {
  recordTranscriptRuntimeConfig,
  registerTranscriptRuntimeConfigRecorder,
} from '../../utils/runtimeConfigTranscript.js';
import { buildTuiPromptSuggestionSystemPrompt } from '../utils/tuiPromptSuggestion.js';
import { getAppPlugins } from '../../app-plugins/registry.js';
import { getTranscriptGitBranch } from '../../utils/transcriptMetadata.js';
import { RootToolRegistry } from '../../session/rootToolRegistry.js';
import { PRESENT_FILES_TOOL_NAME } from '../../session/artifacts/artifactProtocol.js';

interface PendingTranscriptRecord {
  sessionId: string;
  message: Message;
  reason: 'no_writer' | 'session_mismatch' | 'write_failed';
}

type ScheduleAiTitleCheckOptions = AiTitleCheckOptions & {
  businessInfo?: Readonly<BusinessInfo>;
  /** Generate a useful title while the first model turn is still running. */
  description?: string;
  /**
   * Let an early title request finish before checking the completed turn.
   * The completed-turn check is skipped when the early request wrote a title.
   */
  waitForInFlight?: boolean;
};

interface AiTitleGeneration {
  controller: AbortController;
  didWriteTitle: boolean;
  promise: Promise<void>;
  sessionId: string;
}

interface PromptSuggestionGeneration {
  controller: AbortController;
  promise: Promise<void>;
  sessionId: string;
}

interface SessionUsageHydrationGate {
  promise: Promise<void>;
  resolve: () => void;
  sessionId: string;
  settled: boolean;
}

const BACKGROUND_MODEL_REQUEST_SETTLE_TIMEOUT_MS = 30_000;

function createSessionUsageHydrationGate(
  sessionId: string,
): SessionUsageHydrationGate {
  let resolvePromise: (() => void) | undefined;
  const gate: SessionUsageHydrationGate = {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => {
      gate.settled = true;
      resolvePromise?.();
      resolvePromise = undefined;
    },
    sessionId,
    settled: false,
  };
  return gate;
}

function waitForBackgroundModelRequests(
  requests: ReadonlyArray<Promise<void>>,
): Promise<boolean> {
  if (requests.length === 0) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };

    void Promise.allSettled(requests).then(() => finish(true));
    const timer = setTimeout(
      () => finish(false),
      BACKGROUND_MODEL_REQUEST_SETTLE_TIMEOUT_MS,
    );
  });
}

type LocalSlashCommandResult =
  | SlashCommandProcessorResult
  | ProcessInputResult
  | false;

const NOOP_AWAIT_SESSION_START_HOOKS = (_signal?: AbortSignal): Promise<void> =>
  Promise.resolve();

const READY_MODEL_QUEUE_CLEAR_DELAY_MS = 1200;
const MAX_TUI_PROMPT_SUGGESTIONS = 1;

function splitPromptSuggestionLines(suggestion: string): string[] {
  const seen = new Set<string>();
  return suggestion
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    })
    .slice(0, MAX_TUI_PROMPT_SUGGESTIONS);
}

interface UseLocalTuiSessionOrchestratorOptions {
  config: Config;
  settings: LoadedSettings;
  addItem: UseHistoryManagerReturn['addItem'];
  getDisplayPendingHistory?: () => readonly HistoryItemWithoutId[];
  setSystemPrompt?: (prompt: string) => void;
  setAppendSystemPrompt?: (prompt: string) => void;
  displayHistory?: UseHistoryManagerReturn['history'];
  permissionQueue?: PermissionQueueStore | null;
  isReadyForSessionInput?: () => boolean;
  restoreSession?: (data: SessionResumeData) => Promise<boolean>;
  getPreferredEditor: () => EditorType | undefined;
  onCancelSubmit: (shouldRestorePrompt?: boolean) => void;
  focusMachine: AppFocusStateMachine | null;
  onCoreEvent?: (event: QueryEvent) => void;
  onTurnComplete?: () => void;
  onPromptSuggestions?: (
    suggestions: readonly string[],
    promptId: string,
  ) => void;
  onLocalUserMessage?: (message: {
    text: string;
    contentBlocks?: readonly ModelInputContentBlock[];
    uuid: string;
  }) => void;
  onProvisionalSessionTitle?: (submittedPrompt: string) => void;
  onLocalSessionTitle?: (title: string) => void;
  onLocalAiTitle?: (title: string, origin: AiTitleOrigin) => void;
  /** Shows startup-readiness progress outside the resumable conversation feed. */
  /**
   * Set to true once the first-turn readiness wait outlasts a short grace
   * period, and back to false when the wait ends.
   */
  onStartupWaitingChange?: (waiting: boolean) => void;
  onSlashCommand?: (
    input: string,
    pastedContents?: Record<number, PastedContent>,
  ) => Promise<LocalSlashCommandResult>;
  isSlashCommandInput?: (input: string) => boolean;
  onBridgeSlashCommand?: (
    input: string,
  ) =>
    | Promise<{ allow: true } | { allow: false; message: string } | null>
    | { allow: true }
    | { allow: false; message: string }
    | null;
  onBashCommand?: (
    input: string,
    signal: AbortSignal,
  ) => Promise<BashCommandOutcome | false>;
  systemPromptOverride?: string | null;
  appendSystemPrompt?: string | null;
  initialConversationHistory?: Message[];
  initialSessionTitle?: string;
  /** 初始 Resume 由恢复入口按选中的精确路径创建 Writer，禁止先写默认 bucket。 */
  deferInitialTranscriptWriter?: boolean;
  version: string;
  gitBranch?: string;
  runtimeProjectionRef: MutableRefObject<RuntimeProjectionController>;
  /** Awaited inside submitQuery to gate the first model request on startup readiness. */
  awaitSessionStartHooks?: (signal?: AbortSignal) => Promise<void>;
}

export function isChildScopedQueryEvent(event: QueryEvent): boolean {
  return (
    'parent_tool_use_id' in event &&
    typeof event.parent_tool_use_id === 'string' &&
    event.parent_tool_use_id.length > 0
  );
}

/**
 * Creates a runtime-message duplicate detector backed by an incrementally
 * maintained UUID set. Appends are indexed once; replacing the message array
 * after resume, rewind, or compaction rebuilds the set from the new history.
 */
export function createRuntimeMessageUuidDeduplicator(
  getMessages: () => readonly Message[],
): (message: { readonly uuid?: string }) => boolean {
  let indexedMessages: readonly Message[] | null = null;
  let indexedLength = 0;
  let messageUuids = new Set<string>();

  return (message): boolean => {
    const messages = getMessages();
    if (messages !== indexedMessages || messages.length < indexedLength) {
      indexedMessages = messages;
      indexedLength = 0;
      messageUuids = new Set<string>();
    }
    for (let index = indexedLength; index < messages.length; index++) {
      const uuid = messages[index]?.uuid;
      if (uuid !== undefined) messageUuids.add(uuid);
    }
    indexedLength = messages.length;

    const uuid = message.uuid;
    if (uuid === undefined || !messageUuids.has(uuid)) {
      if (uuid !== undefined) messageUuids.add(uuid);
      return false;
    }
    return true;
  };
}

function isModelQueueStatusEvent(event: QueryEvent): event is Extract<
  QueryEvent,
  { type: 'system' }
> & {
  subtype: 'model_queue_status';
} {
  return event.type === 'system' && event.subtype === 'model_queue_status';
}

/**
 * Extract display text from a queued_command attachment prompt.
 * Handles both plain string and ContentBlockParam[] (rich text with images).
 */
function extractQueuedCommandText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt.trim();
  if (Array.isArray(prompt)) {
    return prompt
      .filter(
        (b): b is { type: 'text'; text: string } =>
          b != null &&
          typeof b === 'object' &&
          'type' in b &&
          b.type === 'text' &&
          'text' in b &&
          typeof b.text === 'string',
      )
      .map((b) => b.text)
      .join('')
      .trim();
  }
  return '';
}

interface QueuedCommandDisplayMetadata {
  commandMode?: string;
  origin?: string | ({ kind: string; transport?: string } & PeerOriginLike);
  isMeta?: boolean;
  displaySummary?: string;
  displayColor?: string;
}

function peerOriginOf(
  attachment: unknown,
): ({ kind: string; transport?: string } & PeerOriginLike) | undefined {
  if (typeof attachment !== 'object' || attachment === null) return undefined;
  const origin = (attachment as QueuedCommandDisplayMetadata).origin;
  return typeof origin === 'object' && origin !== null && origin.kind === 'peer'
    ? origin
    : undefined;
}

function isPeerQueuedCommand(attachment: unknown): boolean {
  return peerOriginOf(attachment) !== undefined;
}

/**
 * Whether a peer command came over the cross-session transport.
 *
 * `origin.kind === 'peer'` is not the discriminator: in-process teammate
 * mailbox messages carry it too (`agent-team-main-delivery.ts`), and they render
 * through their own component. Only the UDS transport sets `transport`.
 */
function isCrossSessionQueuedCommand(attachment: unknown): boolean {
  return peerOriginOf(attachment)?.transport === 'uds';
}

function buildQueuedCommandHistoryItem(
  attachment: unknown,
  text: string,
): HistoryItemWithoutId | null {
  const metadata =
    typeof attachment === 'object' && attachment !== null
      ? (attachment as QueuedCommandDisplayMetadata)
      : {};
  if (metadata.commandMode === 'task-notification') {
    return buildTaskNotificationHistoryItem(text);
  }
  if (isCrossSessionQueuedCommand(attachment)) {
    return buildPeerMessageHistoryItem({
      text,
      ...(peerOriginOf(attachment) && { origin: peerOriginOf(attachment) }),
      ...(metadata.displaySummary !== undefined && {
        displaySummary: metadata.displaySummary,
      }),
    });
  }
  if (isPeerQueuedCommand(attachment)) {
    return buildTeammateMessageHistoryItem(
      text,
      metadata.displaySummary,
      metadata.displayColor,
    );
  }
  if (metadata.isMeta) return null;
  return { type: MessageType.USER, text };
}

function isSameModelQueueState(
  previous: ModelQueueProps | undefined,
  next: ModelQueueProps,
): boolean {
  if (previous === undefined) return false;
  const keys = Object.keys(next) as Array<keyof ModelQueueProps>;
  return keys.every((k) => previous[k] === next[k]);
}

function updateActiveModelQueue(
  event: Extract<QueryEvent, { type: 'system' }> & {
    subtype: 'model_queue_status';
  },
  currentQueueRef: MutableRefObject<ModelQueueProps | undefined>,
  setActiveModelQueue: (modelQueue: ModelQueueProps | null) => void,
): { modelQueue: ModelQueueProps; didUpdate: boolean } {
  const previousQueue = currentQueueRef.current;
  const modelQueue = modelQueueFromStatusEvent(event, previousQueue);
  currentQueueRef.current = modelQueue;

  if (isSameModelQueueState(previousQueue, modelQueue)) {
    return { modelQueue, didUpdate: false };
  }

  setActiveModelQueue(modelQueue);

  return { modelQueue, didUpdate: true };
}

/**
 * Build only when the request is ready to consume the resolver. In particular,
 * base config readiness does not imply authenticated remote policy readiness.
 * Local slash commands may never consume it at all. The registry guard is
 * still needed for inputs that bypass the normal first-turn readiness path.
 */
export function createTurnPromptResolverAfterRegistryReady(
  config: Config,
  createResolver: () => Promise<TurnPromptResolver>,
): (signal?: AbortSignal) => Promise<TurnPromptResolver> {
  let resolverPromise: Promise<TurnPromptResolver> | undefined;
  return async (signal?: AbortSignal): Promise<TurnPromptResolver> => {
    if (!resolverPromise) {
      if (!config.isInitialized()) {
        await config.waitForStartupGate('base', { signal });
      }
      resolverPromise = createResolver();
    }
    return resolverPromise;
  };
}

/**
 * Convert a hook attachment to a history item and append it via the provided
 * addItem callback. No-op when the attachment maps to nothing renderable
 * (e.g. silenced Stop continuation).
 */
function renderHookAttachmentToHistory(
  attachment: HookAttachment,
  addItem: (item: HistoryItemWithoutId) => void,
): void {
  const historyItem = buildHookAttachmentHistoryItem(attachment);
  if (historyItem) {
    historyItem.toolCallId = attachment.toolUseID;
    historyItem.isAncillary = true;
    addItem(historyItem);
  }
}

/**
 * Restore raw attachment data and select the precise hook attachment union.
 */
function getHookAttachment(value: unknown): HookAttachment | undefined {
  const attachment = restoreAttachment(value);
  switch (attachment?.type) {
    case 'hook_blocking_error':
    case 'hook_non_blocking_error':
    case 'hook_error_during_execution':
    case 'hook_success':
    case 'hook_cancelled':
    case 'hook_stopped_continuation':
    case 'hook_system_message':
    case 'hook_permission_decision':
      return attachment;
    default:
      return undefined;
  }
}

class TranscriptWriteError extends Error {
  constructor(
    readonly transcriptPath: string,
    cause: unknown,
  ) {
    super(describeTranscriptWriteError(transcriptPath, cause), { cause });
    this.name = 'TranscriptWriteError';
  }
}

function describeTranscriptWriteError(
  transcriptPath: string,
  error: unknown,
): string {
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : undefined;
  return (
    `Failed to save the session transcript at ${transcriptPath}` +
    (code ? ` (${code})` : '') +
    '. Check the file and directory permissions or available disk space, then retry.'
  );
}

function transcriptPathForSession(
  writer: TranscriptWriterHandle | null,
  config: Config,
  sessionId: string,
): string {
  return writer?.getSessionId() === sessionId
    ? writer.getSessionFilePath()
    : getSessionTranscriptPath(
        config.getSessionArtifactProjectRoot(),
        sessionId,
      );
}

function formatTuiApiError(error: unknown, providerSource?: string): string {
  if (error instanceof TranscriptWriteError) {
    return error.message;
  }
  const inferenceError = findModelInferenceError(error);
  if (!inferenceError && getResultErrorCode(error) === undefined)
    return parseAndFormatApiErrorMessage(error);
  const presentation = resolveErrorPresentation(error, providerSource);
  return formatApiErrorDisplayMessage(
    inferenceError && providerSource !== QODER_PROVIDER_ID
      ? undefined
      : presentation.displayErrorCode,
    presentation.fallbackMessage,
  );
}

export function buildBashCommandProcessResult(
  outcome: BashCommandOutcome,
  respondToBashCommands = false,
): ProcessInputResult {
  const messages = [
    createUserMessage(formatBashInput(outcome.command), {
      isMeta: true,
    }),
    createUserMessage(
      formatBashOutput(outcome.modelOutput.stdout, outcome.modelOutput.stderr),
      {
        isMeta: true,
      },
    ),
  ];

  if (respondToBashCommands && outcome.kind === 'completed') {
    return { messages, shouldQuery: true };
  }

  return {
    messages: [createSyntheticUserCaveatMessage(), ...messages],
    shouldQuery: false,
  };
}

export function useLocalTuiSessionOrchestrator(
  options: UseLocalTuiSessionOrchestratorOptions,
): LocalTuiSessionOrchestratorResult {
  const {
    config,
    settings,
    addItem,
    getPreferredEditor,
    onCancelSubmit,
    focusMachine,
    onCoreEvent: forwardCoreEvent,
    onTurnComplete: forwardTurnComplete,
    onPromptSuggestions,
    onLocalUserMessage: forwardLocalUserMessage,
    onProvisionalSessionTitle,
    onLocalSessionTitle: forwardLocalSessionTitle,
    onLocalAiTitle: forwardLocalAiTitle,
    onStartupWaitingChange,
    onSlashCommand,
    isSlashCommandInput: classifySlashCommandInput,
    onBridgeSlashCommand,
    onBashCommand,
    systemPromptOverride,
    appendSystemPrompt,
    initialConversationHistory,
    initialSessionTitle,
    version,
    runtimeProjectionRef,
    awaitSessionStartHooks = NOOP_AWAIT_SESSION_START_HOOKS,
  } = options;
  const model = useModel(config);
  const sessionSourceRef = useRef<LocalTuiSessionSource | null>(null);
  const sessionOwner = useMemo<{
    config: Config;
    adapter?: LocalTuiSessionAdapter;
  }>(() => ({ config }), [config]);
  const getSession = useCallback(
    () =>
      (sessionOwner.adapter ??= new LocalTuiSessionAdapter(
        sessionOwner.config,
        () => sessionSourceRef.current,
      )),
    [sessionOwner],
  );
  const onCoreEvent = useCallback(
    (event: QueryEvent) => {
      sessionOwner.adapter?.handleQueryEvent(event);
      forwardCoreEvent?.(event);
    },
    [sessionOwner, forwardCoreEvent],
  );
  const onTurnComplete = useCallback(() => {
    sessionOwner.adapter?.handleTurnComplete();
    forwardTurnComplete?.();
  }, [sessionOwner, forwardTurnComplete]);
  const onLocalUserMessage = useCallback(
    (message: Parameters<NonNullable<typeof forwardLocalUserMessage>>[0]) => {
      sessionOwner.adapter?.handleLocalUserMessage(message);
      forwardLocalUserMessage?.(message);
    },
    [sessionOwner, forwardLocalUserMessage],
  );
  const onLocalSessionTitle = useCallback(
    (title: string) => {
      sessionOwner.adapter?.sync({ title });
      forwardLocalSessionTitle?.(title);
    },
    [sessionOwner, forwardLocalSessionTitle],
  );
  const onLocalAiTitle = useCallback(
    (title: string, origin: AiTitleOrigin) => {
      sessionOwner.adapter?.sync({ title, origin });
      forwardLocalAiTitle?.(title, origin);
    },
    [sessionOwner, forwardLocalAiTitle],
  );
  const isSlashCommandInput = useCallback(
    (input: string): boolean =>
      classifySlashCommandInput?.(input) ??
      (input.trim().startsWith('/') && isCommandStyleUserPromptText(input)),
    [classifySlashCommandInput],
  );
  const isCommandStyleInput = useCallback(
    (input: string): boolean =>
      classifySlashCommandInput
        ? input.trim().startsWith('?') || isSlashCommandInput(input)
        : isCommandStyleUserPromptText(input),
    [classifySlashCommandInput, isSlashCommandInput],
  );
  const respondToBashCommands =
    options.settings.merged.respondToBashCommands ?? false;
  const configuredMaxTurns = settings.merged.ui?.maxTurns;
  const maxTurns =
    configuredMaxTurns === 'unlimited'
      ? undefined
      : (configuredMaxTurns ?? DEFAULT_MAX_TURNS);

  const messagesRef = useRef<Message[]>(
    initialConversationHistory ? [...initialConversationHistory] : [],
  );
  const runtimeMessageUuidDeduplicatorRef = useRef<ReturnType<
    typeof createRuntimeMessageUuidDeduplicator
  > | null>(null);
  const isDuplicateRuntimeMessage =
    (runtimeMessageUuidDeduplicatorRef.current ??=
      createRuntimeMessageUuidDeduplicator(() => messagesRef.current));
  const hasRunAgentQueryRef = useRef(
    (initialConversationHistory ?? []).some(
      (message) => message.type === 'assistant',
    ),
  );
  const lastToolRegistryRef = useRef<ReturnType<Config['getToolRegistry']> | null>(null);
  const lastPromptBuildResultRef = useRef<PromptBuildResult | undefined>(
    undefined,
  );
  const lastCacheSafeQuerySnapshotRef = useRef<CacheSafeQuerySnapshot | null>(
    null,
  );
  const suggestionRuntimeRevisionRef = useRef(0);
  const suggestionPrefixRevisionRef = useRef(0);
  const runtimeSourceSessionIdRef = useRef<string | undefined>(undefined);
  const transcriptWriterRef = useRef<TranscriptWriterHandle | null>(null);
  const sessionStateStoreRef = useRef<SessionStateStore | null>(null);
  const sessionUsagePersistenceDisposerRef = useRef<
    SessionUsagePersistenceDisposer | undefined
  >(undefined);
  const sessionUsageHydrationRef = useRef<SessionUsageHydrationGate | null>(
    null,
  );
  const fileHistoryManagerRef = useRef<FileHistoryManager | null>(null);
  const lastTranscriptParentUuidRef = useRef<string | null>(null);
  const aiTitlePromptCountRef = useRef(0);
  const writerSwitchInFlightRef = useRef<string | null>(null);
  const transcriptRecoveryPromiseRef = useRef<Promise<void> | null>(null);
  const pendingTranscriptRecordsRef = useRef<PendingTranscriptRecord[]>([]);
  const transcriptRecordTailRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentCtxRef = useRef<AttachmentToolUseContext | null>(null);
  const startupStaticMemoryReadStateSeededRef = useRef(false);
  if (attachmentCtxRef.current === null) {
    const attachmentCtx = createAttachmentContext(
      config.getWorkingDir() ?? process.cwd(),
      config.getSessionId(),
      { config },
    );
    restoreAttachmentTranscriptState(attachmentCtx, messagesRef.current);
    attachmentCtxRef.current = attachmentCtx;
  }
  const stopHookAccRef = useRef<StopHookSummaryProps | null>(null);
  const pendingInitialSessionTitleRef = useRef(initialSessionTitle || null);
  const repeatedToolCallAllowedKeysRef = useRef(new Set<string>());
  // One event bus and query state store for every query of this session.
  const [queryEvents] = useState(createQueryEventBus);
  const abortControllerRef = useRef<AbortController | null>(null);
  // The permission hook bridge was created before this tree rendered, so it
  // cannot see the per-turn controller; publish the current turn's abort into
  // this session's Config slot, which the bridge reads on a deny-with-interrupt.
  // Per-session, so a project rebuild swapping Config never lets the outgoing
  // tree's cleanup disarm the incoming tree's bridge.
  useEffect(() => {
    config.setTurnInterrupt(() => abortControllerRef.current?.abort());
    return () => config.setTurnInterrupt(undefined);
  }, [config]);
  const isUnmountedRef = useRef(false);
  const waitingForInitialResumeRef = useRef(
    options.deferInitialTranscriptWriter === true,
  );
  const writerRebuildsRef = useRef(new Set<Promise<void>>());
  const disposePromiseRef = useRef<Promise<void> | undefined>(undefined);
  const turnCancelledRef = useRef(false);
  const activeQueryIdRef = useRef(0);
  const aiTitleGenerationRef = useRef<AiTitleGeneration | null>(null);
  const promptSuggestionGenerationRef =
    useRef<PromptSuggestionGeneration | null>(null);
  const suggestionsEnabled = settings.merged.promptSuggestionEnabled !== false;
  const suggestionsEnabledRef = useRef(suggestionsEnabled);
  useEffect(() => {
    suggestionsEnabledRef.current = suggestionsEnabled;
    if (!suggestionsEnabled && getPromptSuggestionFeatureConfig().forkEnabled) {
      promptSuggestionGenerationRef.current?.controller.abort();
    }
  }, [suggestionsEnabled]);
  const backgroundModelRequestsRef = useRef(new Set<Promise<void>>());
  const [activeModelQueue, setActiveModelQueue] =
    useState<ModelQueueProps | null>(null);
  const [externalImportApprovalState, setExternalImportApprovalState] =
    useState<ExternalImportApprovalState>(EMPTY_EXTERNAL_IMPORT_STATE);
  const dismissedExternalImportFingerprintRef = useRef<string | null>(null);

  const getPreferredEditorRef = useRef(getPreferredEditor);
  useEffect(() => {
    getPreferredEditorRef.current = getPreferredEditor;
  }, [getPreferredEditor]);

  const rootToolRegistry = useMemo(
    () => new RootToolRegistry(config, () => config.getToolRegistry(), []),
    [config],
  );

  // Reset attachment delta tracking when skills are hot-reloaded,
  // so the next turn re-sends the updated skill listing.
  useEffect(
    () =>
      config.onSkillChange(
        () => {
          attachmentCtxRef.current?.sentSkillNames.clear();
        },
        { replay: false },
      ),
    [config],
  );

  const compressionPipeline = useMemo(
    () =>
      new CompressionPipeline({
        target: 'main',
        modelProviderManager: config.getModelProviderManager(),
      }),
    [config],
  );
  const promptAssembler = useMemo(
    () =>
      new SystemPromptAssembler({
        sessionId: config.getSessionId(),
      }),
    [config],
  );
  useEffect(() => {
    config.setPromptAssembler(promptAssembler);
  }, [config, promptAssembler]);
  const hookCoordinator = useMemo(
    () =>
      config.getHookSystem()
        ? new DefaultHookCoordinator(config.getHookSystem()!)
        : new NoopHookCoordinator(),
    [config],
  );
  useEffect(() => () => hookCoordinator.dispose(), [hookCoordinator]);

  const compressionPipelineRef = useRef(compressionPipeline);
  const hookCoordinatorRef = useRef(hookCoordinator);
  useEffect(() => {
    compressionPipelineRef.current = compressionPipeline;
    hookCoordinatorRef.current = hookCoordinator;
  }, [compressionPipeline, hookCoordinator]);

  // Register fork context accessors so that fork subagents (auto-memory,
  // compression, Agent tool) can align their API request prefix with the
  // current parent turn for prompt-cache hits. Closures read from refs that
  // are updated each turn in submitUserInput — registration itself is a
  // one-shot. QueryEngine performs the same wiring for non-TUI entrypoints.
  useEffect(() => {
    config.registerForkContextAccessors({
      getConversationMessages: () => messagesRef.current,
      getPromptBuildResult: () => lastPromptBuildResultRef.current,
      getParentToolSchemas: () =>
        (lastToolRegistryRef.current?.getSchema() ?? []).filter(
          (declaration) => declaration.name !== PRESENT_FILES_TOOL_NAME,
        ),
      getCacheSafeQuerySnapshot: () => lastCacheSafeQuerySnapshotRef.current,
    });
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: ({ refreshTools, refreshSystemPrompt }) => {
        if (refreshTools || refreshSystemPrompt) {
          suggestionRuntimeRevisionRef.current++;
          promptAssembler.clearCache();
        }
      },
      getTranscriptPath: () =>
        transcriptWriterRef.current?.getSessionFilePath(),
      synchronizeWorktreeRuntimeState: (state) =>
        transcriptWriterRef.current?.synchronizeWorktreeRuntimeState(state),
      recordWorktreeState: async (...args) => {
        if (!transcriptWriterRef.current) {
          throw new Error(
            'Worktree state requires an active transcript writer.',
          );
        }
        await transcriptWriterRef.current.recordWorktreeState(...args);
      },
      stripThoughtsFromConversationHistory: () => {
        messagesRef.current = stripThoughtSignaturesFromMessages(
          messagesRef.current,
        );
      },
      persistSessionTitle: async (title: string) => {
        config.topicState.setTopic(title, undefined);
        const writer = transcriptWriterRef.current;
        if (writer) {
          await writer.recordCustomTitle(title);
        }
        try {
          onLocalSessionTitleRef.current?.(title);
        } catch {
          // Input event subscribers must not break local execution
        }
      },
    });
    return () => {
      config.registerForkContextAccessors(undefined);
      config.registerSessionRuntimeBinding(undefined);
    };
  }, [config, promptAssembler]);

  const addItemRef = useRef(addItem);
  const currentModelQueueRef = useRef<ModelQueueProps | undefined>(undefined);
  const readyModelQueueClearTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const onCoreEventRef = useRef(onCoreEvent);
  const onTurnCompleteRef = useRef(onTurnComplete);
  const onPromptSuggestionsRef = useRef(onPromptSuggestions);
  const onLocalUserMessageRef = useRef(onLocalUserMessage);
  const onProvisionalSessionTitleRef = useRef(onProvisionalSessionTitle);
  const onLocalSessionTitleRef = useRef(onLocalSessionTitle);
  const onLocalAiTitleRef = useRef(onLocalAiTitle);
  useEffect(() => {
    addItemRef.current = addItem;
    onCoreEventRef.current = onCoreEvent;
    onTurnCompleteRef.current = onTurnComplete;
    onPromptSuggestionsRef.current = onPromptSuggestions;
    onLocalUserMessageRef.current = onLocalUserMessage;
    onProvisionalSessionTitleRef.current = onProvisionalSessionTitle;
    onLocalSessionTitleRef.current = onLocalSessionTitle;
    onLocalAiTitleRef.current = onLocalAiTitle;
  }, [
    addItem,
    onCoreEvent,
    onTurnComplete,
    onPromptSuggestions,
    onLocalUserMessage,
    onProvisionalSessionTitle,
    onLocalSessionTitle,
    onLocalAiTitle,
  ]);

  const beginSessionUsageHydration = useCallback((sessionId: string) => {
    const currentGate = sessionUsageHydrationRef.current;
    currentGate?.resolve();
    const nextGate = createSessionUsageHydrationGate(sessionId);
    sessionUsageHydrationRef.current = nextGate;
    return nextGate;
  }, []);

  const getPendingSessionUsageHydration = useCallback((sessionId: string) => {
    const gate = sessionUsageHydrationRef.current;
    if (!gate || gate.sessionId !== sessionId || gate.settled) {
      return undefined;
    }
    return gate.promise;
  }, []);

  const generatePromptSuggestionsForTurn = useCallback(
    (
      queryId: number,
      promptId: string,
      requestSetId: string,
      signal: AbortSignal,
      businessInfo: Readonly<BusinessInfo>,
      terminal: Terminal,
    ) => {
      if (settings.merged.promptSuggestionEnabled === false) {
        return;
      }
      const history = messagesRef.current;
      const messages = [...history];
      const sessionId = config.getSessionId();
      void (async () => {
        const revision = suggestionPrefixRevisionRef.current;
        const forkSource =
          getPromptSuggestionFeatureConfig().forkEnabled &&
          canGeneratePromptSuggestionFork(terminal)
            ? capturePromptSuggestionForkSource(
                config,
                promptId,
                requestSetId,
                () =>
                  activeQueryIdRef.current === queryId &&
                  !isUnmountedRef.current &&
                  suggestionsEnabledRef.current &&
                  revision === suggestionRuntimeRevisionRef.current &&
                  history === messagesRef.current &&
                  history.length === messages.length &&
                  history.at(-1) === messages.at(-1),
              )
            : undefined;
        const pendingHydration = getPendingSessionUsageHydration(sessionId);
        if (pendingHydration) {
          await pendingHydration;
        }
        if (
          signal.aborted ||
          isUnmountedRef.current ||
          activeQueryIdRef.current !== queryId ||
          config.getSessionId() !== sessionId
        ) {
          return;
        }

        promptSuggestionGenerationRef.current?.controller.abort();
        const controller = new AbortController();
        const abortFromTurn = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abortFromTurn, { once: true });
        const store = sessionStateStoreRef.current;
        const generation: PromptSuggestionGeneration = {
          controller,
          promise: Promise.resolve(),
          sessionId,
        };
        generation.promise = (async () => {
          const feature = getPromptSuggestionFeatureConfig();
          if (!feature.enabled) return;
          const unsubscribe = subscribePromptSuggestionFeatureGate((config) => {
            if (!isPromptSuggestionPolicyCurrent(feature, config))
              controller.abort();
          });
          try {
            const suggestion = await tryGeneratePromptSuggestion({
              businessInfo,
              forkSource,
              config,
              messages,
              sessionId,
              promptId,
              signal: controller.signal,
              systemPromptOverride:
                feature.mode === 'legacy'
                  ? buildTuiPromptSuggestionSystemPrompt(
                      getAppPlugins(
                        config.getBuiltinPluginContributions(),
                      )?.getAppPluginPromptSuggestionContributions() ?? [],
                    )
                  : undefined,
            });
            const currentConfig = getPromptSuggestionFeatureConfig();
            if (
              !suggestion ||
              controller.signal.aborted ||
              !isPromptSuggestionPolicyCurrent(feature, currentConfig) ||
              (feature.forkEnabled && !forkSource?.isCurrent()) ||
              isUnmountedRef.current ||
              activeQueryIdRef.current !== queryId ||
              settings.merged.promptSuggestionEnabled === false
            ) {
              return;
            }

            const lines = splitPromptSuggestionLines(suggestion.suggestion);
            if (lines.length > 0) {
              onPromptSuggestionsRef.current?.(lines, promptId);
            }
          } finally {
            unsubscribe?.();
          }
        })()
          .catch((error) => {
            runLogger.warn(
              '[TUI PromptSuggestion] Failed to generate suggestion',
              { error },
            );
          })
          .finally(async () => {
            signal.removeEventListener('abort', abortFromTurn);
            if (store) {
              await flushSessionUsage(store).catch((error) => {
                runLogger.warn(
                  '[TUI PromptSuggestion] Failed to flush session usage',
                  { error },
                );
              });
            }
            backgroundModelRequestsRef.current.delete(generation.promise);
            if (promptSuggestionGenerationRef.current === generation) {
              promptSuggestionGenerationRef.current = null;
            }
          });
        promptSuggestionGenerationRef.current = generation;
        backgroundModelRequestsRef.current.add(generation.promise);
      })().catch((error) => {
        runLogger.warn('[TUI PromptSuggestion] Failed to schedule suggestion', {
          error,
        });
      });
    },
    [config, getPendingSessionUsageHydration, settings],
  );

  const clearReadyModelQueueTimer = useCallback(() => {
    if (readyModelQueueClearTimerRef.current !== null) {
      clearTimeout(readyModelQueueClearTimerRef.current);
      readyModelQueueClearTimerRef.current = null;
    }
  }, []);

  const clearActiveModelQueue = useCallback(() => {
    clearReadyModelQueueTimer();
    currentModelQueueRef.current = undefined;
    setActiveModelQueue(null);
  }, [clearReadyModelQueueTimer]);

  const scheduleReadyModelQueueClear = useCallback(() => {
    clearReadyModelQueueTimer();
    readyModelQueueClearTimerRef.current = setTimeout(() => {
      clearActiveModelQueue();
    }, READY_MODEL_QUEUE_CLEAR_DELAY_MS);
  }, [clearReadyModelQueueTimer, clearActiveModelQueue]);

  const scheduleAiTitleCheck = useCallback(
    (options: ScheduleAiTitleCheckOptions = {}) => {
      const scheduledSessionId = config.getSessionId();
      void (async () => {
        const pendingHydration =
          getPendingSessionUsageHydration(scheduledSessionId);
        if (pendingHydration) {
          await pendingHydration;
        }
        if (
          isUnmountedRef.current ||
          config.getSessionId() !== scheduledSessionId
        ) {
          return;
        }

        const inFlight = aiTitleGenerationRef.current;
        if (
          options.waitForInFlight &&
          inFlight?.sessionId === scheduledSessionId
        ) {
          await inFlight.promise;
          if (
            inFlight.controller.signal.aborted ||
            inFlight.didWriteTitle ||
            config.getSessionId() !== scheduledSessionId
          ) {
            return;
          }
          // A newer request already owns title generation; do not supersede it
          // with this completed-turn fallback.
          if (aiTitleGenerationRef.current) return;
        }

        if (sessionOwner.adapter?.automaticTitleEnabled === false) return;
        const writer = transcriptWriterRef.current;
        if (!writer) return;
        if (writer.getSessionId() !== config.getSessionId()) return;
        const leafUuid = lastTranscriptParentUuidRef.current;
        const description = options.description?.trim();
        if (!leafUuid && !description) return;

        aiTitleGenerationRef.current?.controller.abort();
        const controller = new AbortController();
        const store = sessionStateStoreRef.current;
        const generation: AiTitleGeneration = {
          controller,
          didWriteTitle: false,
          promise: Promise.resolve(),
          sessionId: writer.getSessionId(),
        };
        generation.promise = generateSessionTitleForCurrentSession({
          businessInfo: options.businessInfo,
          config,
          writer,
          ...(description ? { description } : { leafUuidAtSubmit: leafUuid! }),
          signal: controller.signal,
          allowOverwriteAiTitle: options.allowOverwriteAiTitle,
          onTitleWritten: (title: string, origin: AiTitleOrigin) => {
            generation.didWriteTitle = true;
            aiTitlePromptCountRef.current = Math.max(
              1,
              aiTitlePromptCountRef.current,
            );
            try {
              onLocalAiTitleRef.current?.(title, origin);
            } catch {
              // Input event subscribers must not break local execution
            }
          },
        })
          .catch((err: unknown) => {
            runLogger.warn('[AiTitle] background generation failed:', err);
          })
          .finally(() => {
            if (aiTitleGenerationRef.current === generation) {
              if (
                !generation.didWriteTitle &&
                config.getSessionId() === generation.sessionId
              ) {
                aiTitlePromptCountRef.current = 0;
              }
              aiTitleGenerationRef.current = null;
            }
          });
        aiTitleGenerationRef.current = generation;
        const backgroundRequest = generation.promise.finally(async () => {
          if (store) {
            await flushSessionUsage(store).catch((error) => {
              runLogger.warn(
                '[AiTitle] failed to flush background session usage',
                error,
              );
            });
          }
        });
        backgroundModelRequestsRef.current.add(backgroundRequest);
        void backgroundRequest.then(() => {
          backgroundModelRequestsRef.current.delete(backgroundRequest);
        });
      })().catch((err: unknown) => {
        runLogger.warn('[AiTitle] background scheduling failed:', err);
      });
    },
    [config, getPendingSessionUsageHydration, sessionOwner],
  );

  const refreshExternalImportApproval = useCallback(() => {
    const memoryManager = config.getMemoryContextManager();
    if (!memoryManager) {
      dismissedExternalImportFingerprintRef.current = null;
      setExternalImportApprovalState(EMPTY_EXTERNAL_IMPORT_STATE);
      return;
    }
    const pending = memoryManager.getPendingExternalImports();
    if (pending.length > 0) {
      const fingerprint = getExternalImportFingerprint(pending);
      if (dismissedExternalImportFingerprintRef.current === fingerprint) {
        setExternalImportApprovalState(EMPTY_EXTERNAL_IMPORT_STATE);
        return;
      }
      setExternalImportApprovalState({
        isOpen: true,
        pendingImports: pending,
      });
      return;
    }
    dismissedExternalImportFingerprintRef.current = null;
    setExternalImportApprovalState(EMPTY_EXTERNAL_IMPORT_STATE);
  }, [config]);

  useEffect(() => {
    refreshExternalImportApproval();
  }, [refreshExternalImportApproval]);

  useEffect(() => {
    const handleMemoryChanged = () => {
      // MemoryChanged 只影响 memory.auto，别把读文件系统的 section 一起清掉。
      promptAssembler.clearCache(PROMPT_SECTION_ID.memoryAuto);
      refreshExternalImportApproval();
    };
    coreEvents.on(CoreEvent.MemoryChanged, handleMemoryChanged);
    return () => {
      coreEvents.off(CoreEvent.MemoryChanged, handleMemoryChanged);
    };
  }, [promptAssembler, refreshExternalImportApproval]);

  useEffect(
    () =>
      registerTranscriptRuntimeConfigRecorder(
        config,
        () => transcriptWriterRef.current,
      ),
    [config],
  );

  // Keep attachmentCtx in sync with plan enter/exit that happens mid-turn.
  // Plan is reported via PlanStateChanged (driven by PlanStateManager), not
  // PermissionModeChanged, since plan is not a permission mode value.
  useEffect(() => {
    const handlePlanStateChanged = ({ active }: PlanStateChangedPayload) => {
      const ctx = attachmentCtxRef.current;
      if (!ctx) return;
      if (active) {
        ctx.planModeJustEntered = true;
        const plansDir = config.storage.getPlansDir();
        const sessionId = config.getSessionId();
        if (plansDir && sessionId) {
          ctx.currentPlanFilePath = config.planStateManager.getPlanFilePath(
            plansDir,
            sessionId,
          );
        }
      } else {
        // Exiting plan mode mid-turn (via exit_plan_mode tool): set the one-shot
        // flag so the next inter-turn injection emits a plan_mode_exit reminder,
        // letting the model know immediately that it can start coding.
        ctx.planModeJustExited = true;
      }
    };
    coreEvents.on(CoreEvent.PlanStateChanged, handlePlanStateChanged);
    return () => {
      coreEvents.off(CoreEvent.PlanStateChanged, handlePlanStateChanged);
    };
  }, [config]);

  const seedStartupStaticMemoryReadState = useCallback(
    ({ completeWhenEmpty = false }: { completeWhenEmpty?: boolean } = {}) => {
      if (startupStaticMemoryReadStateSeededRef.current) return;
      const ctx = attachmentCtxRef.current;
      if (!ctx) return;
      const seeded = seedStartupStaticMemoryFileReadState(
        ctx,
        config.getMemoryContextManager(),
      );
      if (seeded > 0 || completeWhenEmpty) {
        startupStaticMemoryReadStateSeededRef.current = true;
      }
    },
    [config],
  );

  const rewindFiles = useCallback(
    async (messageId: string) => {
      const manager = config.getFileHistoryManager();
      const cache = attachmentCtxRef.current?.fileReadState;
      if (!manager) return { filesChanged: [], failedFiles: [] };
      try {
        const result = await manager.rewindDetailed(messageId);
        for (const file of [
          ...result.filesChanged,
          ...result.failedFiles.map((f) => f.path),
        ])
          cache?.delete(nodePath.resolve(config.getTargetDir(), file));
        return result;
      } catch (error) {
        cache?.clear();
        throw error;
      }
    },
    [config],
  );

  const rebuildAttachmentContext = useCallback(
    (sessionId: string, cwd: string): AttachmentToolUseContext => {
      const current = attachmentCtxRef.current;
      const next = createAttachmentContext(cwd, sessionId, { config });
      restoreAttachmentTranscriptState(next, messagesRef.current);
      // Hook feedback belongs to the session, even when resume later rebinds
      // its working directory. Re-enqueue outputs after restoring transcript
      // state so SessionStart feedback already present in history is filtered.
      if (current?.agentId === sessionId) {
        for (const output of current.pendingHookOutputs.splice(0)) {
          enqueueHookOutput(next, output);
        }
        next.pendingHookAttachments.push(
          ...current.pendingHookAttachments.splice(0),
        );
      }
      attachmentCtxRef.current = next;
      startupStaticMemoryReadStateSeededRef.current = false;
      seedStartupStaticMemoryReadState();
      return next;
    },
    [config, seedStartupStaticMemoryReadState],
  );

  const ensureAttachmentContext = useCallback(
    (sessionId: string, cwd: string): AttachmentToolUseContext => {
      const current = attachmentCtxRef.current;
      if (current?.agentId === sessionId && current.cwd === cwd) {
        seedStartupStaticMemoryReadState();
        return current;
      }
      return rebuildAttachmentContext(sessionId, cwd);
    },
    [rebuildAttachmentContext, seedStartupStaticMemoryReadState],
  );

  useEffect(() => {
    seedStartupStaticMemoryReadState();
  }, [seedStartupStaticMemoryReadState]);

  useEffect(() => {
    const startupRuntime = config.getStartupRuntime?.();
    return startupRuntime?.onReady('memory', () => {
      seedStartupStaticMemoryReadState({ completeWhenEmpty: true });
    });
  }, [config, seedStartupStaticMemoryReadState]);

  const flushPendingTranscriptRecordsWithWriter = useCallback(
    async (sessionId: string, writer: TranscriptWriterHandle) => {
      const recordsForSession = pendingTranscriptRecordsRef.current.filter(
        (record) => record.sessionId === sessionId,
      );
      if (recordsForSession.length === 0) {
        return;
      }

      pendingTranscriptRecordsRef.current =
        pendingTranscriptRecordsRef.current.filter(
          (record) => record.sessionId !== sessionId,
        );

      try {
        const leafUuid = await writer.recordMessages(
          recordsForSession.map((record) => record.message),
        );
        if (
          transcriptWriterRef.current === writer &&
          config.getSessionId() === sessionId
        ) {
          lastTranscriptParentUuidRef.current = leafUuid;
        }
        runLogger.log(
          'transcript.record.recovered_pending',
          `session=${sessionId}`,
          `count=${recordsForSession.length}`,
        );
      } catch (error) {
        pendingTranscriptRecordsRef.current = [
          ...recordsForSession,
          ...pendingTranscriptRecordsRef.current,
        ];
        throw error;
      }
    },
    [config],
  );

  const rebuildTranscriptWriter = useCallback(
    (
      nextSessionId: string,
      existingMessages: readonly Message[] = [],
      options: ReplaceMessagesOptions = {
        restoreExistingSession: existingMessages.length > 0,
      },
    ) => {
      if (isUnmountedRef.current) {
        return Promise.reject(new Error('TUI session is closing.'));
      }
      const rebuild = runWithWorkspaceTransition(config, async () => {
        const usageHydrationGate = beginSessionUsageHydration(nextSessionId);
        waitingForInitialResumeRef.current = false;
        writerSwitchInFlightRef.current = nextSessionId;
        aiTitleGenerationRef.current?.controller.abort();
        promptSuggestionGenerationRef.current?.controller.abort();
        const previousBackgroundModelRequests = [
          ...backgroundModelRequestsRef.current,
        ];
        const previousWriter = transcriptWriterRef.current;
        transcriptWriterRef.current = null;
        let preparedWriter: TranscriptWriterHandle | null = null;
        let preparedTranscriptParentUuid: string | null = null;
        let previousWriterClosed = false;
        const previousSessionStateStore = sessionStateStoreRef.current;
        const previousUsagePersistenceDisposer =
          sessionUsagePersistenceDisposerRef.current;
        const previousFileHistoryManager = fileHistoryManagerRef.current;
        const previousConfigFileHistoryManager = config.getFileHistoryManager();
        const previousTranscriptParentUuid =
          lastTranscriptParentUuidRef.current;
        const previousAiTitlePromptCount = aiTitlePromptCountRef.current;
        const previousHasRunAgentQuery = hasRunAgentQueryRef.current;
        const previousCwd = process.cwd();
        const previousTargetDir = config.getTargetDir();
        const previousWorkingDir = config.getWorkingDir();
        const previousShellOriginalCwd = getOriginalCwd();
        const previousWorktreeSettings = config.getWorktreeSettings();
        const workspaceContext = config.getWorkspaceContext();
        const previousWorkspaceDirectories = [
          ...(workspaceContext?.getDirectories?.() ?? []),
        ];
        const effectiveProjectRoot =
          options.transcriptProjectRoot ??
          config.getSessionArtifactProjectRoot();
        const transcriptPath =
          options.sessionPath ??
          getSessionTranscriptPath(effectiveProjectRoot, nextSessionId);
        runLogger.log(
          '[transcript.debug] rebuild.start',
          `session=${nextSessionId}`,
          `existing_messages=${existingMessages.length}`,
          `restore_existing=${options.restoreExistingSession === true}`,
          `previous_session=${previousWriter?.getSessionId() ?? 'none'}`,
          `previous_state_store=${previousSessionStateStore ? 'present' : 'none'}`,
          `previous_cwd=${previousCwd}`,
          `previous_target_dir=${previousTargetDir}`,
          `previous_workspace_directories=${previousWorkspaceDirectories.join(',') || 'none'}`,
          `effective_project_root=${effectiveProjectRoot}`,
          `path=${transcriptPath}`,
        );
        const disableOwnedSessionStateStore = (
          store: SessionStateStore,
          stage: string,
          error: unknown,
        ) => {
          if (sessionStateStoreRef.current === store) {
            sessionStateStoreRef.current = null;
          }
          runLogger.warn(
            '[session.state] persistence unavailable',
            error,
            `stage=${stage}`,
            `session=${nextSessionId}`,
            `path=${store.getSessionStatePath()}`,
          );
        };
        try {
          const backgroundRequestsSettled =
            await waitForBackgroundModelRequests(
              previousBackgroundModelRequests,
            );
          if (!backgroundRequestsSettled) {
            runLogger.warn(
              '[session.usage] timed out waiting for background model requests',
              `session=${previousWriter?.getSessionId() ?? 'none'}`,
            );
          }

          sessionStateStoreRef.current = new SessionStateStore({
            projectRoot: effectiveProjectRoot,
            sessionId: nextSessionId,
          });
          runLogger.log(
            '[transcript.debug] state_store.created',
            `session=${nextSessionId}`,
            `project_root=${effectiveProjectRoot}`,
          );

          const restoreToExplicitTranscriptProjectRoot = (
            transcriptProjectRoot: string,
          ) => {
            // 目录恢复也属于 Writer 事务，失败时使用进入事务前的 workspace 回滚。
            workspaceContext.addDirectories([
              ...(options.targetWorkspaceDirectories ?? []),
            ]);
            const staleWorktreeRoot = previousWorktreeSettings?.path
              ? normalizePathForCompare(previousWorktreeSettings.path)
              : undefined;
            const targetWorkspaceDirectoryRoots = new Set(
              (options.targetWorkspaceDirectories ?? []).map((dir) =>
                normalizePathForCompare(dir),
              ),
            );
            const normalizedTranscriptRoot = normalizePathForCompare(
              transcriptProjectRoot,
            );
            const workspaceDirectories = [
              transcriptProjectRoot,
              ...workspaceContext.getDirectories().filter((dir) => {
                if (normalizePathForCompare(dir) === normalizedTranscriptRoot) {
                  return false;
                }
                const resolvedDir = normalizePathForCompare(dir);
                if (targetWorkspaceDirectoryRoots.has(resolvedDir)) {
                  return true;
                }
                if (!staleWorktreeRoot) {
                  return true;
                }
                return !isSameOrChildPath(dir, staleWorktreeRoot);
              }),
            ];

            applyTuiSessionRuntimeState(config, {
              targetDir: transcriptProjectRoot,
              workingDir: transcriptProjectRoot,
              shellOriginalCwd: transcriptProjectRoot,
              workspaceDirectories,
              worktreeSettings: undefined,
              processCwd: transcriptProjectRoot,
              clearPromptAssemblerCache: true,
            });
            fileHistoryManagerRef.current = null;
            // Core 恢复只应影响新会话；旧 Manager 保留给外层失败回滚。
            config.setFileHistoryManager(undefined);
          };

          let resumedWorktreeState:
            | import('@qwen-code/core').TranscriptWorktreeSession
            | null
            | undefined;
          let resumeProjectRoot: string | undefined;
          if (options.restoreExistingSession) {
            const explicitTranscriptProjectRoot = options.transcriptProjectRoot;
            const explicitTranscriptProjectRootExists =
              !!explicitTranscriptProjectRoot &&
              existsSync(explicitTranscriptProjectRoot);
            resumedWorktreeState = options.worktreeSession ?? null;
            resumeProjectRoot =
              resumedWorktreeState?.originalCwd ??
              options.originalCwd ??
              (explicitTranscriptProjectRootExists
                ? explicitTranscriptProjectRoot
                : (previousWorktreeSettings?.originalCwd ??
                  config.getProjectRoot()));
            if (resumeProjectRoot && existsSync(resumeProjectRoot)) {
              restoreToExplicitTranscriptProjectRoot(resumeProjectRoot);
            }
            runLogger.log(
              '[worktree.resume] prepared transcript runtime',
              `project_root=${resumeProjectRoot ?? 'unchanged'}`,
              `has_worktree_state=${resumedWorktreeState ? 'true' : 'false'}`,
            );
          }

          const transcriptHomeCwd =
            resumedWorktreeState?.originalCwd ??
            config.getWorktreeSettings()?.originalCwd ??
            resumeProjectRoot ??
            effectiveProjectRoot;
          const currentGitBranch =
            await getTranscriptGitBranch(transcriptHomeCwd);
          const writer = await config
            .getTranscriptStore()
            .acquireSessionWriter({
              filePath: transcriptPath,
              sessionId: nextSessionId,
              cwd: transcriptHomeCwd,
              entrypoint: 'cli',
              version,
              gitBranch: currentGitBranch,
              initialWorkspaceDirectories:
                config.getWorkspaceContext()?.getDirectories?.() ?? [],
              resume: options.resume,
              coldResume: options.coldResume,
            });
          runLogger.log(
            '[transcript.debug] writer.created',
            `session=${nextSessionId}`,
            `cwd=${transcriptHomeCwd}`,
            `path=${transcriptPath}`,
          );
          preparedWriter = writer;
          let acceptLegacyFileHistorySnapshots = !config.getWorktreeSettings();
          if (options.restoreExistingSession) {
            resumedWorktreeState = options.worktreeSession ?? null;
            const outcome = await applyResumeWorktreeState(
              config,
              resumedWorktreeState,
              (...args) => writer.recordWorktreeState(...args),
            );
            acceptLegacyFileHistorySnapshots =
              outcome.acceptLegacyFileHistorySnapshots;
            if (
              resumedWorktreeState &&
              !(outcome.status === 'fallback' && outcome.pendingCleanup)
            ) {
              await migrateLegacyWorktreeTranscript({
                sessionId: nextSessionId,
                selectedPath: options.sessionPath ?? transcriptPath,
                originalCwd: resumedWorktreeState.originalCwd,
                relocate: async (originalCwd) => {
                  await writer.relocate({
                    filePath: getSessionTranscriptPath(
                      originalCwd,
                      nextSessionId,
                    ),
                    cwd:
                      outcome.worktreeSession?.worktreeCwd ??
                      outcome.worktreeSession?.worktreePath ??
                      originalCwd,
                    gitBranch:
                      outcome.worktreeSession?.worktreeBranch ??
                      currentGitBranch,
                    worktreeSession: outcome.worktreeSession,
                  });
                },
              });
            }
            fileHistoryManagerRef.current = null;
            runLogger.log(
              '[worktree.resume] restored TUI session state',
              `status=${outcome.status}`,
              `cwd=${config.getWorkingDir()}`,
            );
          } else {
            await recordInitialWorktreeTranscriptState(config, writer);
          }

          const fileHistoryManager =
            fileHistoryManagerRef.current ??
            new FileHistoryManager({
              cwd: config.getTargetDir(),
              sessionId: nextSessionId,
              enabled: config.getFileCheckpointingEnabled(),
              acceptLegacySnapshots: acceptLegacyFileHistorySnapshots,
            });
          fileHistoryManager.setSessionId(nextSessionId);
          fileHistoryManager.setRecorder((entry) =>
            writer.recordFileHistorySnapshot(entry),
          );
          fileHistoryManagerRef.current = fileHistoryManager;
          config.setFileHistoryManager(fileHistoryManager);

          if (options.restoreExistingSession) {
            // Re-hydrate JIT-discovered nested memory paths so the Memory UI
            // and relevant_memories delta tracking reflect the resumed state.
            config
              .getMemoryContextManager()
              ?.restoreJitPathsFromMessages(existingMessages);
          }

          const directories =
            config.getWorkspaceContext()?.getDirectories?.() ?? [];
          runLogger.log(
            '[transcript.debug] state_store.workspace_directories.set.start',
            `session=${nextSessionId}`,
            `state_store_ref=${sessionStateStoreRef.current ? 'present' : 'none'}`,
            `directories=${directories.join(',') || 'none'}`,
          );
          const stateStore = sessionStateStoreRef.current;
          if (stateStore) {
            void stateStore
              .setWorkspaceDirectories(directories)
              .then(() => {
                runLogger.log(
                  '[transcript.debug] state_store.workspace_directories.set.done',
                  `session=${nextSessionId}`,
                );
              })
              .catch((error) => {
                disableOwnedSessionStateStore(
                  stateStore,
                  'workspace_directories',
                  error,
                );
              });
          }

          await recordTranscriptRuntimeConfig(
            config,
            writer,
            'writer_rebuilt',
          ).catch((error) => {
            runLogger.warn(
              '[session.runtime_config] transcript.record_failed',
              error,
              `session=${nextSessionId}`,
              'reason=writer_rebuilt',
            );
          });
          preparedTranscriptParentUuid = null;
          for (let index = existingMessages.length - 1; index >= 0; index--) {
            const message = existingMessages[index];
            if (isChainParticipant(message)) {
              preparedTranscriptParentUuid = message.uuid;
              break;
            }
          }
          writer.adoptMainParentUuid(preparedTranscriptParentUuid);
          hasRunAgentQueryRef.current = existingMessages.some(
            (message) => message.type === 'assistant',
          );
          aiTitlePromptCountRef.current =
            countAiTitleCadenceHumanPromptMessages(existingMessages);

          if (options.fileHistorySnapshots) {
            runLogger.log(
              '[transcript.debug] file_history.rehydrate.start',
              `session=${nextSessionId}`,
              `snapshots=${options.fileHistorySnapshots.length}`,
              `source_session=${options.sourceSessionId ?? nextSessionId}`,
            );
            await fileHistoryManager.rehydrateFromResume({
              sourceSessionId: options.sourceSessionId ?? nextSessionId,
              snapshots: options.fileHistorySnapshots,
              persistToTranscript:
                options.persistFileHistoryToTranscript ??
                (options.sourceSessionId ?? nextSessionId) !== nextSessionId,
              copyBackupFiles: options.copyFileHistoryBackups ?? true,
            });
            runLogger.log(
              '[transcript.debug] file_history.rehydrate.done',
              `session=${nextSessionId}`,
            );
          } else if (existingMessages.length === 0) {
            fileHistoryManager.reset();
          }

          const currentStateStore = sessionStateStoreRef.current;
          // Rebuilds run on interactive paths (rewind, `/resume`, history
          // reloads), so the previous session's usage get a short settle
          // budget. The full 30s budget stays on the shutdown path, where losing
          // in-flight metering actually costs something.
          const interactiveDisposeOptions = {
            settleTimeoutMs: INTERACTIVE_USAGE_REQUEST_SETTLE_TIMEOUT_MS,
          };
          if (currentStateStore) {
            try {
              const disposeUsagePersistence = await bindSessionUsagePersistence(
                nextSessionId,
                currentStateStore,
              );
              await previousUsagePersistenceDisposer?.(
                interactiveDisposeOptions,
              );
              sessionUsagePersistenceDisposerRef.current =
                disposeUsagePersistence;
            } catch (error) {
              await previousUsagePersistenceDisposer?.(
                interactiveDisposeOptions,
              );
              sessionUsagePersistenceDisposerRef.current = undefined;
              runLogger.warn(
                '[session.usage] failed to restore persistence binding',
                error,
                `session=${nextSessionId}`,
              );
            }
          } else {
            await previousUsagePersistenceDisposer?.(interactiveDisposeOptions);
            sessionUsagePersistenceDisposerRef.current = undefined;
          }
          usageHydrationGate.resolve();

          // Publish the target writer and its matching parent cursor together.
          // Until this point recordMessage queues target-session writes instead
          // of observing a half-initialized writer with the previous session's
          // parent. The writer owns append ordering after publication.
          lastTranscriptParentUuidRef.current = preparedTranscriptParentUuid;
          transcriptWriterRef.current = writer;
          await flushPendingTranscriptRecordsWithWriter(nextSessionId, writer);

          // The runtime binding persists titles through the published writer.
          // Keep the initial title pending until that writer can accept it.
          const pendingInitialTitle = pendingInitialSessionTitleRef.current;
          if (pendingInitialTitle) {
            await config.persistSessionTitle(pendingInitialTitle);
            pendingInitialSessionTitleRef.current = null;
          }

          // Resumed sessions with existing user/assistant history may be
          // untitled (or titled locally but not yet on the remote side).
          // Only start the background request after persisted usage has been
          // restored so later metering cannot be overwritten by hydration.
          if (
            existingMessages.some(
              (m) => m.type === 'user' || m.type === 'assistant',
            )
          ) {
            scheduleAiTitleCheck();
          }
          if (options.restoreExistingSession) {
            restoreInvokedSkillsFromTranscript(
              config.getSkillManager(),
              existingMessages,
            );
          }
          if (previousWriter) {
            try {
              // Pending records retain the session that owned them. Give the old
              // writer one final ordered drain before releasing its handle so a
              // transient append failure does not become data loss merely
              // because the user navigated away from that session.
              await flushPendingTranscriptRecordsWithWriter(
                previousWriter.getSessionId(),
                previousWriter,
              );
            } catch (error) {
              runLogger.warn(
                'transcript.record.previous_session_drain_failed',
                error,
                `previous_session=${previousWriter.getSessionId()}`,
                `next_session=${nextSessionId}`,
              );
            }
            try {
              await previousWriter.close();
            } catch (error) {
              runLogger.warn(
                '[transcript.debug] previous_writer.close_failed_after_switch',
                error,
                `previous_session=${previousWriter.getSessionId()}`,
                `next_session=${nextSessionId}`,
              );
            }
            previousWriterClosed = true;
          }
          runLogger.log(
            '[transcript.debug] rebuild.done',
            `session=${nextSessionId}`,
            `current_writer=${transcriptWriterRef.current?.getSessionId() ?? 'none'}`,
            `last_parent_uuid=${lastTranscriptParentUuidRef.current ?? 'none'}`,
            `ai_title_prompt_count=${aiTitlePromptCountRef.current}`,
          );
        } catch (error) {
          runLogger.warn(
            '[transcript.debug] rebuild.failed',
            error,
            `session=${nextSessionId}`,
            `current_writer=${transcriptWriterRef.current?.getSessionId() ?? 'none'}`,
            `state_store_ref=${sessionStateStoreRef.current ? 'present' : 'none'}`,
            `previous_writer_closed=${previousWriterClosed}`,
          );
          const failedWriter = preparedWriter ?? transcriptWriterRef.current;
          if (failedWriter && failedWriter !== previousWriter) {
            try {
              await failedWriter.close();
            } catch (closeError) {
              runLogger.warn(
                '[worktree.resume] failed to close failed transcript writer',
                closeError,
              );
            }
          }

          applyTuiSessionRuntimeState(config, {
            targetDir: previousTargetDir,
            workingDir: previousWorkingDir,
            shellOriginalCwd: previousShellOriginalCwd,
            workspaceDirectories: previousWorkspaceDirectories,
            worktreeSettings: previousWorktreeSettings,
            processCwd: previousCwd,
            onWarning: (stage, error) => {
              const label =
                stage === 'chdir'
                  ? 'failed to restore previous cwd'
                  : 'failed to restore workspace directories';
              runLogger.warn(`[worktree.resume] ${label}`, error);
            },
          });
          sessionStateStoreRef.current = previousSessionStateStore;
          transcriptWriterRef.current = previousWriterClosed
            ? null
            : previousWriter;
          fileHistoryManagerRef.current = previousFileHistoryManager;
          config.setFileHistoryManager(previousConfigFileHistoryManager);
          lastTranscriptParentUuidRef.current = previousTranscriptParentUuid;
          hasRunAgentQueryRef.current = previousHasRunAgentQuery;
          aiTitlePromptCountRef.current = previousAiTitlePromptCount;
          throw error;
        } finally {
          usageHydrationGate.resolve();
          if (!isUnmountedRef.current) {
            ensureAttachmentContext(
              config.getSessionId(),
              config.getWorkingDir() ?? process.cwd(),
            );
          }
          if (writerSwitchInFlightRef.current === nextSessionId) {
            writerSwitchInFlightRef.current = null;
          }
        }
      });
      const pending = rebuild.finally(() => {
        writerRebuildsRef.current.delete(pending);
      });
      writerRebuildsRef.current.add(pending);
      return pending;
    },
    [
      beginSessionUsageHydration,
      config,
      ensureAttachmentContext,
      flushPendingTranscriptRecordsWithWriter,
      scheduleAiTitleCheck,
      version,
    ],
  );

  const replaceMessages = useCallback(
    async (
      messages: Message[],
      nextSessionId = config.getSessionId(),
      options?: ReplaceMessagesOptions,
    ) => {
      if (isUnmountedRef.current) {
        throw new Error('TUI session is closing.');
      }
      const shouldSetConfigSessionId = !!options?.setConfigSessionId;
      const previousSessionId = config.getSessionId();
      try {
        if (shouldSetConfigSessionId) {
          writerSwitchInFlightRef.current = nextSessionId;
          config.setSessionId(nextSessionId);
          runLogger.log(
            '[session.resume] session_id.set',
            `target_session=${nextSessionId}`,
            `config_session=${config.getSessionId()}`,
          );
        }
        await rebuildTranscriptWriter(nextSessionId, messages, options);
        messagesRef.current = [...messages];
        // Unconditional rebuild: the session id may be unchanged (rewind,
        // compaction) but the history it must diff against just changed.
        rebuildAttachmentContext(
          nextSessionId,
          config.getWorkingDir() ?? process.cwd(),
        );
        repeatedToolCallAllowedKeysRef.current.clear();
        // Only forks carry a source session; switching sessions without one
        // clears it. A same-session replace (rewind, compaction) keeps it.
        if (
          options?.sourceSessionId !== undefined ||
          previousSessionId !== nextSessionId
        ) {
          runtimeSourceSessionIdRef.current = options?.sourceSessionId;
        }
      } catch (error) {
        if (shouldSetConfigSessionId) {
          config.setSessionId(previousSessionId);
        }
        throw error;
      } finally {
        if (
          shouldSetConfigSessionId &&
          writerSwitchInFlightRef.current === nextSessionId
        ) {
          writerSwitchInFlightRef.current = null;
        }
      }
    },
    [config, rebuildAttachmentContext, rebuildTranscriptWriter],
  );

  const flushPendingTranscriptRecords = useCallback(
    async (sessionId: string) => {
      const writer = transcriptWriterRef.current;
      if (!writer || writer.getSessionId() !== sessionId) {
        return;
      }
      await flushPendingTranscriptRecordsWithWriter(sessionId, writer);
    },
    [flushPendingTranscriptRecordsWithWriter],
  );

  const rewindConversation = useCallback(
    async (
      targetUuid: string,
      options: LocalRewindOptions,
    ): Promise<ConversationRewindPlan> => {
      const sessionId = config.getSessionId();
      await flushPendingTranscriptRecords(sessionId);

      const writer = transcriptWriterRef.current;
      const activeWriter =
        writer?.getSessionId() === sessionId ? writer : undefined;

      const beforeMessages = [...messagesRef.current];
      const beforeLeaf = lastTranscriptParentUuidRef.current;
      const beforeHasRunAgentQuery = hasRunAgentQueryRef.current;
      const beforeAiTitlePromptCount = aiTitlePromptCountRef.current;
      const beforeRepeatedToolCallAllowedKeys = new Set(
        repeatedToolCallAllowedKeysRef.current,
      );
      const readTranscriptSnapshot = (
        activeWriter as
          | { readTranscriptSnapshot?: () => Promise<Buffer> }
          | undefined
      )?.readTranscriptSnapshot;

      return executeConversationRewind({
        targetUuid,
        writer: activeWriter,
        ...(activeWriter && typeof readTranscriptSnapshot === 'function'
          ? {
              resolvePlan: async () => {
                const transcriptBytes =
                  await readTranscriptSnapshot.call(activeWriter);
                const historical = new TranscriptRepository().resolveBuffer(
                  activeWriter.getSessionFilePath(),
                  transcriptBytes,
                  {
                    sessionId,
                    view: 'historical',
                  },
                );
                return planHistoricalConversationRewind(
                  historical.chain,
                  targetUuid,
                );
              },
            }
          : {}),
        adapter: {
          readState: () => ({
            sessionId,
            messages: [...messagesRef.current],
            leafUuid: lastTranscriptParentUuidRef.current,
            guardRevision: options.getExternalRevision(),
          }),
          assertReady: () => options.assertReady(),
          commit: (plan) => {
            messagesRef.current = [...plan.retainedMessages];
            lastTranscriptParentUuidRef.current = plan.retainedLeafUuid;
            hasRunAgentQueryRef.current = plan.retainedMessages.some(
              (message) => message.type === 'assistant',
            );
            aiTitlePromptCountRef.current =
              countAiTitleCadenceHumanPromptMessages(plan.retainedMessages);
            repeatedToolCallAllowedKeysRef.current.clear();
            options.commitView(plan);
          },
          restore: () => {
            messagesRef.current = [...beforeMessages];
            lastTranscriptParentUuidRef.current = beforeLeaf;
            hasRunAgentQueryRef.current = beforeHasRunAgentQuery;
            aiTitlePromptCountRef.current = beforeAiTitlePromptCount;
            repeatedToolCallAllowedKeysRef.current = new Set(
              beforeRepeatedToolCallAllowedKeys,
            );
            options.restoreView();
          },
        },
      });
    },
    [config, flushPendingTranscriptRecords],
  );

  const recoverTranscriptWriterForPendingRecords = useCallback(
    async (sessionId: string): Promise<void> => {
      if (
        isUnmountedRef.current ||
        waitingForInitialResumeRef.current ||
        config.getSessionId() !== sessionId
      ) {
        return;
      }

      if (transcriptRecoveryPromiseRef.current) {
        await transcriptRecoveryPromiseRef.current;
        return;
      }

      const recoveryPromise = (async () => {
        if (writerSwitchInFlightRef.current) {
          for (let attempt = 0; attempt < 50; attempt++) {
            if (config.getSessionId() !== sessionId) {
              return;
            }
            const writer = transcriptWriterRef.current;
            if (writer?.getSessionId() === sessionId) {
              await flushPendingTranscriptRecords(sessionId);
              return;
            }
            if (!writerSwitchInFlightRef.current) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        const writer = transcriptWriterRef.current;
        if (writer?.getSessionId() === sessionId) {
          await flushPendingTranscriptRecords(sessionId);
          return;
        }
        if (config.getSessionId() !== sessionId) {
          return;
        }

        const pendingUuids = new Set(
          pendingTranscriptRecordsRef.current
            .filter((record) => record.sessionId === sessionId)
            .map((record) => record.message.uuid),
        );
        const adoptableMessages = messagesRef.current.filter(
          (message) => !pendingUuids.has(message.uuid),
        );

        runLogger.warn(
          'transcript.writer.recovering_no_writer',
          `session=${sessionId}`,
          `pending=${pendingUuids.size}`,
          `adoptable_messages=${adoptableMessages.length}`,
        );

        await rebuildTranscriptWriter(sessionId, adoptableMessages, {
          restoreExistingSession: adoptableMessages.length > 0,
        });
        await flushPendingTranscriptRecords(sessionId);
      })();

      transcriptRecoveryPromiseRef.current = recoveryPromise;
      try {
        await recoveryPromise;
      } finally {
        if (transcriptRecoveryPromiseRef.current === recoveryPromise) {
          transcriptRecoveryPromiseRef.current = null;
        }
      }
    },
    [config, flushPendingTranscriptRecords, rebuildTranscriptWriter],
  );

  const recordMessages = useCallback(
    async (messages: readonly Message[], propagateError = false) => {
      if (messages.length === 0) return;
      const sessionId = config.getSessionId();
      const transcriptPath = transcriptPathForSession(
        transcriptWriterRef.current,
        config,
        sessionId,
      );
      // Serialize queue draining as well as physical writes. In particular, a
      // new message must not overtake a failed user/tool-result record.
      const operation = transcriptRecordTailRef.current.then(async () => {
        pendingTranscriptRecordsRef.current.push(
          ...messages.map((message) => ({
            sessionId,
            message,
            reason: 'write_failed' as const,
          })),
        );
        await recoverTranscriptWriterForPendingRecords(sessionId);
      });
      transcriptRecordTailRef.current = operation.catch(() => undefined);
      try {
        await operation;
      } catch (error) {
        runLogger.warn('transcript.record.recovery_failed', error);
        const transcriptError =
          error instanceof TranscriptWriteError
            ? error
            : new TranscriptWriteError(transcriptPath, error);
        if (propagateError) throw transcriptError;
        // Supplementary UI events are fire-and-forget. Display this failure
        // without persisting another error message into the failing writer.
        addItemRef.current(
          { type: MessageType.ERROR, text: transcriptError.message },
          Date.now(),
          true,
        );
      }
    },
    [config, recoverTranscriptWriterForPendingRecords],
  );

  const recordMessage = useCallback(
    async (message: Message, propagateError = false) =>
      recordMessages([message], propagateError),
    [recordMessages],
  );

  /**
   * Build the ApplyPostCompactCallbacks bag for this TUI session.
   * Called once per compression event (auto-compact and manual /compress).
   */
  const buildPostCompactCallbacks =
    useCallback((): ApplyPostCompactCallbacks => {
      const mcpManager = config.getMcpClientManager();
      const agentRegistry = config.getAgentRegistry?.();
      const memoryContextManager = config.getMemoryContextManager();
      const externalContext: AttachmentExternalContext | undefined =
        mcpManager || agentRegistry || memoryContextManager
          ? ({
              ...(mcpManager && {
                mcpClientManager: {
                  getConnectedServerInstructions: () =>
                    mcpManager.getConnectedServerInstructions(),
                  getLazyMcpServerSnapshot: () =>
                    mcpManager.getLazyMcpServerSnapshot(),
                },
              }),
              ...(memoryContextManager && { memoryContextManager }),
              toolRegistry: config.getToolRegistry(),
              ...(agentRegistry && { agentRegistry }),
            } as AttachmentExternalContext)
          : undefined;
      const refreshForkHistory = () => {
        const snapshot = lastCacheSafeQuerySnapshotRef.current;
        if (!snapshot) return;
        // Replace the snapshot rather than mutating one already used by /btw.
        // Keep its cache-aligned prompt/settings, but never replay pre-compact history.
        lastCacheSafeQuerySnapshotRef.current = {
          ...snapshot,
          contextAttachmentMessages: messagesRef.current.filter(
            isContextAttachmentMessage,
          ),
          forkContextMessages: normalizeMessagesForAPI(
            [...(snapshot.requestPrefixMessages ?? []), ...messagesRef.current],
            buildModelProjectionOptions(
              config,
              snapshot.model,
              snapshot.modelResolution,
            ),
          ),
          lastAssistantUsage: undefined,
        };
      };
      return {
        replaceMessages: (msgs: Message[]) => {
          messagesRef.current = msgs;
          refreshForkHistory();
        },
        pushAttachments: (msgs: Message[]) => {
          for (const m of msgs) messagesRef.current.push(m);
          refreshForkHistory();
        },
        transcriptParentUuid: () => lastTranscriptParentUuidRef.current,
        setTranscriptParentUuid: (uuid: string | null) => {
          lastTranscriptParentUuidRef.current = uuid;
        },
        transcriptWriter: transcriptWriterRef.current,
        attachmentCtx: ensureAttachmentContext(
          config.getSessionId(),
          config.getWorkingDir() ?? process.cwd(),
        ),
        externalContext,
        config,
        // Render a persistent "Conversation compacted" row in scrollback
        // only after the compact_boundary marker has been persisted to the
        // JSONL transcript. Covers both automatic and manual compaction. The
        // transient progress panel listens to core lifecycle events; the final
        // row is deferred to this callback so it is atomic with the write.
        onCompactionPersisted: (boundary) => {
          const item: HistoryItemCompression = {
            type: 'compression',
            compression: {
              isPending: false,
              originalTokenCount: boundary.compactMetadata?.preTokens ?? null,
              newTokenCount: boundary.compactMetadata?.postTokens ?? null,
              compressionStatus: null,
              trigger: boundary.compactMetadata?.trigger,
            },
          };
          addItemRef.current(item, Date.now());
        },
      };
    }, [config, ensureAttachmentContext]);

  // Manual /compress entry point — runs the pipeline with force=true, then
  // delegates post-compact persistence to the shared helper so manual and
  // auto paths produce identical transcript + runtime state.
  const runManualCompress = useCallback(
    async (customInstructions?: string): Promise<ManualCompressResult> => {
      const priorHistory: Message[] = [...messagesRef.current];
      const pipeline = compressionPipelineRef.current;
      const promptId = `compress-${randomUUID()}`;
      const compactModel = config.getModel();
      const compactIdentity = config.getModelRequestIdentity();
      const compactSessionId = config.getSessionId();
      const compactSignal =
        abortControllerRef.current?.signal ?? new AbortController().signal;
      const assertCompactCurrent = () => {
        if (
          compactSignal.aborted ||
          compactModel !== config.getModel() ||
          compactIdentity !== config.getModelRequestIdentity() ||
          compactSessionId !== config.getSessionId()
        )
          throw new Error('会话目标已变化，压缩已取消。');
      };
      assertCompactCurrent();
      // This path re-resolves the whole request from Config (system prompt,
      // tools), so the memory prefix comes from the same read to stay consistent
      // with them rather than mixing in a previous request's snapshot.
      const requestPrefixMessages = buildStartupMemoryPrefix(
        createStartupMemoryContext(config),
      );
      const resolveCompactSystemPrompt = await createTurnPromptResolver({
        agentLoopContext: config,
        sessionId: config.getSessionId(),
        cwd: config.getWorkingDir() ?? process.cwd(),
        promptSurface: 'local_tui',
        assembler: promptAssembler,
        overrideSystemPrompt: systemPromptOverride ?? undefined,
        customSystemPrompt: config.getCustomSystemPrompt() ?? undefined,
        appendSystemPrompt: appendSystemPrompt ?? undefined,
        cliAppendSystemPrompt: config.getAppendSystemPrompt() ?? undefined,
        mainThreadAgentDefinition: config.getSessionAgentDefinitionLike(),
      });
      const compactPromptResult =
        await resolveCompactSystemPrompt(compactModel);
      const systemPrompt = compactPromptResult.blocks;
      const compactSchemaRegistry = config.getToolRegistry();
      const compactTools = compactSchemaRegistry
        .getSchema(compactModel, { preReadLineDropped: true })
        .filter((declaration) => declaration.name !== PRESENT_FILES_TOOL_NAME);
      assertCompactCurrent();
      const resolveCompactRequest = createCompactRequestResolver({
        config,
        signal: compactSignal,
        sessionId: config.getSessionId(),
        turnIndex: 0,
        logLabel: '[TUI] manual compact resolve',
      });
      const preparedRequest = await resolveCompactRequest.prepareParent();
      assertCompactCurrent();
      // Run inside sessionIdContext so forked subagents (compact agent, etc.)
      // inherit the current session UUID rather than generating a fresh one.
      const result = await sessionIdContext.run(config.getSessionId(), () =>
        pipeline.compress(priorHistory, {
          promptId,
          force: true,
          rootSessionId: config.getSessionId(),
          trigger: 'manual',
          modelResolution: preparedRequest.modelResolution,
          resolveCompactSelection: async () => {
            const request = await resolveCompactRequest();
            return {
              selection: request.modelResolution,
              policyLabels: request.policyLabels,
              source: request.source,
            };
          },
          config,
          requestPrefixMessages,
          customInstructions,
          sessionStateStore: sessionStateStoreRef.current ?? undefined,
          projectionOptions: buildModelProjectionOptions(
            config,
            compactModel,
            preparedRequest.modelResolution,
          ),
          systemPrompt,
          tools: compactTools,
          abortSignal: compactSignal,
        }),
      );

      if (!result.newHistory) {
        return {
          newHistory: null,
          info: {
            originalTokenCount: result.info?.originalTokenCount ?? null,
            newTokenCount: result.info?.newTokenCount ?? null,
            compressionStatus: result.info?.compressionStatus ?? null,
            blockReason: result.info?.blockReason,
            failureReason: result.info?.failureReason,
            providerStatus: result.info?.providerStatus,
            providerCode: result.info?.providerCode,
            providerSource: result.info?.providerSource,
            displayErrorCode: result.info?.displayErrorCode,
            errorFallbackMessage: result.info?.errorFallbackMessage,
          },
        };
      }

      assertCompactCurrent();
      const extended = await applyPostCompact(
        priorHistory,
        result.newHistory,
        buildPostCompactCallbacks(),
      );
      // Sync the ref to the final extended state (applyPostCompact already
      // called replaceMessages + pushAttachments, but extended is the return
      // value that includes both — assign directly to be safe).
      const finalMessages: Message[] = [...extended];
      messagesRef.current = finalMessages;

      // ── Immediately update status bar with post-compression estimate ──
      // Mirrors the same logic in agent-loop.ts. /compact bypasses agent-loop
      // so we must update here to avoid the bar staying at the old value.
      {
        const estimated = countRequestTokens({
          model: compactModel,
          messages: [...requestPrefixMessages, ...finalMessages],
          systemPrompt,
          tools: compactTools,
          projectionOptions: buildModelProjectionOptions(
            config,
            compactModel,
            preparedRequest.modelResolution,
          ),
        }).tokens;
        if (estimated > 0) {
          uiTelemetryService.setLastPromptTokenCount(estimated);
        }
      }

      return {
        newHistory: finalMessages,
        info: {
          originalTokenCount: result.info?.originalTokenCount ?? null,
          newTokenCount: result.info?.newTokenCount ?? null,
          compressionStatus: result.info?.compressionStatus ?? null,
          blockReason: result.info?.blockReason,
          failureReason: result.info?.failureReason,
          providerStatus: result.info?.providerStatus,
          providerCode: result.info?.providerCode,
          providerSource: result.info?.providerSource,
          displayErrorCode: result.info?.displayErrorCode,
          errorFallbackMessage: result.info?.errorFallbackMessage,
        },
      };
    },
    [
      appendSystemPrompt,
      buildPostCompactCallbacks,
      config,
      promptAssembler,
      systemPromptOverride,
    ],
  );

  const appendSupplementaryMessages = useCallback(
    async (messages: readonly Message[]) => {
      messagesRef.current.push(...messages);
      await recordMessages(messages);
    },
    [recordMessages],
  );

  const queueHookContext = useCallback(
    (
      context: string,
      hookEventName?: HookEventName,
      sourceType?: PendingHookOutput['sourceType'],
    ) => {
      if (!context) {
        return;
      }

      const payload: PendingHookOutput = {
        hookEventName: hookEventName ?? HookEventName.UserPromptSubmit,
        output: context,
        ...(sourceType ? { sourceType } : {}),
      };

      enqueueHookOutput(
        ensureAttachmentContext(
          config.getSessionId(),
          config.getWorkingDir() ?? process.cwd(),
        ),
        payload,
      );
    },
    [config, ensureAttachmentContext],
  );

  const recordSupplementaryHistoryItem = useCallback(
    async (item: HistoryItemWithoutId) => {
      if (item.omitFromTranscript) {
        return;
      }
      let message: Message | null = null;

      switch (item.type) {
        case 'user': {
          const trimmed = item.text.trim();
          if (isCommandStyleInput(trimmed)) {
            // Command-style text without a command name (e.g. a bare "/"
            // after the completion popup is dismissed) has no command
            // metadata: the input processor records it as a plain prompt.
            // Skip the caveat/wrapper batch instead of persisting a user
            // message whose content is null.
            const commandInput = formatRawCommandInput(trimmed);
            if (commandInput) {
              const commandMessages: Message[] = [
                createSyntheticUserCaveatMessage(),
                createUserMessage(commandInput),
              ];
              // One writer call keeps the caveat and command wrapper on the
              // same immutable session lineage.
              await appendSupplementaryMessages(commandMessages);
            }
          }
          break;
        }
        case 'info': {
          // Skip formatSupplementarySystemContent for command output — it prepends
          // hook= and event= fields that don't apply here.
          if (item.transcriptSubtype === 'local_command_output') {
            message = createUserMessage(formatCommandOutput(item.text), {
              isMeta: true,
            });
          } else {
            const transcriptContent = item.transcriptSubtype
              ? formatSupplementarySystemContent(item)
              : item.text;
            message = createSystemMessage(
              item.transcriptSubtype ?? 'informational',
              transcriptContent,
            );
          }
          break;
        }
        case 'warning':
          message = createSystemMessage(
            item.transcriptSubtype ?? 'informational',
            item.text,
          );
          break;
        case 'error':
          message =
            item.transcriptSubtype === 'local_command_output'
              ? createUserMessage(formatCommandOutput(item.text), {
                  isMeta: true,
                })
              : createSystemMessage('error', item.text, 'error');
          break;
        case 'compression': {
          // Boundary persistence is owned by the compression-v2 pipeline
          // (which prepends a `system/compact_boundary` marker to
          // `newHistory`) and `runManualCompress` / `applyPostCompact`
          // (which write that marker to the JSONL transcript). The UI
          // history item that lands here is display-only — only emit a
          // best-effort informational record for non-success statuses so
          // the transcript still notes the failure.
          const { compressionStatus } = item.compression;
          const isSuccessful =
            !item.compression.isPending &&
            compressionStatus === CompressionStatus.COMPRESSED;
          if (!isSuccessful && compressionStatus != null) {
            message = createSystemMessage(
              'informational',
              `Context compression: ${compressionStatus}`,
            );
          }
          break;
        }
        default:
          break;
      }

      if (message) {
        await appendSupplementaryMessages([message]);
      }
    },
    [appendSupplementaryMessages, isCommandStyleInput],
  );

  const currentSessionId = config.getSessionId();
  useEffect(() => {
    if (isUnmountedRef.current || waitingForInitialResumeRef.current) return;
    if (writerSwitchInFlightRef.current === currentSessionId) {
      return;
    }
    if (transcriptWriterRef.current?.getSessionId() === currentSessionId) {
      return;
    }
    lastCacheSafeQuerySnapshotRef.current = null;
    const initialWriter = rebuildTranscriptWriter(
      currentSessionId,
      messagesRef.current,
    );
    void initialWriter.catch(() => {
      // rebuildTranscriptWriter logs the failure before rethrowing. This
      // effect owns the initial background invocation and consumes rejection.
    });
  }, [currentSessionId, rebuildTranscriptWriter]);

  const dispose = useCallback((): Promise<void> => {
    if (disposePromiseRef.current) return disposePromiseRef.current;
    isUnmountedRef.current = true;
    void sessionOwner.adapter?.release().catch((error) => {
      runLogger.warn('[local-session] Native handle cleanup failed', error);
    });
    clearActiveModelQueue();
    aiTitleGenerationRef.current?.controller.abort();
    aiTitleGenerationRef.current = null;
    promptSuggestionGenerationRef.current?.controller.abort();
    promptSuggestionGenerationRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const backgroundModelRequests = [...backgroundModelRequestsRef.current];
    disposePromiseRef.current = (async () => {
      // 初始化、Resume 和恢复 Writer 都必须先提交或回滚，再关闭最终持有的资源。
      await Promise.allSettled([...writerRebuildsRef.current]);
      sessionUsageHydrationRef.current?.resolve();
      const writer = transcriptWriterRef.current;
      const store = sessionStateStoreRef.current;
      const disposeUsagePersistence =
        sessionUsagePersistenceDisposerRef.current;
      transcriptWriterRef.current = null;
      sessionStateStoreRef.current = null;
      sessionUsagePersistenceDisposerRef.current = undefined;
      const backgroundRequestsSettled = await waitForBackgroundModelRequests(
        backgroundModelRequests,
      );
      if (!backgroundRequestsSettled) {
        runLogger.warn(
          '[session.usage] timed out waiting for background model requests on shutdown',
          `session=${config.getSessionId()}`,
        );
      }
      if (store) {
        await flushSessionUsage(store).catch((error) => {
          runLogger.warn(
            '[session.usage] failed to flush session usage on shutdown',
            error,
          );
        });
      }
      try {
        await disposeUsagePersistence?.();
      } finally {
        await writer?.close();
      }
    })();
    return disposePromiseRef.current;
  }, [clearActiveModelQueue, config, sessionOwner]);
  useEffect(() => {
    const unregister = registerCleanup(dispose);
    return () => {
      unregister();
      void dispose().catch((error) => {
        runLogger.warn('[session.usage] failed to finalize TUI session', error);
      });
    };
  }, [dispose]);

  const createLocalTurnPromptResolver = useCallback(
    () =>
      createTurnPromptResolver({
        agentLoopContext: config,
        sessionId: config.getSessionId(),
        cwd: config.getWorkingDir() ?? process.cwd(),
        promptSurface: 'local_tui',
        assembler: promptAssembler,
        overrideSystemPrompt: systemPromptOverride ?? undefined,
        customSystemPrompt: config.getCustomSystemPrompt() ?? undefined,
        appendSystemPrompt: appendSystemPrompt ?? undefined,
        cliAppendSystemPrompt: config.getAppendSystemPrompt() ?? undefined,
        mainThreadAgentDefinition: config.getSessionAgentDefinitionLike(),
        onResult: (result: PromptBuildResult) => {
          lastPromptBuildResultRef.current = result;
        },
      }),
    [appendSystemPrompt, config, promptAssembler, systemPromptOverride],
  );

  const ensurePromptBuildResult = useCallback(async () => {
    const cached = lastPromptBuildResultRef.current;
    if (cached) {
      return cached;
    }

    const model = config.getModel();
    if (!model) {
      return undefined;
    }

    try {
      const resolveSystemPrompt = await createLocalTurnPromptResolver();
      return await resolveSystemPrompt(model);
    } catch (error) {
      runLogger.warn('[context] failed to build current system prompt', error);
      return undefined;
    }
  }, [config, createLocalTurnPromptResolver]);

  const refreshContextTokenCount = useCallback(async () => {
    // A resume installs another history and may restore another model. Never
    // reuse the outgoing session's request snapshot or boundary fragment count.
    lastCacheSafeQuerySnapshotRef.current = null;
    const model = config.getModel();
    const resolveSystemPrompt = await createLocalTurnPromptResolver();
    const prompt = await resolveSystemPrompt(model);
    const schemaRegistry = config.getToolRegistry();
    lastToolRegistryRef.current = schemaRegistry;
    const tools = schemaRegistry
      .getSchema(model, { preReadLineDropped: true })
      .filter((tool) => tool.name !== PRESENT_FILES_TOOL_NAME);
    const latestUsage = await loadLatestSessionUsage(
      sessionStateStoreRef.current,
    ).catch(() => null);
    const count = countRequestTokens({
      model,
      messages: [
        ...buildStartupMemoryPrefix(createStartupMemoryContext(config)),
        ...messagesRef.current,
      ],
      systemPrompt: prompt.blocks,
      tools,
      latestUsage,
      projectionOptions: buildModelProjectionOptions(config, model),
    });
    uiTelemetryService.setLastPromptTokenCount(count.tokens);
  }, [config, createLocalTurnPromptResolver]);

  const executeSubmitQuery = useCallback(
    async (
      userQuery: PartListUnion,
      options: SubmitQueryOptions | undefined,
      submission: {
        submittedAtMs: number;
        abortController: AbortController;
        requestSetId: string;
      },
    ) => {
      const {
        submittedAtMs: userMessageSubmittedAtMs,
        abortController: turnAbortController,
      } = submission;
      if (
        runtimeProjectionRef.current.getStreamingState() !== StreamingState.Idle
      ) {
        return;
      }

      // Early echo: show user input in feed immediately, before any async
      // work (session-start hooks, processUserInput). Must run before
      // awaitSessionStartHooks() so the first message also benefits.
      // Note: this only does the feed echo; input events are emitted by
      // echoUserInput() later (which skips the addItem if already done via
      // the earlyEchoed guard below).
      const promptText = partToString(userQuery);
      const effectiveCommandMode = options?.commandMode ?? 'prompt';
      const useRawInputPath = options?.useInputProcessor !== true;
      let earlyEchoed = false;
      if (
        promptText.trim() &&
        !options?.hideFromDisplay &&
        !options?.isMeta &&
        effectiveCommandMode === 'prompt' &&
        !isSlashCommandInput(promptText)
      ) {
        addItemRef.current({ type: MessageType.USER, text: promptText });
        earlyEchoed = true;
      }

      abortControllerRef.current = turnAbortController;
      const signal = turnAbortController.signal;
      turnCancelledRef.current = false;
      const userMessageUuid = options?.userMessage?.uuid ?? randomUUID();
      const promptId = options?.promptId ?? randomUUID();
      const requestSetId = submission.requestSetId;
      const userMessageMetadata = {
        ...options?.userMessage,
        uuid: userMessageUuid,
        requestSetId,
      };

      const isSlashPrompt =
        effectiveCommandMode === 'prompt' && isSlashCommandInput(promptText);
      const hasImmediateModelIntent =
        useRawInputPath ||
        (effectiveCommandMode === 'prompt' && !isCommandStyleInput(promptText));
      runtimeProjectionRef.current.startTurn({
        modelTurnActive: hasImmediateModelIntent,
      });
      clearActiveModelQueue();
      stopHookAccRef.current = { hookErrors: [], preventedContinuation: false };
      const turnBusinessInfo = await createQueryBusinessInfo(
        config.getSessionId(),
        promptText,
        requestSetId,
        'tui',
        config.getModel(),
      );

      let startupReadinessSatisfied = false;
      let requestConfigReady = false;
      const waitForRequestConfig = async () => {
        if (requestConfigReady) return;
        await ensureConfigReadyForRequest({ signal });
        requestConfigReady = true;
      };
      let shouldRestorePromptAfterReadinessFailure = false;
      const waitForStartupReadiness = async (): Promise<boolean> => {
        const readinessNoticeTimer = setTimeout(() => {
          onStartupWaitingChange?.(true);
        }, 300);
        try {
          await Promise.all([
            awaitSessionStartHooks(signal),
            hasImmediateModelIntent || isSlashPrompt
              ? waitForRequestConfig()
              : undefined,
          ]);
          signal.throwIfAborted();
          // The catalog and session model must be ready before checking vision.
          const currentModel = config.getModel();
          const identity = config.getModelRequestIdentity();
          const sessionId = config.getSessionId();
          const listed = currentModel
            ? await config.getModelProviderManager().getModel(currentModel)
            : undefined;
          if (
            currentModel !== config.getModel() ||
            identity !== config.getModelRequestIdentity() ||
            sessionId !== config.getSessionId()
          )
            return false;
          if (
            options?.useInputProcessor &&
            hasImmediateModelIntent &&
            !isSlashPrompt &&
            currentModel &&
            !isVisionSupportedModel(listed) &&
            parseAtMentionedPaths(
              promptText,
              config.getWorkingDir() ?? process.cwd(),
            ).some((path) =>
              IMAGE_EXTENSIONS.has(
                nodePath.extname(path).toLowerCase().slice(1),
              ),
            )
          ) {
            appEvents.emit(AppEvent.TransientMessage, {
              type: TransientMessageType.Warning,
              message:
                'Current model does not support images. Remove image references or switch to a vision-capable model.',
            });
            shouldRestorePromptAfterReadinessFailure = true;
            return false;
          }
          startupReadinessSatisfied = true;
          return true;
        } catch (err: unknown) {
          if (signal.aborted || isAbortError(err)) {
            return false;
          }
          shouldRestorePromptAfterReadinessFailure = true;
          const message =
            err instanceof Error
              ? err.message
              : `Startup readiness failed: ${err}`;
          runLogger.warn(
            '[useLocalTuiSessionOrchestrator] startup readiness failed:',
            err,
          );
          addItemRef.current({
            type: MessageType.ERROR,
            text: message,
          });
          runtimeProjectionRef.current.recordTurnEnd({ error: message });
          return false;
        } finally {
          clearTimeout(readinessNoticeTimer);
          onStartupWaitingChange?.(false);
        }
      };

      if (!isSlashPrompt && !(await waitForStartupReadiness())) {
        runtimeProjectionRef.current.finishTurn();
        clearActiveModelQueue();
        stopHookAccRef.current = null;
        if (abortControllerRef.current === turnAbortController) {
          abortControllerRef.current = null;
        }
        if (shouldRestorePromptAfterReadinessFailure) {
          onCancelSubmit(true);
        }
        return;
      }

      if (!isSlashPrompt) {
        await transcriptRecordTailRef.current;
        if (
          pendingTranscriptRecordsRef.current.some(
            (record) => record.sessionId === config.getSessionId(),
          )
        ) {
          try {
            await recoverTranscriptWriterForPendingRecords(
              config.getSessionId(),
            );
          } catch (error) {
            throw error instanceof TranscriptWriteError
              ? error
              : new TranscriptWriteError(
                  transcriptPathForSession(
                    transcriptWriterRef.current,
                    config,
                    config.getSessionId(),
                  ),
                  error,
                );
          }
        }
      }

      const prepareFirstModelRequest = async () => {
        if (signal.aborted) return;
        await config.getProcessPermissionManager()?.getManagedPolicy().whenReady?.();
        const restriction = config.getPermissionModeRestriction(
          config.getPermissionMode(),
        );
        if (restriction) throw new PermissionModeUnavailableError(restriction);
        try {
          await applyMcpLazyLoad(config);
        } catch (err: unknown) {
          runLogger.debug(
            '[MCP Lazy] Applying the default mode failed; keeping the configured mode:',
            err instanceof Error ? err.message : err,
          );
        }
      };

      if (!isSlashPrompt && hasImmediateModelIntent && !signal.aborted) {
        await prepareFirstModelRequest();
      }

      const queryId = ++activeQueryIdRef.current;

      const isInitialAgentTurn = !hasRunAgentQueryRef.current;
      const shouldEmitInputEvent = options?.emitInputEvent !== false;
      let submissionPastedContents = options?.pastedContents;
      if (submissionPastedContents && shouldEmitInputEvent && !signal.aborted) {
        try {
          submissionPastedContents = await materializePastedContents(
            submissionPastedContents,
            signal,
          );
        } catch (error) {
          // The main input pipeline owns the user-facing image error. Keep the
          // deferred entry so it can retry there, but never announce empty data.
          runLogger.debug(
            '[useLocalTuiSessionOrchestrator] deferred image materialization failed before input event',
            error,
          );
        }
      }
      const shouldCountTowardsAiTitleCadence =
        options?.countTowardsAiTitleCadence === true;
      const isCommandStylePrompt =
        effectiveCommandMode === 'prompt' && isCommandStyleInput(promptText);
      const {
        pendingPromptCount: pendingAiTitlePromptCount,
        aiTitleOptionsForTurn,
      } = planAiTitleCadenceForTurn(
        aiTitlePromptCountRef.current,
        shouldCountTowardsAiTitleCadence,
      );
      const startInitialAiTitleGeneration = () => {
        if (
          pendingAiTitlePromptCount !== 1 ||
          !aiTitleOptionsForTurn ||
          !promptText.trim()
        ) {
          return;
        }
        onProvisionalSessionTitleRef.current?.(promptText);
        // Start title generation as soon as the first real task is submitted,
        // so the provisional title can be replaced while the turn is running.
        scheduleAiTitleCheck({
          ...aiTitleOptionsForTurn,
          description: promptText,
          businessInfo: turnBusinessInfo,
        });
      };
      if (!isCommandStylePrompt) {
        startInitialAiTitleGeneration();
      }
      const inputContentBlocks = shouldEmitInputEvent
        ? extractInputContentBlocks(userQuery, submissionPastedContents)
        : undefined;

      let didEchoUserInput = earlyEchoed;
      const echoUserInput = () => {
        if (didEchoUserInput || (!promptText.trim() && !inputContentBlocks)) {
          return;
        }
        didEchoUserInput = true;
        if (!options?.hideFromDisplay && promptText.trim()) {
          addItemRef.current({ type: MessageType.USER, text: promptText });
        }
        if (shouldEmitInputEvent) {
          try {
            onLocalUserMessageRef.current?.({
              text: promptText,
              ...(inputContentBlocks
                ? { contentBlocks: inputContentBlocks }
                : {}),
              uuid: userMessageMetadata.uuid ?? userMessageUuid,
            });
          } catch {
            // Input event subscribers must not break local execution
          }
        }
      };

      if (useRawInputPath) {
        echoUserInput();
      }

      const cwd = config.getWorkingDir() ?? process.cwd();
      // Defer capture until the model request has passed auth/config readiness.
      // Pure local commands never need to build a system prompt.
      const resolveTurnSystemPrompt =
        createTurnPromptResolverAfterRegistryReady(
          config,
          createLocalTurnPromptResolver,
        );
      const toolRegistry = config.getToolRegistry();
      // Expose parent tool schemas + rendered system prompt to fork subagents
      // (auto-memory, compression, Agent tool) so they can advertise
      // byte-identical tools/system in their API requests and hit the parent
      // turn's prompt cache. Mirrors QueryEngine.registerForkContextAccessors.
      lastToolRegistryRef.current = toolRegistry;

      const buildAttachmentExternalContext = (): AttachmentExternalContext => {
        const mcpManager = config.getMcpClientManager();
        const agentRegistry = config.getAgentRegistry?.();
        const memoryContextManager = config.getMemoryContextManager();
        return {
          mcpResources: createMcpResourceAttachmentSource(config),
          ...(mcpManager && {
            mcpClientManager: {
              getConnectedServerInstructions: () =>
                mcpManager.getConnectedServerInstructions(),
              getLazyMcpServerSnapshot: () =>
                mcpManager.getLazyMcpServerSnapshot(),
              peekLazyMode: () => mcpManager.peekLazyMode(),
            },
          }),
          ...(memoryContextManager && { memoryContextManager }),
          permissionMode: config.getPermissionMode(),
          plansDir: config.storage.getPlansDir(),
          sessionId: config.getSessionId(),
          toolRegistry: config.getToolRegistry(),
          ...(agentRegistry && { agentRegistry }),
        } as AttachmentExternalContext;
      };

      let didProcessInput = false;
      let shouldRunAgentQuery = useRawInputPath;
      let processedOverrides: {
        allowedTools?: string[];
        model?: string;
        effort?: string;
      } = {};
      let commandInvocationId: string | undefined;
      const attachmentCtxForProcessor = ensureAttachmentContext(
        config.getSessionId(),
        cwd,
      );
      if (options?.useInputProcessor === true && !signal.aborted) {
        try {
          const processorPrompt =
            options.contentBlocks && options.contentBlocks.length > 0
              ? options.contentBlocks
              : promptText;
          const commands: QueuedCommand[] =
            options.queuedCommands && options.queuedCommands.length > 0
              ? options.queuedCommands.map((cmd, index) => ({
                  ...cmd,
                  uuid: cmd.uuid ?? (index === 0 ? userMessageUuid : undefined),
                  pastedContents:
                    index === 0
                      ? (cmd.pastedContents ?? submissionPastedContents)
                      : cmd.pastedContents,
                  preExpansionPrompt:
                    cmd.preExpansionPrompt ??
                    (typeof cmd.prompt === 'string' ? cmd.prompt : promptText),
                }))
              : [
                  {
                    prompt: processorPrompt,
                    preExpansionPrompt: promptText,
                    commandMode: options.commandMode ?? 'prompt',
                    pastedContents: submissionPastedContents,
                    uuid: userMessageUuid,
                    isMeta: options.isMeta,
                    suppressWorkflowKeyword: options.suppressWorkflowKeyword,
                  },
                ];
          const processed = await businessInfoContext.run(
            turnBusinessInfo,
            () =>
              executeUserInput(commands, {
                attachmentCtx: attachmentCtxForProcessor,
                config,
                hookCoordinator: hookCoordinatorRef.current,
                sessionId: config.getSessionId(),
                cwd,
                isInitialTurn: isInitialAgentTurn,
                messages: messagesRef.current,
                externalContext: buildAttachmentExternalContext(),
                signal,
                promptId,
                taskId: requestSetId,
                querySource: 'tui',
                onQuery: async () => {},
                onSlashCommand: async (input) => {
                  const result = await onSlashCommand?.(
                    input,
                    submissionPastedContents,
                  );
                  if (!result) {
                    if (result === false) {
                      await prepareFirstModelRequest();
                      // The slash processor did not recognize this command-style
                      // input (e.g. a pasted absolute path like "/Users/... fix
                      // this"), so processUserInput falls back to a plain text
                      // prompt. Nothing else renders that prompt: the early echo
                      // skips "/"-prefixed input and the echo loop below skips
                      // processor-built user messages (origin: human). Echo the
                      // original input here so the user's message stays visible.
                      // This also applies to queued slash-style input: those
                      // commands are dispatched individually at idle time and do
                      // not have a queued_command attachment render path.
                      echoUserInput();
                      return false;
                    }
                    return { messages: [], shouldQuery: false };
                  }
                  if ('messages' in result) {
                    if (result.shouldQuery) {
                      await prepareFirstModelRequest();
                    }
                    return result;
                  }
                  if (result.type === 'submit_prompt') {
                    await prepareFirstModelRequest();
                    const expandedPrompt = partToString(result.content);
                    return {
                      messages: [
                        {
                          ...createUserMessage(expandedPrompt, {
                            uuid: userMessageUuid,
                            isMeta: result.isMeta,
                            origin: { kind: 'human' },
                            permissionMode: config.getPermissionMode(),
                          }),
                          ...(result.isUserDecision
                            ? { isUserDecision: true as const }
                            : {}),
                        },
                      ],
                      shouldQuery: true,
                      commandInvocationId: result.commandInvocationId,
                      attachmentInput: expandedPrompt,
                      ...pickQueryOverrides(result),
                    };
                  }
                  if (
                    result.type === 'schedule_tool' &&
                    result.postSubmitPrompt !== undefined
                  ) {
                    await prepareFirstModelRequest();
                    const expandedPrompt = partToString(
                      result.postSubmitPrompt,
                    );
                    return {
                      messages: [
                        createUserMessage(expandedPrompt, {
                          uuid: userMessageUuid,
                          origin: { kind: 'human' },
                          permissionMode: config.getPermissionMode(),
                        }),
                      ],
                      shouldQuery: true,
                      attachmentInput: expandedPrompt,
                    };
                  }
                  return { messages: [], shouldQuery: false };
                },
                onBridgeSlashCommand,
                onBashCommand: async (input) => {
                  const outcome = await onBashCommand?.(input, signal);
                  const result = outcome
                    ? buildBashCommandProcessResult(
                        outcome,
                        respondToBashCommands && !signal.aborted,
                      )
                    : { messages: [], shouldQuery: false };
                  if (result.shouldQuery) {
                    await prepareFirstModelRequest();
                  }
                  return result;
                },
              }),
          );

          // Input hooks can finish after cancellation without throwing.
          // Discard their result before announcing input or reviving the turn.
          if (signal.aborted) return;

          didProcessInput = true;
          shouldRunAgentQuery = processed.shouldQuery;
          if (processed.shouldQuery && !signal.aborted) {
            // Final safety boundary for every processor route. Known routes
            // prepare earlier when attachment generation needs the locked MCP
            // mode, while this prevents a future shouldQuery path from
            // reaching the model without a process-level decision.
            await prepareFirstModelRequest();
          }
          if (signal.aborted) return;
          runtimeProjectionRef.current.handleInputResolved(
            processed.shouldQuery,
          );
          // Input-processing errors (including an unreadable pasted image)
          // reject the turn before it reaches the model. Restore the submitted
          // prompt so stable image placeholders remain editable instead of
          // disappearing after Enter.
          if (processed.resultIsError === true) {
            onCancelSubmit(true);
          }
          processedOverrides = pickQueryOverrides(processed);
          commandInvocationId = processed.commandInvocationId;
          if (isCommandStylePrompt && processed.shouldQuery) {
            // A slash-style prompt may be either a local UI command or a
            // model-backed command. Wait for the processor to distinguish the
            // two so local commands cannot claim the session title.
            startInitialAiTitleGeneration();
          }

          // Echo each user message and announce it to session subscribers.
          // Share filtering and text extraction between both operations.
          {
            let announcedFirst = false;
            for (const msg of processed.messages) {
              if (msg.type !== 'user' || msg.isMeta) continue;
              // Messages with origin are rendered by the queued_command
              // attachment loop below — skip here to avoid double-rendering.
              if (msg.origin) continue;
              const text = extractText(msg.message.content);
              if (!text.trim()) continue;

              if (!options?.hideFromDisplay) {
                addItemRef.current({ type: MessageType.USER, text });
              }
              if (shouldEmitInputEvent) {
                try {
                  onLocalUserMessageRef.current?.({
                    text,
                    ...(!announcedFirst && inputContentBlocks
                      ? { contentBlocks: inputContentBlocks }
                      : {}),
                    uuid: msg.uuid ?? userMessageUuid,
                  });
                } catch {
                  // Input event subscribers must not break local execution.
                }
                announcedFirst = true;
              }
              didEchoUserInput = true;
            }
          }

          for (const [index, msg] of processed.messages.entries()) {
            if (
              msg.type === 'user' &&
              !msg.isMeta &&
              (msg.requestSetId === requestSetId ||
                msg.uuid === userMessageUuid)
            ) {
              msg.businessModelKey = turnBusinessInfo.model_key;
            }
            messagesRef.current.push(msg);
            if (isChainParticipant(msg)) {
              try {
                await recordMessage(msg, true);
              } catch (error) {
                const remaining = processed.messages.slice(index + 1);
                messagesRef.current.push(...remaining);
                pendingTranscriptRecordsRef.current.push(
                  ...remaining.filter(isChainParticipant).map((message) => ({
                    sessionId: config.getSessionId(),
                    message,
                    reason: 'write_failed' as const,
                  })),
                );
                throw error;
              }
            }
            try {
              onCoreEventRef.current?.(msg as QueryEvent);
            } catch {
              // Input event subscribers must not break local execution
            }
            if (msg.type === 'attachment') {
              const hookAttachment = getHookAttachment(msg.attachment);
              if (hookAttachment) {
                renderHookAttachmentToHistory(
                  hookAttachment,
                  addItemRef.current,
                );
              }
            }
            // Render mid-turn user interjections at the correct position
            if (
              msg.type === 'attachment' &&
              msg.attachment?.type === 'queued_command' &&
              (!msg.attachment['isMeta'] || isPeerQueuedCommand(msg.attachment))
            ) {
              const text = extractQueuedCommandText(msg.attachment['prompt']);
              if (text) {
                const item = buildQueuedCommandHistoryItem(
                  msg.attachment,
                  text,
                );
                if (item) addItemRef.current(item);
              }
            }
            if (!processed.shouldQuery && msg.type === 'system') {
              addItemRef.current({
                type:
                  msg.level === 'error' ? MessageType.ERROR : MessageType.INFO,
                text: msg.content,
              });
            }
          }
        } catch (err) {
          shouldRunAgentQuery = false;
          runtimeProjectionRef.current.handleInputResolved(false);
          if (!signal.aborted && !isAbortError(err)) {
            runLogger.warn(
              '[useLocalTuiSessionOrchestrator] input processor pipeline error:',
              err,
            );
            const text = formatTuiApiError(err);
            addItemRef.current({ type: MessageType.ERROR, text });
            runtimeProjectionRef.current.recordTurnEnd({ error: text });
          }
        }
      }

      // Pasted images must be inlined into the pending user message's content,
      // not appended as a standalone isMeta UserMessage in priorHistory.
      // Otherwise auto-compaction (which compresses everything in priorHistory)
      // summarizes the image away — pending preservation in agent-loop.ts only
      // protects the last user message, and post-compact restore has no logic
      // for inline images. Mirrors processor.ts:processTextPrompt.
      let pastedImageContentBlocks: readonly ModelInputContentBlock[] = [];
      let pastedImageMetadataTexts: string[] = [];
      const pastedContents = submissionPastedContents;
      if (useRawInputPath && pastedContents && !signal.aborted) {
        try {
          const projectTempDir = config.storage.getProjectTempDir();
          const sessionImagesDir = nodePath.join(
            projectTempDir,
            'images',
            config.getSessionId(),
          );
          const filteredContents = filterOrphanedImages(
            pastedContents,
            promptText,
          );
          const imagePipeline = await processPastedImages(
            filteredContents,
            sessionImagesDir,
          );
          pastedImageContentBlocks = imagePipeline.imageContentBlocks;
          pastedImageMetadataTexts = imagePipeline.imageMetadataTexts;
        } catch (err) {
          runLogger.log(
            '[useLocalTuiSessionOrchestrator] image paste pipeline error:',
            err,
          );
        }
      }

      let queryPrompt: ModelStreamUserContent;
      if (didProcessInput) {
        queryPrompt = promptText;
      } else if (options?.contentBlocks?.length) {
        queryPrompt = options.contentBlocks;
      } else if (pastedImageContentBlocks.length > 0) {
        queryPrompt = promptText
          ? [{ type: 'text', text: promptText }, ...pastedImageContentBlocks]
          : [...pastedImageContentBlocks];
      } else {
        queryPrompt = promptText;
      }

      const pendingDurableInputAttachments: Array<
        Extract<Message, { type: 'attachment' }>
      > = [];
      if (fileHistoryManagerRef.current) {
        await fileHistoryManagerRef.current.makeSnapshot(userMessageUuid);
      }

      const attachmentCtx = attachmentCtxRef.current;
      // The agent loop can end before yielding these attachments (hook block or
      // stop, early return, error); generators must not treat them as announced.
      let restoreRawInputDeltaState:
        | ReturnType<typeof snapshotAttachmentDeltaState>
        | undefined;
      const deliveredRawInputAttachments = new Set<
        (typeof pendingDurableInputAttachments)[number]
      >();
      const markRawInputAttachmentDelivered = (event: QueryEvent) => {
        if (
          event.type !== 'attachment' ||
          !pendingDurableInputAttachments.includes(event)
        )
          return;
        deliveredRawInputAttachments.add(event);
        if (
          deliveredRawInputAttachments.size ===
          pendingDurableInputAttachments.length
        ) {
          restoreRawInputDeltaState = undefined;
        }
      };
      if (useRawInputPath && attachmentCtx && !signal.aborted) {
        restoreRawInputDeltaState = snapshotAttachmentDeltaState(attachmentCtx);
        try {
          const listingModel = processedOverrides.model ?? config.getModel();
          const listingIdentity = config.getModelRequestIdentity();
          const listingSessionId = config.getSessionId();
          const currentModel = config.getModel();
          const listingEntry = await config
            .getModelProviderManager()
            .getModel(listingModel);
          const skillListingConfig = await getSkillListingConfig(config, {
            model: listingModel,
            modelEntry: listingEntry,
          });
          if (
            signal.aborted ||
            currentModel !== config.getModel() ||
            listingIdentity !== config.getModelRequestIdentity() ||
            listingSessionId !== config.getSessionId()
          )
            return;
          const attachmentMsgs = await getAttachmentMessages(
            promptText,
            attachmentCtx,
            [],
            getModelVisibleSkillsForTools(
              config,
              toolRegistry.getSchema(listingModel).map((tool) => tool.name),
            ),
            {
              signal,
              isInitialTurn: isInitialAgentTurn,
              // The raw-input path bypasses the input processor, so it has to
              // declare the surface itself — and it must apply the same test.
              // Plenty of callers reach `submitQuery` without
              // `useInputProcessor`: slash `submit_prompt` results, steering
              // hints, `/goal` and `/review`. Those carry `isMeta` and are not
              // text a human typed into the composer, so they get no peer
              // mentions either.
              isTuiPrompt:
                !options?.isMeta && effectiveCommandMode === 'prompt',
              suppressWorkflowKeyword:
                options?.suppressWorkflowKeyword ?? false,
              workflowKeywordTriggerEnabled:
                config.getWorkflowKeywordTriggerEnabled(),
              ultracodeActive: config.isUltracodeActive(listingEntry),
              ultracodeRegularUserPrompt:
                effectiveCommandMode === 'prompt' && !options?.isMeta,
              isTodoToolEnabled: config
                .getToolRegistry()
                .hasToolEnabled(WRITE_TODOS_TOOL_NAME),
              isTaskUpdateToolEnabled: config
                .getToolRegistry()
                .hasToolEnabled(TASK_UPDATE_TOOL_NAME),
              taskStore: config.isTasksEnabled()
                ? config.getTaskStore()
                : undefined,
              skillListingConfig,
            },
            buildAttachmentExternalContext(),
            config.planStateManager,
            messagesRef.current,
          );
          for (const msg of attachmentMsgs) {
            const message = msg as unknown as Message;
            if (isChainParticipant(message)) {
              pendingDurableInputAttachments.push(
                message as Extract<Message, { type: 'attachment' }>,
              );
            } else {
              messagesRef.current.push(message);
            }
          }
          if (pendingDurableInputAttachments.length === 0) {
            restoreRawInputDeltaState = undefined;
          }

          // Presentation-only attachments stay in runtime history. Attachments
          // with replay or ordering semantics are appended after the human
          // message is yielded so runtime and transcript order stay identical.
        } catch (err) {
          runLogger.log(
            '[useLocalTuiSessionOrchestrator] attachment pipeline error:',
            err,
          );
        }
      }
      // Image metadata text (path/source hints) is pushed as a separate isMeta
      // UserMessage so it shows up in scrollback / transcript. It's plain text;
      // if a future turn compresses it, no harm. The image content blocks
      // themselves are already inlined into queryPrompt above.
      if (useRawInputPath && pastedImageMetadataTexts.length > 0) {
        messagesRef.current.push(
          createUserMessage(
            pastedImageMetadataTexts.map((text) => ({
              type: 'text' as const,
              text,
            })),
            {
              isMeta: true,
            },
          ),
        );
      }

      let terminal: Terminal | undefined;
      let errorProviderSource: string | undefined;
      let hasTopLevelAssistantResponseForTurn = false;
      let turnStore = sessionStateStoreRef.current;
      try {
        if (shouldRunAgentQuery) {
          if (isSlashPrompt && !startupReadinessSatisfied) {
            const ready = await waitForStartupReadiness();
            if (!ready) {
              return;
            }
          }
          const querySessionId = config.getSessionId();
          const pendingHydration =
            getPendingSessionUsageHydration(querySessionId);
          if (pendingHydration) {
            await pendingHydration;
          }
          if (signal.aborted || config.getSessionId() !== querySessionId) {
            return;
          }
          await waitForRequestConfig();
          await config.getProcessPermissionManager()?.getManagedPolicy().whenReady?.();
          const restriction = config.getPermissionModeRestriction(
            config.getPermissionMode(),
          );
          if (restriction) throw new PermissionModeUnavailableError(restriction);
          turnStore = sessionStateStoreRef.current;
          // Per-query slash-command frontmatter overrides (e.g. a skill that
          // pins `model:`/`effort:`) flow through as the request's
          // requestedModel / reasoningEffort and are applied by select.
          const effectiveEffort = parseReasoningEffortLevel(
            processedOverrides.effort,
          );
          // Raw TUI input has not entered the transcript yet, so represent that
          // pending message exactly as the agent loop will and apply the shared
          // rule to it directly — the same origin/meta/input-mode/tool-result
          // checks every other host goes through. Once input processing has
          // appended the message, look it up in the transcript instead.
          const isTaskTriggeringInput = didProcessInput
            ? isTaskTriggeringPrompt(messagesRef.current, userMessageUuid)
            : isHumanTaskInputMessage(
                createUserMessage(
                  typeof queryPrompt === 'string'
                    ? queryPrompt
                    : queryPrompt.map(modelInputToTranscriptBlock),
                  {
                    origin: { kind: 'human' },
                    isMeta: options?.isMeta,
                    humanInput:
                      effectiveCommandMode === 'prompt' ||
                      effectiveCommandMode === 'bash'
                        ? {
                            text: promptText,
                            mode: effectiveCommandMode,
                          }
                        : undefined,
                  },
                ),
              );
          const taskTrigger = isTaskTriggeringInput
            ? 'user_prompt'
            : 'continuation';
          // Forward request overrides; select reads the session model defaults.
          const loopOptions = {
            turnHookFactories: config.turnHookFactories,
            businessInfo: turnBusinessInfo,
            prompt: queryPrompt,
            sessionId: config.getSessionId(),
            sourceSessionId: runtimeSourceSessionIdRef.current,
            signal,
            // Awaited here (inside the turn-tracking try) so an unready
            // registry waits for base readiness instead of crashing the
            // submission before the turn lifecycle is armed.
            resolveSystemPrompt: await resolveTurnSystemPrompt(signal),
            promptId,
            preallocatedRequestSetId: requestSetId,
            userMessageSubmittedAtMs:
              taskTrigger === 'user_prompt'
                ? userMessageSubmittedAtMs
                : undefined,
            toolRegistry,
            toolExecutor: config.getToolExecutor(),
            maxTurns,
            messages: messagesRef.current,
            initialInputAttachments: pendingDurableInputAttachments,
            isAttachmentCommitted: (message) =>
              messagesRef.current.some(
                (candidate) => candidate.uuid === message.uuid,
              ),
            permissionMode: config.getPermissionMode(),
            repeatedToolCallAllowedKeys: repeatedToolCallAllowedKeysRef.current,
            querySource: 'tui',
            allowedTools: processedOverrides.allowedTools,
            commandInvocationId,
            userMessage: userMessageMetadata,
            isMeta: options?.isMeta,
            hookCoordinator: hookCoordinatorRef.current,
            sessionStateStore: turnStore ?? undefined,
            compressionPipeline: compressionPipelineRef.current,
            onCompressionCompleted: (prior, next) =>
              applyPostCompact(prior, next, buildPostCompactCallbacks()),
            onCacheSafeSnapshot: (snapshot) => {
              if (!snapshot.lastAssistantUsage) {
                suggestionPrefixRevisionRef.current =
                  suggestionRuntimeRevisionRef.current;
              }
              lastCacheSafeQuerySnapshotRef.current = snapshot;
            },
            config,
            attachmentCtx: attachmentCtxRef.current ?? undefined,
            startupMemoryContext: createStartupMemoryContext(config),
            skipInitialUserMessage: didProcessInput,
            skipBeforeHook: didProcessInput,
            stopHookActive: options?.stopHookActive,
            taskTrigger,
            eventBus: queryEvents,
          } satisfies Parameters<typeof query>[0];
          hasRunAgentQueryRef.current = true;
          terminal = await sessionIdContext.run(
            config.getSessionId(),
            async () => {
              const generator = query({
                ...loopOptions,
                querySelection:
                  processedOverrides.model !== undefined ||
                  effectiveEffort !== undefined
                    ? {
                        key: processedOverrides.model,
                        config: { reasoning: { effort: effectiveEffort } },
                      }
                    : undefined,
              });
              let persistenceFailed = false;
              let result: IteratorResult<QueryEvent, Terminal> | undefined;
              let consumerFailure: { error: unknown } | undefined;
              try {
                result = await generator.next();

                while (!result.done) {
                  const event: QueryEvent = result.value;
                  const isChildScoped = isChildScopedQueryEvent(event);
                  if (
                    !isChildScoped &&
                    event.type === 'assistant' &&
                    event.isApiErrorMessage
                  ) {
                    errorProviderSource = event.modelError?.providerSource;
                  }
                  switch (event.type) {
                    case 'request_start':
                      clearActiveModelQueue();
                      runtimeProjectionRef.current.handleRequestStart();
                      break;
                    case 'stream_event':
                      if (!isChildScoped) {
                        runtimeProjectionRef.current.handleStreamEvent(
                          event.event,
                        );
                      }
                      break;
                    case 'assistant_block':
                      runtimeProjectionRef.current.handleAssistantBlock(
                        event.message,
                        event.index,
                      );
                      break;
                    case 'result_text_reset':
                      // Internal aggregation marker; it is not a durable message.
                      break;
                    case 'error_notification':
                      break;
                    default: {
                      if (
                        event.type === 'assistant' &&
                        !isChildScoped &&
                        !event.isApiErrorMessage
                      ) {
                        if (event.isContentFilteredMessage) {
                          const text = extractText(
                            event.message.content,
                          ).trim();
                          if (text) {
                            addItemRef.current(
                              { type: MessageType.ERROR, text },
                              Date.now(),
                              // The marked assistant is the durable transcript
                              // representation for this error.
                              true,
                            );
                          }
                        } else {
                          if (
                            isTitleEligibleAssistantMessage(event as Message)
                          ) {
                            hasTopLevelAssistantResponseForTurn = true;
                          }
                          runtimeProjectionRef.current.handleAssistantMessage(
                            event.message,
                          );
                        }
                      } else if (
                        event.type === 'user' &&
                        !isChildScoped &&
                        Array.isArray(event.message.content)
                      ) {
                        const toolUseIds = (
                          event.message.content as Array<{
                            type: string;
                            tool_use_id?: string;
                          }>
                        )
                          .filter(
                            (block) =>
                              block.type === 'tool_result' &&
                              !!block.tool_use_id,
                          )
                          .map((block) => block.tool_use_id!);
                        runtimeProjectionRef.current.handleToolResultMessage(
                          event,
                        );
                        runtimeProjectionRef.current.markToolResultsSubmitted(
                          toolUseIds,
                        );
                      } else if (
                        event.type === 'attachment' &&
                        !isChildScoped
                      ) {
                        const att = getHookAttachment(event.attachment);
                        if (att) {
                          const acc = stopHookAccRef.current;
                          if (isStopHookEvent(att.hookEvent) && acc) {
                            if (att.type === 'hook_non_blocking_error') {
                              acc.hookErrors.push(
                                att.stderr || `Exit code ${att.exitCode}`,
                              );
                            } else if (
                              att.type === 'hook_error_during_execution'
                            ) {
                              acc.hookErrors.push(att.content);
                            } else if (att.type === 'hook_blocking_error') {
                              acc.hookErrors.push(
                                att.blockingError.blockingError,
                              );
                            } else if (
                              att.type === 'hook_stopped_continuation'
                            ) {
                              acc.preventedContinuation = true;
                              acc.stopReason = att.message;
                            }
                          }
                          renderHookAttachmentToHistory(
                            att,
                            addItemRef.current,
                          );
                        }
                      }
                      // Render mid-turn user interjections during streaming
                      if (
                        event.type === 'attachment' &&
                        !isChildScoped &&
                        event.attachment?.type === 'queued_command' &&
                        (!event.attachment['isMeta'] ||
                          isPeerQueuedCommand(event.attachment))
                      ) {
                        const text = extractQueuedCommandText(
                          event.attachment['prompt'],
                        );
                        if (text) {
                          const item = buildQueuedCommandHistoryItem(
                            event.attachment,
                            text,
                          );
                          if (item) addItemRef.current(item);
                        }
                      }
                      const isQueueStatusEvent = isModelQueueStatusEvent(event);
                      if (isQueueStatusEvent && !isChildScoped) {
                        const { modelQueue, didUpdate } =
                          updateActiveModelQueue(
                            event,
                            currentModelQueueRef,
                            setActiveModelQueue,
                          );
                        if (didUpdate) {
                          if (modelQueue.status === 'ready') {
                            scheduleReadyModelQueueClear();
                          } else {
                            clearReadyModelQueueTimer();
                          }
                        }
                      }
                      if (
                        !isChildScoped &&
                        !isQueueStatusEvent &&
                        event.type !== 'command_lifecycle'
                      ) {
                        if (event.type === 'assistant') {
                          clearActiveModelQueue();
                        }
                        const isAlreadyInRuntimeHistory =
                          isDuplicateRuntimeMessage(event);
                        if (isAlreadyInRuntimeHistory) {
                          markRawInputAttachmentDelivered(event);
                        }
                        if (!isAlreadyInRuntimeHistory) {
                          messagesRef.current.push(event);
                          markRawInputAttachmentDelivered(event);
                          if (
                            event.type === 'assistant' &&
                            event.message.usage &&
                            turnStore
                          ) {
                            recordSessionUsageInMemory(
                              turnStore,
                              event.message.usage,
                            );
                          }
                          if (persistenceFailed) {
                            pendingTranscriptRecordsRef.current.push({
                              sessionId: config.getSessionId(),
                              message: event,
                              reason: 'write_failed',
                            });
                          } else {
                            try {
                              await recordMessage(event, true);
                            } catch (error) {
                              // Stop further inference/tools, but drain the query's
                              // cancellation path so already executed tool results
                              // are retained rather than silently lost on return().
                              persistenceFailed = true;
                              turnAbortController.abort();
                              addItemRef.current(
                                {
                                  type: MessageType.ERROR,
                                  text: formatTuiApiError(error),
                                },
                                Date.now(),
                                true,
                              );
                            }
                          }
                        }
                      }
                      break;
                    }
                  }

                  try {
                    onCoreEventRef.current?.(event);
                  } catch {
                    // Input event subscribers must not break local execution
                  }
                  result = await generator.next();
                }

                if (result.done) {
                  return result.value;
                }

                return undefined;
              } catch (error) {
                consumerFailure = { error };
                throw error;
              } finally {
                if (!result?.done) {
                  try {
                    if (consumerFailure)
                      await generator.throw(consumerFailure.error);
                    else await generator.return(undefined as never);
                  } catch (error) {
                    if (!consumerFailure)
                      runLogger.debug(
                        '[TUI] Failed to close Agent Loop:',
                        error,
                      );
                  }
                }
              }
            },
          );

          runtimeProjectionRef.current.flushPendingToHistory({
            skipEmptyAssistant: true,
          });

          const stopAcc = stopHookAccRef.current;
          if (stopAcc) {
            const summaryItem = buildStopHookSummaryHistoryItem(stopAcc);
            if (summaryItem) addItemRef.current(summaryItem);
            stopHookAccRef.current = null;
          }

          if (terminal?.reason === 'error' && terminal.error) {
            // Suppress error display for user-initiated cancellations
            const errMsg =
              terminal.error instanceof Error
                ? terminal.error.message
                : String(terminal.error);
            const isAbort =
              (terminal.error instanceof Error &&
                terminal.error.name === 'AbortError') ||
              errMsg.includes('operation was aborted') ||
              errMsg.includes('operation was canceled') ||
              errMsg.includes('Request cancelled');
            if (isAbort) {
              runtimeProjectionRef.current.recordTurnEnd('cancelled');
            } else {
              const text = formatTuiApiError(
                terminal.error,
                errorProviderSource,
              );
              runtimeProjectionRef.current.recordTurnEnd({ error: text });
              addItemRef.current(
                {
                  type: MessageType.ERROR,
                  text,
                  ...(terminal.modelStopReason === 'refusal'
                    ? { excludedFromContext: true }
                    : {}),
                },
                Date.now(),
                // The query stream already persisted a structured synthetic
                // API error. Avoid writing a second system/error transcript
                // record for the same failure.
                true,
              );
            }
          }

          if (terminal?.reason === 'abort') {
            runtimeProjectionRef.current.recordTurnEnd('cancelled');
          }

          if (terminal?.reason === 'max_turns' && maxTurns !== undefined) {
            addItemRef.current(
              {
                type: MessageType.WARNING,
                text: `Reached the ${maxTurns}-turn limit for this run. Conversation history and tool results are preserved; type "continue" or enter another instruction to keep working.`,
              },
              Date.now(),
            );
          }

          if (terminal) {
            if (terminal.reason === 'end_turn' && shouldRunAgentQuery) {
              generatePromptSuggestionsForTurn(
                queryId,
                promptId,
                requestSetId,
                signal,
                turnBusinessInfo,
                terminal,
              );
            }
          }
        } else {
          runtimeProjectionRef.current.flushPendingToHistory({
            skipEmptyAssistant: true,
          });
        }
      } catch (err) {
        runtimeProjectionRef.current.flushPendingToHistory();

        // Suppress error display for user-initiated cancellations
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          (err instanceof Error &&
            (err.message.includes('operation was aborted') ||
              err.message.includes('operation was canceled') ||
              err.message.includes('Request cancelled')));
        if (isAbort) {
          runtimeProjectionRef.current.recordTurnEnd('cancelled');
        } else {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const text = formatTuiApiError(err);
          runtimeProjectionRef.current.recordTurnEnd({ error: text });
          addItemRef.current({ type: MessageType.ERROR, text });
          if (err instanceof PermissionModeUnavailableError) {
            try {
              onCoreEventRef.current?.({
                type: 'error_notification',
                error_type: 'submission_failed',
                message: text,
                timestamp: new Date().toISOString(),
              });
            } catch {
              // Never break the local loop for remote sync failures
            }
          }
          runLogger.warn(
            'Tool call error in useLocalTuiSessionOrchestrator:',
            err instanceof Error ? (err.stack ?? err.message) : errorMessage,
          );
        }
      } finally {
        restoreRawInputDeltaState?.([...deliveredRawInputAttachments]);
        if (turnStore) {
          await flushSessionUsage(turnStore).catch((err) =>
            runLogger.warn(
              '[useLocalTuiSessionOrchestrator] Failed to flush session usage',
              { error: err },
            ),
          );
        }
        if (abortControllerRef.current === turnAbortController) {
          abortControllerRef.current = null;
        }
        if (activeQueryIdRef.current === queryId) {
          runtimeProjectionRef.current.finishTurn();
          clearActiveModelQueue();
        }
        try {
          onTurnCompleteRef.current?.();
        } catch {
          // Input event subscribers must not break local execution
        }

        const isSuccessfulTurn =
          terminal?.reason === 'end_turn' &&
          !turnCancelledRef.current &&
          !signal.aborted &&
          hasTopLevelAssistantResponseForTurn;
        const committedAiTitlePromptCount = commitAiTitleCadenceForTurn(
          pendingAiTitlePromptCount,
          isSuccessfulTurn,
        );
        if (committedAiTitlePromptCount !== null) {
          aiTitlePromptCountRef.current = committedAiTitlePromptCount;
        }
        if (committedAiTitlePromptCount !== null && aiTitleOptionsForTurn) {
          scheduleAiTitleCheck({
            ...aiTitleOptionsForTurn,
            waitForInFlight: committedAiTitlePromptCount === 1,
            businessInfo: turnBusinessInfo,
          });
        }
      }
    },
    [
      awaitSessionStartHooks,
      buildPostCompactCallbacks,
      clearActiveModelQueue,
      clearReadyModelQueueTimer,
      config,
      createLocalTurnPromptResolver,
      ensureAttachmentContext,
      generatePromptSuggestionsForTurn,
      getPendingSessionUsageHydration,
      maxTurns,
      isDuplicateRuntimeMessage,
      isCommandStyleInput,
      isSlashCommandInput,
      onBashCommand,
      onBridgeSlashCommand,
      onCancelSubmit,
      onSlashCommand,
      onStartupWaitingChange,
      queryEvents,
      recordMessage,
      recoverTranscriptWriterForPendingRecords,
      respondToBashCommands,
      runtimeProjectionRef,
      scheduleAiTitleCheck,
      scheduleReadyModelQueueClear,
    ],
  );

  // Keep submission-wide settlement outside the input pipeline so early exits
  // are covered without nesting every existing preparation and execution path.
  const submitQuery = useCallback(
    async (userQuery: PartListUnion, options?: SubmitQueryOptions) => {
      const submittedAtMs = performance.now();
      const abortController = new AbortController();
      const requestSetId = randomUUID();
      let policyRejected = false;
      try {
        await executeSubmitQuery(userQuery, options, {
          submittedAtMs,
          abortController,
          requestSetId,
        });
      } catch (error) {
        runLogger.warn('tui.submit.failed', error);
        if (!abortController.signal.aborted && !isAbortError(error)) {
          const message = formatTuiApiError(error);
          runtimeProjectionRef.current.recordTurnEnd({ error: message });
          if (error instanceof PermissionModeUnavailableError) {
            policyRejected = true;
            addItemRef.current({ type: MessageType.ERROR, text: message });
            try {
              onCoreEventRef.current?.({
                type: 'error_notification',
                error_type: 'submission_failed',
                message,
                timestamp: new Date().toISOString(),
              });
            } catch {
              // Never break the local loop for remote sync failures
            }
          } else {
            addItemRef.current(
              { type: MessageType.ERROR, text: message },
              Date.now(),
              true,
            );
          }
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
          runtimeProjectionRef.current.finishTurn();
          clearActiveModelQueue();
          stopHookAccRef.current = null;
        }
        if (policyRejected) {
          try {
            onTurnCompleteRef.current?.();
          } catch {
            // Never break the local loop for remote sync failures
          }
        }
      }
    },
    [
      clearActiveModelQueue,
      executeSubmitQuery,
      runtimeProjectionRef,
    ],
  );

  const submitUserInput = useCallback(
    async (input: string, options?: SubmitUserInputOptions) => {
      await submitQuery(input, {
        hideFromDisplay: options?.hideFromDisplay,
        userMessage: options?.userMessage,
        contentBlocks: options?.contentBlocks,
        pastedContents: options?.pastedContents,
        commandMode: options?.commandMode,
        queuedCommands: options?.queuedCommands,
        suppressWorkflowKeyword: options?.suppressWorkflowKeyword,
        countTowardsAiTitleCadence: true,
        useInputProcessor: true,
      });
    },
    [submitQuery],
  );

  const cancelOngoingRequest = useCallback(() => {
    const streamingState = runtimeProjectionRef.current.getStreamingState();
    const hasAbortableOperation =
      abortControllerRef.current !== null &&
      !abortControllerRef.current.signal.aborted;
    const shouldCancelProjection =
      streamingState === StreamingState.Responding ||
      streamingState === StreamingState.WaitingForConfirmation;
    if (!shouldCancelProjection && !hasAbortableOperation) {
      return;
    }
    if (turnCancelledRef.current) return;
    turnCancelledRef.current = true;

    if (!abortControllerRef.current) {
      abortControllerRef.current = new AbortController();
    }
    abortControllerRef.current.abort();
    if (shouldCancelProjection) {
      runtimeProjectionRef.current.cancelAllToolCalls(
        abortControllerRef.current.signal,
      );
      runtimeProjectionRef.current.cancelTurn();
    }
    onCancelSubmit(false);
    focusMachine?.focusChat();

    // A user interrupt has to stop the goal loop too, not just the in-flight
    // request. Leaving the goal Active means the Stop hook keeps denying
    // stops, so the very next message silently restarts the loop and burns
    // the turns the user thought they had just stopped.
    const goalManager = config.getGoalManager();
    if (goalManager.isGoalActive) {
      void goalManager
        .pauseForInterrupt()
        .then((paused) => {
          if (!paused) return;
          // Same teardown as `/goal pause`: refresh the tool schema cache
          // after the state change.
          config.getToolRegistry().invalidateSchemaCache();
          addItem(
            {
              type: MessageType.INFO,
              text: `Goal paused: ${
                goalManager.getGoal()?.objective ?? 'unknown'
              }. Use /goal resume to continue.`,
            },
            Date.now(),
          );
        });
    }
  }, [onCancelSubmit, runtimeProjectionRef, focusMachine, config, addItem]);

  const handlePermissionModeChange = useCallback(
    async (_newPermissionMode: PermissionMode) => {
      // Nothing to do. The module re-runs every pending check when the mode
      // changes and pushes the new verdict to the prompt that raised it, so an
      // allow or a deny clears itself and an ask stays. This used to approve the
      // queue by hand under Yolo, which meant keeping the list of prompts that
      // survive Yolo in a second place.
      //
      // Kept rather than removed: AppContainer takes this and the remote
      // controller's handler through one slot, and the remote one applies the
      // mode itself.
    },
    [],
  );

  const handleExternalImportApproval = useCallback(
    (result: ExternalImportApprovalResult) => {
      const currentFingerprint = getExternalImportFingerprint(
        externalImportApprovalState.pendingImports,
      );
      switch (result.choice) {
        case ExternalImportApprovalChoice.ALWAYS_APPROVE:
          dismissedExternalImportFingerprintRef.current = null;
          {
            const projectRoot = config.getSessionArtifactProjectRoot();
            const sessionSettings = config.getLoadedSettings();
            if (
              !approveExternalImportsForProject(projectRoot, sessionSettings)
            ) {
              return;
            }
          }
          break;
        case ExternalImportApprovalChoice.APPROVE:
          dismissedExternalImportFingerprintRef.current = null;
          break;
        case ExternalImportApprovalChoice.REJECT:
          dismissedExternalImportFingerprintRef.current = currentFingerprint;
          setExternalImportApprovalState(EMPTY_EXTERNAL_IMPORT_STATE);
          return;
        default:
          break;
      }

      setExternalImportApprovalState(EMPTY_EXTERNAL_IMPORT_STATE);
      const memoryManager = config.getMemoryContextManager();
      if (memoryManager) {
        memoryManager.resolveExternalImports().catch((err: unknown) => {
          runLogger.log(
            'warn',
            `Failed to resolve external imports: ${String(err)}`,
          );
        });
      }
    },
    [config, externalImportApprovalState.pendingImports],
  );

  const getMessages = useCallback(() => messagesRef.current, []);
  const setMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    messagesRef.current = updater(messagesRef.current);
  }, []);

  const runtime = {
    dispose,
    submitUserInput,
    submitQuery,
    cancelOngoingRequest,
    handlePermissionModeChange,
    replaceMessages,
    rewindConversation,
    queueHookContext,
    recordSupplementaryHistoryItem,
    recordMessage,
    runManualCompress,
    ensurePromptBuildResult,
    refreshContextTokenCount,
    toolRegistry: rootToolRegistry,
    clearAssemblerCache: () => clearSessionPromptCaches(config),
    rewindFiles,
    getIsResponding: () =>
      runtimeProjectionRef.current.getStreamingState() !== StreamingState.Idle,
    getConversationMessages: () => [...messagesRef.current],
    getMessages,
    setMessages,
    externalImportApprovalState,
    handleExternalImportApproval,
    ensureAiTitle: scheduleAiTitleCheck,
    activeModelQueue,
  };
  // The existing native owner commits its sources. The UI never builds SessionState.
  useLayoutEffect(() => {
    sessionSourceRef.current = {
      config,
      runtime,
      model,
      get projection() {
        return runtimeProjectionRef.current;
      },
      settings: options.settings,
      history: options.displayHistory,
      get displayPendingHistory() {
        return options.getDisplayPendingHistory?.();
      },
      setSystemPrompt: options.setSystemPrompt,
      setAppendSystemPrompt: options.setAppendSystemPrompt,
      permissionQueue: options.permissionQueue,
      isReadyForInput: options.isReadyForSessionInput ?? (() => false),
      isClosed: () => isUnmountedRef.current,
      restoreSession: options.restoreSession,
      systemPromptOverride,
      appendSystemPrompt,
    };
    sessionOwner.adapter?.sync();
  });
  return { ...runtime, getSession };
}

function extractInputContentBlocks(
  content: PartListUnion,
  pastedContents?: Record<number, PastedContent>,
): ModelInputContentBlock[] | undefined {
  const blocks = partListUnionToMirrorContentBlocks(content);
  const pastedImageBlocks = pastedContents
    ? pastedContentsToMirrorImageBlocks(pastedContents, partToString(content))
    : [];
  const contentBlocks = [...blocks, ...pastedImageBlocks];
  return contentBlocks.some((block) => block.type === 'image')
    ? contentBlocks
    : undefined;
}

function partListUnionToMirrorContentBlocks(
  content: PartListUnion,
): ModelInputContentBlock[] {
  if (content == null) {
    return [];
  }
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map(partToMirrorContentBlock)
    .filter((block): block is ModelInputContentBlock => block !== null);
}

function partToMirrorContentBlock(
  part: unknown,
): ModelInputContentBlock | null {
  if (typeof part === 'string') {
    return { type: 'text', text: part };
  }
  if (part == null || typeof part !== 'object') {
    return null;
  }
  const record = part as Record<string, unknown>;
  const text = record['text'];
  if (record['type'] === 'text' && typeof text === 'string') {
    return { type: 'text', text };
  }
  if (record['type'] === 'image' && isImageSource(record['source'])) {
    return { type: 'image', source: record['source'] };
  }
  const inline = record['inlineData'];
  if (inline == null || typeof inline !== 'object') {
    return null;
  }
  const inlineRecord = inline as Record<string, unknown>;
  const inlineData = inlineRecord['data'];
  if (typeof inlineData !== 'string') {
    return null;
  }
  const inlineMimeType = inlineRecord['mimeType'];
  return {
    type: 'image',
    source: {
      type: 'base64',
      mediaType:
        typeof inlineMimeType === 'string' ? inlineMimeType : 'image/png',
      data: inlineData,
    },
  };
}

function pastedContentsToMirrorImageBlocks(
  pastedContents: Record<number, PastedContent>,
  promptText: string,
): ModelInputContentBlock[] {
  const filtered = filterOrphanedImages(pastedContents, promptText);
  const placeholderIds = parseImagePlaceholderIds(promptText);
  const ids = [
    ...placeholderIds.filter(
      (id) => filtered[id]?.type === 'image' && filtered[id].content.length > 0,
    ),
    ...Object.keys(filtered)
      .map((id) => Number(id))
      .filter(
        (id) =>
          filtered[id]?.type === 'image' &&
          filtered[id].content.length > 0 &&
          !placeholderIds.includes(id),
      )
      .sort((a, b) => a - b),
  ];
  return ids.map((id) => {
    const image = filtered[id];
    return {
      type: 'image',
      source: {
        type: 'base64',
        mediaType: image.mediaType ?? 'image/png',
        data: image.content,
      },
    };
  });
}

function isImageSource(source: unknown): source is ModelImageBlock['source'] {
  if (source == null || typeof source !== 'object') {
    return false;
  }
  const record = source as Record<string, unknown>;
  const mediaType = record['mediaType'];
  const data = record['data'];
  const url = record['url'];
  if (
    record['type'] === 'base64' &&
    typeof mediaType === 'string' &&
    typeof data === 'string'
  ) {
    return true;
  }
  return record['type'] === 'url' && typeof url === 'string';
}

function getExternalImportFingerprint(
  pendingImports: ReadonlyArray<
    ExternalImportApprovalState['pendingImports'][number]
  >,
): string {
  return pendingImports
    .map(
      (item) => `${item.sourceFile}\n${item.importPath}\n${item.resolvedPath}`,
    )
    .sort()
    .join('\n---\n');
}
