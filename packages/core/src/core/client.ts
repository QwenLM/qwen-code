/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// External dependencies
import { createUserContent } from '@google/genai';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
  PartListUnion,
  Tool,
} from '@google/genai';
import process from 'node:process';

// Config
import { ApprovalMode, type Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { cleanupOldToolResults } from '../utils/toolResultCleanup.js';
import { Storage } from '../config/storage.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import {
  microcompactHistory,
  type MicrocompactMeta,
  type MicrocompactOptions,
} from '../services/microcompaction/microcompact.js';
import {
  activeGoalEquals,
  getActiveGoal,
  type ActiveGoal,
} from '../goals/activeGoalStore.js';
import { abortGoalForStopHookCap } from '../goals/goalHook.js';
import { formatStopHookBlockingCapWarning } from '../hooks/stopHookCap.js';

const debugLogger = createDebugLogger('CLIENT');

// Core modules
import { GeminiChat } from './geminiChat.js';
import { getRecentGitStatus } from '../utils/gitUtils.js';
import {
  getArenaSystemReminder,
  getCoreSystemPrompt,
  getCustomSystemPrompt,
  getPlanModeSystemReminder,
} from './prompts.js';
import {
  CompressionStatus,
  GeminiEventType,
  Turn,
  type ChatCompressionInfo,
  type ServerGeminiStreamEvent,
} from './turn.js';

// Services
import { LoopDetectionService } from '../services/loopDetectionService.js';
import { CommitAttributionService } from '../services/commitAttribution.js';

// Tools
import type { RelevantAutoMemoryPromptResult } from '../memory/manager.js';
import { AUTO_SKILL_THRESHOLD } from '../memory/manager.js';
import {
  DEFAULT_AUTO_SKILL_MAX_TURNS,
  DEFAULT_AUTO_SKILL_TIMEOUT_MS,
} from '../memory/skillReviewAgentPlanner.js';
import { isProjectSkillPath } from '../skills/skill-paths.js';
import { ToolNames } from '../tools/tool-names.js';

// Telemetry
import {
  NextSpeakerCheckEvent,
  logNextSpeakerCheck,
  startInteractionSpan,
  endInteractionSpan,
  getActiveInteractionSpan,
  addUserPromptAttributes,
} from '../telemetry/index.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

// Forked agent cache
import {
  saveCacheSafeParams,
  clearCacheSafeParams,
} from '../utils/forkedAgent.js';

// Utilities
import {
  formatDateForContext,
  buildAddedMcpToolsReminder,
  buildAddedSkillsReminder,
  getDirectoryContextString,
  getInitialChatHistory,
  getStartupContextLength,
} from '../utils/environmentContext.js';
import {
  collectAvailableSkillEntries,
  type AvailableSkillEntry,
} from '../tools/skill-utils.js';
import type { DeferredToolSummary } from '../tools/tool-registry.js';
import {
  buildApiHistoryFromConversation,
  replayUiTelemetryFromConversation,
} from '../services/sessionService.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import { checkNextSpeaker } from '../utils/nextSpeakerChecker.js';
import {
  flatMapTextParts,
  prependToFirstTextPart,
} from '../utils/partUtils.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { retryWithBackoff, isUnattendedMode } from '../utils/retry.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import { escapeSystemReminderTags } from '../utils/xml.js';
import { ApiRetryEvent, LoopType } from '../telemetry/types.js';
import { logApiRetry } from '../telemetry/loggers.js';

// Hook types and utilities
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import { partToString } from '../utils/partUtils.js';
import { createHookOutput, SessionStartSource } from '../hooks/types.js';
import fsPromises from 'node:fs/promises';

// IDE integration
import { ideContextStore } from '../ide/ideContext.js';
import { type File, type IdeContext } from '../ide/types.js';
import { PermissionMode, type StopHookOutput } from '../hooks/types.js';

const MAX_TURNS = 100;
const MAX_RECENT_TOOL_NAMES_FOR_MEMORY = 20;

export enum SendMessageType {
  UserQuery = 'userQuery',
  ToolResult = 'toolResult',
  Retry = 'retry',
  Hook = 'hook',
  /** Cron-fired prompt. Behaves like UserQuery but skips UserPromptSubmit hook. */
  Cron = 'cron',
  /** Background agent notification. Display item is added by the drain loop. */
  Notification = 'notification',
  /**
   * A message delivered to the leader from a teammate. Behaves like a
   * fresh top-level interaction (loop-detector reset + interaction span)
   * but is not a user prompt — it does not bump commit attribution or get
   * recorded as a user message.
   */
  Teammate = 'teammate',
}

export interface SendMessageOptions {
  type: SendMessageType;
  /** Track stop hook iterations to prevent infinite loops and display loop info */
  stopHookState?: {
    iterationCount: number;
    reasons: string[];
  };
  /** Display text for notification messages (persisted for session resume). */
  notificationDisplayText?: string;
  /** Model override from skill execution. When present, overrides the session model for this turn. */
  modelOverride?: string;
}

const EMPTY_RELEVANT_AUTO_MEMORY_RESULT: RelevantAutoMemoryPromptResult = {
  prompt: '',
  selectedDocs: [],
  strategy: 'none',
};

function wrapIdeContext(contextText: string): string {
  const safeContextText = escapeSystemReminderTags(contextText);
  return `<system-reminder>\n${safeContextText}\n</system-reminder>`;
}

/**
 * Handle for a non-blocking auto-memory recall prefetch.
 *
 * Lifecycle:
 *  1. Created on UserQuery/Cron — the recall promise fires immediately,
 *     `pendingMemoryPrefetch` is set to this handle.
 *  2. Consumed at either of two opportunistic points: a zero-wait
 *     `settledAt !== null` poll just before the UserQuery main request,
 *     or — if recall hadn't settled yet — on the first ToolResult turn.
 *  3. Aborted-and-discarded by every cleanup path (resetChat,
 *     MaxSessionTurns, etc.) or replaced when a new UserQuery arrives.
 */
type MemoryPrefetchHandle = {
  promise: Promise<RelevantAutoMemoryPromptResult>;
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null;
  /** True after memory has been injected — prevents double-inject. */
  consumed: boolean;
  controller: AbortController;
};

/** Tools that can write to the skills directory, used to detect skillsModifiedInSession. */
const SKILL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
]);

export class GeminiClient {
  private chat?: GeminiChat;
  private initializedSessionId: string | undefined;
  private sessionTurnCount = 0;
  private toolCallCount = 0;
  private skillsModifiedInSession = false;
  private cachedGitStatus: string | null | undefined;
  private readonly surfacedRelevantAutoMemoryPaths = new Set<string>();

  private readonly loopDetector: LoopDetectionService;
  private lastPromptId: string | undefined = undefined;
  private lastSentIdeContext: IdeContext | undefined;
  private forceFullIdeContext = true;
  private recentCompletedToolNames: string[] = [];
  private pendingMemoryPrefetch: MemoryPrefetchHandle | undefined;
  private lastSessionStartContext: string | undefined;
  private lastSessionStartSource: SessionStartSource | undefined;
  private announcedDeferredToolNames = new Set<string>();
  private pendingAddedMcpTools = new Map<string, DeferredToolSummary>();
  // Dedup state for the per-turn skill/command "now available" delta reminders
  // (drainSkillAndCommandReminders). Keys are "skill:<name>" / "cmd:<name>". The
  // set is seeded on the first drain from the current skills (the startup
  // snapshot already listed them) and reset whenever the startup prelude is
  // rebuilt (startChat), so a resumed/compacted session re-seeds from its fresh
  // snapshot instead of re-announcing — mirrors Claude Code's
  // suppressNextSkillListing / "don't re-inject on compact".
  private announcedSkillReminderKeys = new Set<string>();
  private skillRemindersInitialized = false;

  private static skillEntryKey(e: AvailableSkillEntry): string {
    return e.level !== undefined ? `skill:${e.name}` : `cmd:${e.name}`;
  }

  /**
   * Seeds skill-reminder dedup from the entries actually rendered into the
   * startup snapshot. Mirrors `rememberAnnouncedDeferredTools`: the dedup is
   * seeded from what the model actually SAW, not from whatever happens to be
   * current at the first drain (which may include late-registered MCP
   * prompts/commands the snapshot never listed).
   */
  private seedSkillReminderDedupFromSnapshot(
    snapshotEntries: AvailableSkillEntry[],
  ): void {
    this.announcedSkillReminderKeys = new Set(
      snapshotEntries.map(GeminiClient.skillEntryKey),
    );
    this.skillRemindersInitialized = true;
  }

  /**
   * Tracks the most recently injected date string to prevent injecting
   * duplicate or conflicting dates when a session spans midnight.
   * Only UserQuery turns inject dates; Cron/ToolResult turns reuse the
   * startup-context date which is still current within the same session.
   */
  private lastInjectedDate: string | undefined;

  /**
   * Promises for pending background memory tasks (dream / extract).
   * Each promise resolves with a count of memory files touched (0 = nothing written).
   * Consumed by the CLI via `consumePendingMemoryTaskPromises()`.
   */
  private pendingMemoryTaskPromises: Array<Promise<number>> = [];

  /**
   * Timestamp (epoch ms) of the last completed API call.
   * Used to detect idle periods for thinking block cleanup.
   * Starts as null — on the first query there is no prior thinking to clean,
   * so the idle check is skipped until the first API call completes.
   */
  private lastApiCompletionTimestamp: number | null = null;
  /** Cleanup checkpoint for long-running Hook continuations such as /goal. */
  private lastHookMicrocompactionTimestamp: number | null = null;

  constructor(private readonly config: Config) {
    this.loopDetector = new LoopDetectionService(config);
  }

  async initialize(sessionStartSource?: SessionStartSource) {
    const sessionId = this.config.getSessionId();
    this.lastPromptId = sessionId;

    if (this.isInitialized() && this.initializedSessionId === sessionId) {
      return;
    }

    // Check if we're resuming from a previous session
    const resumedSessionData = this.config.getResumedSessionData();
    if (resumedSessionData) {
      const resumeTokenCounts = replayUiTelemetryFromConversation(
        resumedSessionData.conversation,
        this.config.getSessionId(),
      );
      // Convert resumed session to API history format
      // Each ChatRecord's message field is already a Content object
      const resumedHistory = buildApiHistoryFromConversation(
        resumedSessionData.conversation,
      );
      this.seedRecentCompletedToolNamesFromHistory(resumedHistory);
      await this.startChat(
        resumedHistory,
        sessionStartSource ?? SessionStartSource.Resume,
      );
      const chat = this.getChat();
      if (resumeTokenCounts) {
        chat.seedResumeTokenCounts(
          resumeTokenCounts.promptTokenCount,
          resumeTokenCounts.outputTokenCount,
        );
      } else {
        chat.setLastPromptTokenCount(
          uiTelemetryService.getLastPromptTokenCount(),
        );
      }

      // Restore attribution state from the last snapshot in the session
      this.restoreAttributionFromSession(resumedSessionData.conversation);
    } else {
      if (sessionStartSource !== undefined) {
        await this.startChat(undefined, sessionStartSource);
      } else {
        await this.startChat();
      }
    }

    this.initializedSessionId = sessionId;

    // Clean up stale tool result files from previous sessions (fire-and-forget)
    void cleanupOldToolResults(Storage.getGlobalTempDir(), 24 * 60 * 60 * 1000);
  }

