/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FunctionCall,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import type {
  Config,
  GeminiChat,
  ToolCallConfirmationDetails,
  ToolResult,
  ChatRecord,
  AgentEventEmitter,
  StopHookOutput,
  HookExecutionRequest,
  HookExecutionResponse,
  MessageBus,
  StreamEvent,
  ChatCompressionInfo,
  AutoModeDecision,
  AutoModeOutcome,
  GoalTerminalEvent,
} from '@qwen-code/qwen-code-core';
import {
  AuthType,
  ApprovalMode,
  CompressionStatus,
  convertToFunctionResponse,
  createDebugLogger,
  DiscoveredMCPTool,
  StreamEventType,
  ToolConfirmationOutcome,
  generatePromptSuggestion,
  logPromptSuggestion,
  logToolCall,
  logUserPrompt,
  PromptSuggestionEvent,
  getErrorStatus,
  UserPromptEvent,
  readManyFiles,
  clampInlineMediaPart,
  Storage,
  ToolNames,
  fireNotificationHook,
  firePermissionRequestHook,
  firePreToolUseHook,
  firePostToolUseHook,
  firePostToolUseFailureHook,
  injectPermissionRulesIfMissing,
  NotificationType,
  persistPermissionOutcome,
  createHookOutput,
  generateToolUseId,
  MessageBusType,
  getPlanModeSystemReminder,
  getArenaSystemReminder,
  getStartupContextLength,
  isSystemReminderContent,
  evaluatePermissionFlow,
  getEffectivePermissionForConfirmation,
  needsConfirmation,
  isPlanModeBlocked,
  abortGoalForStopHookCap,
  formatStopHookBlockingCapWarning,
  applyAutoModeDecision,
  evaluateAutoMode,
  getAutoModePermissionDeniedReason,
  isApproveOutcome,
  isDenialFallbackReason,
  MAX_TRANSCRIPT_MESSAGES,
  formatDenialStateLog,
  recordAllow,
  recordFallbackApprove,
  shouldFallback,
  shouldForceAutoModeReviewForAllow,
  shouldFirePermissionDeniedForAutoMode,
  shouldRunAutoModeForCall,
  extractDaemonTraceContext,
  withInteractionSpan,
  startToolSpan,
  endToolSpan,
  runInToolSpanContext,
  startToolExecutionSpan,
  endToolExecutionSpan,
  logConversationFinishedEvent,
  ConversationFinishedEvent,
  acquireSleepInhibitor,
  clearGoalTerminalObserver,
  setGoalTerminalObserver,
  sessionIdContext,
} from '@qwen-code/qwen-code-core';
import { NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE } from '@qwen-code/acp-bridge/bridgeErrors';
import { getCommandSubcommandNames } from '../../services/commandMetadata.js';
import { getEffectiveSupportedModes } from '../../services/commandUtils.js';

import { RequestError } from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  ContentBlock,
  EmbeddedResourceResource,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  AgentSideConnection,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import { z } from 'zod';
import { normalizePartList } from '../../utils/nonInteractiveHelpers.js';
import {
  handleSlashCommand,
  getAvailableCommands,
  type NonInteractiveSlashCommandResult,
} from '../../nonInteractiveCliCommands.js';
import { isSlashCommand } from '../../ui/utils/commandUtils.js';
import { CommandKind } from '../../ui/commands/types.js';
import { MessageType, type HistoryItemGoalStatus } from '../../ui/types.js';
import { parseAcpModelOption } from '../../utils/acpModelUtils.js';
import { classifyApiError } from '../../ui/hooks/useGeminiStream.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

// Import modular session components
import type {
  ApprovalModeValue,
  SessionContext,
  ToolCallStartParams,
} from './types.js';
import { HistoryReplayer } from './HistoryReplayer.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';
import { PlanEmitter } from './emitters/PlanEmitter.js';
import { MessageEmitter } from './emitters/MessageEmitter.js';
import { SubAgentTracker } from './SubAgentTracker.js';
import {
  buildPermissionRequestContent,
  toPermissionOptions,
} from './permissionUtils.js';
import {
  MessageRewriteMiddleware,
  loadRewriteConfig,
} from './rewrite/index.js';

const debugLogger = createDebugLogger('SESSION');
const USER_CANCEL_ABORT_REASON = 'qwen:user-cancel';
const DAEMON_RETRY_META_KEY = 'qwen.daemon.retry';

