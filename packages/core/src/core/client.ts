/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// External dependencies
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
  PartListUnion,
  Tool,
} from '@google/genai';
import { SpanStatusCode } from '@opentelemetry/api';

// Config
import { ApprovalMode, type Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import { microcompactHistory } from '../services/microcompaction/microcompact.js';

const debugLogger = createDebugLogger('CLIENT');

// Core modules
import { GeminiChat } from './geminiChat.js';
import {
  getArenaSystemReminder,
  getCoreSystemPrompt,
  getCustomSystemPrompt,
  getPlanModeSystemReminder,
  getSubagentSystemReminder,
} from './prompts.js';
import {
  CompressionStatus,
  GeminiEventType,
  Turn,
  type ChatCompressionInfo,
  type ServerGeminiStreamEvent,
} from './turn.js';

// Services
import {
  COMPRESSION_PRESERVE_THRESHOLD,
  COMPRESSION_TOKEN_THRESHOLD,
} from '../services/chatCompressionService.js';
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
} from '../telemetry/index.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

// Forked agent cache
import {
  saveCacheSafeParams,
  clearCacheSafeParams,
} from '../utils/forkedAgent.js';

// Utilities
import {
  getDirectoryContextString,
  getInitialChatHistory,
} from '../utils/environmentContext.js';
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
import { escapeSystemReminderTags } from '../utils/xml.js';

// Hook types and utilities
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import { partToString } from '../utils/partUtils.js';
import { createHookOutput, SessionStartSource } from '../hooks/types.js';

// IDE integration
import { ideContextStore } from '../ide/ideContext.js';
import { type File, type IdeContext } from '../ide/types.js';
import { PermissionMode, type StopHookOutput } from '../hooks/types.js';
import {
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
  API_CALL_FAILED_SPAN_STATUS_MESSAGE,
  safeSetStatus,
  withSpan,
} from '../telemetry/tracer.js';

const MAX_TURNS = 100;

