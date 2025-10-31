/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Transport-agnostic JSON Lines protocol handler for bidirectional communication.
 * Works with any Readable/Writable stream (stdin/stdout, HTTP, WebSocket, etc.)
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type {
  CLIMessage,
  CLIUserMessage,
  ContentBlock,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
  CLIAssistantMessage,
  CLIPartialAssistantMessage,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from '../types/protocol.js';
import type { ServerGeminiStreamEvent } from '@qwen-code/qwen-code-core';
import { GeminiEventType } from '@qwen-code/qwen-code-core';

/**
 * ============================================================================
 * Stream JSON I/O Class
 * ============================================================================
 */

export interface StreamJsonOptions {
  input?: Readable;
  output?: Writable;
  onError?: (error: Error) => void;
}

/**
 * Handles JSON Lines communication over arbitrary streams.
 */
export class StreamJson {
  private input: Readable;
  private output: Writable;
  private rl?: readline.Interface;
  private onError?: (error: Error) => void;

  constructor(options: StreamJsonOptions = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.onError = options.onError;
  }

  /**
   * Read messages from input stream as async generator.
   */
  async *readMessages(): AsyncGenerator<
    CLIMessage | CLIControlRequest | CLIControlResponse | ControlCancelRequest,
    void,
    unknown
  > {
    this.rl = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false,
    });

    try {
      for await (const line of this.rl) {
        if (!line.trim()) {
          continue; // Skip empty lines
        }

        try {
          const message = JSON.parse(line);
          yield message;
        } catch (error) {
          console.error(
            '[StreamJson] Failed to parse message:',
            line.substring(0, 100),
            error,
          );
          // Continue processing (skip bad line)
        }
      }
    } finally {
      // Cleanup on exit
    }
  }

  /**
   * Send a message to output stream.
   */
  send(message: CLIMessage | CLIControlResponse | CLIControlRequest): void {
    try {
      const line = JSON.stringify(message) + '\n';
      this.output.write(line);
    } catch (error) {
      console.error('[StreamJson] Failed to send message:', error);
      if (this.onError) {
        this.onError(error as Error);
      }
    }
  }

  /**
   * Create an assistant message builder.
   */
  createAssistantBuilder(
    sessionId: string,
    parentToolUseId: string | null,
    model: string,
    includePartialMessages: boolean = false,
  ): AssistantMessageBuilder {
    return new AssistantMessageBuilder({
      sessionId,
      parentToolUseId,
      includePartialMessages,
      model,
      streamJson: this,
    });
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
  }
}

/**
 * ============================================================================
 * Assistant Message Builder
 * ============================================================================
 */

export interface AssistantMessageBuilderOptions {
  sessionId: string;
  parentToolUseId: string | null;
  includePartialMessages: boolean;
  model: string;
  streamJson: StreamJson;
}

/**
 * Builds assistant messages from Gemini stream events.
 * Accumulates content blocks and emits streaming events in real-time.
 */
export class AssistantMessageBuilder {
  private sessionId: string;
  private parentToolUseId: string | null;
  private includePartialMessages: boolean;
  private model: string;
  private streamJson: StreamJson;

  private messageId: string;
  private contentBlocks: ContentBlock[] = [];
  private openBlocks = new Set<number>();
  private messageStarted: boolean = false;
  private finalized: boolean = false;
  private usage: Usage | null = null;

  // Current block state
  private currentBlockType: 'text' | 'thinking' | null = null;
  private currentTextContent: string = '';
  private currentThinkingContent: string = '';
  private currentThinkingSignature: string = '';

  constructor(options: AssistantMessageBuilderOptions) {
    this.sessionId = options.sessionId;
    this.parentToolUseId = options.parentToolUseId;
    this.includePartialMessages = options.includePartialMessages;
    this.model = options.model;
    this.streamJson = options.streamJson;
    this.messageId = randomUUID();
  }

  /**
   * Process a Gemini stream event and update internal state.
   */
  processEvent(event: ServerGeminiStreamEvent): void {
    if (this.finalized) {
      return;
    }

    switch (event.type) {
      case GeminiEventType.Content:
        this.handleContentEvent(event.value);
        break;

      case GeminiEventType.Thought:
        this.handleThoughtEvent(event.value.subject, event.value.description);
        break;

      case GeminiEventType.ToolCallRequest:
        this.handleToolCallRequest(event.value);
        break;

      case GeminiEventType.Finished:
        this.finalizePendingBlocks();
        break;

      default:
        // Ignore other event types
        break;
    }
  }

