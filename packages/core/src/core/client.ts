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
import {
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_THINKING_MODE,
} from '../config/models.js';

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
import { type ChatRecordingService } from '../services/chatRecordingService.js';
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

// Utilities
import {
  getDirectoryContextString,
  getInitialChatHistory,
} from '../utils/environmentContext.js';
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

export function isThinkingSupported(model: string) {
  return model.startsWith('gemini-2.5') || model === DEFAULT_GEMINI_MODEL_AUTO;
}

export function isThinkingDefault(model: string) {
  if (model.startsWith('gemini-2.5-flash-lite')) {
    return false;
  }
  return model.startsWith('gemini-2.5') || model === DEFAULT_GEMINI_MODEL_AUTO;
}

const MAX_TURNS = 100;

export class GeminiClient {
  private chat?: GeminiChat;
  private readonly generateContentConfig: GenerateContentConfig = {
    temperature: 0,
    topP: 1,
  };
  private sessionTurnCount = 0;

  private readonly loopDetector: LoopDetectionService;
  private lastPromptId: string;
  private lastSentIdeContext: IdeContext | undefined;
  private forceFullIdeContext = true;

  /**
   * At any point in this conversation, was compression triggered without
   * being forced and did it fail?
   */
  private hasFailedCompressionAttempt = false;

  constructor(private readonly config: Config) {
    this.loopDetector = new LoopDetectionService(config);
    this.lastPromptId = this.config.getSessionId();
  }