  /**
   * Restore attribution state from the last snapshot in a resumed session.
   */
  private restoreAttributionFromSession(conversation: {
    messages: Array<{ subtype?: string; systemPayload?: unknown }>;
  }): void {
    // Find the last attribution snapshot in the session
    let lastSnapshot: unknown = null;
    for (const msg of conversation.messages) {
      if (
        msg.subtype === 'attribution_snapshot' &&
        msg.systemPayload &&
        typeof msg.systemPayload === 'object' &&
        'snapshot' in msg.systemPayload
      ) {
        lastSnapshot = (msg.systemPayload as { snapshot: unknown }).snapshot;
      }
    }
    if (lastSnapshot && typeof lastSnapshot === 'object') {
      try {
        CommitAttributionService.getInstance().restoreFromSnapshot(
          lastSnapshot as import('../services/commitAttribution.js').AttributionSnapshot,
        );
        debugLogger.debug('Restored attribution state from session snapshot');
      } catch {
        debugLogger.warn('Failed to restore attribution snapshot');
      }
    }
  }

  async addHistory(content: Content) {
    this.getChat().addHistory(content);
  }

  getChat(): GeminiChat {
    if (!this.chat) {
      throw new Error('Chat not initialized');
    }
    return this.chat;
  }

  isInitialized(): boolean {
    return this.chat !== undefined;
  }

  getHistory(curated: boolean = false): Content[] {
    return this.getChat().getHistory(curated);
  }

  getHistoryShallow(curated: boolean = false): Content[] {
    const chat = this.getChat();
    return chat.getHistoryShallow?.(curated) ?? chat.getHistory(curated);
  }

  getHistoryTail(count: number, curated: boolean = false): Content[] {
    return this.getChat().getHistoryTail(count, curated);
  }

  private getHistoryTailShallow(
    count: number,
    curated: boolean = false,
  ): Content[] {
    const chat = this.getChat();
    return (
      chat.getHistoryTailShallow?.(count, curated) ??
      chat.getHistoryTail?.(count, curated) ??
      chat.getHistory(curated).slice(-count)
    );
  }

  private peekLastHistoryEntry(): Content | undefined {
    const chat = this.getChat();
    return chat.peekLastHistoryEntry?.() ?? chat.getHistory().at(-1);
  }

  private getHistoryLength(): number {
    const chat = this.getChat();
    return chat.getHistoryLength?.() ?? chat.getHistory().length;
  }

