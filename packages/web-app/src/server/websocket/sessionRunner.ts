/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSocket } from 'ws';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type ContentBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type PermissionSuggestion,
  type PermissionResult,
  isSDKAssistantMessage,
  isSDKPartialAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
} from '@qwen-code/sdk';
import type {
  Message,
  PermissionRequest,
  ToolCallData,
  ToolCallContent,
} from '../../shared/types.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import type { ChatRecord } from '@qwen-code/qwen-code-core';

interface StreamState {
  textContent: string;
  thinkingContent: string;
  toolCalls: Map<string, ToolCallData>;
  toolCallIndexes: Map<number, string>;
  assistantMessageId: string | null;
  thinkingMessageId: string | null;
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  signal: AbortSignal;
  input: Record<string, unknown>;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as T, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function createStreamState(): StreamState {
  return {
    textContent: '',
    thinkingContent: '',
    toolCalls: new Map(),
    toolCallIndexes: new Map(),
    assistantMessageId: null,
    thinkingMessageId: null,
  };
}

function resetStreamState(state: StreamState): void {
  state.textContent = '';
  state.thinkingContent = '';
  state.toolCalls.clear();
  state.toolCallIndexes.clear();
  state.assistantMessageId = null;
  state.thinkingMessageId = null;
}

 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function guessToolKind(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('read')) return 'read';
  if (normalized.includes('write')) return 'write';
  if (normalized.includes('edit')) return 'edit';
  if (normalized.includes('search')) return 'search';
  if (normalized.includes('web')) return 'web';
  if (normalized.includes('bash')) return 'bash';
  if (normalized.includes('exec') || normalized.includes('shell'))
    return 'execute';
  if (normalized.includes('plan')) return 'plan';
  if (normalized.includes('think')) return 'think';
  return 'other';
}