  async initialize() {
    this.chat = await this.startChat();
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

  getChatRecordingService(): ChatRecordingService | undefined {
    return this.chat?.getChatRecordingService();
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

      const config: GenerateContentConfig = { ...this.generateContentConfig };

      if (isThinkingSupported(model)) {
        config.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: DEFAULT_THINKING_MODE,
        };
      }

      return new GeminiChat(
        this.config,
        {
          systemInstruction,
          ...config,
          tools,
        },
        history,
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
      // Send full context as JSON
      const openFiles = currentIdeContext.workspaceState?.openFiles || [];
      const activeFile = openFiles.find((f) => f.isActive);
      const otherOpenFiles = openFiles
        .filter((f) => !f.isActive)
        .map((f) => f.path);

      const contextData: Record<string, unknown> = {};

      if (activeFile) {
        contextData['activeFile'] = {
          path: activeFile.path,
          cursor: activeFile.cursor
            ? {
                line: activeFile.cursor.line,
                character: activeFile.cursor.character,
              }
            : undefined,
          selectedText: activeFile.selectedText || undefined,
        };
      }

      if (otherOpenFiles.length > 0) {
        contextData['otherOpenFiles'] = otherOpenFiles;
      }

      if (Object.keys(contextData).length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      const jsonString = JSON.stringify(contextData, null, 2);
      const contextParts = [
        "Here is the user's editor context as a JSON object. This is for your information only.",
        '```json',
        jsonString,
        '```',
      ];

      if (this.config.getDebugMode()) {
        console.log(contextParts.join('\n'));
      }
      return {
        contextParts,
        newIdeContext: currentIdeContext,
      };
    } else {
      // Calculate and send delta as JSON
      const delta: Record<string, unknown> = {};
      const changes: Record<string, unknown> = {};

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
        changes['filesOpened'] = openedFiles;
      }

      const closedFiles: string[] = [];
      for (const [path] of lastFiles.entries()) {
        if (!currentFiles.has(path)) {
          closedFiles.push(path);
        }
      }
      if (closedFiles.length > 0) {
        changes['filesClosed'] = closedFiles;
      }

      const lastActiveFile = (
        this.lastSentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);
      const currentActiveFile = (
        currentIdeContext.workspaceState?.openFiles || []
      ).find((f: File) => f.isActive);

      if (currentActiveFile) {
        if (!lastActiveFile || lastActiveFile.path !== currentActiveFile.path) {
          changes['activeFileChanged'] = {
            path: currentActiveFile.path,
            cursor: currentActiveFile.cursor
              ? {
                  line: currentActiveFile.cursor.line,
                  character: currentActiveFile.cursor.character,
                }
              : undefined,
            selectedText: currentActiveFile.selectedText || undefined,
          };
        } else {
          const lastCursor = lastActiveFile.cursor;
          const currentCursor = currentActiveFile.cursor;
          if (
            currentCursor &&
            (!lastCursor ||
              lastCursor.line !== currentCursor.line ||
              lastCursor.character !== currentCursor.character)
          ) {
            changes['cursorMoved'] = {
              path: currentActiveFile.path,
              cursor: {
                line: currentCursor.line,
                character: currentCursor.character,
              },
            };
          }

          const lastSelectedText = lastActiveFile.selectedText || '';
          const currentSelectedText = currentActiveFile.selectedText || '';
          if (lastSelectedText !== currentSelectedText) {
            changes['selectionChanged'] = {
              path: currentActiveFile.path,
              selectedText: currentSelectedText,
            };
          }
        }
      } else if (lastActiveFile) {
        changes['activeFileChanged'] = {
          path: null,
          previousPath: lastActiveFile.path,
        };
      }

      if (Object.keys(changes).length === 0) {
        return { contextParts: [], newIdeContext: currentIdeContext };
      }

      delta['changes'] = changes;
      const jsonString = JSON.stringify(delta, null, 2);
      const contextParts = [
        "Here is a summary of changes in the user's editor context, in JSON format. This is for your information only.",
        '```json',
        jsonString,
        '```',
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
    turns: number = MAX_TURNS,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    const isNewPrompt = this.lastPromptId !== prompt_id;
    if (isNewPrompt) {
      this.loopDetector.reset(prompt_id);
      this.lastPromptId = prompt_id;
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

    // Check session token limit after compression using accurate token counting
    const sessionTokenLimit = this.config.getSessionTokenLimit();
    if (sessionTokenLimit > 0) {
      // Get all the content that would be sent in an API call
      const currentHistory = this.getChat().getHistory(true);
      const userMemory = this.config.getUserMemory();
      const systemPrompt = getCoreSystemPrompt(
        userMemory,
        this.config.getModel(),
      );
      const initialHistory = await getInitialChatHistory(this.config);

      // Create a mock request content to count total tokens
      const mockRequestContent = [
        {
          role: 'system' as const,
          parts: [{ text: systemPrompt }],
        },
        ...initialHistory,
        ...currentHistory,
      ];

      // Use the improved countTokens method for accurate counting
      const { totalTokens: totalRequestTokens } = await this.config
        .getContentGenerator()
        .countTokens({
          model: this.config.getModel(),
          contents: mockRequestContent,
        });

      if (
        totalRequestTokens !== undefined &&
        totalRequestTokens > sessionTokenLimit
      ) {
        yield {
          type: GeminiEventType.SessionTokenLimitExceeded,
          value: {
            currentTokens: totalRequestTokens,
            limit: sessionTokenLimit,
            message:
              `Session token limit exceeded: ${totalRequestTokens} tokens > ${sessionTokenLimit} limit. ` +
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
    if (isNewPrompt) {
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
        systemReminders.push(getPlanModeSystemReminder());
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
      // Check if next speaker check is needed
      if (this.config.getQuotaErrorOccurred()) {
        return turn;
      }

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

    const configToUse: GenerateContentConfig = {
      ...this.generateContentConfig,
      ...generationConfig,
    };

    try {
      const userMemory = this.config.getUserMemory();
      const finalSystemInstruction = generationConfig.systemInstruction
        ? getCustomSystemPrompt(generationConfig.systemInstruction, userMemory)
        : getCoreSystemPrompt(userMemory, this.config.getModel());

      const requestConfig: GenerateContentConfig = {
        abortSignal,
        ...configToUse,
        systemInstruction: finalSystemInstruction,
      };

      const apiCall = () => {
        const modelToUse = this.config.isInFallbackMode()
          ? DEFAULT_GEMINI_FLASH_MODEL
          : model;
        currentAttemptModel = modelToUse;

        return this.getContentGeneratorOrFail().generateContent(
          {
            model: modelToUse,
            config: requestConfig,
            contents,
          },
          this.lastPromptId,
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
          requestConfig: configToUse,
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
        this.chat = await this.startChat(newHistory);
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
