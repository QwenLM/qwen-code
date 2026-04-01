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

// Config
import { ApprovalMode, type Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CLIENT');

// Core modules
import type { ContentGenerator } from './contentGenerator.js';
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
  ChatCompressionService,
  COMPRESSION_PRESERVE_THRESHOLD,
  COMPRESSION_TOKEN_THRESHOLD,
} from '../services/chatCompressionService.js';
import { LoopDetectionService } from '../services/loopDetectionService.js';

// Tools
import { AgentTool } from '../tools/agent.js';

// Telemetry
import {
  NextSpeakerCheckEvent,
  logNextSpeakerCheck,
} from '../telemetry/index.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { startTurnSpan, endTurnSpan } from '../telemetry/turnSpanContext.js';

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
import { flatMapTextParts } from '../utils/partUtils.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { retryWithBackoff } from '../utils/retry.js';

// Hook types and utilities
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import { partToString } from '../utils/partUtils.js';
import { createHookOutput } from '../hooks/types.js';

// IDE integration
import { ideContextStore } from '../ide/ideContext.js';
import { type File, type IdeContext } from '../ide/types.js';
import type { StopHookOutput } from '../hooks/types.js';
import {
  CompletionChecker,
  type ToolCallRecord,
} from '../hooks/completion-checker.js';
import { BuiltinAgentRegistry } from '../subagents/builtin-agents.js';
import { ContextState } from '../agents/runtime/agent-headless.js';

const MAX_TURNS = 100;

export enum SendMessageType {
  UserQuery = 'userQuery',
  ToolResult = 'toolResult',
  Retry = 'retry',
  Hook = 'hook',
  /** Cron-fired prompt. Behaves like UserQuery but skips UserPromptSubmit hook. */
  Cron = 'cron',
}

export interface SendMessageOptions {
  type: SendMessageType;
}

export class GeminiClient {
  private chat?: GeminiChat;
  private sessionTurnCount = 0;

  private readonly loopDetector: LoopDetectionService;
  private lastPromptId: string | undefined = undefined;
  private lastSentIdeContext: IdeContext | undefined;
  private forceFullIdeContext = true;

  /**
   * At any point in this conversation, was compression triggered without
   * being forced and did it fail?
   */
  private hasFailedCompressionAttempt = false;

  /**
   * Tracks how many times the verification agent has been invoked
   * during this session to prevent infinite verification loops.
   */
  private verificationAttempts = 0;
  private static readonly MAX_VERIFICATION_ATTEMPTS = 3;

  constructor(private readonly config: Config) {
    this.loopDetector = new LoopDetectionService(config);
  }

  async initialize() {
    this.lastPromptId = this.config.getSessionId();

    // Check if we're resuming from a previous session
    const resumedSessionData = this.config.getResumedSessionData();
    if (resumedSessionData) {
      replayUiTelemetryFromConversation(resumedSessionData.conversation);
      // Convert resumed session to API history format
      // Each ChatRecord's message field is already a Content object
      const resumedHistory = buildApiHistoryFromConversation(
        resumedSessionData.conversation,
      );
      await this.startChat(resumedHistory);
    } else {
      await this.startChat();
    }
  }