  /**
   * Handle text content event.
   */
  private handleContentEvent(content: string): void {
    if (!content) {
      return;
    }

    this.ensureMessageStarted();

    // If we're not in a text block, switch to text mode
    if (this.currentBlockType !== 'text') {
      this.switchToTextBlock();
    }

    // Accumulate content
    this.currentTextContent += content;

    // Emit delta for streaming updates
    const currentIndex = this.contentBlocks.length;
    this.emitContentBlockDelta(currentIndex, {
      type: 'text_delta',
      text: content,
    });
  }

  /**
   * Handle thinking event.
   */
  private handleThoughtEvent(subject: string, description: string): void {
    this.ensureMessageStarted();

    const thinkingFragment = `${subject}: ${description}`;

    // If we're not in a thinking block, switch to thinking mode
    if (this.currentBlockType !== 'thinking') {
      this.switchToThinkingBlock(subject);
    }

    // Accumulate thinking content
    this.currentThinkingContent += thinkingFragment;

    // Emit delta for streaming updates
    const currentIndex = this.contentBlocks.length;
    this.emitContentBlockDelta(currentIndex, {
      type: 'thinking_delta',
      thinking: thinkingFragment,
    });
  }

  /**
   * Handle tool call request.
   */
  private handleToolCallRequest(request: any): void {
    this.ensureMessageStarted();

    // Finalize any open blocks first
    this.finalizePendingBlocks();

    // Create and add tool use block
    const index = this.contentBlocks.length;
    const toolUseBlock: ToolUseBlock = {
      type: 'tool_use',
      id: request.callId,
      name: request.name,
      input: request.args,
    };

    this.contentBlocks.push(toolUseBlock);
    this.openBlock(index, toolUseBlock);
    this.closeBlock(index);
  }

  /**
   * Finalize any pending content blocks.
   */
  private finalizePendingBlocks(): void {
    if (this.currentBlockType === 'text' && this.currentTextContent) {
      this.finalizeTextBlock();
    } else if (
      this.currentBlockType === 'thinking' &&
      this.currentThinkingContent
    ) {
      this.finalizeThinkingBlock();
    }
  }

  /**
   * Switch to text block mode.
   */
  private switchToTextBlock(): void {
    this.finalizePendingBlocks();

    this.currentBlockType = 'text';
    this.currentTextContent = '';

    const index = this.contentBlocks.length;
    const textBlock: TextBlock = {
      type: 'text',
      text: '',
    };

    this.openBlock(index, textBlock);
  }

  /**
   * Switch to thinking block mode.
   */
  private switchToThinkingBlock(signature: string): void {
    this.finalizePendingBlocks();

    this.currentBlockType = 'thinking';
    this.currentThinkingContent = '';
    this.currentThinkingSignature = signature;

    const index = this.contentBlocks.length;
    const thinkingBlock: ThinkingBlock = {
      type: 'thinking',
      thinking: '',
      signature,
    };

    this.openBlock(index, thinkingBlock);
  }

  /**
   * Finalize current text block.
   */
  private finalizeTextBlock(): void {
    if (!this.currentTextContent) {
      return;
    }

    const index = this.contentBlocks.length;
    const textBlock: TextBlock = {
      type: 'text',
      text: this.currentTextContent,
    };
    this.contentBlocks.push(textBlock);
    this.closeBlock(index);

    this.currentBlockType = null;
    this.currentTextContent = '';
  }

  /**
   * Finalize current thinking block.
   */
  private finalizeThinkingBlock(): void {
    if (!this.currentThinkingContent) {
      return;
    }

    const index = this.contentBlocks.length;
    const thinkingBlock: ThinkingBlock = {
      type: 'thinking',
      thinking: this.currentThinkingContent,
      signature: this.currentThinkingSignature,
    };
    this.contentBlocks.push(thinkingBlock);
    this.closeBlock(index);

    this.currentBlockType = null;
    this.currentThinkingContent = '';
    this.currentThinkingSignature = '';
  }

  /**
   * Set usage information for the final message.
   */
  setUsage(usage: Usage): void {
    this.usage = usage;
  }

