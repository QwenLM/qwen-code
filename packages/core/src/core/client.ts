/**
 * @license
 * Copyright 2025 Google LLC
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

// Core modules
import type { ContentGenerator } from './contentGenerator.js';
import { GeminiChat } from './geminiChat.js';
import {
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
import { TaskTool } from '../tools/task.js';

// Telemetry
import {
  NextSpeakerCheckEvent,
  logNextSpeakerCheck,
} from '../telemetry/index.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';

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
import { retryWithBackoff } from '../utils/retry.js';

// IDE integration
import { ideContextStore } from '../ide/ideContext.js';
import { type File, type IdeContext } from '../ide/types.js';

// Fallback handling
import { handleFallback } from '../fallback/handler.js';

const MAX_TURNS = 100;

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
      this.chat = await this.startChat(resumedHistory);
    } else {
      this.chat = await this.startChat();
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

  setHistory(history: Content[]) {
    this.getChat().setHistory(history);
    this.forceFullIdeContext = true;
  }

  async setTools(): Promise<void> {
    const toolRegistry = this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];
    this.getChat().setTools(tools);
  }

  async resetChat(): Promise<void> {
    this.chat = await this.startChat();
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

  async startChat(extraHistory?: Content[]): Promise<GeminiChat> {
    this.forceFullIdeContext = true;
    this.hasFailedCompressionAttempt = false;

    const toolRegistry = this.config.getToolRegistry();
    const toolDeclarations = toolRegistry.getFunctionDeclarations();
    const tools: Tool[] = [{ functionDeclarations: toolDeclarations }];

    const history = await getInitialChatHistory(this.config, extraHistory);

    try {
      const userMemory = this.config.getUserMemory();
      const model = this.config.getModel();
      const systemInstruction = getCoreSystemPrompt(userMemory, model);

      return new GeminiChat(
        this.config,
        {
          systemInstruction,
          tools,
        },
        history,
        this.config.getChatRecordingService(),
      );
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

      if (this.config.getDebugMode()) {
        console.log(contextParts.join('\n'));
      }
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

      if (this.config.getDebugMode()) {
        console.log(contextParts.join('\n'));
      }
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
    options?: { isContinuation: boolean },
    turns: number = MAX_TURNS,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    if (!options?.isContinuation) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;

      // record user message for session management
      this.config.getChatRecordingService()?.recordUserMessage(request);

      // strip thoughts from history before sending the message
      this.stripThoughtsFromHistory();
    }
    this.sessionTurnCount++;
    if (
      this.config.getMaxSessionTurns() > 0 &&
      this.sessionTurnCount > this.config.getMaxSessionTurns()
    ) {
      yield { type: GeminiEventType.MaxSessionTurns };
      return new Turn(this.getChat(), prompt_id);
    }
    // Ensure turns never exceeds MAX_TURNS to prevent infinite loops
    const boundedTurns = Math.min(turns, MAX_TURNS);
    if (!boundedTurns) {
      return new Turn(this.getChat(), prompt_id);
    }

    const compressed = await this.tryCompressChat(prompt_id, false);

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

    const turn = new Turn(this.getChat(), prompt_id);

    if (!this.config.getSkipLoopDetection()) {
      const loopDetected = await this.loopDetector.turnStarted(signal);
      if (loopDetected) {
        yield { type: GeminiEventType.LoopDetected };
        return turn;
      }
    }

    // append system reminders to the request
    let requestToSent = await flatMapTextParts(request, async (text) => [text]);
    if (!options?.isContinuation) {
      const systemReminders = [];

      // add subagent system reminder if there are subagents
      const hasTaskTool = this.config.getToolRegistry().getTool(TaskTool.Name);
      const subagents = (await this.config.getSubagentManager().listSubagents())
        .filter((subagent) => subagent.level !== 'builtin')
        .map((subagent) => subagent.name);

      if (hasTaskTool && subagents.length > 0) {
        systemReminders.push(getSubagentSystemReminder(subagents));
      }

      // add plan mode system reminder if approval mode is plan
      if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
        systemReminders.push(
          getPlanModeSystemReminder(this.config.getSdkMode()),
        );
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
          return turn;
        }
      }
      yield event;
      if (event.type === GeminiEventType.Error) {
        return turn;
      }
    }
    if (!turn.pendingToolCalls.length && signal && !signal.aborted) {
      if (this.config.getSkipNextSpeakerCheck()) {
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
        // This recursive call's events will be yielded out, but the final
        // turn object will be from the top-level call.
        yield* this.sendMessageStream(
          nextRequest,
          signal,
          prompt_id,
          options,
          boundedTurns - 1,
        );
      }
    }
    return turn;
  }

  async generateContent(
    contents: Content[],
    generationConfig: GenerateContentConfig,
    abortSignal: AbortSignal,
    model: string,
  ): Promise<GenerateContentResponse> {
    let currentAttemptModel: string = model;

    try {
      const userMemory = this.config.getUserMemory();
      const finalSystemInstruction = generationConfig.systemInstruction
        ? getCustomSystemPrompt(generationConfig.systemInstruction, userMemory)
        : getCoreSystemPrompt(userMemory, this.config.getModel());

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
          this.lastPromptId!,
        );
      };
      const onPersistent429Callback = async (
        authType?: string,
        error?: unknown,
      ) =>
        // Pass the captured model to the centralized handler.
        await handleFallback(this.config, currentAttemptModel, authType, error);

      const result = await retryWithBackoff(apiCall, {
        onPersistent429: onPersistent429Callback,
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
  ): Promise<ChatCompressionInfo> {
    const compressionService = new ChatCompressionService();

    const { newHistory, info } = await compressionService.compress(
      this.getChat(),
      prompt_id,
      force,
      this.config.getModel(),
      this.config,
      this.hasFailedCompressionAttempt,
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

        this.chat = await this.startChat(newHistory);
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
}

export const TEST_ONLY = {
  COMPRESSION_PRESERVE_THRESHOLD,
  COMPRESSION_TOKEN_THRESHOLD,
};