  private getContentGeneratorOrFail(): ContentGenerator {
    if (!this.config.getContentGenerator()) {
      throw new Error('Content generator not initialized');
    }
    return this.config.getContentGenerator();
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

  getHistory(): Content[] {
    return this.getChat().getHistory();
  }

  stripThoughtsFromHistory() {
    this.getChat().stripThoughtsFromHistory();
  }

  private stripOrphanedUserEntriesFromHistory() {
    this.getChat().stripOrphanedUserEntriesFromHistory();
  }

  setHistory(history: Content[]) {
    this.getChat().setHistory(history);
    this.forceFullIdeContext = true;
  }

  setTools(): void {
    if (!this.isInitialized()) {
      return;
    }

    const toolRegistry = this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    this.getChat().setTools(tools);
  }

  async resetChat(): Promise<void> {
    await this.startChat();
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

  private getMainSessionSystemInstruction(): string {
    const userMemory = this.config.getUserMemory();
    const overrideSystemPrompt = this.config.getSystemPrompt();
    const appendSystemPrompt = this.config.getAppendSystemPrompt();

    if (overrideSystemPrompt) {
      return getCustomSystemPrompt(
        overrideSystemPrompt,
        userMemory,
        appendSystemPrompt,
      );
    }

    return getCoreSystemPrompt(
      userMemory,
      this.config.getModel(),
      appendSystemPrompt,
    ).full;
  }

  async startChat(extraHistory?: Content[]): Promise<GeminiChat> {
    this.forceFullIdeContext = true;
    this.hasFailedCompressionAttempt = false;

    const history = await getInitialChatHistory(this.config, extraHistory);

    try {
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

      this.setTools();

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
        "Here is the user's editor context. This is for your information only.",
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
        "Here is a summary of changes in the user's editor context. This is for your information only.",
        changeLines.join('\n'),
      ];

      debugLogger.debug(contextParts.join('\n'));
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
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

    // Start a turn root span for new user prompts. Recursive continuations
    // (Hook, ToolResult, Retry) reuse the already-active span.
    const ownsTurnSpan =
      messageType === SendMessageType.UserQuery ||
      messageType === SendMessageType.Cron;
    if (ownsTurnSpan) {
      startTurnSpan(this.config.getSessionId(), prompt_id);
    }

    if (messageType === SendMessageType.Retry) {
      this.stripOrphanedUserEntriesFromHistory();
    }

    // Fire UserPromptSubmit hook through MessageBus (only if hooks are enabled)
    const hooksEnabled = !this.config.getDisableAllHooks();
    const messageBus = this.config.getMessageBus();
    if (
      messageType !== SendMessageType.Retry &&
      messageType !== SendMessageType.Cron &&
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
          type: GeminiEventType.Error,
          value: {
            error: new Error(
              `UserPromptSubmit hook blocked processing: ${hookOutput.getEffectiveReason()}`,
            ),
          },
        };
        if (ownsTurnSpan) endTurnSpan('error');
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
      messageType === SendMessageType.UserQuery ||
      messageType === SendMessageType.Cron
    ) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;

      // record user message for session management
      this.config.getChatRecordingService()?.recordUserMessage(request);

      // strip thoughts from history before sending the message
      this.stripThoughtsFromHistory();
    }
    if (messageType !== SendMessageType.Retry) {
      this.sessionTurnCount++;

      if (
        this.config.getMaxSessionTurns() > 0 &&
        this.sessionTurnCount > this.config.getMaxSessionTurns()
      ) {
        yield { type: GeminiEventType.MaxSessionTurns };
        if (ownsTurnSpan) endTurnSpan('ok');
        return new Turn(this.getChat(), prompt_id);
      }
    }

    // Ensure turns never exceeds MAX_TURNS to prevent infinite loops
    const boundedTurns = Math.min(turns, MAX_TURNS);
    if (!boundedTurns) {
      if (ownsTurnSpan) endTurnSpan('ok');
      return new Turn(this.getChat(), prompt_id);
    }

    const compressed = await this.tryCompressChat(prompt_id, false, signal);

    if (compressed.compressionStatus === CompressionStatus.COMPRESSED) {
      yield { type: GeminiEventType.ChatCompressed, value: compressed };
    }

    // Check session token limit after compression.
    // `lastPromptTokenCount` is treated as authoritative for the (possibly compressed) history;
    const sessionTokenLimit = this.config.getSessionTokenLimit();
    if (sessionTokenLimit > 0) {
      const lastPromptTokenCount = uiTelemetryService.getLastPromptTokenCount();
      if (lastPromptTokenCount > sessionTokenLimit) {
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
        if (ownsTurnSpan) endTurnSpan('error');
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

    if (this.config.getIdeMode() && !hasPendingToolCall) {
      const { contextParts, newIdeContext } = this.getIdeContextParts(
        this.forceFullIdeContext || history.length === 0,
      );
      if (contextParts.length > 0) {
        this.getChat().addHistory({
          role: 'user',
          parts: [{ text: contextParts.join('\n') }],
        });
      }
      this.lastSentIdeContext = newIdeContext;
      this.forceFullIdeContext = false;
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
        if (ownsTurnSpan) endTurnSpan('ok');
        return new Turn(this.getChat(), prompt_id);
      }
    }

    const turn = new Turn(this.getChat(), prompt_id);

    // append system reminders to the request
    let requestToSent = await flatMapTextParts(request, async (text) => [text]);
    if (
      messageType === SendMessageType.UserQuery ||
      messageType === SendMessageType.Cron
    ) {
      const systemReminders = [];

      // add subagent system reminder if there are subagents
      const hasAgentTool = this.config
        .getToolRegistry()
        .getTool(AgentTool.Name);
      const subagents = (await this.config.getSubagentManager().listSubagents())
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

      requestToSent = [...systemReminders, ...requestToSent];
    }

    const resultStream = turn.run(
      this.config.getModel(),
      requestToSent,
      signal,
    );
    for await (const event of resultStream) {
      if (!this.config.getSkipLoopDetection()) {
        if (this.loopDetector.addAndCheck(event)) {
          yield { type: GeminiEventType.LoopDetected };
          if (arenaAgentClient) {
            await arenaAgentClient.reportError('Loop detected');
          }
          if (ownsTurnSpan) endTurnSpan('error');
          return turn;
        }
      }
      // Update arena status on Finished events — stats are derived
      // automatically from uiTelemetryService by the reporter.
      if (arenaAgentClient && event.type === GeminiEventType.Finished) {
        await arenaAgentClient.updateStatus();
      }

      yield event;
      if (event.type === GeminiEventType.Error) {
        if (arenaAgentClient) {
          const errorMsg =
            event.value instanceof Error
              ? event.value.message
              : 'Unknown error';
          await arenaAgentClient.reportError(errorMsg);
        }
        if (ownsTurnSpan) endTurnSpan('error');
        return turn;
      }
    }
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
        if (ownsTurnSpan) endTurnSpan('ok');
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
          if (ownsTurnSpan) endTurnSpan('ok');
          return turn;
        }

        const continueReason = stopOutput.getEffectiveReason();
        const continueRequest = [{ text: continueReason }];
        const hookResult = yield* this.sendMessageStream(
          continueRequest,
          signal,
          prompt_id,
          { type: SendMessageType.Hook },
          boundedTurns - 1,
        );
        if (ownsTurnSpan) endTurnSpan('ok');
        return hookResult;
      }
    }

    // Run heuristic completion checker before the verification agent.
    // This is a cheap, zero-model-call check that catches obvious signs of
    // incomplete work (unresolved errors, missing tests, uncommitted changes).
    // Only runs when the main agent has finished and this is not a hook continuation.
    if (
      !turn.pendingToolCalls.length &&
      signal &&
      !signal.aborted &&
      messageType !== SendMessageType.Hook
    ) {
      const completionHistory = this.getHistory();
      const toolCallHistory = this.extractToolCallHistory(completionHistory);

      // Get the last assistant message
      const lastModel = completionHistory
        .filter((msg) => msg.role === 'model')
        .pop();
      const lastAssistantMessage =
        lastModel?.parts
          ?.filter((p): p is { text: string } => 'text' in p)
          .map((p) => p.text)
          .join('') || '';

      const checker = new CompletionChecker();
      const checkResult = checker.check({
        toolCallHistory,
        lastAssistantMessage,
      });

      if (!checkResult.passed) {
        const issueText = checkResult.issues.map((i) => `- ${i}`).join('\n');
        const continueReason = `Completion check found unresolved issues:\n${issueText}\n\nPlease address these issues before finishing.`;
        const continueRequest = [{ text: continueReason }];
        const completionResult = yield* this.sendMessageStream(
          continueRequest,
          signal,
          prompt_id,
          { type: SendMessageType.Hook },
          boundedTurns - 1,
        );
        if (ownsTurnSpan) endTurnSpan('ok');
        return completionResult;
      }
    }

    // Run verification agent before the session concludes.
    // Only runs when the main agent has finished (no pending tool calls),
    // is not a recursive hook continuation, and hasn't exceeded max attempts.
    if (
      !turn.pendingToolCalls.length &&
      signal &&
      !signal.aborted &&
      messageType !== SendMessageType.Hook &&
      this.verificationAttempts < GeminiClient.MAX_VERIFICATION_ATTEMPTS
    ) {
      const verifyConfig = BuiltinAgentRegistry.getBuiltinAgent('verify');
      if (verifyConfig) {
        this.verificationAttempts++;
        try {
          const subagentManager = this.config.getSubagentManager();
          const verifyAgent = await subagentManager.createAgentHeadless(
            verifyConfig,
            this.config,
          );

          // Build a summary of the session for the verification agent
          const history = this.getHistory();
          const lastModelMessage = history
            .filter((msg) => msg.role === 'model')
            .pop();
          const responseText =
            lastModelMessage?.parts
              ?.filter((p): p is { text: string } => 'text' in p)
              .map((p) => p.text)
              .join('') || '[no response text]';

          const verifyPrompt = `Review the following assistant response for completeness and correctness. Check that all requested work was done, there are no obvious errors, and no files were left in a broken state.\n\nAssistant's final response:\n${responseText}`;

          const verifyContext = new ContextState();
          verifyContext.set('task_prompt', verifyPrompt);
          await verifyAgent.execute(verifyContext, signal);

          if (!signal.aborted) {
            const verifyResult = verifyAgent.getFinalText();

            // Parse the verification result JSON
            try {
              const jsonMatch = verifyResult.match(
                /\{[\s\S]*"passed"\s*:\s*(true|false)[\s\S]*\}/,
              );
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as {
                  passed: boolean;
                  issues?: string[];
                  summary?: string;
                };

                if (
                  !parsed.passed &&
                  parsed.issues &&
                  parsed.issues.length > 0
                ) {
                  const issueList = parsed.issues
                    .map((issue: string) => `- ${issue}`)
                    .join('\n');
                  const continueReason = `Verification agent found issues that must be addressed before completing:\n${issueList}\n\nPlease fix these issues now.`;
                  const continueRequest = [{ text: continueReason }];
                  const verifyResult2 = yield* this.sendMessageStream(
                    continueRequest,
                    signal,
                    prompt_id,
                    { type: SendMessageType.Hook },
                    boundedTurns - 1,
                  );
                  if (ownsTurnSpan) endTurnSpan('ok');
                  return verifyResult2;
                }
              }
            } catch {
              debugLogger.warn(
                '[Verification] Failed to parse verification agent output, allowing completion',
              );
            }
          }
        } catch (verifyError) {
          debugLogger.warn(
            `[Verification] Verification agent failed, allowing completion: ${verifyError}`,
          );
        }
      }
    }

    if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
      if (this.config.getSkipNextSpeakerCheck()) {
        // Report completed before returning — agent has no more work to do
        if (arenaAgentClient) {
          await arenaAgentClient.reportCompleted();
        }
        if (ownsTurnSpan) endTurnSpan('ok');
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
        // This recursive call's events will be yielded out, and the final
        // turn object from the recursive call will be returned.
        const nextResult = yield* this.sendMessageStream(
          nextRequest,
          signal,
          prompt_id,
          options,
          boundedTurns - 1,
        );
        if (ownsTurnSpan) endTurnSpan('ok');
        return nextResult;
      } else if (arenaAgentClient) {
        // No continuation needed — agent completed its task
        await arenaAgentClient.reportCompleted();
      }
    }

    // Report cancelled to arena when user cancelled mid-stream
    if (signal?.aborted && arenaAgentClient) {
      await arenaAgentClient.reportCancelled();
    }

    if (ownsTurnSpan) endTurnSpan('ok');
    return turn;
  }

  async generateContent(
    contents: Content[],
    generationConfig: GenerateContentConfig,
    abortSignal: AbortSignal,
    model: string,
    promptIdOverride?: string,
  ): Promise<GenerateContentResponse> {
    let currentAttemptModel: string = model;
    const promptId =
      promptIdOverride ?? promptIdContext.getStore() ?? this.lastPromptId!;

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

      const apiCall = () => {
        currentAttemptModel = model;

        return this.getContentGeneratorOrFail().generateContent(
          {
            model,
            config: requestConfig,
            contents,
          },
          promptId,
        );
      };
      const result = await retryWithBackoff(apiCall, {
        authType: this.config.getContentGeneratorConfig()?.authType,
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

  async tryCompressChat(
    prompt_id: string,
    force: boolean = false,
    signal?: AbortSignal,
  ): Promise<ChatCompressionInfo> {
    const compressionService = new ChatCompressionService();

    const { newHistory, info } = await compressionService.compress(
      this.getChat(),
      prompt_id,
      force,
      this.config.getModel(),
      this.config,
      this.hasFailedCompressionAttempt,
      signal,
    );

    // Handle compression result
    if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      // Success: update chat with new compressed history
      if (newHistory) {
        const chatRecordingService = this.config.getChatRecordingService();
        chatRecordingService?.recordChatCompression({
          info,
          compressedHistory: newHistory,
        });

        await this.startChat(newHistory);
        uiTelemetryService.setLastPromptTokenCount(info.newTokenCount);
        this.forceFullIdeContext = true;
      }
    } else if (
      info.compressionStatus ===
        CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT ||
      info.compressionStatus ===
        CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY
    ) {
      // Track failed attempts (only mark as failed if not forced)
      if (!force) {
        this.hasFailedCompressionAttempt = true;
      }
    }

    return info;
  }

  /**
   * Extracts a flat list of tool call records from the conversation history.
   *
   * Walks through the history pairing functionCall parts (model role) with
   * their corresponding functionResponse parts (user role) to build
   * ToolCallRecord entries with name, success status, and input args.
   */
  private extractToolCallHistory(history: Content[]): ToolCallRecord[] {
    const records: ToolCallRecord[] = [];

    // Build a map of function responses keyed by call id or name for correlation
    const responseMap = new Map<
      string,
      { success: boolean; response?: Record<string, unknown> }
    >();
    for (const entry of history) {
      if (entry.role !== 'user' || !entry.parts) continue;
      for (const part of entry.parts) {
        if (!part.functionResponse) continue;
        const fr = part.functionResponse;
        // Use id if available, fall back to name
        const key = fr.id ?? fr.name ?? '';
        if (!key) continue;
        const resp = fr.response as Record<string, unknown> | undefined;
        const hasError =
          resp !== undefined && ('error' in resp || 'is_error' in resp);
        responseMap.set(key, {
          success: !hasError,
          response: resp,
        });
      }
    }

    // Walk function calls and match them to responses
    for (const entry of history) {
      if (entry.role !== 'model' || !entry.parts) continue;
      for (const part of entry.parts) {
        if (!part.functionCall) continue;
        const fc = part.functionCall;
        const name = fc.name ?? '';
        if (!name) continue;

        const key = fc.id ?? name;
        const matched = responseMap.get(key);

        records.push({
          name,
          success: matched?.success ?? true,
          input: (fc.args as Record<string, unknown>) ?? undefined,
        });
      }
    }

    return records;
  }
}

export const TEST_ONLY = {
  COMPRESSION_PRESERVE_THRESHOLD,
  COMPRESSION_TOKEN_THRESHOLD,
};