  /**
   * Build and return the final assistant message.
   */
  finalize(): CLIAssistantMessage {
    if (this.finalized) {
      return this.buildFinalMessage();
    }

    this.finalized = true;

    // Finalize any pending blocks
    this.finalizePendingBlocks();

    // Close all open blocks in order
    const orderedOpenBlocks = [...this.openBlocks].sort((a, b) => a - b);
    for (const index of orderedOpenBlocks) {
      this.closeBlock(index);
    }

    // Emit message stop event
    if (this.messageStarted) {
      this.emitMessageStop();
    }

    return this.buildFinalMessage();
  }

  /**
   * Build the final message structure.
   */
  private buildFinalMessage(): CLIAssistantMessage {
    return {
      type: 'assistant',
      uuid: this.messageId,
      session_id: this.sessionId,
      parent_tool_use_id: this.parentToolUseId,
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: this.contentBlocks,
        stop_reason: null,
        usage: this.usage || {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
  }

  /**
   * Ensure message has been started.
   */
  private ensureMessageStarted(): void {
    if (this.messageStarted) {
      return;
    }
    this.messageStarted = true;
    this.emitMessageStart();
  }

  /**
   * Open a content block and emit start event.
   */
  private openBlock(index: number, block: ContentBlock): void {
    this.openBlocks.add(index);
    this.emitContentBlockStart(index, block);
  }

  /**
   * Close a content block and emit stop event.
   */
  private closeBlock(index: number): void {
    if (!this.openBlocks.has(index)) {
      return;
    }
    this.openBlocks.delete(index);
    this.emitContentBlockStop(index);
  }

  /**
   * Emit message_start stream event.
   */
  private emitMessageStart(): void {
    const event: StreamEvent = {
      type: 'message_start',
      message: {
        id: this.messageId,
        role: 'assistant',
        model: this.model,
      },
    };
    this.emitStreamEvent(event);
  }

  /**
   * Emit content_block_start stream event.
   */
  private emitContentBlockStart(
    index: number,
    contentBlock: ContentBlock,
  ): void {
    const event: StreamEvent = {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    };
    this.emitStreamEvent(event);
  }

  /**
   * Emit content_block_delta stream event.
   */
  private emitContentBlockDelta(
    index: number,
    delta: {
      type: 'text_delta' | 'thinking_delta';
      text?: string;
      thinking?: string;
    },
  ): void {
    const event: StreamEvent = {
      type: 'content_block_delta',
      index,
      delta,
    };
    this.emitStreamEvent(event);
  }

  /**
   * Emit content_block_stop stream event
   */
  private emitContentBlockStop(index: number): void {
    const event: StreamEvent = {
      type: 'content_block_stop',
      index,
    };
    this.emitStreamEvent(event);
  }

  /**
   * Emit message_stop stream event
   */
  private emitMessageStop(): void {
    const event: StreamEvent = {
      type: 'message_stop',
    };
    this.emitStreamEvent(event);
  }

  /**
   * Emit a stream event as SDKPartialAssistantMessage
   */
  private emitStreamEvent(event: StreamEvent): void {
    if (!this.includePartialMessages) return;

    const message: CLIPartialAssistantMessage = {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: this.sessionId,
      event,
      parent_tool_use_id: this.parentToolUseId,
    };
    this.streamJson.send(message);
  }
}

/**
 * Extract text content from user message
 */
export function extractUserMessageText(message: CLIUserMessage): string[] {
  const texts: string[] = [];
  const content = message.message.content;

  if (typeof content === 'string') {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if ('content' in block && typeof block.content === 'string') {
        texts.push(block.content);
      }
    }
  }

  return texts;
}

/**
 * Extract text content from content blocks
 */
export function extractTextFromContent(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Create text content block
 */
export function createTextContent(text: string): ContentBlock {
  return {
    type: 'text',
    text,
  };
}

/**
 * Create tool use content block
 */
export function createToolUseContent(
  id: string,
  name: string,
  input: Record<string, any>,
): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
  };
}

/**
 * Create tool result content block
 */
export function createToolResultContent(
  tool_use_id: string,
  content: string | Array<Record<string, any>> | null,
  is_error?: boolean,
): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id,
    content,
    is_error,
  };
}