function buildToolCallData(block: ToolUseBlock): ToolCallData {
  return {
    toolCallId: block.id,
    kind: guessToolKind(block.name),
    title: block.name,
    status: 'in_progress',
    rawInput: block.input as string | object | undefined,
    timestamp: Date.now(),
  };
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function toolResultToContent(block: ToolResultBlock): ToolCallContent[] {
  const content = block.content;
  if (typeof content === 'string') {
    return [{ type: 'content', content: { type: 'text', text: content } }];
  }

  if (Array.isArray(content)) {
    const items: ToolCallContent[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      if ('type' in entry && entry.type === 'text' && 'text' in entry) {
        items.push({
          type: 'content',
          content: { type: 'text', text: String(entry.text) },
        });
      }
    }
    if (items.length > 0) {
      return items;
    }
  }

  if (content !== undefined) {
    return [
      {
        type: 'content',
        content: { type: 'text', text: JSON.stringify(content) },
      },
    ];
  }

  return [];
}

function upsertToolCall(
  state: StreamState,
  toolCall: ToolCallData,
): ToolCallData {
  const existing = state.toolCalls.get(toolCall.toolCallId);
  if (!existing) {
    state.toolCalls.set(toolCall.toolCallId, toolCall);
    return toolCall;
  }

  const merged: ToolCallData = {
    ...existing,
    ...toolCall,
    rawInput: toolCall.rawInput ?? existing.rawInput,
    content: toolCall.content ?? existing.content,
    locations: toolCall.locations ?? existing.locations,
  };
  state.toolCalls.set(toolCall.toolCallId, merged);
  return merged;
}

export class SessionRunner {
  private clients: Set<WebSocket> = new Set();
  private queryInstance: Query | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  private streamState = createStreamState();
  private pendingPermissions = new Map<string, PendingPermission>();
  private lastUserMessageId: string | null = null;
  private readonly sessionIdReady: Promise<string>;
  private resolveSessionIdReady: ((sessionId: string) => void) | null = null;

  constructor(
    private sessionId: string | null,
    private readonly cwd: string = process.cwd(),
  ) {
    this.sessionIdReady = new Promise((resolve) => {
      this.resolveSessionIdReady = resolve;
    });

    if (this.sessionId) {
      this.resolveSessionId(this.sessionId);
    }
  }

  static async createNew(cwd: string = process.cwd()): Promise<SessionRunner> {
    const runner = new SessionRunner(null, cwd);
    await runner.ensureQuery();
    await runner.waitForSessionId();
    return runner;
  }

  getSessionId(): string {
    return this.sessionId ?? '';
  }

  async waitForSessionId(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }
    return this.sessionIdReady;
  }

  private resolveSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    if (this.resolveSessionIdReady) {
      this.resolveSessionIdReady(sessionId);
      this.resolveSessionIdReady = null;
    }
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      void this.shutdown();
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  private async ensureQuery(): Promise<void> {
    if (this.queryInstance) {
      return;
    }

    this.inputQueue = new AsyncQueue<SDKUserMessage>();

    const sessionService = new SessionService(this.cwd);
    const resumeSessionId =
      this.sessionId && (await sessionService.sessionExists(this.sessionId))
        ? this.sessionId
        : undefined;

    const options = {
      cwd: this.cwd,
      includePartialMessages: true,
      // Use globally installed 'qwen' command instead of bundled CLI
      pathToQwenExecutable: 'qwen',
      env: resumeSessionId
        ? { QWEN_CODE_RESUME_SESSION_ID: resumeSessionId }
        : undefined,
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        context: {
          signal: AbortSignal;
          suggestions?: PermissionSuggestion[] | null;
        },
      ) => this.handlePermissionRequest(toolName, input, context),
    };

    this.queryInstance = query({ prompt: this.inputQueue, options });
    if (resumeSessionId) {
      this.resolveSessionId(resumeSessionId);
    }

    void this.consumeMessages(this.queryInstance);
  }

  private async consumeMessages(queryInstance: Query): Promise<void> {
    try {
      for await (const message of queryInstance as AsyncIterable<SDKMessage>) {
        this.handleSdkMessage(message);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      // Exit code 130 means user interrupted (SIGINT), not a real error
      const isUserInterrupt =
        errorMessage.includes('code 130') || errorMessage.includes('SIGINT');
      if (!isUserInterrupt) {
        console.error('SDK message loop error:', error);
        this.broadcast({ type: 'error', message: errorMessage });
      }
      // Always send stream_end to reset client state
      this.broadcast({ type: 'stream_end' });
      resetStreamState(this.streamState);
    }
  }

  private handleSdkMessage(message: SDKMessage): void {
    if (isSDKSystemMessage(message)) {
      this.handleSystemMessage(message);
      return;
    }

    if (isSDKPartialAssistantMessage(message)) {
      this.handleStreamEvent(message);
      return;
    }

    if (isSDKAssistantMessage(message)) {
      this.handleAssistantMessage(message);
      return;
    }

    if (isSDKUserMessage(message)) {
      this.handleSdkUserMessage(message);
      return;
    }

    if (isSDKResultMessage(message)) {
      this.handleResultMessage(message);
    }
  }

  private handleSystemMessage(message: SDKSystemMessage): void {
    // Only update session ID if we don't have one yet (new session)
    // For resumed sessions, keep the original session ID
    if (message.session_id && !this.sessionId) {
      this.resolveSessionId(message.session_id);
    }
    // Broadcast session info to clients
    this.broadcast({
      type: 'session_info',
      version: message.qwen_code_version ?? '',
      model: message.model ?? '',
      contextWindow: 200000,
    });
  }

  private handleStreamEvent(event: SDKPartialAssistantMessage): void {
    const streamEvent = event.event;

    switch (streamEvent.type) {
      case 'message_start':
        resetStreamState(this.streamState);
        this.streamState.assistantMessageId = streamEvent.message.id;
        this.streamState.thinkingMessageId = null;
        break;
      case 'content_block_start': {
        const block = streamEvent.content_block as ContentBlock;
        if (block.type === 'thinking') {
          const thinkingId =
            this.streamState.thinkingMessageId ??
            `${this.streamState.assistantMessageId ?? randomUUID()}-thinking`;
          this.streamState.thinkingMessageId = thinkingId;
          this.broadcast({
            type: 'thinking',
            uuid: thinkingId,
            parentUuid: this.lastUserMessageId,
            sessionId: this.getSessionId(),
            timestamp: new Date().toISOString(),
            message: {
              role: 'thinking',
              parts: [{ text: '' }],
            },
          });
        }

        if (block.type === 'tool_use') {
          const toolBlock = block as ToolUseBlock;
          const toolCall = buildToolCallData(toolBlock);
          this.streamState.toolCalls.set(toolCall.toolCallId, toolCall);
          this.streamState.toolCallIndexes.set(
            streamEvent.index,
            toolCall.toolCallId,
          );

          this.broadcast({
            type: 'tool_call',
            uuid: toolCall.toolCallId,
            parentUuid: this.streamState.assistantMessageId,
            sessionId: this.getSessionId(),
            timestamp: new Date().toISOString(),
            toolCall,
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = streamEvent.delta;
        const assistantId = this.streamState.assistantMessageId ?? randomUUID();
        this.streamState.assistantMessageId = assistantId;

        if (delta.type === 'text_delta') {
          this.streamState.textContent += delta.text;
          this.broadcast({
            type: 'assistant_message',
            uuid: assistantId,
            parentUuid: this.lastUserMessageId,
            sessionId: this.getSessionId(),
            timestamp: new Date().toISOString(),
            streaming: true,
            message: {
              role: 'assistant',
              parts: [{ text: this.streamState.textContent }],
            },
          });
        }

        if (delta.type === 'thinking_delta') {
          this.streamState.thinkingContent += delta.thinking;
          const thinkingId =
            this.streamState.thinkingMessageId ?? `${assistantId}-thinking`;
          this.streamState.thinkingMessageId = thinkingId;
          this.broadcast({
            type: 'thinking',
            uuid: thinkingId,
            parentUuid: this.lastUserMessageId,
            sessionId: this.getSessionId(),
            timestamp: new Date().toISOString(),
            message: {
              role: 'thinking',
              parts: [{ text: this.streamState.thinkingContent }],
            },
          });
        }

        if (delta.type === 'input_json_delta') {
          const toolCallId = this.streamState.toolCallIndexes.get(
            streamEvent.index,
          );
          if (!toolCallId) {
            break;
          }
          const toolCall = this.streamState.toolCalls.get(toolCallId);
          if (!toolCall) {
            break;
          }
          try {
            toolCall.rawInput = JSON.parse(delta.partial_json);
          } catch {
            toolCall.rawInput = delta.partial_json;
          }
          this.streamState.toolCalls.set(toolCallId, toolCall);
          this.broadcast({
            type: 'tool_call',
            uuid: toolCall.toolCallId,
            parentUuid: assistantId,
            sessionId: this.getSessionId(),
            timestamp: new Date().toISOString(),
            toolCall,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private handleAssistantMessage(message: SDKAssistantMessage): void {
    this.streamState.assistantMessageId = message.uuid;
    const blocks = message.message?.content ?? [];
    const text = extractTextFromBlocks(blocks);

    if (text) {
      this.broadcast({
        type: 'assistant_message',
        uuid: message.uuid,
        parentUuid: this.lastUserMessageId,
        sessionId: this.getSessionId(),
        timestamp: new Date().toISOString(),
        streaming: false,
        message: {
          role: 'assistant',
          parts: [{ text }],
        },
      });
    }

    for (const block of blocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ('type' in block && block.type === 'tool_use') {
        const toolBlock = block as ToolUseBlock;
        const toolCall = upsertToolCall(
          this.streamState,
          buildToolCallData(toolBlock),
        );
        this.broadcast({
          type: 'tool_call',
          uuid: toolCall.toolCallId,
          parentUuid: message.uuid,
          sessionId: this.getSessionId(),
          timestamp: new Date().toISOString(),
          toolCall,
        });
      }
    }
  }

  private handleSdkUserMessage(message: SDKUserMessage): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ('type' in block && block.type === 'tool_result') {
        const toolResult = block as ToolResultBlock;
        const existing = this.streamState.toolCalls.get(toolResult.tool_use_id);
        const toolCall: ToolCallData = {
          toolCallId: toolResult.tool_use_id,
          kind: existing?.kind ?? 'other',
          title: existing?.title ?? toolResult.tool_use_id,
          status: toolResult.is_error ? 'failed' : 'completed',
          rawInput: existing?.rawInput,
          content: toolResultToContent(toolResult),
          locations: existing?.locations,
          timestamp: existing?.timestamp ?? Date.now(),
        };

        const merged = upsertToolCall(this.streamState, toolCall);
        this.broadcast({
          type: 'tool_call',
          uuid: merged.toolCallId,
          parentUuid: this.streamState.assistantMessageId,
          sessionId: this.getSessionId(),
          timestamp: new Date().toISOString(),
          toolCall: merged,
        });
      }
    }
  }

  private handleResultMessage(message: SDKResultMessage): void {
    if (message.is_error) {
      this.broadcast({ type: 'error', message: 'CLI execution failed' });
    }
    // Broadcast usage information
    const usage = message.usage;
    if (usage) {
      // Get contextWindow from modelUsage if available
      let contextWindow = 200000; // default fallback
      if (message.modelUsage) {
        const modelUsages = Object.values(message.modelUsage);
        if (modelUsages.length > 0 && modelUsages[0].contextWindow) {
          contextWindow = modelUsages[0].contextWindow;
        }
      }
      this.broadcast({
        type: 'usage_update',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        contextWindow,
      });
    }
    this.broadcast({ type: 'stream_end' });
    resetStreamState(this.streamState);
  }

  private async handlePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    context: {
      signal: AbortSignal;
      suggestions?: PermissionSuggestion[] | null;
    },
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const timeoutMs = 60_000;

    const options = context.suggestions?.map((suggestion) => ({
      name: suggestion.label,
      kind: suggestion.type,
      optionId: suggestion.type,
    }));

    const permissionRequest: PermissionRequest = {
      id: requestId,
      operation: toolName,
      args: input,
      description: `Allow ${toolName}?`,
      options,
    };

    this.broadcast({ type: 'permission_request', ...permissionRequest });

    return new Promise((resolve) => {
      const onAbort = () => {
        const pending = this.pendingPermissions.get(requestId);
        if (pending?.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        this.pendingPermissions.delete(requestId);
        resolve({ behavior: 'deny', message: 'Permission request cancelled' });
      };

      context.signal.addEventListener('abort', onAbort, { once: true });

      const timeoutId = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        resolve({ behavior: 'deny', message: 'Permission request timeout' });
      }, timeoutMs);

      this.pendingPermissions.set(requestId, {
        resolve: (result) => {
          context.signal.removeEventListener('abort', onAbort);
          clearTimeout(timeoutId);
          resolve(result);
        },
        signal: context.signal,
        input,
        timeoutId,
      });
    });
  }

  async handleUserMessage(content: string): Promise<void> {
    await this.ensureQuery();
    if (!this.inputQueue) {
      throw new Error('Input queue not initialized');
    }

    resetStreamState(this.streamState);

    const sessionId = await this.waitForSessionId();

    const userMessage: SDKUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    };

    this.lastUserMessageId = userMessage.uuid ?? null;

    this.broadcast({
      type: 'user_message',
      uuid: userMessage.uuid,
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        parts: [{ text: content }],
      },
    });

    this.broadcast({ type: 'stream_start' });

    this.inputQueue.push(userMessage);
  }

  cancel(): void {
    if (this.queryInstance) {
      this.queryInstance.interrupt().catch((error) => {
        // Ignore "Transport not ready" errors - this happens when the process is already terminated
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Transport not ready')) {
          console.error('Error interrupting query:', error);
        }
      });
    }
    // Always send stream_end to reset client state
    this.broadcast({ type: 'stream_end' });
    resetStreamState(this.streamState);
  }

  handlePermissionResponse(message: {
    optionId: string;
    requestId?: string;
  }): void {
    if (!message.requestId) {
      return;
    }
    const pending = this.pendingPermissions.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pendingPermissions.delete(message.requestId);
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    const optionId = message.optionId.toLowerCase();
    const allow =
      optionId === 'allow' ||
      optionId === 'allow_once' ||
      optionId === 'modify';

    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: 'deny', message: 'Denied by user' });
    }
  }

  async getHistory(): Promise<Message[]> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      return [];
    }

    const sessionService = new SessionService(this.cwd);
    const session = await sessionService.loadSession(sessionId);
    if (!session) {
      return [];
    }

    const messages: Message[] = [];
    const records = session.conversation.messages as ChatRecord[];

    for (const record of records) {
      if (record.type === 'system') {
        continue;
      }

      const parts = record.message?.parts as
        | Array<Record<string, unknown>>
        | undefined;

      if (record.type === 'tool_result') {
        const toolCallId = record.toolCallResult?.callId ?? record.uuid;
        const toolName = this.extractToolNameFromParts(parts);
        const toolCall: ToolCallData = {
          toolCallId,
          kind: 'other',
          title: toolName || toolCallId,
          status: record.toolCallResult?.error ? 'failed' : 'completed',
          content: this.buildToolCallContent(
            parts,
            record.toolCallResult?.resultDisplay,
            record.toolCallResult?.error,
          ),
          timestamp: Number.isNaN(Date.parse(record.timestamp))
            ? Date.now()
            : Date.parse(record.timestamp),
        };

        messages.push({
          uuid: toolCallId,
          parentUuid: record.parentUuid,
          sessionId: record.sessionId,
          timestamp: record.timestamp,
          type: 'tool_call',
          toolCall,
        });
        continue;
      }

      const { text, thought } = this.splitTextParts(parts);

      if (thought) {
        messages.push({
          uuid: `${record.uuid}-thought`,
          parentUuid: record.parentUuid,
          sessionId: record.sessionId,
          timestamp: record.timestamp,
          type: 'thinking',
          message: {
            role: 'thinking',
            parts: [{ text: thought }],
          },
        });
      }

      if (text) {
        const role = record.type === 'user' ? 'user' : 'assistant';
        messages.push({
          uuid: record.uuid,
          parentUuid: record.parentUuid,
          sessionId: record.sessionId,
          timestamp: record.timestamp,
          type: record.type === 'user' ? 'user' : 'assistant',
          message: {
            role,
            parts: [{ text }],
          },
        });
      }
    }

    return messages;
  }

  private splitTextParts(parts: Array<Record<string, unknown>> | undefined): {
    text: string;
    thought: string;
  } {
    const textParts: string[] = [];
    const thoughtParts: string[] = [];

    for (const part of parts ?? []) {
      if ('text' in part && typeof part.text === 'string') {
        const isThought = (part as { thought?: boolean }).thought ?? false;
        if (isThought) {
          thoughtParts.push(part.text);
        } else {
          textParts.push(part.text);
        }
      }
    }

    return { text: textParts.join(''), thought: thoughtParts.join('') };
  }

  private extractToolNameFromParts(
    parts: Array<Record<string, unknown>> | undefined,
  ): string {
    for (const part of parts ?? []) {
      if (
        'functionResponse' in part &&
        typeof part.functionResponse === 'object' &&
        part.functionResponse &&
        'name' in (part.functionResponse as Record<string, unknown>)
      ) {
        const name = (part.functionResponse as { name?: unknown }).name;
        if (typeof name === 'string') {
          return name;
        }
      }
      if (
        'functionCall' in part &&
        typeof part.functionCall === 'object' &&
        part.functionCall &&
        'name' in (part.functionCall as Record<string, unknown>)
      ) {
        const name = (part.functionCall as { name?: unknown }).name;
        if (typeof name === 'string') {
          return name;
        }
      }
    }
    return '';
  }

  private buildToolCallContent(
    parts: Array<Record<string, unknown>> | undefined,
    resultDisplay: unknown,
    error: unknown,
  ): ToolCallContent[] {
    if (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return [
        {
          type: 'content',
          content: { type: 'text', text: errorMessage },
        },
      ];
    }

    const content: ToolCallContent[] = [];
    for (const part of parts ?? []) {
      if ('text' in part && typeof part.text === 'string' && part.text) {
        content.push({
          type: 'content',
          content: { type: 'text', text: part.text },
        });
      }
      if (
        'functionResponse' in part &&
        typeof part.functionResponse === 'object' &&
        part.functionResponse
      ) {
        try {
          const response = (part.functionResponse as { response?: unknown })
            .response as Record<string, unknown>;
          const outputField = response?.['output'];
          const errorField = response?.['error'];
          const responseText =
            typeof outputField === 'string'
              ? outputField
              : typeof errorField === 'string'
                ? errorField
                : JSON.stringify(response);
          content.push({
            type: 'content',
            content: { type: 'text', text: responseText },
          });
        } catch {
          // Ignore serialization errors
        }
      }
    }

    if (content.length > 0) {
      return content;
    }

    if (resultDisplay !== undefined) {
      const text =
        typeof resultDisplay === 'string'
          ? resultDisplay
          : JSON.stringify(resultDisplay);
      return [{ type: 'content', content: { type: 'text', text } }];
    }

    return [];
  }

  async shutdown(): Promise<void> {
    for (const pending of this.pendingPermissions.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.resolve({ behavior: 'deny', message: 'Session closed' });
    }
    this.pendingPermissions.clear();

    if (this.inputQueue) {
      this.inputQueue.close();
      this.inputQueue = null;
    }

    if (this.queryInstance) {
      await this.queryInstance.close();
      this.queryInstance = null;
    }
  }
}
