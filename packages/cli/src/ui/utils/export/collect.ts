/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config, ChatRecord } from '@qwen-code/qwen-code-core';
import type { SessionContext } from '../../../acp-integration/session/types.js';
import type * as acp from '../../../acp-integration/acp.js';
import { HistoryReplayer } from '../../../acp-integration/session/HistoryReplayer.js';
import type { ExportMessage, ExportSessionData } from './types.js';

/**
 * Export session context that captures session updates into export messages.
 * Implements SessionContext to work with HistoryReplayer.
 */
class ExportSessionContext implements SessionContext {
  readonly sessionId: string;
  readonly config: Config;
  private messages: ExportMessage[] = [];
  private currentMessage: {
    type: 'user' | 'assistant';
    role: 'user' | 'assistant' | 'thinking';
    parts: Array<{ text: string }>;
    timestamp: number;
  } | null = null;
  private activeRecordId: string | null = null;
  private toolCallMap: Map<string, ExportMessage['toolCall']> = new Map();

  constructor(sessionId: string, config: Config) {
    this.sessionId = sessionId;
    this.config = config;
  }

  async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this.handleMessageChunk('user', update.content);
        break;
      case 'agent_message_chunk':
        this.handleMessageChunk('assistant', update.content);
        break;
      case 'agent_thought_chunk':
        this.handleMessageChunk('assistant', update.content, 'thinking');
        break;
      case 'tool_call':
        this.flushCurrentMessage();
        this.handleToolCallStart(update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        break;
      default:
        // Ignore other update types
        break;
    }
  }

  setActiveRecordId(recordId: string | null): void {
    this.activeRecordId = recordId;
  }

  private getMessageUuid(): string {
    return this.activeRecordId ?? randomUUID();
  }

  private handleMessageChunk(
    role: 'user' | 'assistant',
    content: { type: string; text?: string },
    messageRole: 'user' | 'assistant' | 'thinking' = role,
  ): void {
    if (content.type !== 'text' || !content.text) return;

    // If we're starting a new message type, flush the previous one
    if (
      this.currentMessage &&
      (this.currentMessage.type !== role ||
        this.currentMessage.role !== messageRole)
    ) {
      this.flushCurrentMessage();
    }

    // Add to current message or create new one
    if (
      this.currentMessage &&
      this.currentMessage.type === role &&
      this.currentMessage.role === messageRole
    ) {
      this.currentMessage.parts.push({ text: content.text });
    } else {
      this.currentMessage = {
        type: role,
        role: messageRole,
        parts: [{ text: content.text }],
        timestamp: Date.now(),
      };
    }
  }

  private handleToolCallStart(update: acp.ToolCall): void {
    const toolCall: ExportMessage['toolCall'] = {
      toolCallId: update.toolCallId,
      kind: update.kind || 'other',
      title:
        typeof update.title === 'string' ? update.title : update.title || '',
      status: update.status || 'pending',
      rawInput: update.rawInput as string | object | undefined,
      locations: update.locations,
      timestamp: Date.now(),
    };

    this.toolCallMap.set(update.toolCallId, toolCall);

    // Immediately add tool call to messages to preserve order
    const uuid = this.getMessageUuid();
    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp: new Date(toolCall.timestamp || Date.now()).toISOString(),
      type: 'tool_call',
      toolCall,
    });
  }

  private handleToolCallUpdate(update: {
    toolCallId: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
    title?: string | null;
    content?: Array<{ type: string; [key: string]: unknown }> | null;
    kind?: string | null;
  }): void {
    const toolCall = this.toolCallMap.get(update.toolCallId);
    if (toolCall) {
      // Update the tool call in place
      if (update.status) toolCall.status = update.status;
      if (update.content) toolCall.content = update.content;
      if (update.title)
        toolCall.title = typeof update.title === 'string' ? update.title : '';
    }
  }

  private flushCurrentMessage(): void {
    if (!this.currentMessage) return;

    const uuid = this.getMessageUuid();
    this.messages.push({
      uuid,
      sessionId: this.sessionId,
      timestamp: new Date(this.currentMessage.timestamp).toISOString(),
      type: this.currentMessage.type,
      message: {
        role: this.currentMessage.role,
        parts: this.currentMessage.parts,
      },
    });

    this.currentMessage = null;
  }

  flushMessages(): void {
    this.flushCurrentMessage();
  }

  getMessages(): ExportMessage[] {
    return this.messages;
  }
}

/**
 * Collects session data from ChatRecord[] using HistoryReplayer.
 * Returns the raw ExportSessionData (SSOT) without normalization.
 */
export async function collectSessionData(
  conversation: {
    sessionId: string;
    startTime: string;
    messages: ChatRecord[];
  },
  config: Config,
): Promise<ExportSessionData> {
  // Create export session context
  const exportContext = new ExportSessionContext(
    conversation.sessionId,
    config,
  );

  // Create history replayer with export context
  const replayer = new HistoryReplayer(exportContext);

  // Replay chat records to build export messages
  await replayer.replay(conversation.messages);

  // Flush any buffered messages
  exportContext.flushMessages();

  // Get the export messages
  const messages = exportContext.getMessages();

  return {
    sessionId: conversation.sessionId,
    startTime: conversation.startTime,
    messages,
  };
}