function maskApiKeyForDisplay(apiKey: string | undefined): string {
  const trimmed = apiKey?.trim() ?? '';
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

type AutoCompressionSendResult =
  | { responseStream: AsyncGenerator<StreamEvent>; stopReason?: never }
  | { responseStream: null; stopReason: PromptResponse['stopReason'] };

const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';
// The drain is served from an in-memory queue, so a conforming client answers
// near-instantly (or rejects with -32601). No response within this window
// means the client silently drops unknown methods; without a deadline the
// await would wedge the prompt turn forever.
const MID_TURN_QUEUE_DRAIN_TIMEOUT_MS = 2_000;
// Latch the drain off only after this many consecutive timeouts: one slow
// answer must not permanently disable mid-turn messages for a
// conforming-but-busy client, while a client that never answers stops
// costing a stall per tool batch after a few batches.
const MID_TURN_QUEUE_DRAIN_MAX_TIMEOUT_STRIKES = 3;

class MidTurnDrainTimeoutError extends Error {
  constructor() {
    super(
      `mid-turn queue drain got no response within ${MID_TURN_QUEUE_DRAIN_TIMEOUT_MS}ms`,
    );
  }
}

interface BackgroundNotificationQueueItem {
  displayText: string;
  modelText: string;
  taskId: string;
  status: string;
  kind: 'agent' | 'monitor' | 'shell';
  toolUseId?: string;
}

const MAX_NOTIFICATION_QUEUE = 20;

export function computeInitialTurnFromHistory(
  records: ChatRecord[],
  sessionId: string,
): number {
  let maxPromptTurn = 0;
  let userMessageCount = 0;
  const promptIdPrefix = `${sessionId}########`;

  for (const record of records) {
    if (record.sessionId === sessionId && isUserPromptRecord(record)) {
      userMessageCount += 1;
    }

    for (const promptId of getRecordPromptIds(record)) {
      if (!promptId.startsWith(promptIdPrefix)) {
        continue;
      }

      const suffix = promptId.slice(promptIdPrefix.length);
      if (!/^\d+$/.test(suffix)) {
        continue;
      }

      maxPromptTurn = Math.max(maxPromptTurn, Number(suffix));
    }
  }

  return maxPromptTurn > 0 ? maxPromptTurn : userMessageCount;
}

export async function fireSessionPermissionDeniedForAutoMode(
  config: Config,
  decision: AutoModeDecision,
  outcome: AutoModeOutcome,
  toolName: string,
  toolParams: Record<string, unknown>,
  callId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !config.getDisableAllHooks?.() &&
    shouldFirePermissionDeniedForAutoMode(decision, outcome)
  ) {
    try {
      await config
        .getHookSystem?.()
        ?.firePermissionDeniedEvent(
          toolName,
          toolParams,
          callId,
          getAutoModePermissionDeniedReason(decision),
          signal,
        );
    } catch (hookError) {
      debugLogger.warn(
        `PermissionDenied hook failed for tool ${callId}: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
      );
    }
  }
}

function getRecordPromptIds(record: ChatRecord): string[] {
  const promptIds: string[] = [];
  const recordPromptId = (record as { promptId?: unknown }).promptId;
  if (typeof recordPromptId === 'string') {
    promptIds.push(recordPromptId);
  }
  const telemetryPromptId = readTelemetryPromptId(record.systemPayload);
  if (telemetryPromptId) {
    promptIds.push(telemetryPromptId);
  }
  return promptIds;
}

function readTelemetryPromptId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('uiEvent' in payload)) {
    return undefined;
  }
  const uiEvent = (payload as { uiEvent?: unknown }).uiEvent;
  if (!uiEvent || typeof uiEvent !== 'object' || !('prompt_id' in uiEvent)) {
    return undefined;
  }
  const promptId = (uiEvent as { prompt_id?: unknown }).prompt_id;
  return typeof promptId === 'string' ? promptId : undefined;
}

function isUserPromptRecord(record: ChatRecord): boolean {
  if (record.type !== 'user') {
    return false;
  }
  return (
    record.message?.parts?.some(
      (part) => typeof part.text === 'string' && part.text.trim().length > 0,
    ) ?? false
  );
}

export interface AvailableCommandsSnapshot {
  availableCommands: AvailableCommand[];
  availableSkills?: string[];
  availableSkillDetails?: Array<{
    name: string;
    description?: string;
    body?: string;
    filePath?: string;
    level?: string;
    modelInvocable?: boolean;
  }>;
}

export async function buildAvailableCommandsSnapshot(
  config: Config,
  abortSignal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<AvailableCommandsSnapshot> {
  const slashCommands = await getAvailableCommands(config, abortSignal, 'acp');

  const availableCommands: AvailableCommand[] = slashCommands.map((cmd) => {
    const acceptsInput =
      cmd.acceptsInput ??
      (cmd.kind !== CommandKind.BUILT_IN ||
        cmd.completion != null ||
        cmd.argumentHint != null ||
        (cmd.subCommands != null && cmd.subCommands.length > 0));
    return {
      name: cmd.name,
      description: cmd.description,
      input: acceptsInput ? { hint: cmd.argumentHint ?? '' } : null,
      _meta: {
        argumentHint: cmd.argumentHint,
        source: cmd.source,
        sourceLabel: cmd.sourceLabel,
        supportedModes: getEffectiveSupportedModes(cmd),
        subcommands: getCommandSubcommandNames(cmd),
        modelInvocable: cmd.modelInvocable === true,
      },
    };
  });

  let availableSkills: string[] | undefined;
  const skillDetailsByName = new Map<
    string,
    NonNullable<AvailableCommandsSnapshot['availableSkillDetails']>[number]
  >();
  try {
    const skillManager = config.getSkillManager();
    if (skillManager) {
      const skills = await skillManager.listSkills();
      availableSkills = skills.map((skill) => skill.name);
      for (const skill of skills) {
        skillDetailsByName.set(skill.name, {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          filePath: skill.filePath,
          level: skill.level,
          modelInvocable: skill.disableModelInvocation !== true,
        });
      }
    }
  } catch (error) {
    debugLogger.error('Error loading available skills:', error);
  }

  for (const command of slashCommands) {
    if (command.kind !== CommandKind.SKILL || !command.skillDetail) {
      continue;
    }
    const existing = skillDetailsByName.get(command.skillDetail.name);
    skillDetailsByName.set(command.skillDetail.name, {
      ...existing,
      ...command.skillDetail,
      modelInvocable: command.modelInvocable === true,
    });
  }
  const availableSkillDetails =
    skillDetailsByName.size > 0
      ? Array.from(skillDetailsByName.values())
      : undefined;
  // Always derive the name list from the details map so the two stay in sync.
  // skillManager only contributes its own skills to `availableSkills`, but the
  // slashCommands loop above also adds bundled skills to `skillDetailsByName`;
  // a `??=` would leave bundled skills in details but missing from the name
  // list whenever skillManager succeeded.
  availableSkills = availableSkillDetails?.map((skill) => skill.name);

  return {
    availableCommands,
    ...(availableSkills !== undefined ? { availableSkills } : {}),
    ...(availableSkillDetails !== undefined ? { availableSkillDetails } : {}),
  };
}

/**
 * Session represents an active conversation session with the AI model.
 * It uses modular components for consistent event emission:
 * - HistoryReplayer for replaying past conversations
 * - ToolCallEmitter for tool-related session updates
 * - PlanEmitter for todo/plan updates
 * - SubAgentTracker for tracking sub-agent tool calls
 */
export class Session implements SessionContext {
  private pendingPrompt: AbortController | null = null;
  /**
   * Tracks the completion of the current prompt so that the next prompt
   * can await it.  This prevents a new prompt from reading chat history
   * before the previous prompt's tool results have been added —
   * a race condition that causes malformed history on Windows where
   * process termination is slow.
   */
  private pendingPromptCompletion: Promise<void> | null = null;
  /**
   * Per-turn AbortController for the fire-and-forget follow-up suggestion
   * generation. Aborted on the top of the next `prompt()` and on
   * `cancelPendingPrompt()` so a stale suggestion never lands after the
   * user has moved on. Null when no suggestion generation is in flight.
   */
  private followupAbort: AbortController | null = null;
  private turn: number = 0;
  private readonly createdAt: number = Date.now();
  private readonly runtimeBaseDir: string;

  // Cron scheduling state
  private cronQueue: string[] = [];
  private cronProcessing = false;
  private cronAbortController: AbortController | null = null;
  private cronCompletion: Promise<void> | null = null;
  private cronDisabledByTokenLimit = false;
  private lastPromptTokenCount = 0;
  private lastPromptTokenCountChat: GeminiChat | null = null;
  private midTurnDrainUnavailable = false;
  private midTurnDrainTimeoutStrikes = 0;

  // Background notification drain state. ACP does not have the TUI's idle
  // hook, so the session serializes registry callbacks through this queue.
  private notificationQueue: BackgroundNotificationQueueItem[] = [];
  private notificationProcessing = false;
  private notificationAbortController: AbortController | null = null;
  private notificationCompletion: Promise<void> | null = null;

  // Set true in dispose(). Guards #drainCronQueue and #drainNotificationQueue
  // against the race where #drainNotificationQueue's finally block kicks off
  // #drainCronQueue after the session has already been disposed (e.g. /clear
  // or session reload), which would otherwise execute orphaned cron prompts
  // on a session whose registries are already unregistered.
  private disposed = false;

  // Modular components
  private readonly historyReplayer: HistoryReplayer;
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly planEmitter: PlanEmitter;
  private readonly messageEmitter: MessageEmitter;

  // Message rewrite middleware (optional, installed after history replay)
  messageRewriter?: MessageRewriteMiddleware;

  /**
   * Phase C worktree restore notice. Set by acpAgent.loadSession when a
   * resumed session has a live worktree sidecar; prepended to the next
   * #executePrompt call as a <system-reminder>, then cleared.
   *
   * One-shot by design — after the first prompt the worktree path is
   * already in the conversation context (the reminder we just sent + any
   * subsequent tool calls), so re-injecting on every turn would clutter
   * the history without adding signal. TUI uses historyManager.addItem(INFO)
   * for the equivalent UX hint and headless prepends to the single shot
   * prompt; all three modes share the `restoreWorktreeContext` helper
   * that produces this string.
   */
  pendingWorktreeNotice: string | null = null;

  // Implement SessionContext interface
  readonly sessionId: string;

  constructor(
    id: string,
    readonly config: Config,
    private readonly client: AgentSideConnection,
    private readonly settings: LoadedSettings,
  ) {
    this.sessionId = id;
    this.runtimeBaseDir = Storage.getRuntimeBaseDir();

    // Initialize modular components with this session as context
    this.toolCallEmitter = new ToolCallEmitter(this);
    this.planEmitter = new PlanEmitter(this);
    this.historyReplayer = new HistoryReplayer(this);
    this.messageEmitter = new MessageEmitter(this);

    this.#installGoalTerminalObserver();
    this.#registerBackgroundNotificationCallbacks();
  }

  getId(): string {
    return this.sessionId;
  }

  /**
   * Starts the cron scheduler at session creation. Durable tasks live on
   * disk; waiting for the end of the first prompt (the in-turn start at
   * the bottom of prompt()) would leave them invisible to cron_list /
   * cron_delete for the whole first turn and unfired while the session
   * idles before any prompt — the TUI equivalent enables durable cron on
   * mount.
   */
  startCronScheduler(): void {
    // Best-effort: a cron startup failure must not break session creation.
    this.#startCronSchedulerIfNeeded().catch((error) => {
      debugLogger.warn(
        `Cron scheduler startup failed [session ${this.sessionId}]: ${error}`,
      );
    });
  }

  getConfig(): Config {
    return this.config;
  }

  isIdle(): boolean {
    return (
      !this.pendingPrompt &&
      !this.pendingPromptCompletion &&
      !this.cronProcessing &&
      !this.cronAbortController &&
      !this.notificationProcessing &&
      !this.notificationAbortController
    );
  }

  getTurnCount(): number {
    return this.turn;
  }

  getCreatedAt(): number {
    return this.createdAt;
  }

  dispose(): void {
    this.disposed = true;
    this.notificationQueue = [];
    this.cronQueue = [];
    this.notificationAbortController?.abort();
    this.notificationAbortController = null;
    this.notificationProcessing = false;
    this.notificationCompletion = null;

    if (this.cronAbortController) {
      this.cronAbortController.abort();
      this.cronAbortController = null;
    }
    this.cronProcessing = false;
    this.cronCompletion = null;

    // Stop the scheduler too: after dispose the drain guard drops fired
    // prompts, but tick() would still mark durable fires (deleting
    // one-shots from disk without executing them) and the held lock
    // would block another session from taking over.
    if (this.config.isCronEnabled()) {
      this.config.getCronScheduler().stop();
    }

    this.config.getBackgroundTaskRegistry().setNotificationCallback(undefined);
    this.config.getMonitorRegistry().setNotificationCallback(undefined);
    this.config.getBackgroundShellRegistry().setNotificationCallback(undefined);
    this.config.getChatRecordingService()?.setTitleRecordedCallback(undefined);
    clearGoalTerminalObserver(this.sessionId);
  }

  /**
   * Install the message rewrite middleware if configured.
   * Must be called AFTER history replay to avoid rewriting historical messages.
   */
  installRewriter(): void {
    const rewriteConfig = loadRewriteConfig(this.settings);
    if (rewriteConfig?.enabled) {
      debugLogger.info('Message rewrite middleware enabled');
      this.messageRewriter = new MessageRewriteMiddleware(
        this.config,
        rewriteConfig,
        (update) => this.sendUpdate(update),
      );
    }
  }

  #installGoalTerminalObserver(): void {
    setGoalTerminalObserver(this.sessionId, (event: GoalTerminalEvent) => {
      void this.messageEmitter.emitGoalTerminal(event).catch((error) => {
        debugLogger.warn(
          `Failed to emit goal terminal update: ${this.#formatError(error)}`,
        );
      });
    });
  }

  emitGoalStatus(status: Omit<HistoryItemGoalStatus, 'id' | 'type'>): void {
    void this.messageEmitter.emitGoalStatus(status).catch((error) => {
      debugLogger.warn(
        `Failed to emit goal status update: ${this.#formatError(error)}`,
      );
    });
  }

  /**
   * Replays conversation history to the client using modular components.
   * Delegates to HistoryReplayer for consistent event emission.
   */
  async replayHistory(records: ChatRecord[]): Promise<void> {
    this.turn = Math.max(
      this.turn,
      computeInitialTurnFromHistory(records, this.config.getSessionId()),
    );
    await this.historyReplayer.replay(records);
  }

  rewindToTurn(targetTurnIndex: number): {
    targetTurnIndex: number;
    apiTruncateIndex: number;
  } {
    if (!Number.isInteger(targetTurnIndex) || targetTurnIndex < 0) {
      throw RequestError.invalidParams(
        undefined,
        'targetTurnIndex must be a non-negative integer',
      );
    }

    if (
      this.pendingPrompt ||
      this.cronProcessing ||
      this.cronAbortController ||
      this.notificationProcessing ||
      this.notificationAbortController
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot rewind while a prompt is running',
      );
    }

    const chat = this.config.getGeminiClient()!.getChat();
    const apiHistory = chat.getHistoryShallow();
    const apiTruncateIndex = this.#computeApiTruncationIndexForUserTurn(
      apiHistory,
      targetTurnIndex,
    );

    if (apiTruncateIndex < 0) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot rewind to the requested turn. It may have been compressed or does not exist.',
      );
    }

    chat.truncateHistory(apiTruncateIndex);
    chat.stripThoughtsFromHistory();

    const fileHistoryService = this.config.getFileHistoryService();
    const survivingSnapshots = fileHistoryService
      .getSnapshots()
      .slice(0, targetTurnIndex + 1);

    fileHistoryService.restoreFromSnapshots(survivingSnapshots);

    this.config
      .getChatRecordingService()
      ?.rewindRecording(
        targetTurnIndex,
        { truncatedCount: Math.max(0, apiHistory.length - apiTruncateIndex) },
        survivingSnapshots,
      );

    return { targetTurnIndex, apiTruncateIndex };
  }

  captureHistorySnapshot(): Content[] {
    return this.config.getGeminiClient()!.getChat().getHistoryShallow();
  }

  restoreHistory(history: Content[]): void {
    if (
      this.pendingPrompt ||
      this.cronProcessing ||
      this.cronAbortController ||
      this.notificationProcessing ||
      this.notificationAbortController
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Cannot restore history while a prompt is running',
      );
    }

    this.config
      .getGeminiClient()!
      .getChat()
      .setHistory(structuredClone(history));
  }

  #computeApiTruncationIndexForUserTurn(
    apiHistory: Content[],
    targetTurnIndex: number,
  ): number {
    const startIndex = getStartupContextLength(apiHistory);

    if (targetTurnIndex === 0) {
      return startIndex;
    }

    let realUserPromptCount = 0;
    for (let i = startIndex; i < apiHistory.length; i++) {
      if (!this.#isUserTextContent(apiHistory[i]!)) {
        continue;
      }

      if (realUserPromptCount === targetTurnIndex) {
        return i;
      }

      realUserPromptCount += 1;
    }

    return -1;
  }

  #isUserTextContent(content: Content): boolean {
    if (content.role !== 'user') return false;
    if (!content.parts || content.parts.length === 0) return false;

    const hasFunctionResponse = content.parts.some(
      (part) => 'functionResponse' in part,
    );
    if (hasFunctionResponse) return false;

    // Exclude pure <system-reminder> entries (the startup prelude and the
    // mid-history MCP added-tool reminders). They are structural, not real
    // user prompts; counting them would shift the rewind truncation index and
    // silently drop a real turn. A genuine user turn that merely has a
    // per-turn reminder prepended still has a non-reminder prompt part, so it
    // is NOT excluded.
    if (isSystemReminderContent(content)) return false;

    return content.parts.some((part) => 'text' in part && part.text);
  }

  async cancelPendingPrompt(): Promise<void> {
    const hadPrompt = !!this.pendingPrompt;
    const hadCron = !!this.cronAbortController;
    const hadNotification =
      !!this.notificationAbortController || this.notificationProcessing;

    if (this.followupAbort) {
      this.followupAbort.abort();
      this.followupAbort = null;
    }
    if (!hadPrompt && !hadCron && !hadNotification) {
      throw new Error(NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE);
    }

    if (this.pendingPrompt) {
      this.pendingPrompt.abort(USER_CANCEL_ABORT_REASON);
      this.pendingPrompt = null;
    }

    // Cancel any in-progress cron execution
    if (this.cronAbortController) {
      this.cronAbortController.abort();
      this.cronAbortController = null;
      this.cronQueue = [];
      this.cronProcessing = false;
    }

    if (this.notificationAbortController) {
      this.notificationAbortController.abort();
      this.notificationAbortController = null;
    }
    this.notificationQueue = [];
    this.notificationProcessing = false;

    // Stop scheduler and emit exit summary
    const scheduler = this.config.isCronEnabled()
      ? this.config.getCronScheduler()
      : null;
    if (scheduler) {
      const summary = scheduler.getExitSummary();
      scheduler.stop();
      if (summary) {
        await this.messageEmitter.emitAgentMessage(summary);
      }
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // Install this prompt's AbortController before awaiting the previous
    // prompt, so that a session/cancel during the wait targets us.
    this.pendingPrompt?.abort();
    const pendingSend = new AbortController();
    this.pendingPrompt = pendingSend;

    // Abort the previous turn's in-flight follow-up suggestion
    // generation (if any). Mirrors `pendingPrompt?.abort()` above —
    // a fresh prompt arriving means any pending suggestion would be
    // stale before it could ever render.
    if (this.followupAbort) {
      this.followupAbort.abort();
      this.followupAbort = null;
    }
    // Abort any in-progress cron execution (user prompt takes priority)
    if (this.cronAbortController) {
      this.cronAbortController.abort();
      this.cronAbortController = null;
      this.cronQueue = [];
      this.cronProcessing = false;
    }
    if (this.cronCompletion) {
      try {
        await this.cronCompletion;
      } catch {
        // Expected: cron was aborted
      }
      this.cronCompletion = null;
    }

    // Wait for the previous prompt to finish so chat history is consistent.
    if (this.pendingPromptCompletion) {
      try {
        await this.pendingPromptCompletion;
      } catch {
        // Expected: previous prompt was cancelled or errored
      }
    }

    // A background notification turn mutates the same chat history as a user
    // prompt. Abort it before awaiting the drain so user input is not blocked
    // behind notification tool calls.
    if (this.notificationAbortController) {
      this.notificationAbortController.abort();
      this.notificationAbortController = null;
      this.notificationQueue = [];
      this.notificationProcessing = false;
    }
    if (this.notificationCompletion) {
      try {
        await this.notificationCompletion;
      } catch {
        // Notification errors are surfaced through the session stream.
      }
    }

    // Cancelled while waiting for the previous prompt to finish.
    if (pendingSend.signal.aborted) {
      return { stopReason: 'cancelled' };
    }

    // Track this prompt's completion for the next prompt to await
    let resolveCompletion!: () => void;
    this.pendingPromptCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    try {
      const result = await this.#executePrompt(params, pendingSend);
      this.pendingPrompt = null;
      void this.#startCronSchedulerIfNeeded();
      // Drain any cron prompts that queued while the prompt was active
      void this.#drainCronQueue();
      void this.#drainNotificationQueue();
      this.#maybeEmitFollowupSuggestion(result);
      return result;
    } finally {
      this.pendingPrompt = null;
      resolveCompletion();
      this.pendingPromptCompletion = null;
    }
  }

  /**
   * Generate a server-side follow-up suggestion for the just-completed
   * turn and push it to attached clients via the daemon's
   * `qwen/notify/session/prompt-suggestion` extNotification. Mirrors
   * the CLI's `AppContainer.tsx` integration: same `generatePromptSuggestion`
   * call, same `enableCacheSharing` flag forwarding, same curated
   * history slice (`getHistory(true).slice(-40)`).
   *
   * Differences from the CLI:
   *   - Triggers only on `stopReason === 'end_turn'` (the daemon
   *     equivalent of "the assistant finished cleanly"). Cancelled /
   *     errored turns don't get a suggestion.
   *   - Aborted via `this.followupAbort`, which is reset on the next
   *     `prompt()` and on `cancelPendingPrompt()`.
   *   - Filter-reason logging only — accept / dismiss telemetry stays
   *     client-side (the CLI hook owns it).
   *
   * Fire-and-forget by design: an unawaited IIFE that swallows its own
   * errors. A failed suggestion is invisible to the user; a thrown
   * error here would propagate up through `prompt()` and break the
   * primary response path.
   */
  #maybeEmitFollowupSuggestion(result: PromptResponse): void {
    if (result.stopReason !== 'end_turn') return;
    if (this.settings.merged.ui?.enableFollowupSuggestions !== true) return;
    if (this.config.getApprovalMode() === ApprovalMode.PLAN) return;

    const chat = this.config.getGeminiClient()?.getChat();
    if (!chat) return;

    const ac = new AbortController();
    this.followupAbort = ac;
    const promptId =
      this.config.getSessionId() + '########' + String(this.turn);

    void (async () => {
      try {
        const fullHistory = chat.getHistory(true);
        const lastEntry = fullHistory[fullHistory.length - 1];
        if (!lastEntry || lastEntry.role !== 'model') {
          debugLogger.debug(
            'Skipping followup suggestion: last history entry is not model',
          );
          return;
        }
        const conversationHistory =
          fullHistory.length > 40 ? fullHistory.slice(-40) : fullHistory;

        const r = await generatePromptSuggestion(
          this.config,
          conversationHistory,
          ac.signal,
          {
            enableCacheSharing:
              this.settings.merged.ui?.enableCacheSharing === true,
          },
        );
        if (ac.signal.aborted) return;
        if (r.suggestion) {
          await this.client.extNotification(
            'qwen/notify/session/prompt-suggestion',
            {
              v: 1,
              sessionId: this.sessionId,
              suggestion: r.suggestion,
              promptId,
            },
          );
        } else if (r.filterReason) {
          // Mirror the CLI's suppression analytics path so server-side
          // generations are observable in the same telemetry stream.
          logPromptSuggestion(
            this.config,
            new PromptSuggestionEvent({
              outcome: 'suppressed',
              reason: r.filterReason,
            }),
          );
        }
      } catch (error) {
        if (ac.signal.aborted) {
          debugLogger.debug('Follow-up suggestion generation aborted');
        } else {
          debugLogger.warn('Follow-up suggestion generation failed', error);
        }
      } finally {
        if (this.followupAbort === ac) {
          this.followupAbort = null;
        }
      }
    })();
  }

  async #executePrompt(
    params: PromptRequest,
    pendingSend: AbortController,
  ): Promise<PromptResponse> {
    // Bind this turn to the session's ID via AsyncLocalStorage so shell
    // subprocesses (and hooks) read the CURRENT session's ID instead of
    // the process-global env slot, which in daemon mode only ever holds
    // the first session created in this process.
    return sessionIdContext.run(this.config.getSessionId(), () =>
      this.#executePromptInner(params, pendingSend),
    );
  }

  async #executePromptInner(
    params: PromptRequest,
    pendingSend: AbortController,
  ): Promise<PromptResponse> {
    return Storage.runWithRuntimeBaseDir(
      this.runtimeBaseDir,
      this.config.getWorkingDir(),
      async () => {
        // Increment turn counter for each user prompt
        this.turn += 1;

        const promptId = this.config.getSessionId() + '########' + this.turn;
        const parentContext = extractDaemonTraceContext(params);

        return await withInteractionSpan(
          this.config,
          {
            promptId,
            model: this.config.getModel(),
            messageType: 'acp_prompt',
            ...(parentContext ? { parentContext } : {}),
          },
          async () => {
            // Extract text from all text blocks to construct the full prompt text for logging
            const promptText = params.prompt
              .filter((block) => block.type === 'text')
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join(' ');

            // Log user prompt
            logUserPrompt(
              this.config,
              new UserPromptEvent(
                promptText.length,
                promptId,
                this.config.getContentGeneratorConfig()?.authType,
                promptText,
              ),
            );

            // Retry: strip orphaned user entries so the model sees a clean
            // history (no dangling user message from the failed attempt).
            // Also skip recordUserMessage to avoid duplicating the user
            // turn in the JSONL transcript.
            const isRetry =
              (params as { retry?: boolean }).retry === true ||
              (params as { _meta?: Record<string, unknown> })._meta?.[
                DAEMON_RETRY_META_KEY
              ] === true;
            if (isRetry) {
              this.#getCurrentChat().stripOrphanedUserEntriesFromHistory();
            } else {
              // record user message for session management
              this.config
                .getChatRecordingService()
                ?.recordUserMessage(promptText);
            }

            // Check if the input contains a slash command
            // Extract text from the first text block if present
            const firstTextBlock = params.prompt.find(
              (block) => block.type === 'text',
            );
            const inputText = firstTextBlock?.text || '';

            let parts: Part[] | null;

            if (isSlashCommand(inputText)) {
              // Handle slash command in ACP mode using capability-based filtering
              const slashCommandResult = await handleSlashCommand(
                inputText,
                pendingSend,
                this.config,
                this.settings,
              );

              parts = await this.#processSlashCommandResult(
                slashCommandResult,
                params.prompt,
              );

              // If parts is null, the command was fully handled (e.g., /summary completed)
              // Return early without sending to the model
              if (parts === null) {
                return { stopReason: 'end_turn' };
              }
            } else {
              // Normal processing for non-slash commands
              parts = await this.#resolvePrompt(
                params.prompt,
                pendingSend.signal,
              );
            }

            // Fire UserPromptSubmit hook through MessageBus (aligned with core path in client.ts)
            const hooksEnabled = !this.config.getDisableAllHooks?.();
            const messageBus = this.config.getMessageBus?.();
            if (
              hooksEnabled &&
              messageBus &&
              this.config.hasHooksForEvent?.('UserPromptSubmit')
            ) {
              const response = await messageBus.request<
                HookExecutionRequest,
                HookExecutionResponse
              >(
                {
                  type: MessageBusType.HOOK_EXECUTION_REQUEST,
                  eventName: 'UserPromptSubmit',
                  input: {
                    prompt: promptText,
                  },
                  signal: pendingSend.signal,
                },
                MessageBusType.HOOK_EXECUTION_RESPONSE,
              );
              const hookOutput = response.output
                ? createHookOutput('UserPromptSubmit', response.output)
                : undefined;

              if (
                hookOutput?.isBlockingDecision() ||
                hookOutput?.shouldStopExecution()
              ) {
                // Hook blocked the prompt - send notification to UI and return
                const blockReason =
                  hookOutput?.getEffectiveReason() || 'No reason provided';
                await this.messageEmitter.emitAgentMessage(
                  `🚫 **UserPromptSubmit blocked**: ${blockReason}`,
                );
                return { stopReason: 'end_turn' };
              }

              // Add additional context from hooks to the request
              const additionalContext = hookOutput?.getAdditionalContext();
              if (additionalContext) {
                parts = [...parts, { text: additionalContext }];
              }
            }

            // Snapshot file state before this turn (mirrors the makeSnapshot
            // block in GeminiClient.sendMessageStream). Placed after
            // slash-command and hook early-returns so locally handled commands
            // don't create phantom snapshots that desync the snapshot index.
            try {
              const fileHistoryService = this.config.getFileHistoryService();
              await fileHistoryService.makeSnapshot(promptId);
              try {
                const latestSnapshot = fileHistoryService.getSnapshots().at(-1);
                if (latestSnapshot) {
                  this.config
                    .getChatRecordingService()
                    ?.recordFileHistorySnapshot(latestSnapshot);
                }
              } catch (e) {
                debugLogger.error(`FileHistory: recordSnapshot failed: ${e}`);
              }
            } catch (e) {
              debugLogger.error(`FileHistory: makeSnapshot failed: ${e}`);
            }

            // Prepend session-level system reminders (plan mode / subagent /
            // arena) so the model sees them, matching the behaviour of
            // `GeminiClient.sendMessageStream` in the CLI/TUI path. Without this,
            // plan mode in ACP has no effect because the model never learns it
            // should avoid edits.
            const systemReminders = await this.#buildInitialSystemReminders();
            if (systemReminders.length > 0) {
              parts = [...systemReminders, ...parts];
            }

            // Phase C: one-shot worktree restore notice, set by acpAgent on
            // --resume / loadSession when the session's worktree is still alive.
            // Prepended exactly once, then cleared so it doesn't repeat on
            // subsequent turns.
            if (this.pendingWorktreeNotice) {
              parts = [
                {
                  text: `<system-reminder>\n${this.pendingWorktreeNotice}\n</system-reminder>\n\n`,
                },
                ...parts,
              ];
              this.pendingWorktreeNotice = null;
            }

            let nextMessage: Content | null = { role: 'user', parts };
            let turnCount = 0;

            // conversation_finished must fire on every terminal path of the
            // turn — the loop below has cancel/abort/no-stream early-returns
            // and API-error throws — so the emission lives in a finally that
            // wraps the whole turn, not just the stop-hook loop. Daemon turns
            // run autonomously in all approval modes (approvals are mediated by
            // the ACP client rather than by gating this loop), so unlike the
            // CLI reference (useGeminiStream.ts, which only emits in YOLO) this
            // is intentionally emitted for every mode.
            try {
              while (nextMessage !== null) {
                turnCount++;
                if (pendingSend.signal.aborted) {
                  this.#getCurrentChat().addHistory(nextMessage);
                  return { stopReason: 'cancelled' };
                }

                const functionCalls: FunctionCall[] = [];
                let usageMetadata: GenerateContentResponseUsageMetadata | null =
                  null;
                const streamStartTime = Date.now();

                try {
                  const sendResult =
                    await this.#sendMessageStreamWithAutoCompression(
                      promptId,
                      nextMessage?.parts ?? [],
                      pendingSend.signal,
                    );
                  if (!sendResult.responseStream) {
                    this.#preserveUnsentMessageHistory(
                      nextMessage,
                      sendResult.stopReason === 'cancelled',
                    );
                    return { stopReason: sendResult.stopReason };
                  }
                  const responseStream = sendResult.responseStream;
                  nextMessage = null;

                  for await (const resp of responseStream) {
                    if (pendingSend.signal.aborted) {
                      return { stopReason: 'cancelled' };
                    }

                    if (
                      resp.type === StreamEventType.CHUNK &&
                      resp.value.candidates &&
                      resp.value.candidates.length > 0
                    ) {
                      const candidate = resp.value.candidates[0];
                      for (const part of candidate.content?.parts ?? []) {
                        if (!part.text) {
                          continue;
                        }

                        this.messageEmitter.emitMessage(
                          part.text,
                          'assistant',
                          part.thought,
                        );
                      }
                    }

                    if (
                      resp.type === StreamEventType.CHUNK &&
                      resp.value.usageMetadata
                    ) {
                      usageMetadata = resp.value.usageMetadata;
                    }

                    if (
                      resp.type === StreamEventType.CHUNK &&
                      resp.value.functionCalls
                    ) {
                      functionCalls.push(...resp.value.functionCalls);
                    }
                  }
                } catch (error) {
                  // Only explicit user cancellation maps to a normal
                  // cancelled turn. Other aborts/errors should surface so
                  // infra failures are not hidden as successful cancels.
                  if (
                    pendingSend.signal.aborted &&
                    pendingSend.signal.reason === USER_CANCEL_ABORT_REASON &&
                    this.#isAbortError(error)
                  ) {
                    return { stopReason: 'cancelled' };
                  }

                  // Fire StopFailure hook (fire-and-forget, replaces Stop event for API errors)
                  // Aligned with useGeminiStream.ts handleFinishedWithErrorEvent
                  const errorStatus = getErrorStatus(error);
                  const errorMessage =
                    error instanceof Error ? error.message : String(error);
                  const errorType = classifyApiError({
                    message: errorMessage,
                    status: errorStatus,
                  });

                  const hookSystem = this.config.getHookSystem?.();
                  const hooksEnabledForStopFailure =
                    !this.config.getDisableAllHooks?.();
                  if (
                    hooksEnabledForStopFailure &&
                    hookSystem &&
                    this.config.hasHooksForEvent?.('StopFailure')
                  ) {
                    // Fire-and-forget: don't wait for hook to complete
                    hookSystem
                      .fireStopFailureEvent(errorType, errorMessage)
                      .catch((err) => {
                        debugLogger.warn(`StopFailure hook failed: ${err}`);
                      });
                  }

                  if (errorStatus === 429) {
                    throw new RequestError(
                      429,
                      'Rate limit exceeded. Try again later.',
                    );
                  }

                  throw error;
                }

                if (usageMetadata) {
                  this.#recordPromptTokenCount(usageMetadata);
                  // Kick off rewrite in background (non-blocking, runs parallel to tools)
                  if (this.messageRewriter) {
                    this.messageRewriter.flushTurn(pendingSend.signal);
                  }

                  const durationMs = Date.now() - streamStartTime;
                  await this.messageEmitter.emitUsageMetadata(
                    usageMetadata,
                    '',
                    durationMs,
                  );
                }

                if (functionCalls.length > 0) {
                  const toolResponseParts = await this.runToolCalls(
                    pendingSend.signal,
                    promptId,
                    functionCalls,
                  );
                  nextMessage = {
                    role: 'user',
                    parts: [
                      ...toolResponseParts,
                      ...(await this.#drainMidTurnUserMessages()),
                    ],
                  };
                }
              }

              // Wait for any pending rewrite before returning
              if (this.messageRewriter) {
                await this.messageRewriter.waitForPendingRewrites();
              }

              // Fire Stop hook loop (aligned with core path in client.ts)
              // This is triggered after model response completes with no pending tool calls
              return await this.#handleStopHookLoop(
                pendingSend,
                promptId,
                hooksEnabled,
                messageBus,
              );
            } finally {
              logConversationFinishedEvent(
                this.config,
                new ConversationFinishedEvent(
                  this.config.getApprovalMode(),
                  turnCount,
                ),
              );
            }
          },
          (result: { stopReason: PromptResponse['stopReason'] }) =>
            result.stopReason === 'cancelled' ? 'cancelled' : 'ok',
        );
      },
    );
  }

  /**
   * Handles the Stop hook iteration loop.
   * This method processes Stop hooks after a model response completes with no pending tool calls.
   * If a Stop hook requests continuation, it sends a follow-up message and loops back.
   * Maximum iterations (100) prevent infinite loops.
   *
   * @param pendingSend - The abort controller for the current prompt
   * @param promptId - The prompt ID for tracking
   * @param hooksEnabled - Whether hooks are enabled
   * @param messageBus - The MessageBus for hook communication (may be undefined)
   * @returns The ACP stop reason for the prompt.
   */
  async #handleStopHookLoop(
    pendingSend: AbortController,
    promptId: string,
    hooksEnabled: boolean,
    messageBus: MessageBus | undefined,
  ): Promise<{ stopReason: PromptResponse['stopReason'] }> {
    const stopHookBlockingCap = this.config.getStopHookBlockingCap();
    let stopHookIterationCount = 0;
    let stopHookReasons: string[] = [];

    while (stopHookIterationCount < stopHookBlockingCap) {
      if (
        !hooksEnabled ||
        !messageBus ||
        pendingSend.signal.aborted ||
        !this.config.hasHooksForEvent?.('Stop')
      ) {
        return { stopReason: 'end_turn' };
      }

      // Extract last model text without cloning the full history.
      const responseText =
        this.#getCurrentChat().getLastModelMessageText?.() ||
        '[no response text]';

      const response = await messageBus.request<
        HookExecutionRequest,
        HookExecutionResponse
      >(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'Stop',
          input: {
            stop_hook_active: true,
            last_assistant_message: responseText,
          },
          signal: pendingSend.signal,
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      );

      // Check if aborted after hook execution
      if (pendingSend.signal.aborted) {
        return { stopReason: 'cancelled' };
      }

      const hookOutput = response.output
        ? createHookOutput('Stop', response.output)
        : undefined;

      const stopOutput = hookOutput as StopHookOutput | undefined;

      // Emit system message if provided by hook
      if (stopOutput?.systemMessage) {
        await this.messageEmitter.emitAgentMessage(stopOutput.systemMessage);
      }

      // For Stop hooks, blocking/stop execution should force continuation
      if (
        stopOutput?.isBlockingDecision() ||
        stopOutput?.shouldStopExecution()
      ) {
        const continueReason = stopOutput.getEffectiveReason();

        // Track Stop hook iterations
        stopHookIterationCount++;
        stopHookReasons = [...stopHookReasons, continueReason];

        if (stopHookIterationCount >= stopHookBlockingCap) {
          const warning = formatStopHookBlockingCapWarning(
            'Stop',
            stopHookBlockingCap,
          );
          abortGoalForStopHookCap(
            this.config,
            this.config.getSessionId(),
            warning,
          );
          await this.messageEmitter.emitAgentMessage(warning);
          debugLogger.warn(warning);
          return { stopReason: 'end_turn' };
        }

        if (stopHookIterationCount > 1) {
          await this.messageEmitter.emitStopHookLoop(
            stopHookIterationCount,
            stopHookReasons,
            response.stopHookCount ?? 1,
          );
        }

        // Continue the conversation with the hook's reason
        const continueParts: Part[] = [{ text: continueReason }];
        let nextMessage: Content | null = {
          role: 'user',
          parts: continueParts,
        };

        // Process the follow-up message and any tool calls that result
        while (nextMessage !== null) {
          if (pendingSend.signal.aborted) {
            return { stopReason: 'cancelled' };
          }

          const functionCalls: FunctionCall[] = [];
          let usageMetadata: GenerateContentResponseUsageMetadata | null = null;
          const streamStartTime = Date.now();

          try {
            const continueSendResult =
              await this.#sendMessageStreamWithAutoCompression(
                promptId + '_stop_hook_' + stopHookIterationCount,
                nextMessage?.parts ?? [],
                pendingSend.signal,
                { skipCompression: stopHookIterationCount > 1 },
              );
            if (!continueSendResult.responseStream) {
              this.#preserveUnsentMessageHistory(
                nextMessage,
                continueSendResult.stopReason === 'cancelled',
              );
              return { stopReason: continueSendResult.stopReason };
            }
            const continueResponseStream = continueSendResult.responseStream;
            nextMessage = null;

            for await (const resp of continueResponseStream) {
              if (pendingSend.signal.aborted) {
                return { stopReason: 'cancelled' };
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.candidates &&
                resp.value.candidates.length > 0
              ) {
                const candidate = resp.value.candidates[0];
                for (const part of candidate.content?.parts ?? []) {
                  if (!part.text) continue;
                  this.messageEmitter.emitMessage(
                    part.text,
                    'assistant',
                    part.thought,
                  );
                }
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.usageMetadata
              ) {
                usageMetadata = resp.value.usageMetadata;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.functionCalls
              ) {
                functionCalls.push(...resp.value.functionCalls);
              }
            }
          } catch (error) {
            // Fire StopFailure hook (fire-and-forget)
            const errorStatus = getErrorStatus(error);
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const errorType = classifyApiError({
              message: errorMessage,
              status: errorStatus,
            });

            const hookSystem = this.config.getHookSystem?.();
            const hooksEnabledForStopFailure =
              !this.config.getDisableAllHooks?.();
            if (
              hooksEnabledForStopFailure &&
              hookSystem &&
              this.config.hasHooksForEvent?.('StopFailure')
            ) {
              hookSystem
                .fireStopFailureEvent(errorType, errorMessage)
                .catch((err) => {
                  debugLogger.warn(`StopFailure hook failed: ${err}`);
                });
            }

            if (errorStatus === 429) {
              throw new RequestError(
                429,
                'Rate limit exceeded. Try again later.',
              );
            }

            throw error;
          }

          if (usageMetadata) {
            this.#recordPromptTokenCount(usageMetadata);
            const durationMs = Date.now() - streamStartTime;
            await this.messageEmitter.emitUsageMetadata(
              usageMetadata,
              '',
              durationMs,
            );
          }

          // Process tool calls from the follow-up message
          if (functionCalls.length > 0) {
            const toolResponseParts = await this.runToolCalls(
              pendingSend.signal,
              promptId,
              functionCalls,
            );
            nextMessage = {
              role: 'user',
              parts: [
                ...toolResponseParts,
                ...(await this.#drainMidTurnUserMessages()),
              ],
            };
          }
        }

        // Loop continues to check Stop hook again after processing the follow-up
        continue;
      }

      // Stop hook allowed stopping, exit the loop
      break;
    }

    return { stopReason: 'end_turn' };
  }

  async sendUpdate(update: SessionUpdate): Promise<void> {
    const params: SessionNotification = {
      sessionId: this.sessionId,
      update,
    };

    await this.client.sessionUpdate(params);
  }

  #getCurrentChat(): GeminiChat {
    return this.config.getGeminiClient()!.getChat();
  }

  /**
   * Mirrors the core send path for ACP model sends.
   *
   * Attempts automatic chat compression first, checks the session token limit,
   * emits an ACP-visible notice when compression succeeds, and returns the ACP
   * stop reason when the provider send should be skipped because the request
   * was cancelled or the session token limit was exceeded.
   */
  async #sendMessageStreamWithAutoCompression(
    promptId: string,
    message: Part[],
    abortSignal: AbortSignal,
    options: { skipCompression?: boolean } = {},
  ): Promise<AutoCompressionSendResult> {
    const geminiClient = this.config.getGeminiClient()!;
    let compressionDiagnostic: string | null = null;
    let compressionInfo: ChatCompressionInfo | null = null;
    if (!options.skipCompression) {
      try {
        const compressed = await geminiClient.tryCompressChat(
          promptId,
          false,
          abortSignal,
        );
        compressionInfo = compressed;
        this.#recordCompressionTokenCount(compressed);
        if (compressed.compressionStatus === CompressionStatus.COMPRESSED) {
          const reasonClause =
            compressed.triggerReason === 'image_overflow'
              ? `accumulated enough tool screenshots to trigger compaction for ${this.config.getModel()}`
              : `approached the input token limit for ${this.config.getModel()}`;
          compressionDiagnostic =
            `IMPORTANT: This conversation ${reasonClause}. ` +
            `A compressed context will be sent for future messages (compressed from: ` +
            `${compressed.originalTokenCount ?? 'unknown'} to ` +
            `${compressed.newTokenCount ?? 'unknown'} tokens).`;
        }
      } catch (compressionError) {
        if (abortSignal.aborted || this.#isAbortError(compressionError)) {
          debugLogger.debug(`Auto-compression aborted for prompt ${promptId}`);
          return { responseStream: null, stopReason: 'cancelled' };
        }
        debugLogger.warn(
          `Auto-compression failed for prompt ${promptId}; proceeding without compression: ` +
            this.#formatError(compressionError),
        );
      }
    }

    if (abortSignal.aborted) {
      debugLogger.debug(`Auto-compression aborted for prompt ${promptId}`);
      return { responseStream: null, stopReason: 'cancelled' };
    }

    if (!compressionInfo) {
      this.#syncPromptTokenCountWithCurrentChat();
    }

    const sessionTokenLimit = this.config.getSessionTokenLimit();
    if (sessionTokenLimit > 0) {
      const lastPromptTokenCount =
        this.#getPostCompressionTokenCount(compressionInfo);
      if (lastPromptTokenCount > sessionTokenLimit) {
        debugLogger.warn(
          `Session token limit exceeded for prompt ${promptId}: ` +
            `${lastPromptTokenCount} > ${sessionTokenLimit}. Send dropped.`,
        );
        await this.#emitAgentDiagnosticMessageSafely(
          `Session token limit exceeded: ${lastPromptTokenCount} tokens > ${sessionTokenLimit} limit. ` +
            'Please start a new session or increase the sessionTokenLimit in your settings.json.',
          `Failed to emit token limit diagnostic for prompt ${promptId}`,
        );
        return { responseStream: null, stopReason: 'max_tokens' };
      }
    }

    if (compressionDiagnostic) {
      await this.#emitAgentDiagnosticMessageSafely(
        compressionDiagnostic,
        `Failed to emit compression notification for prompt ${promptId}`,
      );
    }

    if (abortSignal.aborted) {
      debugLogger.debug(
        `Send aborted after compression diagnostic for prompt ${promptId}`,
      );
      return { responseStream: null, stopReason: 'cancelled' };
    }

    const responseStream = await this.#getCurrentChat().sendMessageStream(
      this.config.getModel(),
      {
        message,
        config: {
          abortSignal,
        },
      },
      promptId,
    );
    return { responseStream };
  }

  #preserveUnsentMessageHistory(
    message: Content | null,
    preserveFullMessage: boolean,
  ): void {
    if (!message) return;

    if (preserveFullMessage) {
      this.#getCurrentChat().addHistory(message);
      return;
    }

    const functionResponseParts =
      message.parts?.filter(
        (part: Part) => 'functionResponse' in part && part.functionResponse,
      ) ?? [];
    const droppedParts =
      (message.parts?.length ?? 0) - functionResponseParts.length;
    if (droppedParts > 0) {
      debugLogger.debug(
        `Dropping ${droppedParts} non-functionResponse part(s) from unsent ACP message after send was skipped.`,
      );
    }
    if (functionResponseParts.length > 0) {
      this.#getCurrentChat().addHistory({
        ...message,
        parts: functionResponseParts,
      });
    }
  }

  #recordCompressionTokenCount(info: ChatCompressionInfo): void {
    this.#syncPromptTokenCountWithCurrentChat();
    const tokenCount = this.#extractCompressionTokenCount(info);
    if (tokenCount !== null && tokenCount > 0) {
      this.lastPromptTokenCount = tokenCount;
    }
  }

  #recordPromptTokenCount(
    usageMetadata: GenerateContentResponseUsageMetadata,
  ): void {
    this.#syncPromptTokenCountWithCurrentChat();
    const tokenCount =
      usageMetadata.promptTokenCount ?? usageMetadata.totalTokenCount;
    if (tokenCount !== undefined && tokenCount > 0) {
      this.lastPromptTokenCount = tokenCount;
    }
  }

  #getPostCompressionTokenCount(info: ChatCompressionInfo | null): number {
    const tokenCount = this.#extractCompressionTokenCount(info);
    if (tokenCount !== null) {
      return tokenCount;
    }

    return this.lastPromptTokenCount;
  }

  #extractCompressionTokenCount(
    info: ChatCompressionInfo | null,
  ): number | null {
    if (!info) {
      return null;
    }
    if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      return info.newTokenCount > 0 ? info.newTokenCount : null;
    }
    const tokenCount = info.originalTokenCount ?? info.newTokenCount ?? null;
    if (tokenCount === 0 && info.compressionStatus === CompressionStatus.NOOP) {
      return null;
    }
    return tokenCount;
  }

  #syncPromptTokenCountWithCurrentChat(): void {
    const chat = this.#getCurrentChat();
    if (
      this.lastPromptTokenCountChat &&
      this.lastPromptTokenCountChat !== chat
    ) {
      this.lastPromptTokenCount = 0;
    }
    this.lastPromptTokenCountChat = chat;
  }

  #isAbortError(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError') ||
      (typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: unknown }).name === 'AbortError')
    );
  }

  #formatError(error: unknown): string {
    if (error instanceof Error) {
      const parts = [error.message];
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        parts.push(`cause: ${cause.message}`);
      }
      const status = (error as Error & { status?: unknown }).status;
      if (status !== undefined) {
        parts.push(`status: ${String(status)}`);
      }
      return parts.join(' | ');
    }
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }

  async #emitAgentDiagnosticMessageSafely(
    text: string,
    failureContext: string,
  ): Promise<void> {
    try {
      await this.#emitAgentDiagnosticMessage(text);
    } catch (notifyError) {
      debugLogger.warn(`${failureContext}: ${this.#formatError(notifyError)}`);
    }
  }

  async #emitAgentDiagnosticMessage(text: string): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  async #drainMidTurnUserMessages(): Promise<Part[]> {
    if (this.midTurnDrainUnavailable) return [];

    let drainPromise: ReturnType<AgentSideConnection['extMethod']> | undefined;
    try {
      drainPromise = this.client.extMethod(MID_TURN_QUEUE_DRAIN_METHOD, {
        sessionId: this.sessionId,
      });
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new MidTurnDrainTimeoutError()),
          MID_TURN_QUEUE_DRAIN_TIMEOUT_MS,
        );
      });
      let response: Awaited<typeof drainPromise>;
      try {
        response = await Promise.race([drainPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      this.midTurnDrainTimeoutStrikes = 0;
      // A client may legally resolve with `result: null` (passed through
      // unwrapped by the ACP SDK); guard the object access so that doesn't
      // throw a TypeError and get misclassified as a transient drain error.
      const messages =
        response &&
        typeof response === 'object' &&
        Array.isArray(response['messages'])
          ? response['messages'].filter(
              (message): message is string =>
                typeof message === 'string' && message.trim().length > 0,
            )
          : [];

      return messages.map((message) => {
        const part = {
          text: `\n[User message received during tool execution]: ${message}`,
        };
        this.config
          .getChatRecordingService()
          ?.recordMidTurnUserMessage([part], message);
        return part;
      });
    } catch (error) {
      // The ACP SDK rejects with the raw JSON-RPC error object
      // (`{ code, message, data }`), which is not an `Error` instance, so
      // classify on the JSON-RPC code (-32601 = "Method not found") and fall
      // back to the message. Otherwise the one-shot latch never trips and every
      // tool batch keeps paying a failed `extMethod` round-trip all session.
      const errorMessage =
        error instanceof Error
          ? error.message
          : error && typeof error === 'object' && 'message' in error
            ? String((error as { message?: unknown }).message)
            : String(error);
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      const isTimeout = error instanceof MidTurnDrainTimeoutError;
      if (isTimeout) {
        this.midTurnDrainTimeoutStrikes += 1;
        // The lost race leaves the request pending; if the client settles it
        // later, a rejection must not surface as an unhandled rejection.
        drainPromise?.catch(() => {});
      }
      // Repeated timeouts are also permanent: a conforming client answers
      // (or rejects with -32601) immediately, so sustained silence means the
      // client drops unknown methods and would stall every subsequent tool
      // batch the same way. A single timeout is treated as transient so one
      // slow answer doesn't disable the drain for the whole session.
      const isPermanentError =
        errorCode === -32601 ||
        /method not found/i.test(errorMessage) ||
        (isTimeout &&
          this.midTurnDrainTimeoutStrikes >=
            MID_TURN_QUEUE_DRAIN_MAX_TIMEOUT_STRIKES);

      if (isPermanentError) {
        this.midTurnDrainUnavailable = true;
      }

      debugLogger.warn(
        `Mid-turn queue drain ${isPermanentError ? 'permanently ' : ''}unavailable [session ${this.sessionId}]: ${errorMessage}`,
      );
      return [];
    }
  }

  /**
   * Starts the cron scheduler if cron is enabled and jobs exist.
   * The scheduler runs in the background, pushing fired prompts into
   * `cronQueue` and triggering `#drainCronQueue`.
   */
  async #startCronSchedulerIfNeeded(): Promise<void> {
    if (this.disposed) return;
    if (!this.config.isCronEnabled()) return;
    if (this.cronDisabledByTokenLimit) return;
    const scheduler = this.config.getCronScheduler();

    // Enable durable cron support (loads tasks from disk, acquires lock).
    // Awaited: on a fresh session the only jobs may live on disk, and
    // checking for work before the load completes would skip start() and
    // leave durable jobs dormant until the next prompt. Missed one-shots
    // are delivered as late fires through the start() callback below.
    // Durable tasks live under ~/.qwen (user-owned, not in the working
    // tree), so no folder-trust gate is needed here.
    try {
      await scheduler.enableDurable(this.sessionId);
    } catch (err) {
      // Durable support is best-effort; session-only jobs still run.
      debugLogger.warn(
        `Durable cron init failed — persistent tasks will not fire in this session: ${err}`,
      );
    }

    // dispose() may have run while the durable load was in flight; its
    // stop() already tore the scheduler down — don't restart the tick.
    if (this.disposed) return;

    if (!scheduler.hasPendingWork) return;

    scheduler.start((job: { prompt: string }) => {
      if (this.cronDisabledByTokenLimit) return;
      this.cronQueue.push(job.prompt);
      void this.#drainCronQueue();
    });
  }

  /**
   * Processes queued cron prompts one at a time. Uses `cronProcessing`
   * as a mutex to prevent concurrent access to the chat.
   */
  async #drainCronQueue(): Promise<void> {
    if (this.disposed) return;
    if (this.cronProcessing) return;
    // Don't process cron while a user prompt is active — the queue will be
    // drained after the prompt completes (see end of prompt()).
    if (this.pendingPrompt) return;
    if (this.notificationProcessing) return;
    this.cronProcessing = true;

    let resolveCompletion!: () => void;
    this.cronCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    try {
      while (this.cronQueue.length > 0) {
        const prompt = this.cronQueue.shift()!;
        await this.#executeCronPrompt(prompt);
      }
    } finally {
      this.cronProcessing = false;
      resolveCompletion();
      this.cronCompletion = null;

      void this.#drainNotificationQueue();

      // Stop scheduler if all jobs were deleted during execution. With
      // durable mode active hasPendingWork stays true even at zero
      // in-memory jobs — the file watcher / lock takeover can still
      // install tasks persisted by other sessions.
      if (this.config.isCronEnabled()) {
        const scheduler = this.config.getCronScheduler();
        if (!scheduler.hasPendingWork) {
          scheduler.stop();
        }
      }
    }
  }

  /**
   * Executes a single cron-fired prompt: echoes it as a user message with
   * `_meta.source='cron'`, streams the model response, and handles tool calls.
   */
  async #executeCronPrompt(prompt: string): Promise<void> {
    // Same session-ID binding rationale as #executePrompt.
    return sessionIdContext.run(this.config.getSessionId(), () =>
      this.#executeCronPromptInner(prompt),
    );
  }

  async #executeCronPromptInner(prompt: string): Promise<void> {
    return Storage.runWithRuntimeBaseDir(
      this.runtimeBaseDir,
      this.config.getWorkingDir(),
      async () => {
        const ac = new AbortController();
        this.cronAbortController = ac;
        const promptId =
          this.config.getSessionId() + '########cron' + Date.now();

        let cronHadError = false;
        await withInteractionSpan(
          this.config,
          {
            promptId,
            model: this.config.getModel(),
            messageType: 'cron',
          },
          async () => {
            let turnCount = 0;
            try {
              // Echo the cron prompt as a user message so the client sees it
              await this.sendUpdate({
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: prompt },
                _meta: { source: 'cron' },
              });

              // Prepend session-level system reminders (same rationale as the
              // user-query path in #executePrompt).
              const cronReminders = await this.#buildInitialSystemReminders();
              let nextMessage: Content | null = {
                role: 'user',
                parts: [...cronReminders, { text: prompt }],
              };

              while (nextMessage !== null) {
                turnCount++;
                if (ac.signal.aborted) return;

                const functionCalls: FunctionCall[] = [];
                let usageMetadata: GenerateContentResponseUsageMetadata | null =
                  null;
                const streamStartTime = Date.now();

                const sendResult =
                  await this.#sendMessageStreamWithAutoCompression(
                    promptId,
                    nextMessage.parts ?? [],
                    ac.signal,
                  );
                if (!sendResult.responseStream) {
                  this.#preserveUnsentMessageHistory(
                    nextMessage,
                    sendResult.stopReason === 'cancelled',
                  );
                  if (sendResult.stopReason === 'max_tokens') {
                    this.#stopCronAfterTokenLimit();
                  }
                  return;
                }
                const responseStream = sendResult.responseStream;
                nextMessage = null;

                for await (const resp of responseStream) {
                  if (ac.signal.aborted) return;

                  if (
                    resp.type === StreamEventType.CHUNK &&
                    resp.value.candidates &&
                    resp.value.candidates.length > 0
                  ) {
                    const candidate = resp.value.candidates[0];
                    for (const part of candidate.content?.parts ?? []) {
                      if (!part.text) continue;
                      this.messageEmitter.emitMessage(
                        part.text,
                        'assistant',
                        part.thought,
                      );
                    }
                  }

                  if (
                    resp.type === StreamEventType.CHUNK &&
                    resp.value.usageMetadata
                  ) {
                    usageMetadata = resp.value.usageMetadata;
                  }

                  if (
                    resp.type === StreamEventType.CHUNK &&
                    resp.value.functionCalls
                  ) {
                    functionCalls.push(...resp.value.functionCalls);
                  }
                }

                if (usageMetadata) {
                  this.#recordPromptTokenCount(usageMetadata);
                  if (this.messageRewriter) {
                    this.messageRewriter.flushTurn(ac.signal);
                  }
                  const durationMs = Date.now() - streamStartTime;
                  await this.messageEmitter.emitUsageMetadata(
                    usageMetadata,
                    '',
                    durationMs,
                  );
                }

                if (functionCalls.length > 0) {
                  const toolResponseParts = await this.runToolCalls(
                    ac.signal,
                    promptId,
                    functionCalls,
                  );
                  nextMessage = {
                    role: 'user',
                    parts: [
                      ...toolResponseParts,
                      ...(await this.#drainMidTurnUserMessages()),
                    ],
                  };
                }
              }
            } catch (error) {
              if (ac.signal.aborted) return;
              cronHadError = true;
              debugLogger.error('Error processing cron prompt:', error);
              const msg =
                error instanceof Error ? error.message : String(error);
              await this.messageEmitter.emitAgentMessage(`[cron error] ${msg}`);
            } finally {
              if (this.cronAbortController === ac) {
                this.cronAbortController = null;
              }
              // Mirror the user-query path: emit conversation_finished on every
              // terminal cron path (clean finish, abort, or caught error) so
              // cron turns are not silently missing from conversation metrics.
              logConversationFinishedEvent(
                this.config,
                new ConversationFinishedEvent(
                  this.config.getApprovalMode(),
                  turnCount,
                ),
              );
            }
          },
          () =>
            ac.signal.aborted ? 'cancelled' : cronHadError ? 'error' : 'ok',
        );
      },
    );
  }

  #stopCronAfterTokenLimit(): void {
    this.cronDisabledByTokenLimit = true;
    this.cronQueue = [];
    if (!this.config.isCronEnabled()) return;
    this.config.getCronScheduler().stop();
    void this.#emitAgentDiagnosticMessageSafely(
      'Cron jobs disabled for the rest of this session due to token limit. Restart the session to re-enable.',
      'Failed to emit cron-disabled diagnostic',
    );
  }

  #registerBackgroundNotificationCallbacks(): void {
    const backgroundRegistry = this.config.getBackgroundTaskRegistry();
    backgroundRegistry.setNotificationCallback(
      (displayText, modelText, meta) => {
        this.#enqueueBackgroundNotification({
          displayText,
          modelText,
          taskId: meta.agentId,
          status: meta.status,
          kind: 'agent',
          toolUseId: meta.toolUseId,
        });
      },
    );

    const monitorRegistry = this.config.getMonitorRegistry();
    monitorRegistry.setNotificationCallback((displayText, modelText, meta) => {
      if (meta.status === 'running') {
        return;
      }

      this.#enqueueBackgroundNotification({
        displayText,
        modelText,
        taskId: meta.monitorId,
        status: meta.status,
        kind: 'monitor',
        toolUseId: meta.toolUseId,
      });
    });

    const shellRegistry = this.config.getBackgroundShellRegistry();
    shellRegistry.setNotificationCallback((displayText, modelText, meta) => {
      this.#enqueueBackgroundNotification({
        displayText,
        modelText,
        taskId: meta.shellId,
        status: meta.status,
        kind: 'shell',
      });
    });

    // Session title recorded (auto-generated after a turn, or an in-process
    // /rename) → notify attached clients. A title update is NOT an ACP
    // `SessionUpdate` variant (the external @agentclientprotocol/sdk union
    // would reject an unknown kind at validation), so — like
    // `current_model_update` above — it goes over the agent→bridge
    // `extNotification` side-channel. The bridge demuxes it into the
    // canonical `session_metadata_updated` bus event so HTTP clients can
    // refresh their session list immediately instead of discovering the
    // new title on their next poll.
    this.config
      .getChatRecordingService()
      ?.setTitleRecordedCallback((customTitle, titleSource) => {
        void this.client
          .extNotification('qwen/notify/session/title-update', {
            v: 1,
            sessionId: this.sessionId,
            title: customTitle,
            titleSource,
          })
          .catch(() => {
            // Best-effort: a dropped notification only delays the title
            // until the client's next session-list refresh.
          });
      });
  }

  #enqueueBackgroundNotification(item: BackgroundNotificationQueueItem): void {
    while (this.notificationQueue.length >= MAX_NOTIFICATION_QUEUE) {
      const evicted = this.notificationQueue.shift()!;
      debugLogger.warn(
        `Notification queue overflow: evicting task=${evicted.taskId} kind=${evicted.kind}`,
      );
    }
    this.notificationQueue.push(item);
    void this.#drainNotificationQueue();
  }

  async #drainNotificationQueue(): Promise<void> {
    if (this.disposed) return;
    if (this.notificationProcessing) return;
    if (this.pendingPrompt || this.cronProcessing || this.cronAbortController) {
      return;
    }
    if (this.notificationQueue.length === 0) return;

    this.notificationProcessing = true;
    let resolveCompletion!: () => void;
    this.notificationCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    try {
      while (this.notificationQueue.length > 0) {
        if (
          this.pendingPrompt ||
          this.cronProcessing ||
          this.cronAbortController
        ) {
          break;
        }
        const item = this.notificationQueue.shift()!;
        await this.#executeBackgroundNotificationPrompt(item);
      }
    } finally {
      this.notificationProcessing = false;
      resolveCompletion();
      this.notificationCompletion = null;

      void this.#drainCronQueue();

      if (
        this.notificationQueue.length > 0 &&
        !this.pendingPrompt &&
        !this.cronProcessing &&
        !this.cronAbortController
      ) {
        void this.#drainNotificationQueue();
      }
    }
  }

  async #executeBackgroundNotificationPrompt(
    item: BackgroundNotificationQueueItem,
  ): Promise<void> {
    // Same session-ID binding rationale as #executePrompt.
    return sessionIdContext.run(this.config.getSessionId(), () =>
      this.#executeBackgroundNotificationPromptInner(item),
    );
  }

  async #executeBackgroundNotificationPromptInner(
    item: BackgroundNotificationQueueItem,
  ): Promise<void> {
    return Storage.runWithRuntimeBaseDir(
      this.runtimeBaseDir,
      this.config.getWorkingDir(),
      async () => {
        const ac = new AbortController();
        this.notificationAbortController = ac;
        const promptId =
          this.config.getSessionId() + '########notification' + Date.now();

        try {
          await this.#emitBackgroundNotificationDisplay(item);

          const notificationParts: Part[] = [{ text: item.modelText }];
          this.config
            .getChatRecordingService()
            ?.recordNotification(notificationParts, item.displayText);

          const notificationReminders =
            await this.#buildInitialSystemReminders();
          let nextMessage: Content | null = {
            role: 'user',
            parts: [...notificationReminders, ...notificationParts],
          };

          while (nextMessage !== null) {
            if (ac.signal.aborted) {
              await this.#emitBackgroundNotificationEndTurn('cancelled');
              return;
            }

            const functionCalls: FunctionCall[] = [];
            let usageMetadata: GenerateContentResponseUsageMetadata | null =
              null;
            let responseText = '';
            const streamStartTime = Date.now();

            const sendResult = await this.#sendMessageStreamWithAutoCompression(
              promptId,
              nextMessage.parts ?? [],
              ac.signal,
            );
            if (!sendResult.responseStream) {
              this.#preserveUnsentMessageHistory(
                nextMessage,
                sendResult.stopReason === 'cancelled',
              );
              await this.#emitBackgroundNotificationEndTurn(
                sendResult.stopReason,
              );
              return;
            }

            const responseStream = sendResult.responseStream;
            nextMessage = null;

            for await (const resp of responseStream) {
              if (ac.signal.aborted) {
                await this.#emitBackgroundNotificationEndTurn('cancelled');
                return;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.candidates &&
                resp.value.candidates.length > 0
              ) {
                const candidate = resp.value.candidates[0];
                for (const part of candidate.content?.parts ?? []) {
                  if (!part.text) continue;
                  if (part.thought) {
                    await this.messageEmitter.emitMessage(
                      part.text,
                      'assistant',
                      true,
                    );
                  } else {
                    responseText += part.text;
                  }
                }
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.usageMetadata
              ) {
                usageMetadata = resp.value.usageMetadata;
              }

              if (
                resp.type === StreamEventType.CHUNK &&
                resp.value.functionCalls
              ) {
                functionCalls.push(...resp.value.functionCalls);
              }
            }

            if (responseText.length > 0) {
              await this.#emitBackgroundNotificationResponse(
                item,
                responseText,
                ac.signal,
              );
            }

            if (this.messageRewriter) {
              await this.messageRewriter.flushTurn(ac.signal);
            }

            if (usageMetadata) {
              this.#recordPromptTokenCount(usageMetadata);
              const durationMs = Date.now() - streamStartTime;
              await this.messageEmitter.emitUsageMetadata(
                usageMetadata,
                '',
                durationMs,
              );
            }

            if (functionCalls.length > 0) {
              const toolResponseParts = await this.runToolCalls(
                ac.signal,
                promptId,
                functionCalls,
              );
              nextMessage = {
                role: 'user',
                parts: [
                  ...toolResponseParts,
                  ...(await this.#drainMidTurnUserMessages()),
                ],
              };
            }
          }

          if (this.messageRewriter) {
            await this.messageRewriter.waitForPendingRewrites();
          }

          await this.#emitBackgroundNotificationEndTurn('end_turn');
        } catch (error) {
          if (ac.signal.aborted) {
            await this.#emitBackgroundNotificationEndTurn('cancelled');
            return;
          }
          debugLogger.error('Error processing background notification:', error);
          const msg = error instanceof Error ? error.message : String(error);
          try {
            await this.messageEmitter.emitAgentMessage(
              `[notification error] ${msg}`,
            );
          } catch (emitError) {
            debugLogger.error(
              'Failed to emit background notification error:',
              emitError,
            );
          } finally {
            await this.#emitBackgroundNotificationEndTurn('end_turn');
          }
        } finally {
          if (this.notificationAbortController === ac) {
            this.notificationAbortController = null;
          }
        }
      },
    );
  }

  async #emitBackgroundNotificationDisplay(
    item: BackgroundNotificationQueueItem,
  ): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: item.displayText },
      _meta: {
        source: 'background_notification',
        qwenDiscreteMessage: true,
        backgroundTask: {
          taskId: item.taskId,
          status: item.status,
          kind: item.kind,
          toolUseId: item.toolUseId,
        },
      },
    });
  }

  async #emitBackgroundNotificationResponse(
    item: BackgroundNotificationQueueItem,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
      _meta: {
        source: 'background_notification_response',
        qwenDiscreteMessage: true,
        backgroundTask: {
          taskId: item.taskId,
          status: item.status,
          kind: item.kind,
          toolUseId: item.toolUseId,
        },
      },
    };

    if (this.messageRewriter) {
      await this.messageRewriter.interceptUpdate(update, signal);
      return;
    }

    await this.sendUpdate(update);
  }

  async #emitBackgroundNotificationEndTurn(
    reason: PromptResponse['stopReason'],
  ): Promise<void> {
    try {
      await this.client.extNotification('_qwencode/end_turn', {
        sessionId: this.sessionId,
        reason,
        source: 'background_notification',
      });
    } catch (error) {
      debugLogger.debug(
        `Background notification end-turn extNotification dropped: ${this.#formatError(error)}`,
      );
    }
  }

  async sendAvailableCommandsUpdate(): Promise<void> {
    try {
      const { availableCommands, availableSkills, availableSkillDetails } =
        await buildAvailableCommandsSnapshot(this.config);

      const update: SessionUpdate = {
        sessionUpdate: 'available_commands_update',
        availableCommands,
        ...(availableSkills !== undefined
          ? {
              _meta: {
                availableSkills,
                ...(availableSkillDetails ? { availableSkillDetails } : {}),
              },
            }
          : {}),
      };

      await this.sendUpdate(update);
    } catch (error) {
      // Log error but don't fail session creation
      debugLogger.error('Error sending available commands update:', error);
    }
  }

  /**
   * Requests permission from the client for a tool call.
   * Used by SubAgentTracker for sub-agent approval requests.
   */
  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.client.requestPermission(params);
  }

  /**
   * Sets the approval mode for the current session.
   * Maps ACP approval mode values to core ApprovalMode enum.
   */
  async setMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const modeMap: Record<ApprovalModeValue, ApprovalMode> = {
      plan: ApprovalMode.PLAN,
      default: ApprovalMode.DEFAULT,
      'auto-edit': ApprovalMode.AUTO_EDIT,
      auto: ApprovalMode.AUTO,
      yolo: ApprovalMode.YOLO,
    };

    // `modeId` arrives over the wire (ACP `session/set_mode`, or
    // `setSessionConfigOption` casting an unknown `value` to string), so
    // validate at this boundary. An unknown id would otherwise call
    // `setApprovalMode(undefined)` — leaving the permission system in an
    // undefined state — and the A2 broadcast below would fan the bogus id
    // out to every attached SSE client.
    const approvalMode = modeMap[params.modeId as ApprovalModeValue];
    if (approvalMode === undefined) {
      throw RequestError.invalidParams(
        undefined,
        `Unknown approval mode: ${params.modeId}`,
      );
    }
    this.config.setApprovalMode(approvalMode);

    // A2 (#4511): notify attached clients of an in-session mode switch.
    // Mirrors the model-update extNotification in `setModel`.
    void this.client
      .extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: this.sessionId,
        currentModeId: params.modeId,
      })
      .catch((error) => {
        // Advisory only; a failed notification must not fail the mode
        // switch. Matches the model-update extNotification in `setModel`.
        debugLogger.debug('mode-update extNotification failed', error);
      });
  }

  /**
   * Sets the model for the current session.
   * Validates the model ID and switches the model via Config.
   */
  async setModel(
    params: SetSessionModelRequest,
    options: { persistDefault?: boolean } = {},
  ): Promise<SetSessionModelResponse | void> {
    const rawModelId = params.modelId.trim();

    if (!rawModelId) {
      throw RequestError.invalidParams(undefined, 'modelId cannot be empty');
    }

    const parsed = parseAcpModelOption(rawModelId);
    const previousAuthType = this.config.getAuthType?.();
    const selectedAuthType = parsed.authType ?? previousAuthType;

    if (!selectedAuthType) {
      throw RequestError.invalidParams(
        undefined,
        `authType cannot be determined for modelId "${parsed.modelId}"`,
      );
    }

    await this.config.switchModel(
      selectedAuthType,
      parsed.modelId,
      selectedAuthType !== previousAuthType &&
        selectedAuthType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : undefined,
    );

    const after = this.config.getContentGeneratorConfig?.();
    const effectiveAuthType = after?.authType ?? selectedAuthType;
    const effectiveModelId = after?.model ?? parsed.modelId;

    // Notify attached clients of an in-session model switch so a
    // `/model` slash command or plan-mode change reaches the bus (today only
    // the HTTP `POST /session/:id/model` path publishes `model_switched`).
    // `current_model_update` is NOT an ACP `SessionUpdate` variant (the type
    // is the external @agentclientprotocol/sdk union, which has
    // `current_mode_update` but not a model equivalent), so this goes over
    // the agent→bridge `extNotification` side-channel. The bridge demuxes it
    // to `model_switched` and SUPPRESSES it when the bridge itself is driving
    // the change (the HTTP path also flows through this method), avoiding a
    // double publish. Fire-and-forget, matching the MCP-budget extNotification.
    void this.client
      .extNotification('qwen/notify/session/model-update', {
        v: 1,
        sessionId: this.sessionId,
        currentModelId: effectiveModelId,
      })
      .catch((error) => {
        // Advisory only; a failed notification must not fail the model switch.
        debugLogger.debug('model-update extNotification failed', error);
      });

    if (options.persistDefault ?? true) {
      const persistScope = getPersistScopeForModelSelection(this.settings);
      this.settings.setValue(persistScope, 'model.name', parsed.modelId);
      this.settings.setValue(
        persistScope,
        'security.auth.selectedType',
        selectedAuthType,
      );
    }

    return {
      _meta: {
        qwenModelSwitch: {
          authType: effectiveAuthType,
          modelId: effectiveModelId,
          baseUrl: after?.baseUrl ?? '(default)',
          apiKey: maskApiKeyForDisplay(after?.apiKey),
          isRuntime: rawModelId.startsWith('$runtime|'),
        },
      },
    };
  }

  /**
   * Sends a current_mode_update notification to the client.
   * Called after the agent switches modes (e.g., from exit_plan_mode tool).
   */
  private async sendCurrentModeUpdateNotification(
    outcome: ToolConfirmationOutcome,
  ): Promise<void> {
    // Determine the new mode based on the approval outcome
    // This mirrors the logic in ExitPlanModeTool.onConfirm
    let newModeId: ApprovalModeValue;
    switch (outcome) {
      case ToolConfirmationOutcome.ProceedAlways:
        newModeId = 'auto-edit';
        break;
      case ToolConfirmationOutcome.RestorePrevious:
        // onConfirm has already restored the mode; read the actual current mode
        newModeId = this.config.getApprovalMode() as ApprovalModeValue;
        break;
      case ToolConfirmationOutcome.ProceedOnce:
      default:
        newModeId = 'default';
        break;
    }

    const update: SessionUpdate = {
      sessionUpdate: 'current_mode_update',
      currentModeId: newModeId,
    };

    await this.sendUpdate(update);

    // A2 (#4511): promote the mode change to the bridge side-channel so
    // it reaches `approval_mode_changed` on the SSE bus, matching the
    // extNotification in `setMode`.
    //
    // Unlike `setMode`, this path already published the legacy
    // `session_update{current_mode_update}` frame via `sendUpdate` above
    // (BridgeClient.sessionUpdate fans it onto the bus). Tell the demux to
    // skip its compat dual-emit so the IDE companion sees exactly one
    // legacy frame for this change, not two. `setMode` omits the flag, so
    // its dual-emit still fires (it has no `sendUpdate`).
    void this.client
      .extNotification('qwen/notify/session/mode-update', {
        v: 1,
        sessionId: this.sessionId,
        currentModeId: newModeId,
        legacyFrameSent: true,
      })
      .catch((error) => {
        // Advisory only; a failed notification must not fail the mode
        // change. Matches the model-update extNotification in `setModel`.
        debugLogger.debug('mode-update extNotification failed', error);
      });
  }

  /**
   * Execute a batch of model-returned tool calls, running Agent calls
   * concurrently while keeping other tools sequential.
   *
   * Mirrors the partition logic in `coreToolScheduler.partitionToolCalls`:
   * consecutive Agent calls form a parallel batch (they spawn independent
   * sub-agents with no shared mutable state); any other tool forms its own
   * sequential batch to preserve the implicit ordering the model may rely
   * on. Response-part ordering matches the original `functionCalls` order.
   */
  private async runToolCalls(
    abortSignal: AbortSignal,
    promptId: string,
    functionCalls: FunctionCall[],
  ): Promise<Part[]> {
    type Batch = { concurrent: boolean; calls: FunctionCall[] };
    const batches: Batch[] = [];
    for (const fc of functionCalls) {
      const isAgent = fc.name === ToolNames.AGENT;
      const last = batches[batches.length - 1];
      if (isAgent && last?.concurrent) {
        last.calls.push(fc);
      } else {
        batches.push({ concurrent: isAgent, calls: [fc] });
      }
    }

    // Bounded-concurrency runner: matches core's `runConcurrently`
    // behaviour (`coreToolScheduler.ts:1506`), capped by
    // `QWEN_CODE_MAX_TOOL_CONCURRENCY` (default 10). Results are returned
    // in input order regardless of resolution order.
    const runBounded = async (calls: FunctionCall[]): Promise<Part[][]> => {
      const parsed = parseInt(
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] || '',
        10,
      );
      const maxConcurrency =
        Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
      const results: Part[][] = new Array(calls.length);
      const executing = new Set<Promise<void>>();
      for (let i = 0; i < calls.length; i++) {
        const idx = i;
        const p = this.runTool(abortSignal, promptId, calls[idx])
          .then((r) => {
            results[idx] = r;
          })
          .finally(() => {
            executing.delete(p);
          });
        executing.add(p);
        if (executing.size >= maxConcurrency) {
          await Promise.race(executing);
        }
      }
      await Promise.all(executing);
      return results;
    };

    const parts: Part[] = [];
    for (const batch of batches) {
      if (batch.concurrent && batch.calls.length > 1) {
        const results = await runBounded(batch.calls);
        for (const r of results) parts.push(...r);
      } else {
        for (const fc of batch.calls) {
          const r = await this.runTool(abortSignal, promptId, fc);
          parts.push(...r);
        }
      }
    }
    return parts;
  }

  /**
   * Assemble the per-turn system reminders the model needs to see at the
   * start of a user query or cron fire. Mirrors the subagent/plan/arena
   * branches in `GeminiClient.sendMessageStream` (`client.ts:848-878`) —
   * the ACP path bypasses that code, so without this helper plan mode is
   * silently inert and subagent/arena sessions lose context.
   *
   * Scope note: the `relevantAutoMemory` reminder is intentionally NOT
   * included here. Managed auto-memory requires a prefetch pipeline that
   * lives in `GeminiClient`, and porting it into the ACP path is tracked
   * separately as part of the broader middleware-alignment work.
   */
  async #buildInitialSystemReminders(): Promise<Part[]> {
    const reminders: Part[] = [];

    if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
      reminders.push({
        text: getPlanModeSystemReminder(this.config.getSdkMode?.()),
      });
    }

    const arenaManager = this.config.getArenaManager?.();
    if (arenaManager) {
      try {
        const sessionDir = arenaManager.getArenaSessionDir();
        const configPath = `${sessionDir}/config.json`;
        reminders.push({ text: getArenaSystemReminder(configPath) });
      } catch {
        // Arena config not yet initialized — skip (matches client.ts).
      }
    }

    return reminders;
  }

  private async runTool(
    abortSignal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<Part[]> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    let args = (fc.args ?? {}) as Record<string, unknown>;

    const startTime = Date.now();
    let spanError: string | undefined;

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: durationMs,
        // An aborted signal means the call was cancelled, not a genuine error.
        status: abortSignal.aborted ? 'cancelled' : 'error',
        success: false,
        error: error.message,
        tool_type:
          typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
            ? 'mcp'
            : 'native',
      });

      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        },
      ];
    };

    const earlyErrorResponse = async (
      error: Error,
      toolName = fc.name ?? 'unknown_tool',
    ) => {
      spanError = error.message;
      if (toolName !== ToolNames.TODO_WRITE) {
        await this.toolCallEmitter.emitError(callId, toolName, error);
      }

      const errorParts = errorResponse(error);
      this.config.getChatRecordingService()?.recordToolResult(errorParts, {
        callId,
        status: 'error',
        resultDisplay: undefined,
        error,
        errorType: undefined,
      });
      return errorParts;
    };

    if (!fc.name) {
      return earlyErrorResponse(new Error('Missing function name'));
    }

    const toolName = fc.name;
    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    if (!tool) {
      return earlyErrorResponse(
        new Error(`Tool "${toolName}" not found in registry.`),
      );
    }

    const toolSpan = startToolSpan(toolName, {
      'tool.call_id': callId,
      // Dual-emit the legacy call_id/tool_name aliases like CoreToolScheduler
      // (coreToolScheduler.ts) so pre-Phase-2 dashboards keyed off call_id keep
      // matching daemon/ACP tool spans during the migration window.
      call_id: callId,
      tool_name: toolName,
    });
    let spanSuccess = false;

    try {
      return await runInToolSpanContext(toolSpan, async () => {
        // ---- L1: Tool enablement check ----
        const pm = this.config.getPermissionManager?.();
        if (pm && !(await pm.isToolEnabled(toolName))) {
          return earlyErrorResponse(
            new Error(`Tool "${toolName}" is disabled.`),
            toolName,
          );
        }

        // Detect TodoWriteTool early - route to plan updates instead of tool_call events
        const isTodoWriteTool = tool.name === ToolNames.TODO_WRITE;
        const isAgentTool = tool.name === ToolNames.AGENT;
        const isExitPlanModeTool = tool.name === ToolNames.EXIT_PLAN_MODE;
        const isEnterPlanModeTool = tool.name === ToolNames.ENTER_PLAN_MODE;

        // Track cleanup functions for sub-agent event listeners
        let subAgentCleanupFunctions: Array<() => void> = [];

        // Generate tool_use_id for hook tracking (aligned with core path)
        const toolUseId = generateToolUseId();

        // Get approval mode for hook context (defined outside try for catch block access)
        const approvalMode = this.config.getApprovalMode();

        try {
          const invocation = tool.build(args);

          // Production AgentTool always initializes `eventEmitter` on its
          // invocation (`agent.ts:392`). Be defensive about the `undefined`
          // case too so an incomplete/custom AgentTool invocation degrades
          // gracefully (no sub-agent event forwarding) instead of throwing
          // inside SubAgentTracker.setup — the `'eventEmitter' in invocation`
          // key-presence check passed for `{ eventEmitter: undefined }` and
          // the ensuing `eventEmitter.on(...)` blew up.
          const taskEventEmitter = (
            invocation as {
              eventEmitter?: AgentEventEmitter;
            }
          ).eventEmitter;
          if (isAgentTool && taskEventEmitter) {
            // Extract subagent metadata from AgentTool call
            const parentToolCallId = callId;
            const subagentType = (args['subagent_type'] as string) ?? '';

            // Create a SubAgentTracker for this tool execution
            const subSubAgentTracker = new SubAgentTracker(
              this,
              this.client,
              parentToolCallId,
              subagentType,
            );

            // Set up sub-agent tool tracking
            subAgentCleanupFunctions = subSubAgentTracker.setup(
              taskEventEmitter,
              abortSignal,
            );
          }

          // L3→L4→L5 Permission Flow (aligned with coreToolScheduler)
          //
          // L3: Tool's intrinsic default permission
          // L4: PermissionManager rule override
          // L5: ApprovalMode override (YOLO / AUTO_EDIT / PLAN)
          //
          // AUTO_EDIT auto-approval is handled HERE, same as coreToolScheduler.
          // The VS Code extension is just a UI layer for requestPermission.
          const isAskUserQuestionTool =
            toolName === ToolNames.ASK_USER_QUESTION;

          // ---- L3→L4: Shared permission flow ----
          const toolParams = invocation.params as Record<string, unknown>;
          const flowResult = await evaluatePermissionFlow(
            this.config,
            invocation,
            toolName,
            toolParams,
          );
          const { finalPermission, pmForcedAsk, pmCtx, denyMessage } =
            flowResult;

          // ---- L5: ApprovalMode overrides ----
          const isPlanMode = approvalMode === ApprovalMode.PLAN;

          if (finalPermission === 'deny') {
            return earlyErrorResponse(
              new Error(denyMessage ?? `Tool "${toolName}" is denied.`),
              toolName,
            );
          }

          // Explicit allow (user rule matched, or tool's L3 default is 'allow')
          // is authoritative for ordinary calls. In AUTO, protected
          // self-modification writes must still reach the classifier/fail-closed
          // path so allow rules cannot bypass AUTO mode's safety boundary.
          // Also resets the denialTracking streak so a following
          // classifier-eligible call doesn't surprise the user with a manual
          // prompt right after an allow-rule call just worked.
          const forceAutoReviewForAllow =
            approvalMode === ApprovalMode.AUTO &&
            shouldForceAutoModeReviewForAllow(pmCtx, this.config.getCwd());
          const confirmationPermission = getEffectivePermissionForConfirmation(
            finalPermission,
            forceAutoReviewForAllow,
          );
          if (finalPermission === 'allow' && forceAutoReviewForAllow) {
            debugLogger.info(
              `Auto mode: L4 allow overridden by protected-write guard for ${toolName}`,
            );
          }
          let autoModeAllowed =
            finalPermission === 'allow' && !forceAutoReviewForAllow;
          if (autoModeAllowed && approvalMode === ApprovalMode.AUTO) {
            this.config.setAutoModeDenialState(
              recordAllow(this.config.getAutoModeDenialState()),
            );
          }
          let wasAutoModeDenialFallback = false;

          // ── L5: AUTO mode three-layer filter (duplicated from
          // coreToolScheduler.ts; ACP routes through this Session path).
          // Returns 'allowed' / 'blocked' / 'fallback'. Blocked early-returns;
          // allowed skips requestPermission; fallback drops through to the
          // existing manual-approval flow below.
          if (
            !autoModeAllowed &&
            shouldRunAutoModeForCall(approvalMode, toolName)
          ) {
            const denialState = this.config.getAutoModeDenialState();
            const fallback = shouldFallback(denialState);
            // `buildClassifierContents` retains only the most recent
            // MAX_TRANSCRIPT_MESSAGES messages; ask the chat client for
            // exactly that tail rather than triggering a `structuredClone`
            // of the whole session on every non-fast-path AUTO call.
            // Parallels coreToolScheduler.ts.
            const messages =
              this.config
                .getGeminiClient?.()
                ?.getHistoryTail(MAX_TRANSCRIPT_MESSAGES, false) ?? [];
            const decision = await evaluateAutoMode({
              ctx: pmCtx,
              pmForcedAsk,
              toolParams,
              messages,
              config: this.config,
              signal: abortSignal,
              skipClassifierReason: fallback.fallback
                ? fallback.reason
                : undefined,
            });

            // Apply decision via shared helper — eliminates ~40 lines of
            // line-for-line duplication with coreToolScheduler.ts and makes
            // the CLI / ACP paths share one source of truth for the
            // switch + denial-tracking state updates + exhaustiveness
            // guard.
            const outcome = applyAutoModeDecision(
              decision,
              this.config,
              denialState,
            );
            await fireSessionPermissionDeniedForAutoMode(
              this.config,
              decision,
              outcome,
              toolName,
              toolParams,
              callId,
              abortSignal,
            );
            switch (outcome.kind) {
              case 'approved':
                autoModeAllowed = true;
                break;
              case 'blocked':
                debugLogger.warn(
                  `Auto mode blocked (${outcome.reason}): tool=${toolName}, ` +
                    formatDenialStateLog(denialState),
                );
                return earlyErrorResponse(
                  new Error(outcome.errorMessage),
                  toolName,
                );
              case 'fallback':
                // Drop through to the manual-approval flow below.
                wasAutoModeDenialFallback = isDenialFallbackReason(
                  outcome.reason,
                );
                if (wasAutoModeDenialFallback) {
                  debugLogger.warn(
                    `Auto mode fallback to manual approval (${outcome.reason}): ` +
                      formatDenialStateLog(denialState),
                  );
                }
                break;
              default: {
                const _exhaustive: never = outcome;
                void _exhaustive;
              }
            }
          }

          let didRequestPermission = false;
          let confirmationDetails: ToolCallConfirmationDetails | undefined;
          const recordAutoModeFallbackResolution = (
            outcome: ToolConfirmationOutcome,
          ) => {
            // Reset AUTO-mode fallback counters when approval resolves a prompt
            // raised because denialTracking forced fallback. This covers both ACP
            // requestPermission and PermissionRequest hook approvals.
            if (
              approvalMode === ApprovalMode.AUTO &&
              wasAutoModeDenialFallback &&
              isApproveOutcome(outcome)
            ) {
              const before = this.config.getAutoModeDenialState();
              const after = recordFallbackApprove(before);
              if (after === before) {
                debugLogger.warn(
                  `Auto mode denial counters already clear after fallback approval: ` +
                    formatDenialStateLog(before),
                );
                return;
              }
              debugLogger.warn(
                `Auto mode denial counters reset after fallback approval: ` +
                  `${formatDenialStateLog(before)} -> ${formatDenialStateLog(after)}`,
              );
              this.config.setAutoModeDenialState(after);
            }
          };

          if (
            !autoModeAllowed &&
            needsConfirmation(confirmationPermission, approvalMode, toolName)
          ) {
            confirmationDetails =
              await invocation.getConfirmationDetails(abortSignal);

            // Centralised rule injection (for display and persistence)
            injectPermissionRulesIfMissing(confirmationDetails, pmCtx);

            if (
              isPlanModeBlocked(
                isPlanMode,
                isExitPlanModeTool,
                isAskUserQuestionTool,
                confirmationDetails,
                isEnterPlanModeTool,
              )
            ) {
              return earlyErrorResponse(
                new Error(
                  `Plan mode is active. The tool "${toolName}" cannot be executed because it modifies the system. ` +
                    'Please use the exit_plan_mode tool to present your plan and exit plan mode before making changes.',
                ),
                toolName,
              );
            }

            const messageBus = this.config.getMessageBus?.();
            const hooksEnabled = !this.config.getDisableAllHooks?.();
            let hookHandled = false;

            if (hooksEnabled && messageBus) {
              const hookResult = await firePermissionRequestHook(
                messageBus,
                toolName,
                args,
                String(approvalMode),
              );

              if (hookResult.hasDecision) {
                hookHandled = true;
                if (hookResult.shouldAllow) {
                  if (hookResult.updatedInput) {
                    args = hookResult.updatedInput;
                    invocation.params =
                      hookResult.updatedInput as typeof invocation.params;
                  }

                  await confirmationDetails.onConfirm(
                    ToolConfirmationOutcome.ProceedOnce,
                  );
                  recordAutoModeFallbackResolution(
                    ToolConfirmationOutcome.ProceedOnce,
                  );
                } else {
                  return earlyErrorResponse(
                    new Error(
                      hookResult.denyMessage ||
                        `Permission denied by hook for "${toolName}"`,
                    ),
                    toolName,
                  );
                }
              }
            }

            // AUTO_EDIT mode: auto-approve edit and info tools
            // (same as coreToolScheduler L5 — NOT delegated to the extension)
            if (
              approvalMode === ApprovalMode.AUTO_EDIT &&
              (confirmationDetails.type === 'edit' ||
                confirmationDetails.type === 'info')
            ) {
              // Auto-approve, skip requestPermission.
              // didRequestPermission stays false → emitStart below.
            } else if (!hookHandled) {
              // Show permission dialog via ACP requestPermission
              didRequestPermission = true;
              const content =
                buildPermissionRequestContent(confirmationDetails);

              // Map tool kind, using switch_mode for exit_plan_mode per ACP spec
              const mappedKind = this.toolCallEmitter.mapToolKind(
                tool.kind,
                toolName,
              );

              if (hooksEnabled && messageBus) {
                this.fireNotificationHookWithTerminalSequence(
                  messageBus,
                  `Qwen Code needs your permission to use ${toolName}`,
                  NotificationType.PermissionPrompt,
                  'Permission needed',
                );
              }

              const params: RequestPermissionRequest = {
                sessionId: this.sessionId,
                options: toPermissionOptions(confirmationDetails, pmForcedAsk),
                toolCall: {
                  toolCallId: callId,
                  status: 'pending',
                  title: invocation.getDescription(),
                  content,
                  locations: invocation.toolLocations(),
                  kind: mappedKind,
                  rawInput: args,
                },
              };

              const output = (await this.client.requestPermission(
                params,
              )) as RequestPermissionResponse & {
                answers?: Record<string, string>;
              };
              const outcome =
                output.outcome.outcome === 'cancelled'
                  ? ToolConfirmationOutcome.Cancel
                  : z
                      .nativeEnum(ToolConfirmationOutcome)
                      .parse(output.outcome.optionId);

              recordAutoModeFallbackResolution(outcome);

              await confirmationDetails.onConfirm(outcome, {
                answers: output.answers,
              });

              // Persist permission rules when user explicitly chose "Always Allow".
              // This branch is only reached for tools that went through
              // requestPermission (user saw dialog and made a choice).
              // AUTO_EDIT auto-approved tools never reach here.
              if (
                outcome === ToolConfirmationOutcome.ProceedAlways ||
                outcome === ToolConfirmationOutcome.ProceedAlwaysProject ||
                outcome === ToolConfirmationOutcome.ProceedAlwaysUser
              ) {
                await persistPermissionOutcome(
                  outcome,
                  confirmationDetails,
                  this.config.getOnPersistPermissionRule?.(),
                  this.config.getPermissionManager?.(),
                  { answers: output.answers },
                );
              }

              // After exit_plan_mode confirmation, send current_mode_update
              if (
                isExitPlanModeTool &&
                outcome !== ToolConfirmationOutcome.Cancel
              ) {
                await this.sendCurrentModeUpdateNotification(outcome);
              }

              // After edit tool ProceedAlways, notify the client about mode change
              if (
                confirmationDetails.type === 'edit' &&
                outcome === ToolConfirmationOutcome.ProceedAlways
              ) {
                await this.sendCurrentModeUpdateNotification(outcome);
              }

              switch (outcome) {
                case ToolConfirmationOutcome.Cancel:
                  // Route through earlyErrorResponse so spanError carries the
                  // cancellation reason (plain errorResponse leaves it unset,
                  // which makes endToolSpan fall back to the generic 'tool
                  // error' message) and the declined call is still recorded.
                  return earlyErrorResponse(
                    new Error(`Tool "${toolName}" was canceled by the user.`),
                    toolName,
                  );
                case ToolConfirmationOutcome.ProceedOnce:
                case ToolConfirmationOutcome.ProceedAlways:
                case ToolConfirmationOutcome.ProceedAlwaysProject:
                case ToolConfirmationOutcome.ProceedAlwaysUser:
                case ToolConfirmationOutcome.ProceedAlwaysServer:
                case ToolConfirmationOutcome.ProceedAlwaysTool:
                case ToolConfirmationOutcome.ModifyWithEditor:
                case ToolConfirmationOutcome.RestorePrevious:
                  break;
                default: {
                  const resultOutcome: never = outcome;
                  throw new Error(`Unexpected: ${resultOutcome}`);
                }
              }
            }
          }

          if (!didRequestPermission && !isTodoWriteTool) {
            // Auto-approved (L3 allow / L4 PM allow / L5 YOLO|AUTO_EDIT)
            // → emit tool_call start notification
            const startParams: ToolCallStartParams = {
              callId,
              toolName,
              args,
              status: 'in_progress',
            };
            await this.toolCallEmitter.emitStart(startParams);
          }

          // Fire PreToolUse hook (aligned with core path in coreToolScheduler.ts)
          const hooksEnabledForTool = !this.config.getDisableAllHooks?.();
          const messageBusForTool = this.config.getMessageBus?.();
          const permissionMode = String(approvalMode);

          if (hooksEnabledForTool && messageBusForTool) {
            const preHookResult = await firePreToolUseHook(
              messageBusForTool,
              toolName,
              args,
              toolUseId,
              permissionMode,
              abortSignal,
            );

            if (!preHookResult.shouldProceed) {
              // Hook blocked the tool execution - send notification to UI
              const blockReason =
                preHookResult.blockReason || 'Blocked by PreToolUse hook';
              await this.messageEmitter.emitAgentMessage(
                `🚫 **PreToolUse blocked**: ${toolName} - ${blockReason}`,
              );
              return earlyErrorResponse(new Error(blockReason), toolName);
            }

            // Add additional context from PreToolUse hook if provided
            // Note: This context would need to be passed to the tool invocation
            // For now, we just log it as the tool execution proceeds
            if (preHookResult.additionalContext) {
              debugLogger.debug(
                `PreToolUse hook additional context for ${toolName}: ${preHookResult.additionalContext}`,
              );
            }
          }

          const execSpan = startToolExecutionSpan();
          let toolResult: ToolResult;
          try {
            const sleepInhibitorHandle = acquireSleepInhibitor(
              this.config,
              `Qwen Code is executing tool ${toolName}`,
            );
            try {
              toolResult = await invocation.execute(abortSignal);
            } finally {
              sleepInhibitorHandle.release();
            }
            const aborted = abortSignal.aborted;
            endToolExecutionSpan(execSpan, {
              success: !toolResult.error && !aborted,
              error: aborted
                ? 'tool_cancelled'
                : toolResult.error
                  ? 'tool_error'
                  : undefined,
              cancelled: aborted,
            });
          } catch (execError) {
            endToolExecutionSpan(execSpan, {
              success: false,
              error: abortSignal.aborted ? 'tool_cancelled' : 'tool_exception',
              cancelled: abortSignal.aborted,
            });
            throw execError;
          }

          // Clean up event listeners
          subAgentCleanupFunctions.forEach((cleanup) => cleanup());

          // enter_plan_mode and the AUTO/YOLO gate path of exit_plan_mode change the
          // approval mode inside execute() without going through the user-confirmation
          // branch above, so notify the client of the current mode explicitly.
          // Only send when the mode actually changed (a gate "blocked" result keeps
          // the mode at PLAN, and a redundant notification would be misleading).
          if (
            (isEnterPlanModeTool || isExitPlanModeTool) &&
            !didRequestPermission &&
            !toolResult.error &&
            this.config.getApprovalMode() !== approvalMode
          ) {
            await this.sendUpdate({
              sessionUpdate: 'current_mode_update',
              currentModeId: this.config.getApprovalMode() as ApprovalModeValue,
            });
          }

          // Create response parts first (needed for emitResult and recordToolResult)
          const responseParts = convertToFunctionResponse(
            toolName,
            callId,
            toolResult.llmContent,
          );

          // Fire PostToolUse hook on successful execution (aligned with core path)
          if (hooksEnabledForTool && messageBusForTool && !toolResult.error) {
            // Use the same response shape as core (llmContent/returnDisplay)
            const toolResponse = {
              llmContent: toolResult.llmContent,
              returnDisplay: toolResult.returnDisplay,
            };
            const postHookResult = await firePostToolUseHook(
              messageBusForTool,
              toolName,
              args,
              toolResponse,
              toolUseId,
              permissionMode,
              abortSignal,
            );

            // If hook indicates to stop, return an error response
            if (postHookResult.shouldStop) {
              const stopMessage =
                postHookResult.stopReason ||
                'Execution stopped by PostToolUse hook';
              debugLogger.info(
                `PostToolUse hook requested stop for ${toolName}: ${stopMessage}`,
              );
              return earlyErrorResponse(new Error(stopMessage), toolName);
            }

            // Add additional context from PostToolUse hook if provided
            if (postHookResult.additionalContext) {
              // Append additional context to the tool response
              const contextPart = { text: postHookResult.additionalContext };
              responseParts.push(contextPart);
            }
          } else if (
            hooksEnabledForTool &&
            messageBusForTool &&
            toolResult.error
          ) {
            // Fire PostToolUseFailure hook when tool returns an error (aligned with core path)
            const failureHookResult = await firePostToolUseFailureHook(
              messageBusForTool,
              toolUseId,
              toolName,
              args,
              toolResult.error.message,
              false, // not an interrupt
              permissionMode,
              abortSignal,
            );

            // Log additional context if provided
            if (failureHookResult.additionalContext) {
              debugLogger.debug(
                `PostToolUseFailure hook additional context for ${toolName}: ${failureHookResult.additionalContext}`,
              );
            }
          }

          // A tool can fail "softly" by returning toolResult.error without
          // throwing, and can be cancelled mid-flight. Compute the real outcome
          // once and reflect it on the client-facing emitResult as well as
          // logToolCall / recordToolResult / the tool span, instead of
          // hardcoding success — otherwise failed/cancelled daemon/ACP tools
          // are mislabeled as successful in telemetry, session replay, and the
          // client UI.
          const aborted = abortSignal.aborted;
          const status: 'success' | 'error' | 'cancelled' = aborted
            ? 'cancelled'
            : toolResult.error
              ? 'error'
              : 'success';
          const succeeded = status === 'success';

          // Handle TodoWriteTool: extract todos and send plan update
          if (isTodoWriteTool) {
            const todos = this.planEmitter.extractTodos(
              toolResult.returnDisplay,
              args,
            );

            // Match original logic: emit plan if todos.length > 0 OR if args had todos
            if ((todos && todos.length > 0) || Array.isArray(args['todos'])) {
              await this.planEmitter.emitPlan(todos ?? []);
            }

            // Skip tool_call_update event for TodoWriteTool
            // Still log and return function response for LLM
          } else {
            // Normal tool handling: emit result using ToolCallEmitter
            const error = toolResult.error
              ? new Error(toolResult.error.message)
              : aborted
                ? new Error('Tool execution was cancelled')
                : undefined;

            await this.toolCallEmitter.emitResult({
              callId,
              toolName,
              args,
              message: responseParts,
              resultDisplay: toolResult.returnDisplay,
              error,
              success: succeeded,
            });
          }

          const durationMs = Date.now() - startTime;
          logToolCall(this.config, {
            'event.name': 'tool_call',
            'event.timestamp': new Date().toISOString(),
            function_name: toolName,
            function_args: args,
            duration_ms: durationMs,
            status,
            success: succeeded,
            error: toolResult.error?.message,
            error_type: toolResult.error?.type,
            prompt_id: promptId,
            tool_type:
              typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
                ? 'mcp'
                : 'native',
          });

          // Record tool result for session management
          this.config
            .getChatRecordingService()
            ?.recordToolResult(responseParts, {
              callId,
              status,
              resultDisplay: toolResult.returnDisplay,
              error: toolResult.error
                ? new Error(toolResult.error.message)
                : undefined,
              errorType: toolResult.error?.type,
            });

          spanSuccess = succeeded;
          if (toolResult.error) {
            spanError = toolResult.error.message;
          } else if (aborted) {
            spanError = 'Tool execution was cancelled';
          }
          return responseParts;
        } catch (e) {
          // Ensure cleanup on error
          subAgentCleanupFunctions.forEach((cleanup) => cleanup());

          const error = e instanceof Error ? e : new Error(String(e));
          spanError = error.message;

          // Fire PostToolUseFailure hook (aligned with core path in coreToolScheduler.ts)
          const hooksEnabledForError = !this.config.getDisableAllHooks?.();
          const messageBusForError = this.config.getMessageBus?.();
          const isInterrupt = abortSignal.aborted;

          if (hooksEnabledForError && messageBusForError) {
            const failureHookResult = await firePostToolUseFailureHook(
              messageBusForError,
              toolUseId,
              toolName,
              args,
              error.message,
              isInterrupt,
              String(approvalMode),
              abortSignal,
            );

            // Log additional context if provided
            if (failureHookResult.additionalContext) {
              debugLogger.debug(
                `PostToolUseFailure hook additional context for ${toolName}: ${failureHookResult.additionalContext}`,
              );
            }
          }

          // Use ToolCallEmitter for error handling
          await this.toolCallEmitter.emitError(callId, toolName, error);

          // Record tool error for session management
          const errorParts = [
            {
              functionResponse: {
                id: callId,
                name: toolName,
                response: { error: error.message },
              },
            },
          ];
          this.config.getChatRecordingService()?.recordToolResult(errorParts, {
            callId,
            // A throw caused by abort (e.g. AbortError) is a cancellation, not
            // a genuine tool error — keep it consistent with the success path.
            status: abortSignal.aborted ? 'cancelled' : 'error',
            resultDisplay: undefined,
            error,
            errorType: undefined,
          });

          return errorResponse(error);
        }
      }); // end runInToolSpanContext
    } finally {
      endToolSpan(toolSpan, { success: spanSuccess, error: spanError });
    }
  }

  #emitGoalStatusItems(result: NonInteractiveSlashCommandResult): void {
    if (!('outputHistoryItems' in result)) {
      return;
    }
    for (const item of result.outputHistoryItems ?? []) {
      if (item.type === MessageType.GOAL_STATUS) {
        this.emitGoalStatus({
          kind: item.kind,
          condition: item.condition,
          ...(item.iterations !== undefined
            ? { iterations: item.iterations }
            : {}),
          ...(item.setAt !== undefined ? { setAt: item.setAt } : {}),
          ...(item.durationMs !== undefined
            ? { durationMs: item.durationMs }
            : {}),
          ...(item.lastReason !== undefined
            ? { lastReason: item.lastReason }
            : {}),
        });
      }
    }
  }

  /**
   * Processes the result of a slash command execution.
   *
   * Supported result types in ACP mode:
   * - submit_prompt: Submits content to the model
   * - stream_messages: Streams multiple messages to the client (ACP-specific)
   * - unsupported: Command cannot be executed in ACP mode
   * - no_command: No command was found, use original prompt
   *
   * Note: 'message' type is not supported in ACP mode - commands should use
   * 'stream_messages' instead for consistent async handling.
   *
   * @param result The result from handleSlashCommand
   * @param originalPrompt The original prompt blocks
   * @returns Parts to use for the prompt, or null if command was handled without needing model interaction
   */
  async #processSlashCommandResult(
    result: NonInteractiveSlashCommandResult,
    originalPrompt: ContentBlock[],
  ): Promise<Part[] | null> {
    this.#emitGoalStatusItems(result);

    switch (result.type) {
      case 'submit_prompt':
        // Command wants to submit a prompt to the model
        // Convert PartListUnion to Part[]
        return normalizePartList(result.content);

      case 'message': {
        if (result.messageType === 'error') {
          // Throw error to stop execution
          throw new Error(result.content || 'Slash command failed.');
        }
        // Emit the message as an agent message chunk so Zed renders it in the
        // chat UI. extNotification only goes to the ACP debug log and is not
        // rendered by Zed.
        // Replace bare \n with Markdown hard line-breaks (two trailing spaces)
        // so Zed's Markdown renderer preserves the line structure.
        const rendered = (result.content || '').replace(/\n/g, '  \n');
        await this.messageEmitter.emitAgentMessage(rendered);
        // Write a system/slash_command record so history replay on restart can
        // re-emit this message. system records are skipped by
        // buildApiHistoryFromConversation, so this won't pollute model context.
        this.config.getChatRecordingService()?.recordSlashCommand({
          phase: 'result',
          rawCommand: originalPrompt
            .filter((b) => b.type === 'text')
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join(' '),
          outputHistoryItems: [
            { type: 'assistant', text: result.content || '' },
          ],
        });
        return null;
      }

      case 'stream_messages': {
        // Command returns multiple messages via async generator (ACP-preferred)
        // Stream all messages to the client as agent message chunks.
        const chunks: string[] = [];
        for await (const msg of result.messages) {
          if (msg.messageType === 'error') {
            throw new Error(msg.content || 'Slash command failed.');
          }
          await this.messageEmitter.emitAgentMessage(
            (msg.content || '').replace(/\n/g, '  \n'),
          );
          chunks.push(msg.content || '');
        }
        // Write a system/slash_command record for history replay (same reason as
        // 'message' case — system records are invisible to model history).
        if (chunks.length > 0) {
          this.config.getChatRecordingService()?.recordSlashCommand({
            phase: 'result',
            rawCommand: originalPrompt
              .filter((b) => b.type === 'text')
              .map((b) => (b.type === 'text' ? b.text : ''))
              .join(' '),
            outputHistoryItems: [
              { type: 'assistant', text: chunks.join('\n') },
            ],
          });
        }

        // All messages sent successfully, return null to indicate command was handled
        return null;
      }

      case 'unsupported': {
        // Command returned an unsupported result type
        const unsupportedError = `Slash command not supported in ACP integration: ${result.reason}`;
        throw new Error(unsupportedError);
      }

      case 'no_command':
        // No command was found or executed, resolve the original prompt
        // through the standard path that handles all block types
        return this.#resolvePrompt(
          originalPrompt,
          new AbortController().signal,
        );

      default: {
        // Exhaustiveness check
        const _exhaustive: never = result;
        const unknownError = `Unknown slash command result type: ${(_exhaustive as NonInteractiveSlashCommandResult).type}`;
        throw new Error(unknownError);
      }
    }
  }

  async #resolvePrompt(
    message: ContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<Part[]> {
    const FILE_URI_SCHEME = 'file://';

    const embeddedContext: EmbeddedResourceResource[] = [];

    const parts = message.map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'image':
        case 'audio':
          return clampInlineMediaPart({
            inlineData: {
              mimeType: part.mimeType,
              data: part.data,
            },
          });
        case 'resource_link': {
          if (part.uri.startsWith(FILE_URI_SCHEME)) {
            return {
              fileData: {
                mimeData: part.mimeType,
                name: part.name,
                fileUri: part.uri.slice(FILE_URI_SCHEME.length),
              },
            };
          } else {
            return { text: `@${part.uri}` };
          }
        }
        case 'resource': {
          embeddedContext.push(part.resource);
          return { text: `@${part.resource.uri}` };
        }
        default: {
          const unreachable: never = part;
          throw new Error(`Unexpected chunk type: '${unreachable}'`);
        }
      }
    });

    const atPathCommandParts = parts.filter((part) => 'fileData' in part);

    if (atPathCommandParts.length === 0 && embeddedContext.length === 0) {
      return parts;
    }

    // Extract paths from @ commands - pass directly to readManyFiles without filtering
    // since this is user-triggered behavior, not LLM-triggered
    const pathSpecsToRead: string[] = atPathCommandParts.map(
      (part) => part.fileData!.fileUri!,
    );

    // Construct the initial part of the query for the LLM
    let initialQueryText = '';
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if ('text' in chunk) {
        initialQueryText += chunk.text;
      } else if ('fileData' in chunk) {
        const pathName = chunk.fileData!.fileUri;
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ')
        ) {
          initialQueryText += ' ';
        }
        initialQueryText += `@${pathName}`;
      }
    }

    const processedQueryParts: Part[] = [];

    // Read files using readManyFiles utility
    if (pathSpecsToRead.length > 0) {
      const readResult = await readManyFiles(this.config, {
        paths: pathSpecsToRead,
        signal: abortSignal,
      });

      const contentParts = Array.isArray(readResult.contentParts)
        ? readResult.contentParts
        : [readResult.contentParts];

      // Add initial query text first
      processedQueryParts.push({ text: initialQueryText });

      // Then add content parts (preserving binary files as inlineData)
      for (const part of contentParts) {
        if (typeof part === 'string') {
          processedQueryParts.push({ text: part });
        } else {
          processedQueryParts.push(clampInlineMediaPart(part));
        }
      }
    } else {
      processedQueryParts.push({ text: initialQueryText.trim() });
    }

    // Process embedded context from resource blocks
    for (const contextPart of embeddedContext) {
      // Type guard for text resources
      if ('text' in contextPart && contextPart.text) {
        processedQueryParts.push({
          text: `File: ${contextPart.uri}\n${contextPart.text}`,
        });
      }
      // Type guard for blob resources
      if ('blob' in contextPart && contextPart.blob) {
        processedQueryParts.push(
          clampInlineMediaPart({
            inlineData: {
              mimeType: contextPart.mimeType ?? 'application/octet-stream',
              data: contextPart.blob,
            },
          }),
        );
      }
    }

    return processedQueryParts;
  }

  debug(msg: string): void {
    if (this.config.getDebugMode()) {
      debugLogger.warn(msg);
    }
  }

  /**
   * Fire a notification hook and forward any terminalSequence to the ACP
   * client as an extNotification. Fire-and-forget — errors are logged at
   * debug level.
   */
  private fireNotificationHookWithTerminalSequence(
    messageBus: MessageBus,
    message: string,
    notificationType: NotificationType,
    title?: string,
  ): void {
    void fireNotificationHook(messageBus, message, notificationType, title)
      .then((hookResult) => {
        if (!hookResult.terminalSequence) return;
        return this.client.extNotification(
          'qwen/notify/session/terminal-sequence',
          {
            v: 1,
            sessionId: this.sessionId,
            terminalSequence: hookResult.terminalSequence,
          },
        );
      })
      .catch((err: unknown) => {
        debugLogger.debug(
          `ACP terminalSequence notification dropped ` +
            `(session=${this.sessionId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