export enum SendMessageType {
  UserQuery = 'userQuery',
  ToolResult = 'toolResult',
  Retry = 'retry',
  Hook = 'hook',
  /** Cron-fired prompt. Behaves like UserQuery but skips UserPromptSubmit hook. */
  Cron = 'cron',
  /** Background agent notification. Display item is added by the drain loop. */
  Notification = 'notification',
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
 * Resolve the auto-memory recall promise with a hard deadline.
 * If the recall (model-driven selection + heuristic fallback) does not complete
 * within the deadline, return an empty result so the main request is not delayed.
 *
 * The deadline is set slightly above the model-driven selector's own
 * AbortSignal.timeout (2s) to give the heuristic fallback time to complete,
 * but low enough that the user does not perceive a delay on every turn.
 */
async function resolveAutoMemoryWithDeadline(
  promise: Promise<RelevantAutoMemoryPromptResult> | undefined,
  onDeadline: () => void,
): Promise<RelevantAutoMemoryPromptResult> {
  if (!promise) {
    return EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RelevantAutoMemoryPromptResult>((resolve) => {
    timer = setTimeout(() => {
      try {
        onDeadline();
      } finally {
        resolve(EMPTY_RELEVANT_AUTO_MEMORY_RESULT);
      }
    }, 2_500);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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
  private readonly surfacedRelevantAutoMemoryPaths = new Set<string>();

  private readonly loopDetector: LoopDetectionService;
  private lastPromptId: string | undefined = undefined;
  private lastSentIdeContext: IdeContext | undefined;
  private forceFullIdeContext = true;
  private pendingRecallAbortController: AbortController | undefined;
  private lastSessionStartContext: string | undefined;
  private lastSessionStartSource: SessionStartSource | undefined;

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
      replayUiTelemetryFromConversation(resumedSessionData.conversation);
      // Convert resumed session to API history format
      // Each ChatRecord's message field is already a Content object
      const resumedHistory = buildApiHistoryFromConversation(
        resumedSessionData.conversation,
      );
      await this.startChat(
        resumedHistory,
        sessionStartSource ?? SessionStartSource.Resume,
      );
      this.getChat().setLastPromptTokenCount(
        uiTelemetryService.getLastPromptTokenCount(),
      );

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
    const deferredTools = this.resolveDeferredToolsForSystemPrompt();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    this.getChat().setTools(tools);
    // Rebuild the system instruction so its "Deferred Tools" section
    // matches the registry's current state. Without this refresh, MCP
    // tools that land in the registry after startChat() (progressive
    // discovery — see Config.startMcpDiscoveryInBackground) stay invisible
    // to the model: they're filtered out of `toolDeclarations` by
    // `shouldDefer`, and the prompt's deferred listing was frozen at the
    // built-in-only snapshot taken inside startChat(). The model then has
    // no signal that an MCP tool exists and never invokes ToolSearch to
    // reveal it — silently regressing non-interactive `--prompt` runs.
    this.getChat().setSystemInstruction(
      this.getMainSessionSystemInstruction(deferredTools),
    );
    // setSystemInstruction overwrites the chat's systemInstruction wholesale,
    // dropping any SessionStart additionalContext that startChat() (or a
    // prior Compact) appended via applySessionStartContext. Re-apply it so
    // a SessionStart hook's context survives the progressive-MCP refresh.
    if (this.lastSessionStartContext && this.lastSessionStartSource) {
      this.getChat().applySessionStartContext(
        this.lastSessionStartContext,
        this.lastSessionStartSource,
      );
    }
    recordStartupEvent('gemini_tools_updated', {
      toolCount: toolDeclarations.length,
      deferredCount: deferredTools?.length ?? 0,
    });
  }

  async resetChat(): Promise<void> {
    this.initializedSessionId = undefined;
    this.surfacedRelevantAutoMemoryPaths.clear();
    this.lastApiCompletionTimestamp = null;
    // startChat() rewrites the chat to its initial state. Any prior
    // read_file tool results the FileReadCache still tracks are no
    // longer in history, so a follow-up Read would serve a placeholder
    // pointing at content the model can no longer retrieve.
    debugLogger.debug('[FILE_READ_CACHE] clear after resetChat');
    this.config.getFileReadCache().clear();
    this.config.getBaseLlmClient().clearPerModelGeneratorCache();
    // Abort any in-flight auto-memory recall so the stale controller
    // does not leak into the next session.
    if (this.pendingRecallAbortController) {
      this.pendingRecallAbortController.abort();
      this.pendingRecallAbortController = undefined;
    }
    // Drop any deferred tools revealed this session so /clear really gives
    // a clean slate. We don't clear inside startChat itself because that path
    // is also taken by compression (which preserves the session), and
    // compression should keep previously-revealed tools so the model can
    // continue using them without re-running ToolSearch.
    this.config.getToolRegistry().clearRevealedDeferredTools();
    await this.startChat(undefined, SessionStartSource.Clear);
    this.initializedSessionId = this.config.getSessionId();
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

  private getMainSessionSystemInstruction(
    deferredTools?: Array<{ name: string; description: string }>,
  ): string {
    const userMemory = this.config.getUserMemory();
    const overrideSystemPrompt = this.config.getSystemPrompt();
    const appendSystemPrompt = this.config.getAppendSystemPrompt();

    if (overrideSystemPrompt) {
      return getCustomSystemPrompt(
        overrideSystemPrompt,
        userMemory,
        appendSystemPrompt,
        deferredTools,
      );
    }

    return getCoreSystemPrompt(
      userMemory,
      this.config.getModel(),
      appendSystemPrompt,
      deferredTools,
    );
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
    const deferredTools = this.resolveDeferredToolsForSystemPrompt();
    this.chat.setSystemInstruction(
      this.getMainSessionSystemInstruction(deferredTools),
    );
    if (this.lastSessionStartContext && this.lastSessionStartSource) {
      this.chat.applySessionStartContext(
        this.lastSessionStartContext,
        this.lastSessionStartSource,
      );
    }
  }

  /**
   * Computes the deferred-tools list passed to the system prompt. Shared by
   * {@link startChat}, {@link setTools}, and {@link refreshSystemInstruction}
   * so all three render the same "Deferred Tools" section for a given
   * registry state.
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
   * Returns `undefined` when ToolSearch is unavailable: the prompt's
   * deferred-tools section must not advertise tools the model has no way to
   * load on demand.
   */
  private resolveDeferredToolsForSystemPrompt():
    | Array<{ name: string; description: string }>
    | undefined {
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

  private toPermissionMode(approvalMode: ApprovalMode): PermissionMode {
    switch (approvalMode) {
      case ApprovalMode.DEFAULT:
        return PermissionMode.Default;
      case ApprovalMode.PLAN:
        return PermissionMode.Plan;
      case ApprovalMode.AUTO_EDIT:
        return PermissionMode.AutoEdit;
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
    // Clear stale cache params on session reset to prevent cross-session leakage
    clearCacheSafeParams();

    const history = await getInitialChatHistory(this.config, extraHistory);

    try {
      // Warm the tool registry before building the system prompt so we know
      // which tools are marked `shouldDefer`. The deferred list is appended to
      // the prompt so the model knows which tools are reachable via
      // ToolSearch. warmAll() is idempotent — setTools() below reuses the
      // warmed state. Revealed-deferred state is NOT cleared here because
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
      // BEFORE `resolveDeferredToolsForSystemPrompt()` runs so the resumed
      // tools are correctly filtered out of the deferred-summary list.
      if (history.length > 0) {
        const deferredNames = new Set(
          toolRegistry.getDeferredToolSummary().map((t) => t.name),
        );
        if (deferredNames.size > 0) {
          for (const entry of history) {
            for (const part of entry.parts ?? []) {
              const callName = part.functionCall?.name;
              if (callName && deferredNames.has(callName)) {
                toolRegistry.revealDeferredTool(callName);
              }
            }
          }
        }
      }
      const deferredTools = this.resolveDeferredToolsForSystemPrompt();
      const systemInstruction =
        this.getMainSessionSystemInstruction(deferredTools);

      this.chat = new GeminiChat(
        this.config,
        {
          systemInstruction,
        },
        history,
        this.config.getChatRecordingService(),
        uiTelemetryService,
      );

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
      const history = this.getHistory();
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
    const history = this.getHistory();
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

  async *sendMessageStream(
    request: PartListUnion,
    signal: AbortSignal,
    prompt_id: string,
    options?: SendMessageOptions,
    turns: number = MAX_TURNS,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    const messageType = options?.type ?? SendMessageType.UserQuery;
    let relevantAutoMemoryPromise:
      | Promise<RelevantAutoMemoryPromptResult>
      | undefined;

    if (messageType === SendMessageType.Retry) {
      this.stripOrphanedUserEntriesFromHistory();
    }

    // Fire UserPromptSubmit hook through MessageBus (only if hooks are enabled)
    const hooksEnabled = !this.config.getDisableAllHooks();
    const messageBus = this.config.getMessageBus();
    if (
      messageType !== SendMessageType.Retry &&
      messageType !== SendMessageType.Cron &&
      messageType !== SendMessageType.Notification &&
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

    if (messageType === SendMessageType.Notification) {
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
      messageType === SendMessageType.Notification;
    if (isTopLevelInteraction) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;
      startInteractionSpan(this.config, {
        promptId: prompt_id,
        model: options?.modelOverride ?? this.config.getModel(),
        messageType,
      });
    }

    try {
      if (
        messageType === SendMessageType.UserQuery ||
        messageType === SendMessageType.Cron
      ) {
        if (this.config.getManagedAutoMemoryEnabled()) {
          const recallAbortController = new AbortController();
          const rawRecallPromise = this.config
            .getMemoryManager()
            .recall(this.config.getProjectRoot(), partToString(request), {
              config: this.config,
              excludedFilePaths: this.surfacedRelevantAutoMemoryPaths,
              abortSignal: recallAbortController.signal,
            })
            .catch((error: unknown) => {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                debugLogger.debug(
                  'Auto-memory recall aborted by deadline.',
                  error,
                );
              } else {
                debugLogger.warn(
                  'Managed auto-memory recall prefetch failed.',
                  error,
                );
              }
              return EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
            });
          this.pendingRecallAbortController = recallAbortController;
          // Race the recall against the deadline at initiation time so the 2.5s
          // budget is not consumed by intermediate work (microcompact, compression,
          // token checks, IDE context) between initiation and consumption.
          relevantAutoMemoryPromise = resolveAutoMemoryWithDeadline(
            rawRecallPromise,
            () => recallAbortController.abort(),
          );
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

        // Idle cleanup: clear old tool results when idle > threshold.
        // Runs on user and cron messages (not tool result submissions or
        // retries/hooks) so that model latency during a tool-call loop
        // doesn't count as user idle time.
        const mcResult = microcompactHistory(
          this.getChat().getHistory(),
          this.lastApiCompletionTimestamp,
          this.config.getClearContextOnIdle(),
        );
        if (mcResult.meta) {
          this.getChat().setHistory(mcResult.history);
          // Microcompaction replaces old compactable tool outputs
          // (including read_file) with a placeholder, but the
          // FileReadCache still records the prior full Reads as "seen in
          // this conversation". A follow-up Read of an unchanged file
          // would then return the file_unchanged placeholder pointing at
          // bytes the model can no longer retrieve from history. Drop the
          // cache so post-microcompaction Reads re-emit the bytes,
          // mirroring the post-compaction clear in tryCompressChat.
          debugLogger.debug('[FILE_READ_CACHE] clear after microcompaction');
          this.config.getFileReadCache().clear();
          const m = mcResult.meta;
          debugLogger.debug(
            `[TIME-BASED MC] gap ${m.gapMinutes}min > ${m.thresholdMinutes}min, ` +
              `cleared ${m.toolsCleared} tool result(s) + ${m.mediaCleared} media (~${m.tokensSaved} tokens), ` +
              `kept ${m.toolsKept} tool / ${m.mediaKept} media`,
          );
        }
      }

      if (messageType !== SendMessageType.Retry) {
        // Snapshot on every non-retry turn. ToolResult turns run right after
        // tool execution, so their snapshot captures edits that a prior
        // UserQuery turn scheduled. Without this, a resumed session only sees
        // the UserQuery-time snapshot (empty) and loses tool-driven edits.
        this.config
          .getChatRecordingService()
          ?.recordAttributionSnapshot(
            CommitAttributionService.getInstance().toSnapshot(),
          );

        this.sessionTurnCount++;

        if (
          this.config.getMaxSessionTurns() > 0 &&
          this.sessionTurnCount > this.config.getMaxSessionTurns()
        ) {
          this.pendingRecallAbortController?.abort();
          this.pendingRecallAbortController = undefined;
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
        this.pendingRecallAbortController?.abort();
        this.pendingRecallAbortController = undefined;
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
          this.pendingRecallAbortController?.abort();
          this.pendingRecallAbortController = undefined;
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
      // in the conversation history . The IDE context is not discarded; it will
      // be included in the next regular message sent to the model.
      const history = this.getHistory();
      const lastMessage =
        history.length > 0 ? history[history.length - 1] : undefined;
      const hasPendingToolCall =
        !!lastMessage &&
        lastMessage.role === 'model' &&
        (lastMessage.parts?.some((p) => 'functionCall' in p) || false);
      let ideContextText: string | undefined;
      let nextIdeContext: IdeContext | undefined;
      let shouldUpdateIdeContextState = false;

      if (this.config.getIdeMode() && !hasPendingToolCall) {
        const { contextParts, newIdeContext } = this.getIdeContextParts(
          this.forceFullIdeContext || history.length === 0,
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
          this.pendingRecallAbortController?.abort();
          this.pendingRecallAbortController = undefined;
          if (isTopLevelInteraction) endInteractionSpan('cancelled');
          return new Turn(this.getChat(), prompt_id);
        }
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
        // The recall promise was already raced against the 2.5s deadline at
        // initiation time; this await just collects the result.
        this.pendingRecallAbortController = undefined;
        const relevantAutoMemory = relevantAutoMemoryPromise
          ? await relevantAutoMemoryPromise
          : EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
        const relevantAutoMemoryPrompt = relevantAutoMemory.prompt;

        if (relevantAutoMemoryPrompt) {
          systemReminders.push(relevantAutoMemoryPrompt);
          for (const doc of relevantAutoMemory.selectedDocs) {
            this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
          }
        }

        // add subagent system reminder if there are subagents
        const hasAgentTool = await this.config
          .getToolRegistry()
          .ensureTool(ToolNames.AGENT);
        const subagents = (
          await this.config.getSubagentManager().listSubagents()
        )
          .filter((subagent) => subagent.level !== 'builtin')
          .map((subagent) => subagent.name);

        if (hasAgentTool && subagents.length > 0) {
          systemReminders.push(getSubagentSystemReminder(subagents));
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

        requestToSend = [...systemReminders, ...requestToSend];
      }

      const resultStream = turn.run(model, requestToSend, signal);
      let didUpdateIdeContextState = false;
      for await (const event of resultStream) {
        if (shouldUpdateIdeContextState && !didUpdateIdeContextState) {
          this.lastSentIdeContext = nextIdeContext;
          this.forceFullIdeContext = false;
          didUpdateIdeContextState = true;
        }

        if (!this.config.getSkipLoopDetection()) {
          if (this.loopDetector.addAndCheck(event)) {
            const loopType = this.loopDetector.getLastLoopType();
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
            return turn;
          }
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
        // Get response text from the chat history
        const history = this.getHistory();
        const lastModelMessage = history
          .filter((msg) => msg.role === 'model')
          .pop();
        const responseText =
          lastModelMessage?.parts
            ?.filter((p): p is { text: string } => 'text' in p)
            .map((p) => p.text)
            .join('') || '[no response text]';

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

        // Check if aborted after hook execution
        if (signal.aborted) {
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

          // Emit StopHookLoop event for iterations after the first one.
          // The first iteration (currentIterationCount === 1) is the initial request,
          // so there's no prior stop hook execution to report. We only emit this event
          // when stop hooks have been executed multiple times (loop detected).
          if (currentIterationCount > 1) {
            yield {
              type: GeminiEventType.StopHookLoop,
              value: {
                iterationCount: currentIterationCount,
                reasons: currentReasons,
                stopHookCount: response.stopHookCount ?? 1,
              },
            };
          }

          const continueRequest = [{ text: continueReason }];
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
            boundedTurns - 1,
          );
          if (isTopLevelInteraction)
            endInteractionSpan(signal.aborted ? 'cancelled' : 'ok');
          return hookTurn;
        }
      }

      if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
        // Save cache-safe params here — before any early return — so that
        // background extract/dream agents calling getCacheSafeParams() always
        // see the current turn's history regardless of which path exits below.
        try {
          const chat = this.getChat();
          const fullHistory = chat.getHistory(true);
          const maxHistoryForCache = 40;
          const cachedHistory =
            fullHistory.length > maxHistoryForCache
              ? fullHistory.slice(-maxHistoryForCache)
              : fullHistory;
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
      return turn;
    } finally {
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

    return withSpan(
      'client.generateContent',
      { model, prompt_id: promptId },
      async (span) => {
        let currentAttemptModel: string = model;

        try {
          const userMemory = this.config.getUserMemory();
          const finalSystemInstruction = generationConfig.systemInstruction
            ? getCustomSystemPrompt(
                generationConfig.systemInstruction,
                userMemory,
              )
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
            persistentMode: isUnattendedMode(),
            signal: abortSignal,
            heartbeatFn: (info) => {
              process.stderr.write(
                `[qwen-code] Waiting for API capacity... attempt ${info.attempt}, retry in ${Math.ceil(info.remainingMs / 1000)}s\n`,
              );
            },
          });
          return result;
        } catch (error: unknown) {
          if (abortSignal.aborted) {
            safeSetStatus(span, {
              code: SpanStatusCode.ERROR,
              message: API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
            });
            throw error;
          }

          safeSetStatus(span, {
            code: SpanStatusCode.ERROR,
            message: API_CALL_FAILED_SPAN_STATUS_MESSAGE,
          });
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
      },
    );
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
  ): Promise<ChatCompressionInfo> {
    const previousSessionStartContext = this.lastSessionStartContext;
    const previousSessionStartSource = this.lastSessionStartSource;
    const info = await this.getChat().tryCompress(
      prompt_id,
      this.config.getModel(),
      force,
      signal,
    );
    if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      const compressedHistory = this.getChat().getHistory();
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
      // Re-send a full IDE context blob on the next regular message —
      // compression may have summarized away the merged IDE context
      // that lived inside the previous user prompt.
      this.forceFullIdeContext = true;
    }
    return info;
  }
}

export const TEST_ONLY = {
  COMPRESSION_PRESERVE_THRESHOLD,
  COMPRESSION_TOKEN_THRESHOLD,
};