  private getLastModelMessageText(): string | undefined {
    const chat = this.getChat();
    if (chat.getLastModelMessageText) {
      return chat.getLastModelMessageText();
    }
    const history = chat.getHistoryShallow?.() ?? chat.getHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message?.role !== 'model') continue;
      const text =
        message.parts
          ?.filter(
            (part): part is { text: string } => typeof part.text === 'string',
          )
          .map((part) => part.text)
          .join('') ?? '';
      return text || undefined;
    }
    return undefined;
  }

  /**
   * Walk-only accessor for the set of `functionResponse.id` strings in
   * raw history. Callers that only need the dedup id set (notably
   * `useGeminiStream.handleCompletedTools`) MUST prefer this over
   * {@link getHistory}, which deep-clones the entire conversation via
   * `structuredClone` on every call. On long sessions with sizable
   * tool outputs the clone is a multi-millisecond hit on the React UI
   * thread; running it on every tool-completion batch caused visible
   * frame drops during streaming. See
   * `GeminiChat.getHistoryFunctionResponseIds` for the implementation.
   */
  getHistoryFunctionResponseIds(): Set<string> {
    return this.getChat().getHistoryFunctionResponseIds();
  }

  /**
   * Pop orphaned trailing user entries from the in-memory chat history.
   * Used by:
   *   - The Retry submit path (sendMessageStream below), which drops a
   *     prior failed attempt before re-sending.
   *   - The auto-restore-on-cancel flow in AppContainer, which rewinds
   *     a user prompt out of the UI transcript and the disk-backed
   *     ↑-history; this is the third place the cancelled prompt lives.
   *     Without calling this from auto-restore, the next request's wire
   *     payload would carry two consecutive user turns — the cancelled
   *     one and the new one — and the model would see context the user
   *     thought had been undone.
   */
  stripOrphanedUserEntriesFromHistory() {
    const chat = this.getChat();
    const before = chat.getHistoryLength();
    chat.stripOrphanedUserEntriesFromHistory();
    const after = chat.getHistoryLength();
    if (after >= before) {
      // Nothing to strip — leave caches and IDE context alone.
      return;
    }
    // Stripped trailing user entries can include read_file
    // functionResponses from a failed-then-retried request. The
    // FileReadCache would still record those reads, so the retry's
    // re-issued Read could hit the file_unchanged placeholder while
    // the model has nothing to fall back on. Clear to be safe.
    debugLogger.debug(
      `[FILE_READ_CACHE] clear after stripOrphanedUserEntriesFromHistory(prev=${before}, new=${after})`,
    );
    this.config.getFileReadCache().clear();
    // The stripped user turn may have carried the IDE context (open files,
    // workspace state) that `lastSentIdeContext` advanced past. Without
    // forcing a resend, the next request would either skip IDE context
    // entirely or send only a diff against a now-removed baseline. Match
    // the invalidation `setHistory()` / `truncateHistory()` already do.
    this.forceFullIdeContext = true;
  }

  /**
   * Synthesize a `functionResponse` for every dangling `model[functionCall]`
   * in chat history whose corresponding tool_result never landed. Inverse of
   * {@link stripOrphanedUserEntriesFromHistory}, which only handles trailing
   * `user` entries.
   *
   * This `GeminiClient` method is the resume-path entry point — called once
   * from {@link startChat} after the transcript loads, covering `--resume`
   * of a session that crashed between a partial-tool_use push and the
   * tool's eventual completion.
   *
   * The other two coverage points (Retry submit path after
   * `stripOrphanedUserEntriesFromHistory`, and the defensive pass at the
   * start of every UserQuery / Cron send) live one layer down inside
   * `GeminiChat.sendMessageStream` and call the standalone
   * `repairOrphanedToolUseTurns(history)` function directly — they don't
   * route through this wrapper. Anyone tracing the repair-pass coupling
   * between the client and chat layers should follow that path
   * separately rather than expect everything to funnel through here.
   *
   * Synthesizes an `error` `functionResponse`. The React tool scheduler
   * (`useGeminiStream.handleCompletedTools`) MUST dedupe by `callId` against
   * the live history before submitting its own `tool_result` — otherwise a
   * late real result lands as a second `user[tool_result]` block (orphan
   * because the synthetic already consumed the matching `tool_use`).
   */
  repairOrphanedToolUseTurnsInHistory(reason?: string): {
    injected: Array<{ callId: string; name: string }>;
    droppedDuplicates: Array<{ callId: string; name: string }>;
  } {
    const result = this.getChat().repairOrphanedToolUseTurns(reason);
    if (result.injected.length > 0) {
      debugLogger.warn(
        `[REPAIR] Synthesized ${result.injected.length} functionResponse(s) ` +
          `for dangling tool_use(s): ${result.injected
            .map((e) => `${e.name}(${e.callId})`)
            .join(', ')}`,
      );
    }
    if (result.droppedDuplicates.length > 0) {
      // Surface the duplicate-cleanup pass so investigators tracing
      // a dedup-drop log have a breadcrumb pointing back to the
      // repair function. Without this a duplicate-only repair (no
      // synthesis, no hoist) leaves zero diagnostic trail and a
      // future callId-collision bug would silently delete the
      // wrong fr.
      debugLogger.warn(
        `[REPAIR] Dropped ${result.droppedDuplicates.length} duplicate ` +
          `functionResponse(s) for callId(s): ${result.droppedDuplicates
            .map((e) => `${e.name}(${e.callId})`)
            .join(', ')}`,
      );
    }
    return result;
  }

  setHistory(history: Content[]) {
    this.getChat().setHistory(history);
    // Replacing history wholesale drops any prior read_file tool
    // results the FileReadCache still believes the model has seen.
    // Without clearing, a follow-up Read of an unchanged file would
    // return the file_unchanged placeholder for bytes that no longer
    // exist in the new history.
    debugLogger.debug('[FILE_READ_CACHE] clear after setHistory');
    this.config.getFileReadCache().clear();
    this.forceFullIdeContext = true;
  }

  truncateHistory(keepCount: number) {
    // Use the O(1) length getter rather than getHistory() — the latter
    // structuredClone's the entire history just to read .length, which
    // gets expensive in long-running sessions.
    const prevLen = this.getChat().getHistoryLength();
    this.getChat().truncateHistory(keepCount);
    // Decide whether to invalidate based on the *actual* post-truncate
    // length, not on the keepCount argument. Comparing keepCount alone
    // misses pathological inputs (e.g. NaN: slice(0, NaN) returns [],
    // emptying history, but `NaN < prevLen` is false and would skip
    // the clear, reintroducing the file_unchanged placeholder bug).
    const newLen = this.getChat().getHistoryLength();
    if (newLen < prevLen) {
      debugLogger.debug(
        `[FILE_READ_CACHE] clear after truncateHistory(keep=${keepCount}, prev=${prevLen}, new=${newLen})`,
      );
      this.config.getFileReadCache().clear();
    }
    this.forceFullIdeContext = true;
  }

  async setTools(): Promise<void> {
    if (!this.isInitialized()) {
      return;
    }

    const toolRegistry = this.config.getToolRegistry();
    await toolRegistry.warmAll();
    const deferredTools = this.resolveDeferredToolsForReminder();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    this.getChat().setTools(tools);
    this.queueAddedMcpToolsReminder(deferredTools ?? []);
    recordStartupEvent('gemini_tools_updated', {
      toolCount: toolDeclarations.length,
      deferredCount: deferredTools?.length ?? 0,
    });
  }

  /**
   * Abort and release the pending auto-memory prefetch in one step.
   * Safe to call when no prefetch is pending — does nothing. Centralises
   * the abort-then-clear idiom so every cleanup path (resetChat, early
   * returns, finally) cannot half-fix one without the other.
   *
   * If the handle has already settled (recall completed but consume point
   * hadn't run yet), the settled result is discarded — logged at debug so
   * operators can diagnose missing-memory scenarios.
   */
  private cancelPendingMemoryPrefetch(): void {
    const handle = this.pendingMemoryPrefetch;
    if (!handle) return;
    if (handle.settledAt !== null && !handle.consumed) {
      debugLogger.debug('Discarding settled but unconsumed memory prefetch.');
    }
    handle.controller.abort();
    this.pendingMemoryPrefetch = undefined;
  }

  /**
   * Atomically consume the pending prefetch if it has already settled.
   * Returns the recall result (caller decides where to inject it in
   * `requestToSend`), or `null` if there's nothing to consume yet.
   *
   * Centralises the consume-and-mark dance so the UserQuery and ToolResult
   * inject sites can't drift on the guard logic.
   */
  private async tryConsumeMemoryPrefetch(): Promise<RelevantAutoMemoryPromptResult | null> {
    const handle = this.pendingMemoryPrefetch;
    if (!handle || handle.settledAt === null || handle.consumed) {
      return null;
    }
    handle.consumed = true;
    this.pendingMemoryPrefetch = undefined;
    const result = await handle.promise; // already settled, returns immediately
    if (result.prompt) {
      for (const doc of result.selectedDocs) {
        this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
      }
    }
    return result;
  }

  async resetChat(): Promise<void> {
    const memBefore = process.memoryUsage();
    const historyLength = this.chat?.getHistoryLength() ?? 0;
    if (debugLogger.isEnabled()) {
      debugLogger.debug(
        `[RESET_CHAT_START] Starting resetChat, ` +
          `historyLength=${historyLength}, ` +
          `heapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
          `rss=${(memBefore.rss / 1024 / 1024).toFixed(1)}MB`,
      );
    }

    this.initializedSessionId = undefined;
    this.surfacedRelevantAutoMemoryPaths.clear();
    this.cachedGitStatus = undefined;
    this.lastApiCompletionTimestamp = null;
    this.lastHookMicrocompactionTimestamp = null;
    this.recentCompletedToolNames = [];
    // startChat() rewrites the chat to its initial state. Any prior
    // read_file tool results the FileReadCache still tracks are no
    // longer in history, so a follow-up Read would serve a placeholder
    // pointing at content the model can no longer retrieve.
    debugLogger.debug('[FILE_READ_CACHE] clear after resetChat');
    this.config.getFileReadCache().clear();
    // Clean up old tool result overflow files on /clear
    void cleanupOldToolResults(Storage.getGlobalTempDir(), 24 * 60 * 60 * 1000);
    this.config.getBaseLlmClient().clearPerModelGeneratorCache();
    // Abort any in-flight auto-memory recall so the stale controller
    // does not leak into the next session.
    this.cancelPendingMemoryPrefetch();
    // Drop any deferred tools revealed this session so /clear really gives
    // a clean slate. We don't clear inside startChat itself because that path
    // is also taken by compression (which preserves the session), and
    // compression should keep previously-revealed tools so the model can
    // continue using them without re-running ToolSearch.
    this.config.getToolRegistry().clearRevealedDeferredTools();
    await this.startChat(undefined, SessionStartSource.Clear);
    this.initializedSessionId = this.config.getSessionId();

    const memAfter = process.memoryUsage();
    const newHistoryLength = this.chat?.getHistoryLength() ?? 0;
    if (debugLogger.isEnabled()) {
      debugLogger.debug(
        `[RESET_CHAT_END] resetChat completed, ` +
          `oldHistoryLength=${historyLength}, ` +
          `newHistoryLength=${newHistoryLength}, ` +
          `heapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(1)}MB, ` +
          `rss=${(memAfter.rss / 1024 / 1024).toFixed(1)}MB, ` +
          `heapDiff=${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)}MB`,
      );
    }
  }

  getLoopDetectionService(): LoopDetectionService {
    return this.loopDetector;
  }

  async addDirectoryContext(): Promise<void> {
    if (!this.chat) {
      return;
    }

    this.getChat().addHistory({
      role: 'user',
      parts: [{ text: await getDirectoryContextString(this.config) }],
    });
  }

  async addWorkingDirectoryChangedContext(
    oldDir: string,
    newDir: string,
  ): Promise<void> {
    if (!this.chat) {
      return;
    }

    this.cachedGitStatus = undefined;
    await this.refreshSystemInstruction();
    this.getChat().addHistory({
      role: 'user',
      parts: [
        {
          text:
            `The session's working directory has changed from ${oldDir} to ${newDir} via /cd. ` +
            `The startup directory context above is stale. All tool calls and relative paths now resolve from ${newDir}.`,
        },
      ],
    });
    await this.addDirectoryContext();
  }

  private getCachedGitStatus(): string | null {
    if (this.cachedGitStatus === undefined) {
      // Mirror claude-code: append git status (branch + recent commits) to the
      // system prompt so the main agent treats version history as authoritative
      // context, not background noise. Only injected when cwd is a git repo.
      this.cachedGitStatus = getRecentGitStatus(this.config.getCwd());
    }
    return this.cachedGitStatus;
  }

  private getMainSessionSystemInstruction(): string {
    const userMemory = this.config.getUserMemory();
    const overrideSystemPrompt = this.config.getSystemPrompt();
    const appendSystemPrompt = this.config.getAppendSystemPrompt();
    const gitStatus = this.getCachedGitStatus();

    if (overrideSystemPrompt) {
      const base = getCustomSystemPrompt(
        overrideSystemPrompt,
        userMemory,
        appendSystemPrompt,
      );
      return gitStatus ? base + '\n\n' + gitStatus : base;
    }

    const base = getCoreSystemPrompt(
      userMemory,
      this.config.getModel(),
      appendSystemPrompt,
    );
    return gitStatus ? base + '\n\n' + gitStatus : base;
  }

  async refreshStartupContextReminder(): Promise<void> {
    if (!this.chat) {
      return;
    }

    const currentHistory = this.getChat().getHistory();
    const startupLength = getStartupContextLength(currentHistory);
    if (startupLength === 0) {
      return;
    }

    // Slice by the detected prelude length, not a hardcoded 1: a restored
    // legacy session stores startup context as a [user(env), model("Got
    // it…")] pair (getStartupContextLength === 2), so slice(1) would leave
    // the orphaned model-ack entry behind when re-prepending the prelude.
    const remaining = currentHistory.slice(startupLength);
    const [[startupContext], snapshotEntries] = await getInitialChatHistory(
      this.config,
    );
    this.seedSkillReminderDedupFromSnapshot(snapshotEntries);
    this.getChat().setHistory(
      startupContext ? [startupContext, ...remaining] : remaining,
    );
  }

  /**
   * Re-prepend a fresh startup-context prelude after auto-compaction.
   *
   * Auto-compaction runs in-place inside `GeminiChat.sendMessageStream`
   * (`setHistory([summary, ack, ...kept])`) and does NOT route through
   * `tryCompressChat` → `startChat`, so — unlike manual `/compress` — the
   * startup prelude at history[0] is consumed into the summary and never
   * rebuilt. Without this, workspace/env context, deferred-tool metadata,
   * and MCP server instructions are lost for the rest of the session (before
   * this PR they lived in the system instruction and survived compaction).
   *
   * Unlike `refreshStartupContextReminder` (which replaces an existing
   * prelude and no-ops when absent), this prepends when absent. No-ops if a
   * prelude is already present so it can't double-prepend.
   */
  async restoreStartupContextAfterCompaction(): Promise<void> {
    if (!this.chat) {
      return;
    }

    const currentHistory = this.getChat().getHistory();
    if (getStartupContextLength(currentHistory) !== 0) {
      return;
    }

    const [[startupContext], snapshotEntries] = await getInitialChatHistory(
      this.config,
    );
    this.seedSkillReminderDedupFromSnapshot(snapshotEntries);
    if (startupContext) {
      this.getChat().setHistory([startupContext, ...currentHistory]);
    }
  }

  /**
   * Rebuilds the main-session system instruction from the current
   * `userMemory` / model / prompt overrides and re-binds it to the live chat.
   *
   * Use this after mutating inputs that feed into the system instruction
   * (e.g. user memory refreshed from `output-language.md`) so the change
   * takes effect on the next turn without restarting the session. No-op if
   * no chat has been started yet.
   */
  async refreshSystemInstruction(): Promise<void> {
    if (!this.chat) {
      return;
    }
    await this.config.getToolRegistry().warmAll();
    this.chat.setSystemInstruction(this.getMainSessionSystemInstruction());
    if (this.lastSessionStartContext && this.lastSessionStartSource) {
      this.chat.applySessionStartContext(
        this.lastSessionStartContext,
        this.lastSessionStartSource,
      );
    }
  }

  /**
   * Computes the deferred-tools list that should be announced through
   * user-role system reminders.
   *
   * Caller MUST `await toolRegistry.warmAll()` first — this method only
   * inspects the registry's eager state and would otherwise miss factory-
   * backed deferred tools.
   *
   * Side effect: when ToolSearch is not registered (e.g. `--exclude-tools
   * tool_search` or a deny rule), every deferred tool is eagerly revealed
   * here so it lands in the declaration list. Skipping this would leave the
   * tool both off the declarations AND off the deferred-summary list (since
   * `undefined` is returned in that branch) — a silent disappearance that's
   * harder to diagnose than seeing the tool name absent from `/mcp` output.
   *
   * Returns `undefined` when ToolSearch is unavailable: reminders must not
   * advertise tools the model has no way to load on demand.
   */
  private resolveDeferredToolsForReminder(): DeferredToolSummary[] | undefined {
    const toolRegistry = this.config.getToolRegistry();
    const deferredSummary = toolRegistry.getDeferredToolSummary();
    const toolSearchAvailable = !!toolRegistry.getTool(ToolNames.TOOL_SEARCH);
    if (!toolSearchAvailable) {
      if (deferredSummary.length > 0) {
        for (const t of deferredSummary) {
          toolRegistry.revealDeferredTool(t.name);
        }
      }
      return undefined;
    }
    return deferredSummary.filter(
      (t) => !toolRegistry.isDeferredToolRevealed(t.name),
    );
  }

  private rememberAnnouncedDeferredTools(
    deferredTools: readonly DeferredToolSummary[] | undefined,
  ): void {
    this.announcedDeferredToolNames = new Set(
      (deferredTools ?? []).map((tool) => tool.name),
    );
    this.pendingAddedMcpTools.clear();
  }

  private queueAddedMcpToolsReminder(
    deferredTools: readonly DeferredToolSummary[],
  ): void {
    const currentDeferredNames = new Set(
      deferredTools.map((tool) => tool.name),
    );
    for (const name of this.pendingAddedMcpTools.keys()) {
      if (!currentDeferredNames.has(name)) {
        this.pendingAddedMcpTools.delete(name);
      }
    }

    // Drop announced names that are no longer deferred (e.g. an MCP server
    // disconnected and removeMcpToolsByServer() pruned its tools). Without
    // this, a tool that reconnects later is still in announcedDeferredToolNames
    // and gets silently skipped below, so the user never sees the "new tools
    // available" reminder even though setTools() re-declared the tool.
    for (const name of this.announcedDeferredToolNames) {
      if (!currentDeferredNames.has(name)) {
        this.announcedDeferredToolNames.delete(name);
      }
    }

    for (const tool of deferredTools) {
      if (tool.serverName && !this.announcedDeferredToolNames.has(tool.name)) {
        this.pendingAddedMcpTools.set(tool.name, tool);
      }
      this.announcedDeferredToolNames.add(tool.name);
    }
  }

  private drainPendingAddedMcpToolsReminder(): void {
    if (this.pendingAddedMcpTools.size === 0) {
      return;
    }

    const addedMcpTools = Array.from(this.pendingAddedMcpTools.values());
    const reminder = buildAddedMcpToolsReminder(addedMcpTools);
    this.pendingAddedMcpTools.clear();

    if (!reminder) {
      return;
    }

    this.getChat().addHistory({
      role: 'user',
      parts: [{ text: reminder }],
    });
  }

  /**
   * Per-turn delta for skills/commands that became invocable after session start
   * — skills enabled mid-session (e.g. via `/skills`) and MCP prompts added after
   * startup. Emitted as a tail `<system-reminder>` only, so it never mutates the
   * cached tools/system/messages prefix. Deduped via `announcedSkillReminderKeys`.
   *
   * The first call after a (re)built startup prelude seeds the announced set from
   * the current skills and emits nothing — the startup snapshot already listed
   * them (mirrors Claude Code's `suppressNextSkillListing` and its decision not
   * to re-inject the listing after compaction). Conditional path-activations are
   * announced inline on the tool result by `coreToolScheduler`, so they are
   * recorded here as announced (not re-queued) to avoid a double announcement.
   */
  private async drainSkillAndCommandReminders(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    // Only relevant when the model can actually invoke skills (subagents often
    // run without the Skill tool).
    if (!toolRegistry?.getTool(ToolNames.SKILL)) {
      return;
    }
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      return;
    }

    let entries: AvailableSkillEntry[];
    try {
      ({ entries } = await collectAvailableSkillEntries(
        skillManager,
        this.config,
      ));
    } catch (error) {
      debugLogger.warn(
        'drainSkillAndCommandReminders: collectAvailableSkillEntries failed',
        error,
      );
      return;
    }

    const currentKeys = new Set(entries.map(GeminiClient.skillEntryKey));

    // Prune announced keys no longer present so a later re-enable / reconnect
    // re-announces (mirrors the MCP added-tools prune above).
    for (const key of this.announcedSkillReminderKeys) {
      if (!currentKeys.has(key)) {
        this.announcedSkillReminderKeys.delete(key);
      }
    }

    // Safety net: if seedSkillReminderDedupFromSnapshot was never called (e.g.
    // edge-case construction path), mark initialized but do NOT seed from
    // current entries — no startup snapshot was shown to the model, so all
    // entries are genuinely new and should be announced by the code below.
    // Seeding here used to silently swallow late registrations (cmd:* keys
    // and MCP prompts discovered after startChat) by marking them as
    // "already announced" when the model had never seen them.
    if (!this.skillRemindersInitialized) {
      this.skillRemindersInitialized = true;
    }

    // Consume skill keys that coreToolScheduler announced inline on a tool
    // result this turn (e.g. path-activated conditional skills). Mark them as
    // announced so the drain below does not re-announce them. This fixes the
    // subagent shared-SkillManager case: the inline reminder lands in the
    // subagent's discarded transcript, but the parent's drain now skips those
    // keys because the scheduler recorded them on the shared Config.
    const inlineKeys = this.config.consumeInlineAnnouncedSkillKeys();
    for (const key of inlineKeys) {
      this.announcedSkillReminderKeys.add(key);
    }

    // Announce every genuinely new skill/command that was not already
    // announced — either in the startup snapshot, a prior drain, or inline
    // by coreToolScheduler above.
    const newEntries: AvailableSkillEntry[] = [];
    for (const entry of entries) {
      const key = GeminiClient.skillEntryKey(entry);
      if (this.announcedSkillReminderKeys.has(key)) {
        continue;
      }
      this.announcedSkillReminderKeys.add(key);
      newEntries.push(entry);
    }

    if (newEntries.length === 0) {
      return;
    }
    const reminder = buildAddedSkillsReminder(newEntries);
    if (!reminder) {
      return;
    }
    this.getChat().addHistory({
      role: 'user',
      parts: [{ text: reminder }],
    });
  }

  private toPermissionMode(approvalMode: ApprovalMode): PermissionMode {
    switch (approvalMode) {
      case ApprovalMode.DEFAULT:
        return PermissionMode.Default;
      case ApprovalMode.PLAN:
        return PermissionMode.Plan;
      case ApprovalMode.AUTO_EDIT:
        return PermissionMode.AutoEdit;
      case ApprovalMode.AUTO:
        return PermissionMode.Auto;
      case ApprovalMode.YOLO:
        return PermissionMode.Yolo;
      default:
        return PermissionMode.Default;
    }
  }

  private async fireSessionStartHook(
    source: SessionStartSource,
  ): Promise<string | undefined> {
    const hookSystem = this.config.getHookSystem();
    if (
      this.config.getDisableAllHooks() ||
      !hookSystem ||
      !this.config.hasHooksForEvent('SessionStart')
    ) {
      return undefined;
    }

    try {
      const output = await hookSystem.fireSessionStartEvent(
        source,
        this.config.getModel() ?? '',
        this.toPermissionMode(this.config.getApprovalMode()),
      );
      return output?.getAdditionalContext()?.trim() || undefined;
    } catch (err) {
      this.config.getDebugLogger().warn(`SessionStart hook failed: ${err}`);
      return undefined;
    }
  }

  async startChat(
    extraHistory?: Content[],
    sessionStartSource = extraHistory
      ? SessionStartSource.Resume
      : SessionStartSource.Startup,
  ): Promise<GeminiChat> {
    this.forceFullIdeContext = true;
    this.lastInjectedDate = undefined;
    // Clear stale cache params on session reset to prevent cross-session leakage
    clearCacheSafeParams();

    let history: Content[] = [];

    try {
      // Warm the tool registry before building startup reminders and tool
      // declarations. Revealed-deferred state is NOT cleared here because
      // startChat is also taken by the compression path (which preserves the
      // session); `/clear` clears the revealed set via resetChat() before
      // calling us.
      const toolRegistry = this.config.getToolRegistry();
      await toolRegistry.warmAll();
      // Resume support: when a transcript contains prior calls to a deferred
      // tool, re-reveal that tool so `setTools()` below sends its schema in
      // the declaration list. Without this, the model sees history like
      // "I called foo_tool, got result" but the API rejects a follow-up
      // call to foo_tool because the schema is absent. This must happen
      // BEFORE `resolveDeferredToolsForReminder()` runs so the resumed tools
      // are correctly filtered out of the startup reminder built below.
      if (extraHistory && extraHistory.length > 0) {
        const deferredNames = new Set(
          toolRegistry.getDeferredToolSummary().map((t) => t.name),
        );
        if (deferredNames.size > 0) {
          for (const entry of extraHistory) {
            for (const part of entry.parts ?? []) {
              const callName = part.functionCall?.name;
              if (callName && deferredNames.has(callName)) {
                toolRegistry.revealDeferredTool(callName);
              }
            }
          }
        }
      }
      const deferredTools = this.resolveDeferredToolsForReminder();
      this.rememberAnnouncedDeferredTools(deferredTools);
      let snapshotEntries: AvailableSkillEntry[];
      [history, snapshotEntries] = await getInitialChatHistory(
        this.config,
        extraHistory,
      );
      this.seedSkillReminderDedupFromSnapshot(snapshotEntries);
      const systemInstruction = this.getMainSessionSystemInstruction();

      this.chat = new GeminiChat(
        this.config,
        {
          systemInstruction,
        },
        history,
        this.config.getChatRecordingService(),
        uiTelemetryService,
      );

      // Repair any dangling `model[functionCall]` whose `functionResponse`
      // never made it back into the transcript before we wrote the JSONL.
      // The common cause is a process crash / OOM / SIGKILL between the
      // partial-tool_use push (see `processStreamResponse`) and the React
      // scheduler's tool_result submission. Without this pass, the first
      // API call on a resumed session would 400 with the same
      // `tool_use_id ... corresponding tool_use` error this whole
      // subsystem is trying to escape. (Belt-and-suspenders: the same
      // helper runs again inside `chat.sendMessageStream` after the user
      // content is pushed, so a dangling left here by setHistory /
      // compaction reordering is also caught — but doing it here keeps
      // any pre-send code reading `chat.history` from seeing a malformed
      // shape.)
      this.repairOrphanedToolUseTurnsInHistory();

      const sessionStartAdditionalContext =
        await this.fireSessionStartHook(sessionStartSource);
      this.lastSessionStartContext = sessionStartAdditionalContext;
      this.lastSessionStartSource = sessionStartAdditionalContext
        ? sessionStartSource
        : undefined;

      if (sessionStartAdditionalContext) {
        this.chat.applySessionStartContext(
          sessionStartAdditionalContext,
          sessionStartSource,
        );
      }

      await this.setTools();

      return this.chat;
    } catch (error) {
      await reportError(
        error,
        'Error initializing chat session.',
        history,
        'startChat',
      );
      throw new Error(`Failed to initialize chat: ${getErrorMessage(error)}`);
    }
  }

  private getIdeContextParts(forceFullContext: boolean): {
    contextParts: string[];
    newIdeContext: IdeContext | undefined;
  } {
    const currentIdeContext = ideContextStore.get();
    if (!currentIdeContext) {
      return { contextParts: [], newIdeContext: undefined };
    }

    if (forceFullContext || !this.lastSentIdeContext) {
      // Send full context as plain text
      const openFiles = currentIdeContext.workspaceState?.openFiles || [];
      const activeFile = openFiles.find((f) => f.isActive);
      const otherOpenFiles = openFiles
        .filter((f) => !f.isActive)
        .map((f) => f.path);

      const contextLines: string[] = [];

      if (activeFile) {
        contextLines.push('Active file:');
        contextLines.push(`  Path: ${activeFile.path}`);
        if (activeFile.cursor) {
          contextLines.push(
            `  Cursor: line ${activeFile.cursor.line}, character ${activeFile.cursor.character}`,
          );
        }
        if (activeFile.selectedText) {
          contextLines.push('  Selected text:');
          contextLines.push('```');
          contextLines.push(activeFile.selectedText);
          contextLines.push('```');
        }
      }

      if (otherOpenFiles.length > 0) {
        if (contextLines.length > 0) {
          contextLines.push('');
        }
        contextLines.push('Other open files:');
        for (const filePath of otherOpenFiles) {
          contextLines.push(`  - ${filePath}`);
        }
      }

      if (contextLines.length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      const contextParts = [
        "Here is the user's current editor context. Use it when relevant, including to answer questions about the active file, open files, cursor, or selected text.",
        contextLines.join('\n'),
      ];

      debugLogger.debug(contextParts.join('\n'));
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
    } else {
      // Calculate and send delta as plain text
      const changeLines: string[] = [];

      const lastFiles = new Map(
        (this.lastSentIdeContext.workspaceState?.openFiles || []).map(
          (f: File) => [f.path, f],
        ),
      );
      const currentFiles = new Map(
        (currentIdeContext.workspaceState?.openFiles || []).map((f: File) => [
          f.path,
          f,
        ]),
      );

      const openedFiles: string[] = [];
      for (const [path] of currentFiles.entries()) {
        if (!lastFiles.has(path)) {
          openedFiles.push(path);
        }
      }
      if (openedFiles.length > 0) {
        changeLines.push('Files opened:');
        for (const filePath of openedFiles) {
          changeLines.push(`  - ${filePath}`);
        }
      }

      const closedFiles: string[] = [];
      for (const [path] of lastFiles.entries()) {
        if (!currentFiles.has(path)) {
          closedFiles.push(path);
        }
      }
      if (closedFiles.length > 0) {
        if (changeLines.length > 0) {
          changeLines.push('');
        }
        changeLines.push('Files closed:');
        for (const filePath of closedFiles) {
          changeLines.push(`  - ${filePath}`);
        }
      }

      const lastActiveFile = (
        this.lastSentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);
      const currentActiveFile = (
        currentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);

      if (currentActiveFile) {
        if (!lastActiveFile || lastActiveFile.path !== currentActiveFile.path) {
          if (changeLines.length > 0) {
            changeLines.push('');
          }
          changeLines.push('Active file changed:');
          changeLines.push(`  Path: ${currentActiveFile.path}`);
          if (currentActiveFile.cursor) {
            changeLines.push(
              `  Cursor: line ${currentActiveFile.cursor.line}, character ${currentActiveFile.cursor.character}`,
            );
          }
          if (currentActiveFile.selectedText) {
            changeLines.push('  Selected text:');
            changeLines.push('```');
            changeLines.push(currentActiveFile.selectedText);
            changeLines.push('```');
          }
        } else {
          const lastCursor = lastActiveFile.cursor;
          const currentCursor = currentActiveFile.cursor;
          if (
            currentCursor &&
            (!lastCursor ||
              lastCursor.line !== currentCursor.line ||
              lastCursor.character !== currentCursor.character)
          ) {
            if (changeLines.length > 0) {
              changeLines.push('');
            }
            changeLines.push('Cursor moved:');
            changeLines.push(`  Path: ${currentActiveFile.path}`);
            changeLines.push(
              `  New position: line ${currentCursor.line}, character ${currentCursor.character}`,
            );
          }

          const lastSelectedText = lastActiveFile.selectedText || '';
          const currentSelectedText = currentActiveFile.selectedText || '';
          if (lastSelectedText !== currentSelectedText) {
            if (changeLines.length > 0) {
              changeLines.push('');
            }
            changeLines.push('Selection changed:');
            changeLines.push(`  Path: ${currentActiveFile.path}`);
            if (currentSelectedText) {
              changeLines.push('  Selected text:');
              changeLines.push('```');
              changeLines.push(currentSelectedText);
              changeLines.push('```');
            } else {
              changeLines.push('  Selected text: (none)');
            }
          }
        }
      } else if (lastActiveFile) {
        if (changeLines.length > 0) {
          changeLines.push('');
        }
        changeLines.push('Active file changed:');
        changeLines.push('  No active file');
        changeLines.push(`  Previous path: ${lastActiveFile.path}`);
      }

      if (changeLines.length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      const contextParts = [
        "Here is a summary of changes in the user's current editor context. Use it with the previous editor context when relevant, including to answer questions about the active file, open files, cursor, or selected text.",
        changeLines.join('\n'),
      ];

      debugLogger.debug(contextParts.join('\n'));
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
    }
  }

  private runManagedAutoMemoryBackgroundTasks(
    messageType: SendMessageType,
  ): void {
    // autoSkill counts tool calls and can trigger on both UserQuery and
    // ToolResult turns so the threshold can fire mid-session.
    if (
      messageType === SendMessageType.UserQuery ||
      messageType === SendMessageType.ToolResult
    ) {
      const projectRoot = this.config.getProjectRoot();
      const sessionId = this.config.getSessionId();
      const history = this.getHistoryShallow();
      const mgr = this.config.getMemoryManager();
      const autoSkillEnabled = this.config.getAutoSkillEnabled();

      if (autoSkillEnabled) {
        const skillReviewResult = mgr.scheduleSkillReview({
          projectRoot,
          sessionId,
          history,
          config: this.config,
          toolCallCount: this.toolCallCount,
          skillsModified: this.skillsModifiedInSession,
          enabled: autoSkillEnabled,
          threshold: AUTO_SKILL_THRESHOLD,
          maxTurns: DEFAULT_AUTO_SKILL_MAX_TURNS,
          timeoutMs: DEFAULT_AUTO_SKILL_TIMEOUT_MS,
        });
        if (skillReviewResult.status === 'scheduled') {
          // Reset tool-call counter when a review is dispatched so the next
          // review only fires after a full new threshold worth of tool calls.
          this.toolCallCount = 0;
          if (skillReviewResult.promise) {
            this.pendingMemoryTaskPromises.push(
              skillReviewResult.promise
                .then((record) => {
                  const touched = record.metadata?.['touchedSkillFiles'];
                  return Array.isArray(touched) ? touched.length : 0;
                })
                .catch((error: unknown) => {
                  debugLogger.warn(
                    'Failed to run managed skill review.',
                    error,
                  );
                  return 0;
                }),
            );
          }
        } else if (
          skillReviewResult.status === 'skipped' &&
          skillReviewResult.skippedReason === 'already_running' &&
          this.toolCallCount >= AUTO_SKILL_THRESHOLD
        ) {
          // A review is already in-flight; reset the counter so that when the
          // current review completes the next call doesn't immediately trigger
          // another review without accumulating a fresh threshold of tool calls.
          this.toolCallCount = 0;
        }
        // Always reset the skills-modified flag after the scheduleSkillReview
        // check, regardless of whether a review was dispatched. This prevents
        // a deadlock where skillsModifiedInSession stays true forever: when
        // the flag is set, scheduleSkillReview returns 'skipped' immediately
        // (never 'scheduled'), so without this reset the flag can never clear.
        this.skillsModifiedInSession = false;
      }
    }

    // extract and dream keep the original UserQuery-only gate to preserve
    // the existing "once per user turn" semantics and avoid redundant work.
    if (messageType !== SendMessageType.UserQuery) {
      return;
    }

    const projectRoot = this.config.getProjectRoot();
    const sessionId = this.config.getSessionId();
    const history = this.getHistoryShallow();
    const mgr = this.config.getMemoryManager();

    if (!this.config.getManagedAutoMemoryEnabled()) {
      return;
    }

    const extractPromise = mgr
      .scheduleExtract({
        projectRoot,
        sessionId,
        history,
        config: this.config,
      })
      .then((result) => result.touchedTopics.length)
      .catch((error: unknown) => {
        debugLogger.warn(
          'Failed to schedule managed auto-memory extraction.',
          error,
        );
        return 0;
      });
    this.pendingMemoryTaskPromises.push(extractPromise);

    const dreamPromise = mgr
      .scheduleDream({
        projectRoot,
        sessionId,
        config: this.config,
      })
      .then((schedResult) => {
        if (schedResult.status === 'scheduled' && schedResult.promise) {
          return schedResult.promise.then((state) => {
            const topics = state.metadata?.['touchedTopics'] as
              | string[]
              | undefined;
            return topics ? topics.length : 0;
          });
        }
        return 0;
      })
      .catch((error: unknown) => {
        debugLogger.warn(
          'Failed to schedule managed auto-memory dream.',
          error,
        );
        return 0;
      });
    this.pendingMemoryTaskPromises.push(dreamPromise);
  }

  /**
   * Returns and clears the list of pending background memory task promises.
   * Each promise resolves with the number of memory files touched (0 = nothing
   * was written, caller should ignore).
   */
  consumePendingMemoryTaskPromises(): Array<Promise<number>> {
    const promises = this.pendingMemoryTaskPromises;
    this.pendingMemoryTaskPromises = [];
    return promises;
  }

  recordCompletedToolCall(
    toolName: string,
    args?: Record<string, unknown>,
  ): void {
    this.rememberCompletedToolName(toolName);

    if (args && SKILL_WRITE_TOOL_NAMES.has(toolName)) {
      const filePath = args['file_path'] ?? args['path'] ?? args['target_file'];
      if (
        typeof filePath === 'string' &&
        isProjectSkillPath(filePath, this.config.getProjectRoot())
      ) {
        this.skillsModifiedInSession = true;
      }
    }
    this.toolCallCount += 1;
  }

  private rememberCompletedToolName(toolName: string): void {
    const normalizedToolName = toolName.trim();
    if (!normalizedToolName) {
      return;
    }
    this.recentCompletedToolNames = [
      ...this.recentCompletedToolNames.filter(
        (name) => name !== normalizedToolName,
      ),
      normalizedToolName,
    ].slice(-MAX_RECENT_TOOL_NAMES_FOR_MEMORY);
  }

  private seedRecentCompletedToolNamesFromHistory(history: Content[]): void {
    const completedCallIds = new Set<string>();
    for (const message of history) {
      for (const part of message.parts ?? []) {
        const responseId = part.functionResponse?.id;
        if (responseId) {
          completedCallIds.add(responseId);
        }
      }
    }

    this.recentCompletedToolNames = [];
    for (const message of history) {
      for (const part of message.parts ?? []) {
        const call = part.functionCall;
        if (!call?.name) {
          continue;
        }
        if (call.id && !completedCallIds.has(call.id)) {
          continue;
        }
        this.rememberCompletedToolName(call.name);
      }
    }
  }

  private async microcompactHistoryBeforeSend(
    lastCompletionTimestamp: number | null,
    opts?: MicrocompactOptions,
  ): Promise<boolean> {
    try {
      const mcResult = microcompactHistory(
        this.getHistoryShallow(),
        lastCompletionTimestamp,
        this.config.getClearContextOnIdle(),
        opts,
      );
      if (!mcResult.meta) {
        return false;
      }

      const m = mcResult.meta;
      const changed = m.tokensSaved > 0;
      if (changed) {
        this.getChat().setHistory(mcResult.history);
        await this.disarmFileReadCacheAfterEviction(m, 'microcompaction');
      }
      if (m.triggerReason === 'size') {
        const pendingNote =
          m.pendingToolResultChars && m.pendingToolResultChars > 0
            ? ` (+${m.pendingToolResultChars} pending)`
            : '';
        debugLogger.info(
          `[TOOL-RESULT MC] tool result chars ${m.toolResultCharsBefore} > ` +
            `${m.toolResultsTotalCharsThreshold}, cleared ${m.toolsCleared} ` +
            `tool result(s) (~${m.tokensSaved} tokens), history now ` +
            `${m.toolResultCharsAfter}${pendingNote}, kept ${m.toolsKept} ` +
            `tool result(s)`,
        );
      } else {
        debugLogger.info(
          `[TIME-BASED MC] gap ${m.gapMinutes}min > ${m.thresholdMinutes}min, ` +
            `cleared ${m.toolsCleared} tool result(s) + ${m.mediaCleared} media (~${m.tokensSaved} tokens), ` +
            `kept ${m.toolsKept} tool / ${m.mediaKept} media`,
        );
      }
      return changed;
    } catch (err) {
      debugLogger.error(
        `[MICROCOMPACTION] microcompactHistory failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  async *sendMessageStream(
    request: PartListUnion,
    signal: AbortSignal,
    prompt_id: string,
    options?: SendMessageOptions,
    turns: number = MAX_TURNS,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    const messageType = options?.type ?? SendMessageType.UserQuery;

    if (messageType === SendMessageType.Retry) {
      this.stripOrphanedUserEntriesFromHistory();
      // The matching dangling-`functionCall` repair runs inside
      // `chat.sendMessageStream` AFTER the user content is pushed, so any
      // tool_result the user is supplying (Retry of a ToolResult
      // submission, lastPrompt === fr parts) closes the pair via the real
      // `functionResponse` before we synthesize an error one. Doing the
      // repair here would happen pre-push and race against the user
      // content's own pairing.
    }

    // Fire UserPromptSubmit hook through MessageBus (only if hooks are enabled)
    const hooksEnabled = !this.config.getDisableAllHooks();
    const messageBus = this.config.getMessageBus();
    if (
      messageType !== SendMessageType.Retry &&
      messageType !== SendMessageType.Cron &&
      messageType !== SendMessageType.Notification &&
      // Teammate envelopes are machine-driven re-entries like Cron /
      // Notification, not user prompts: user-authored UserPromptSubmit
      // hooks must not fire on (or be able to block) internal team
      // coordination traffic.
      messageType !== SendMessageType.Teammate &&
      hooksEnabled &&
      messageBus &&
      this.config.hasHooksForEvent('UserPromptSubmit')
    ) {
      const promptText = partToString(request);
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
        yield {
          type: GeminiEventType.UserPromptSubmitBlocked,
          value: {
            reason: hookOutput.getEffectiveReason(),
            originalPrompt: promptText,
          },
        };
        return new Turn(this.getChat(), prompt_id);
      }

      // Add additional context from hooks to the request
      const additionalContext = hookOutput?.getAdditionalContext();
      if (additionalContext) {
        const requestArray = Array.isArray(request) ? request : [request];
        request = [...requestArray, { text: additionalContext }];
      }
    }

    if (
      messageType === SendMessageType.Notification ||
      messageType === SendMessageType.Teammate
    ) {
      // Teammate envelopes record like notifications: the UI rendered
      // them as a compact `●` line (the displayText) and the envelope
      // is the model-bound payload, so a resumed session restores the
      // same info item. Without this they were the one top-level
      // interaction missing from chat recording entirely.
      this.config
        .getChatRecordingService()
        ?.recordNotification(request, options?.notificationDisplayText);
    }

    // Notifications start a fresh Turn with a new prompt_id, so the loop
    // detector must reset — otherwise a prior turn's count can trip
    // LoopDetected early on the notification turn.
    const isTopLevelInteraction =
      messageType === SendMessageType.UserQuery ||
      messageType === SendMessageType.Cron ||
      messageType === SendMessageType.Notification ||
      messageType === SendMessageType.Teammate;
    if (isTopLevelInteraction) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;
      startInteractionSpan(this.config, {
        promptId: prompt_id,
        model: options?.modelOverride ?? this.config.getModel(),
        messageType,
      });
      const interactionSpan = getActiveInteractionSpan();
      if (
        interactionSpan &&
        this.config.getTelemetryIncludeSensitiveSpanAttributes?.()
      ) {
        // Guard partToString — addUserPromptAttributes would early-return
        // anyway, but the argument is evaluated unconditionally otherwise.
        addUserPromptAttributes(
          this.config,
          interactionSpan,
          partToString(request),
        );
      }
    }

    // Tracks whether the generator reached its natural end (the bottom-of-try
    // `return turn`). Only on that path do we want to preserve the pending
    // memory prefetch so the next ToolResult turn can consume it. Any other
    // exit (LoopDetected, Error, signal abort, uncaught exception, abnormal
    // early-return) leaves this `false`, and the `finally` block aborts the
    // prefetch as a safety net.
    let normalCompletion = false;
    try {
      if (
        messageType === SendMessageType.UserQuery ||
        messageType === SendMessageType.Cron
      ) {
        if (this.config.getManagedAutoMemoryEnabled()) {
          // A previous recall may still be pending (slow side-query, new user
          // turn arrived before it settled). Abort it before installing the
          // new handle so the orphan doesn't keep running indefinitely.
          this.cancelPendingMemoryPrefetch();
          const controller = new AbortController();
          // Bridge the caller's signal into the prefetch controller so a user
          // abort (Ctrl-C / Esc) on the parent turn also terminates the
          // recall side-query. `{ once: true }` lets the listener clean itself
          // up after firing; we still call removeEventListener on the promise's
          // finally to cover the normal-completion case so a long-lived parent
          // signal doesn't accumulate listeners across many turns.
          const onParentAbort = () => controller.abort();
          if (signal.aborted) {
            controller.abort();
          } else {
            signal.addEventListener('abort', onParentAbort, { once: true });
          }
          const promise = this.config
            .getMemoryManager()
            .recall(this.config.getProjectRoot(), partToString(request), {
              config: this.config,
              excludedFilePaths: this.surfacedRelevantAutoMemoryPaths,
              recentTools: [...this.recentCompletedToolNames],
              abortSignal: controller.signal,
            })
            .catch((error: unknown) => {
              // Abort sources are now numerous (caller signal, new UserQuery,
              // cleanup paths, safety-net timeout). Keep a debug trace so
              // operators can diagnose missing-memory scenarios without
              // raising noise on the common abort path.
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                debugLogger.debug(
                  'Managed auto-memory recall prefetch aborted.',
                );
              } else {
                debugLogger.warn(
                  'Managed auto-memory recall prefetch failed.',
                  error,
                );
              }
              return EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
            });
          const handle: MemoryPrefetchHandle = {
            promise,
            settledAt: null,
            consumed: false,
            controller,
          };
          void promise.finally(() => {
            handle.settledAt = Date.now();
            signal.removeEventListener('abort', onParentAbort);
          });
          this.pendingMemoryPrefetch = handle;
        }

        // Track prompt count for commit attribution. Only the user typing a
        // fresh prompt should bump the counter — `ToolResult` (tool-call
        // continuation), `Retry`, `Hook`, `Cron`, and `Notification` are all
        // model-driven or background-driven re-entries of the same logical
        // turn. Counting them inflates the "N-shotted" label in the PR
        // attribution trailer (one user message becomes "10-shotted" when it
        // triggered ten tool calls).
        const attributionService = CommitAttributionService.getInstance();
        if (messageType === SendMessageType.UserQuery) {
          attributionService.incrementPromptCount();
        }

        // record user/cron message for session management
        if (messageType === SendMessageType.Cron) {
          this.config
            .getChatRecordingService()
            ?.recordCronPrompt(request, options?.notificationDisplayText);
        } else {
          this.config.getChatRecordingService()?.recordUserMessage(request);
        }
      }

      if (
        messageType === SendMessageType.UserQuery ||
        messageType === SendMessageType.Cron
      ) {
        // Pre-send microcompaction: user and cron turns can trigger both
        // idle-based and cumulative-size cleanup. ToolResult and Retry are
        // excluded here; ToolResult runs a size-only checkpoint after its
        // pending content is assembled.
        const compacted = await this.microcompactHistoryBeforeSend(
          this.lastApiCompletionTimestamp,
        );
        if (messageType === SendMessageType.UserQuery || compacted) {
          this.lastHookMicrocompactionTimestamp = Date.now();
        }
      } else if (messageType === SendMessageType.Hook) {
        this.lastHookMicrocompactionTimestamp ??=
          this.lastApiCompletionTimestamp ?? Date.now();
        const checkpoint = this.lastHookMicrocompactionTimestamp;
        if (await this.microcompactHistoryBeforeSend(checkpoint)) {
          this.lastHookMicrocompactionTimestamp = Date.now();
        }
      }

      if (messageType !== SendMessageType.Retry) {
        // Attribution snapshots are recorded on every non-retry turn. File
        // history snapshots are created only at UserQuery boundaries; later
        // tool edits update that latest snapshot through trackEdit().
        this.config
          .getChatRecordingService()
          ?.recordAttributionSnapshot(
            CommitAttributionService.getInstance().toSnapshot(),
          );

        this.sessionTurnCount++;

        if (messageType === SendMessageType.UserQuery) {
          try {
            await this.config.getFileHistoryService().makeSnapshot(prompt_id);
            try {
              const latestSnapshot = this.config
                .getFileHistoryService()
                .getSnapshots()
                .at(-1);
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
        }

        if (
          this.config.getMaxSessionTurns() > 0 &&
          this.sessionTurnCount > this.config.getMaxSessionTurns()
        ) {
          this.cancelPendingMemoryPrefetch();
          yield { type: GeminiEventType.MaxSessionTurns };
          if (isTopLevelInteraction)
            endInteractionSpan('error', {
              errorMessage: 'max session turns exceeded',
            });
          return new Turn(this.getChat(), prompt_id);
        }
      }

      // Ensure turns never exceeds MAX_TURNS to prevent infinite loops
      const boundedTurns = Math.min(turns, MAX_TURNS);
      if (!boundedTurns) {
        this.cancelPendingMemoryPrefetch();
        if (isTopLevelInteraction)
          endInteractionSpan('error', { errorMessage: 'max turns exhausted' });
        return new Turn(this.getChat(), prompt_id);
      }

      // Auto-compaction happens inside GeminiChat.sendMessageStream and surfaces
      // via the `compressed → ChatCompressed` bridge in turn.ts. Manual /compress
      // still calls tryCompressChat directly for the full reset (env refresh +
      // forceFullIdeContext flip).
      const sessionTokenLimit = this.config.getSessionTokenLimit();
      if (sessionTokenLimit > 0) {
        const lastPromptTokenCount =
          uiTelemetryService.getLastPromptTokenCount();
        if (lastPromptTokenCount > sessionTokenLimit) {
          this.cancelPendingMemoryPrefetch();
          yield {
            type: GeminiEventType.SessionTokenLimitExceeded,
            value: {
              currentTokens: lastPromptTokenCount,
              limit: sessionTokenLimit,
              message:
                `Session token limit exceeded: ${lastPromptTokenCount} tokens > ${sessionTokenLimit} limit. ` +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          };
          if (isTopLevelInteraction)
            endInteractionSpan('error', {
              errorMessage: 'session token limit exceeded',
            });
          return new Turn(this.getChat(), prompt_id);
        }
      }

      // Prevent context updates from being sent while a tool call is
      // waiting for a response. The Qwen API requires that a functionResponse
      // part from the user immediately follows a functionCall part from the model
      // in the conversation history. The IDE context is not discarded; it will
      // be included in the next regular message sent to the model.
      const historyLength = this.getHistoryLength();
      const lastMessage = this.peekLastHistoryEntry();
      const hasPendingToolCall =
        !!lastMessage &&
        lastMessage.role === 'model' &&
        (lastMessage.parts?.some((p) => 'functionCall' in p) || false);
      let ideContextText: string | undefined;
      let nextIdeContext: IdeContext | undefined;
      let shouldUpdateIdeContextState = false;

      if (this.config.getIdeMode() && !hasPendingToolCall) {
        const { contextParts, newIdeContext } = this.getIdeContextParts(
          this.forceFullIdeContext || historyLength === 0,
        );
        if (contextParts.length > 0) {
          ideContextText = wrapIdeContext(contextParts.join('\n'));
          nextIdeContext = newIdeContext;
          shouldUpdateIdeContextState = true;
        } else {
          debugLogger.debug(
            'IDE mode enabled but no context parts generated (forceFull=%s)',
            this.forceFullIdeContext,
          );
        }
      }

      // Check for arena control signal before starting a new turn
      const arenaAgentClient = this.config.getArenaAgentClient();
      if (arenaAgentClient) {
        const controlSignal = await arenaAgentClient.checkControlSignal();
        if (controlSignal) {
          debugLogger.info(
            `Arena control signal received: ${controlSignal.type} - ${controlSignal.reason}`,
          );
          await arenaAgentClient.reportCancelled();
          this.cancelPendingMemoryPrefetch();
          if (isTopLevelInteraction) endInteractionSpan('cancelled');
          return new Turn(this.getChat(), prompt_id);
        }
      }

      if (
        !hasPendingToolCall &&
        (messageType === SendMessageType.UserQuery ||
          messageType === SendMessageType.Cron)
      ) {
        this.drainPendingAddedMcpToolsReminder();
        await this.drainSkillAndCommandReminders();
      }

      const turn = new Turn(this.getChat(), prompt_id);

      // Determine the model to use for this turn
      const model = options?.modelOverride ?? this.config.getModel();

      // Assemble the outgoing request. IDE context is merged into the
      // user prompt's first text part, then on UserQuery / Cron turns
      // the system reminders block is prepended in front of everything
      // so the final shape is: [systemReminders..., ideContext + user prompt].
      let requestToSend = await flatMapTextParts(request, async (text) => [
        text,
      ]);
      if (ideContextText) {
        requestToSend = prependToFirstTextPart(requestToSend, ideContextText);
      }
      if (
        messageType === SendMessageType.UserQuery ||
        messageType === SendMessageType.Cron
      ) {
        const systemReminders = [];

        // Inject fresh date on UserQuery turns only; Cron and ToolResult turns
        // reuse the same session and the startup-context date is still current.
        if (messageType === SendMessageType.UserQuery) {
          const today = formatDateForContext();

          // Only inject if the date has changed since the last injection.
          // This prevents accumulating conflicting dates when a session
          // spans midnight.
          if (today !== this.lastInjectedDate) {
            systemReminders.push(
              `<system-reminder>\nThe current date is: ${today}. Note: This is the authoritative current date — it may differ from the "Today's date" mentioned earlier in the conversation startup context.\n</system-reminder>`,
            );
            this.lastInjectedDate = today;
          }
        }

        // add plan mode system reminder if approval mode is plan
        if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
          systemReminders.push(
            getPlanModeSystemReminder(this.config.getSdkMode()),
          );
        }

        // add arena system reminder if an arena session is active
        const arenaManager = this.config.getArenaManager();
        if (arenaManager) {
          try {
            const sessionDir = arenaManager.getArenaSessionDir();
            const configPath = `${sessionDir}/config.json`;
            systemReminders.push(getArenaSystemReminder(configPath));
          } catch {
            // Arena config not yet initialized — skip
          }
        }

        // Zero-wait poll: consume only if the prefetch has already settled.
        // Done AFTER the async reminder setup above so recall settling during
        // those awaits still gets caught here. (settledAt is set in
        // promise.finally(); microtask ordering guarantees it's visible
        // after any await prior to this point — flatMapTextParts above is
        // the natural drain.) If still not settled, skip — the ToolResult
        // inject point will retry on the next turn.
        const userQueryMemory = await this.tryConsumeMemoryPrefetch();
        if (userQueryMemory?.prompt) {
          // Unshift to the front of systemReminders: on a UserQuery turn
          // requestToSend leads with user text, so positioning memory at
          // the very start of the system-reminder block keeps it close to
          // the user prompt. Contrast the ToolResult path below, which
          // must append to avoid splitting functionCall / functionResponse.
          systemReminders.unshift(userQueryMemory.prompt);
        }

        requestToSend = [...systemReminders, ...requestToSend];
      }

      if (messageType === SendMessageType.ToolResult) {
        const toolResultMemory = await this.tryConsumeMemoryPrefetch();
        if (toolResultMemory?.prompt) {
          // Append (not prepend): on a ToolResult turn, requestToSend leads
          // with functionResponse parts that must immediately follow the
          // model's functionCall (Qwen API constraint — same reason the
          // IDE-context block above is skipped while a tool call is pending,
          // see the `hasPendingToolCall` guard). Putting the memory text
          // after the functionResponse parts keeps the call/response pairing
          // intact under native Gemini; the OpenAI converter then emits the
          // text as a separate user message after the tool messages.
          requestToSend = [...requestToSend, toolResultMemory.prompt];
        }
        await this.microcompactHistoryBeforeSend(null, {
          sizeOnly: true,
          pendingContent: createUserContent(requestToSend),
        });
      }

      const activeGoalAtTurnStart = getActiveGoal(this.config.getSessionId());
      if (activeGoalAtTurnStart) {
        yield {
          type: GeminiEventType.ActiveGoal,
          value: activeGoalAtTurnStart,
        };
      }
      let lastEmittedActiveGoal: ActiveGoal | undefined = activeGoalAtTurnStart;
      // Tracks the last emitted goal value to suppress duplicate events.
      // Mutates `lastEmittedActiveGoal` when an event is returned.
      const maybeEmitActiveGoalChange = (
        nextActiveGoal: ActiveGoal | undefined,
      ): ServerGeminiStreamEvent | undefined => {
        if (activeGoalEquals(lastEmittedActiveGoal, nextActiveGoal)) {
          return undefined;
        }
        lastEmittedActiveGoal = nextActiveGoal;
        return {
          type: GeminiEventType.ActiveGoal,
          value: nextActiveGoal ?? null,
        };
      };

      const resultStream = turn.run(model, requestToSend, signal);
      let didUpdateIdeContextState = false;
      for await (const event of resultStream) {
        if (shouldUpdateIdeContextState && !didUpdateIdeContextState) {
          this.lastSentIdeContext = nextIdeContext;
          this.forceFullIdeContext = false;
          didUpdateIdeContextState = true;
        }

        // Loop detection is opt-in: `model.skipLoopDetection` defaults to true
        // (see settingsSchema) to avoid false-positive interruptions. Keep BOTH
        // the deterministic identical-tool-call check and the heuristic checks
        // behind this single flag so the documented `model.skipLoopDetection`
        // escape hatch stays honest (including the non-interactive hint in
        // nonInteractiveCli.ts). The deterministic split, retry-reset, and
        // pending-call splice below still apply once detection is enabled.
        const skipLoopDetection = this.config.getSkipLoopDetection();
        const deterministicToolCallLoop =
          !skipLoopDetection &&
          this.loopDetector.addAndCheckDeterministicToolCallLoop(event);
        const heuristicLoop =
          !deterministicToolCallLoop &&
          !skipLoopDetection &&
          this.loopDetector.addAndCheckHeuristicLoops(event);
        if (deterministicToolCallLoop || heuristicLoop) {
          const loopType = this.loopDetector.getLastLoopType();
          if (
            event.type === GeminiEventType.ToolCallRequest &&
            loopType === LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS
          ) {
            const repeatedCount =
              this.loopDetector.getConsecutiveToolCallCount();
            const repeatedStartIndex = Math.max(
              0,
              turn.pendingToolCalls.length - repeatedCount,
            );
            turn.pendingToolCalls.splice(repeatedStartIndex);
          }
          yield {
            type: GeminiEventType.LoopDetected,
            ...(loopType && { value: { loopType } }),
          };
          if (arenaAgentClient) {
            await arenaAgentClient.reportError('Loop detected');
          }
          this.lastApiCompletionTimestamp = Date.now();
          if (isTopLevelInteraction)
            endInteractionSpan('error', { errorMessage: 'loop detected' });
          // finally cleanup catches this, but cancel explicitly to match
          // the cleanup pattern at other early-return sites.
          this.cancelPendingMemoryPrefetch();
          return turn;
        }
        // Update arena status on Finished events — stats are derived
        // automatically from uiTelemetryService by the reporter.
        if (arenaAgentClient && event.type === GeminiEventType.Finished) {
          await arenaAgentClient.updateStatus();
        }

        // Re-send a full IDE context blob on the next regular message — auto
        // compaction inside chat.sendMessageStream may have summarized away
        // the previous merged IDE context.
        if (event.type === GeminiEventType.ChatCompressed) {
          this.forceFullIdeContext = true;
          // Auto-compaction summarized away the startup prelude. Rebuild it
          // before the next turn so env/tool/MCP context isn't lost for the
          // rest of the session (manual /compress gets this via startChat).
          try {
            await this.restoreStartupContextAfterCompaction();
          } catch (error) {
            this.config
              .getDebugLogger()
              .warn(
                `Failed to restore startup context after compaction: ${error}`,
              );
          }
          void this.fireSessionStartHook(SessionStartSource.Compact)
            .then((compactAdditionalContext) => {
              if (!compactAdditionalContext || !this.chat) {
                return;
              }
              this.lastSessionStartContext = compactAdditionalContext;
              this.lastSessionStartSource = SessionStartSource.Compact;
              this.chat.applySessionStartContext(
                compactAdditionalContext,
                SessionStartSource.Compact,
              );
            })
            .catch((error) => {
              this.config
                .getDebugLogger()
                .warn(`SessionStart hook failed: ${error}`);
            });
        }

        yield event;
        if (event.type === GeminiEventType.Error) {
          this.forceFullIdeContext = true;
          if (arenaAgentClient) {
            const errorMsg =
              event.value instanceof Error
                ? event.value.message
                : 'Unknown error';
            await arenaAgentClient.reportError(errorMsg);
          }
          this.lastApiCompletionTimestamp = Date.now();
          if (isTopLevelInteraction) {
            // Sanitize: do not pass raw API error messages to span status
            const errMsg =
              event.value instanceof Error ? '[API error]' : 'unknown error';
            endInteractionSpan('error', { errorMessage: errMsg });
          }
          // finally cleanup catches this, but cancel explicitly to match
          // the cleanup pattern at other early-return sites.
          this.cancelPendingMemoryPrefetch();
          return turn;
        }
      }

      // Track API completion time for thinking block idle cleanup
      this.lastApiCompletionTimestamp = Date.now();

      // Fire Stop hook through MessageBus (only if hooks are enabled and registered)
      // This must be done before any early returns to ensure hooks are always triggered
      if (
        hooksEnabled &&
        messageBus &&
        !turn.pendingToolCalls.length &&
        signal &&
        !signal.aborted &&
        this.config.hasHooksForEvent('Stop')
      ) {
        const responseText =
          this.getLastModelMessageText() || '[no response text]';

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
            signal,
          },
          MessageBusType.HOOK_EXECUTION_RESPONSE,
        );

        // Stop hook callbacks can mutate active goal state during request().
        // Capture it before cancellation returns so clear events are not lost.
        const activeGoalAfterStopHook = getActiveGoal(
          this.config.getSessionId(),
        );

        // Check if aborted after hook execution
        if (signal.aborted) {
          const activeGoalEvent = maybeEmitActiveGoalChange(
            activeGoalAfterStopHook,
          );
          if (activeGoalEvent) {
            yield activeGoalEvent;
          }
          if (isTopLevelInteraction) endInteractionSpan('cancelled');
          return turn;
        }

        const hookOutput = response.output
          ? createHookOutput('Stop', response.output)
          : undefined;

        const stopOutput = hookOutput as StopHookOutput | undefined;

        // This should happen regardless of the hook's decision
        if (stopOutput?.systemMessage) {
          yield {
            type: GeminiEventType.HookSystemMessage,
            value: stopOutput.systemMessage,
          };
        }

        // For Stop hooks, blocking/stop execution should force continuation
        if (
          stopOutput?.isBlockingDecision() ||
          stopOutput?.shouldStopExecution()
        ) {
          // Check if aborted before continuing
          if (signal.aborted) {
            const activeGoalEvent = maybeEmitActiveGoalChange(
              activeGoalAfterStopHook,
            );
            if (activeGoalEvent) {
              yield activeGoalEvent;
            }
            if (isTopLevelInteraction) endInteractionSpan('cancelled');
            return turn;
          }

          const continueReason = stopOutput.getEffectiveReason();

          // Track stop hook iterations
          const currentIterationCount =
            (options?.stopHookState?.iterationCount ?? 0) + 1;
          const currentReasons = [
            ...(options?.stopHookState?.reasons ?? []),
            continueReason,
          ];

          // Emit StopHookLoop starting with the first blocking decision so
          // /goal and configured Stop hooks both surface their reason before
          // the follow-up turn is generated. The cap check stays before the
          // yield because a cap of 1 means no follow-up turn should run.
          const stopHookBlockingCap = this.config.getStopHookBlockingCap();
          if (currentIterationCount >= stopHookBlockingCap) {
            const warning = formatStopHookBlockingCapWarning(
              'Stop',
              stopHookBlockingCap,
            );
            abortGoalForStopHookCap(
              this.config,
              this.config.getSessionId(),
              warning,
            );
            const activeGoalAfterCap = getActiveGoal(
              this.config.getSessionId(),
            );
            const activeGoalEvent =
              maybeEmitActiveGoalChange(activeGoalAfterCap);
            if (activeGoalEvent) {
              yield activeGoalEvent;
            }
            yield {
              type: GeminiEventType.HookSystemMessage,
              value: warning,
            };
            debugLogger.warn(warning);
            if (isTopLevelInteraction) endInteractionSpan('ok');
            return turn;
          }

          const activeGoalEvent = maybeEmitActiveGoalChange(
            activeGoalAfterStopHook,
          );
          if (activeGoalEvent) {
            yield activeGoalEvent;
          }

          yield {
            type: GeminiEventType.StopHookLoop,
            value: {
              iterationCount: currentIterationCount,
              reasons: currentReasons,
              stopHookCount: response.stopHookCount ?? 1,
            },
          };

          const continueRequest = [{ text: continueReason }];
          const activeGoal = getActiveGoal(this.config.getSessionId());
          const hookTurnBudget = activeGoal ? boundedTurns : boundedTurns - 1;
          const hookTurn = yield* this.sendMessageStream(
            continueRequest,
            signal,
            prompt_id,
            {
              type: SendMessageType.Hook,
              modelOverride: options?.modelOverride,
              stopHookState: {
                iterationCount: currentIterationCount,
                reasons: currentReasons,
              },
            },
            hookTurnBudget,
          );
          if (isTopLevelInteraction)
            endInteractionSpan(signal.aborted ? 'cancelled' : 'ok');
          // Preserve the pending prefetch: the inner Hook turn we just
          // yielded may have produced tool calls, and the caller's next
          // ToolResult turn still needs to consume the recall result.
          normalCompletion = true;
          return hookTurn;
        }

        const activeGoalEvent = maybeEmitActiveGoalChange(
          activeGoalAfterStopHook,
        );
        if (activeGoalEvent) {
          yield activeGoalEvent;
        }
      }

      if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
        // Save cache-safe params here — before any early return — so that
        // background extract/dream agents calling getCacheSafeParams() always
        // see the current turn's history regardless of which path exits below.
        try {
          const chat = this.getChat();
          const maxHistoryForCache = 40;
          const cachedHistory = this.getHistoryTailShallow(
            maxHistoryForCache,
            true,
          );
          saveCacheSafeParams(
            chat.getGenerationConfig(),
            cachedHistory,
            this.config.getModel(),
          );
        } catch {
          // Best-effort — don't block the main flow
        }

        if (this.config.getSkipNextSpeakerCheck()) {
          this.runManagedAutoMemoryBackgroundTasks(messageType);
          if (arenaAgentClient) {
            await arenaAgentClient.reportCompleted();
          }
          if (isTopLevelInteraction) endInteractionSpan('ok');
          return turn;
        }

        const nextSpeakerCheck = await checkNextSpeaker(
          this.getChat(),
          this.config,
          signal,
          prompt_id,
        );
        logNextSpeakerCheck(
          this.config,
          new NextSpeakerCheckEvent(
            prompt_id,
            turn.finishReason?.toString() || '',
            nextSpeakerCheck?.next_speaker || '',
          ),
        );
        if (nextSpeakerCheck?.next_speaker === 'model') {
          const nextRequest = [{ text: 'Please continue.' }];
          const continueTurn = yield* this.sendMessageStream(
            nextRequest,
            signal,
            prompt_id,
            { ...options, type: SendMessageType.Hook },
            boundedTurns - 1,
          );
          if (isTopLevelInteraction)
            endInteractionSpan(signal.aborted ? 'cancelled' : 'ok');
          // Preserve the pending prefetch: same reasoning as the
          // `return hookTurn` site above — the recursive Hook turn may
          // have produced tool calls whose ToolResult turn still needs
          // the recall result.
          normalCompletion = true;
          return continueTurn;
        }

        this.runManagedAutoMemoryBackgroundTasks(messageType);

        if (arenaAgentClient) {
          // No continuation needed — agent completed its task
          await arenaAgentClient.reportCompleted();
        }
      }

      // Report cancelled to arena when user cancelled mid-stream
      if (signal?.aborted && arenaAgentClient) {
        await arenaAgentClient.reportCancelled();
      }

      if (isTopLevelInteraction) {
        endInteractionSpan(signal?.aborted ? 'cancelled' : 'ok');
      }
      // Reached the bottom of the try — this turn ended cleanly. Preserve
      // any still-pending memory prefetch so the next ToolResult turn can
      // consume it (the whole point of the fire-and-forget design).
      normalCompletion = true;
      return turn;
    } finally {
      // Belt-and-suspenders: abort the prefetch on any exit other than the
      // bottom-of-try `return turn`. Catches uncaught exceptions and guards
      // against future early-return sites that forget to call cancel.
      if (!normalCompletion) {
        this.cancelPendingMemoryPrefetch();
      }
      if (isTopLevelInteraction) {
        endInteractionSpan(signal?.aborted ? 'cancelled' : 'error', {
          errorMessage: 'unexpected exit',
        });
      }
    }
  }

  async generateContent(
    contents: Content[],
    generationConfig: GenerateContentConfig,
    abortSignal: AbortSignal,
    model: string,
    promptIdOverride?: string,
  ): Promise<GenerateContentResponse> {
    const promptId =
      promptIdOverride ?? promptIdContext.getStore() ?? this.lastPromptId!;

    let currentAttemptModel: string = model;

    try {
      const userMemory = this.config.getUserMemory();
      const finalSystemInstruction = generationConfig.systemInstruction
        ? getCustomSystemPrompt(generationConfig.systemInstruction, userMemory)
        : this.getMainSessionSystemInstruction();

      const requestConfig: GenerateContentConfig = {
        abortSignal,
        ...generationConfig,
        systemInstruction: finalSystemInstruction,
      };

      // When the requested model differs from the main model (e.g. fast model
      // side queries for session recap / title / summary), resolve the target
      // model's own ContentGeneratorConfig so that per-model settings like
      // extra_body, samplingParams, and reasoning are not inherited from the
      // main model's config. The retry authType is resolved alongside so that
      // provider-specific checks (e.g. QWEN_OAUTH quota detection) reference
      // the target model's provider.
      const {
        contentGenerator,
        retryAuthType,
        retryErrorCodes,
        model: requestModel,
      } = await this.config.getBaseLlmClient().resolveForModel(model);

      const apiCall = () => {
        currentAttemptModel = requestModel;

        return contentGenerator.generateContent(
          {
            model: requestModel,
            config: requestConfig,
            contents,
          },
          promptId,
        );
      };
      const result = await retryWithBackoff(apiCall, {
        authType: retryAuthType,
        extraRetryErrorCodes: retryErrorCodes,
        persistentMode: isUnattendedMode(),
        signal: abortSignal,
        heartbeatFn: (info) => {
          process.stderr.write(
            `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
          );
        },
        // Phase 4b — emit ApiRetryEvent telemetry for HTTP-status retries.
        // subagent_name read from subagentNameContext (active in catch block
        // since the entire generateContent invocation runs inside the parent
        // subagent's ALS frame when applicable).
        onRetry: (info) => {
          logApiRetry(
            this.config,
            new ApiRetryEvent({
              model: currentAttemptModel,
              promptId,
              attemptNumber: info.attempt,
              error: info.error,
              statusCode: info.errorStatus,
              retryDelayMs: info.delayMs,
              subagentName: subagentNameContext.getStore(),
            }),
          );
        },
      });
      return result;
    } catch (error: unknown) {
      if (abortSignal.aborted) {
        throw error;
      }
      await reportError(
        error,
        `Error generating content via API with model ${currentAttemptModel}.`,
        {
          requestContents: contents,
          requestConfig: generationConfig,
        },
        'generateContent-api',
      );
      throw new Error(
        `Failed to generate content with model ${currentAttemptModel}: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Wrapper around {@link GeminiChat.tryCompress} that restores main-session
   * startup context after successful compaction and flips the IDE full-context
   * flag for the next regular message.
   */
  async tryCompressChat(
    prompt_id: string,
    force: boolean = false,
    signal?: AbortSignal,
    customInstructions?: string,
  ): Promise<ChatCompressionInfo> {
    const previousSessionStartContext = this.lastSessionStartContext;
    const previousSessionStartSource = this.lastSessionStartSource;
    const info = await this.getChat().tryCompress(
      prompt_id,
      this.config.getModel(),
      force,
      signal,
      customInstructions ? { customInstructions } : undefined,
    );
    if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      const chat = this.getChat();
      const compressedHistory = chat.getHistoryShallow?.() ?? chat.getHistory();
      await this.startChat(compressedHistory, SessionStartSource.Compact);
      if (
        !this.lastSessionStartContext &&
        previousSessionStartContext &&
        previousSessionStartSource
      ) {
        this.lastSessionStartContext = previousSessionStartContext;
        this.lastSessionStartSource = previousSessionStartSource;
        this.getChat().applySessionStartContext(
          previousSessionStartContext,
          previousSessionStartSource,
        );
      }
      // startChat() creates a new GeminiChat without touching FileReadCache,
      // so prior read_file results that were summarised away would still
      // resolve to the file_unchanged placeholder. Clear so post-compaction
      // Reads re-emit bytes the model can no longer see in history.
      debugLogger.debug('[FILE_READ_CACHE] clear after tryCompressChat');
      this.config.getFileReadCache().clear();
      this.getChat().setLastPromptTokenCount(info.newTokenCount);
      // Re-send a full IDE context blob on the next regular message
      // compression may have summarized away the merged IDE context
      // that lived inside the previous user prompt.
      this.forceFullIdeContext = true;
    }
    return info;
  }

  /**
   * Surgically disarm FileReadCache entries for files evicted by
   * microcompaction. Falls back to a blanket clear() when any evicted
   * path can't be resolved.
   *
   * Shared by pre-send microcompaction and /compress-fast.
   */
  private async disarmFileReadCacheAfterEviction(
    meta: MicrocompactMeta,
    logTag: string,
  ): Promise<void> {
    const fileReadCache = this.config.getFileReadCache();
    if (meta.unresolvedEvictedReads > 0) {
      debugLogger.debug(
        `[FILE_READ_CACHE] clear after ${logTag} ` +
          `(${meta.unresolvedEvictedReads} unresolved blanked read(s))`,
      );
      fileReadCache.clear();
      return;
    }
    if (meta.evictedReadPaths.length === 0) {
      return;
    }
    const statResults = await Promise.all(
      meta.evictedReadPaths.map((p) =>
        fsPromises.stat(p).catch(() => undefined),
      ),
    );
    let fullyDisarmed = true;
    for (const stats of statResults) {
      if (!stats || !fileReadCache.markReadEvictedFromHistory(stats)) {
        fullyDisarmed = false;
      }
    }
    if (fullyDisarmed) {
      debugLogger.debug(
        `[FILE_READ_CACHE] disarmed fast-path for ` +
          `${meta.evictedReadPaths.length} file(s) after ${logTag}`,
      );
    } else {
      debugLogger.debug(
        `[FILE_READ_CACHE] clear after ${logTag} ` +
          '(an evicted path was unresolvable)',
      );
      fileReadCache.clear();
    }
  }

  /**
   * Fast, rule-based compression without any LLM side-query.
   * Delegates to {@link GeminiChat.compressFast} and handles post-compression
   * FileReadCache disarming.
   */
  async tryCompressChatFast(): Promise<ChatCompressionInfo> {
    const { info, microcompactMeta } = this.getChat().compressFast();

    if (info.compressionStatus !== CompressionStatus.COMPRESSED) {
      return info;
    }

    if (microcompactMeta) {
      await this.disarmFileReadCacheAfterEviction(
        microcompactMeta,
        'compress-fast',
      );
    }
    this.forceFullIdeContext = true;

    return info;
  }
}
