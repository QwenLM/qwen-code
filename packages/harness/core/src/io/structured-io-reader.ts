/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview StructuredIOReader — NDJSON stdin reader for SDK communication.
 *
 * Reads JSON Lines from a readable stream (typically process.stdin),
 * parses each line, and routes messages by their `type` field:
 *
 *   - `user`              → User prompt messages (SDKUserMessage)
 *   - `control_request`   → Control requests (initialize, interrupt, etc.)
 *   - `control_response`  → Responses to outbound control requests
 *   - `control_cancel_request` / `control_cancel` → Cancel pending requests
 *   - `keep_alive`        → Heartbeat (discarded)
 *
 * Design:
 *   - Frames messages strictly on LF, preserving Unicode separators in content
 *   - Exposes an async generator for message consumption
 *   - Typed message routing via discriminated union on `type`
 *   - Reports malformed JSON as a fatal input protocol error
 */

import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { parseSdkUserContent } from '../engine/headless-projection.js';
import type {
  ModelStreamUserMessage,
  ModelStreamToolResultMessage,
} from '../provider/modelStreamRequest.js';
import { runLogger } from '../utils/runLogger.js';
import {
  SDKControlRequestEnvelopeSchema,
  SDKControlResponseEnvelopeSchema,
  SDKControlCancelRequestSchema,
  SDKKeepAliveSchema,
} from '../protocol/schemas/control.js';
import {
  HostActionEventSchema,
  type HostActionEvent,
} from '../protocol/schemas/sdk-message.js';
import type {
  CommandMode,
  MessageOrigin,
  SelectedSkillInput,
} from '../input/types.js';

// ---------------------------------------------------------------------------
// Message types (inbound from SDK)
// ---------------------------------------------------------------------------

/**
 * A user message sent from the SDK to drive a new prompt.
 *
 * Wire format:
 * ```json
 * {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
 * ```
 */
export interface InboundUserMessage {
  type: 'user';
  message: ModelStreamUserMessage;
  /** SDK 工具结果在网络入口拆成独立标准工具消息。 */
  toolResults?: readonly ModelStreamToolResultMessage[];
  parent_tool_use_id: string | null;
  custom_context?: Record<string, string>;
  /** Additional headers for this input's first main-model request and its retries. */
  extra_headers?: Record<string, string>;
  /** SDK metadata; timestamps use Unix milliseconds. */
  extra?: Record<string, unknown>;
  /** The client has resolved slash commands, so a leading slash is literal input. */
  client_composed?: boolean;
  /** Skills explicitly selected by the user for this input turn. */
  selected_skills?: SelectedSkillInput[];
  request_set_id?: string;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: 'now' | 'next' | 'later';
  /**
   * When false, append the user message to the transcript without starting an
   * assistant turn. The next queryable user message absorbs it through normal
   * adjacent-user-message normalization.
   */
  shouldQuery?: boolean;
  timestamp?: string;
  uuid?: string;
  session_id?: string;
  commandMode?: CommandMode;
  isMeta?: boolean;
  origin?: MessageOrigin;
  stopHookActive?: boolean;
}

/**
 * A control request sent from the SDK.
 *
 * Wire format:
 * ```json
 * {"type":"control_request","request_id":"abc","request":{"type":"initialize","subtype":"initialize",...}}
 * ```
 */
export interface InboundControlRequest {
  type: 'control_request';
  request_id: string;
  request: {
    type: string;
    subtype?: string;
    [key: string]: unknown;
  };
}

/**
 * A control response sent from the SDK (for bidirectional control requests).
 */
export interface InboundControlResponse {
  type: 'control_response';
  response: {
    subtype: 'success' | 'error';
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
    code?: string;
  };
}

/**
 * A cancel request sent from the SDK to cancel a pending control request.
 */
export interface InboundControlCancelRequest {
  type: 'control_cancel_request' | 'control_cancel';
  request_id: string;
}

/**
 * Heartbeat message (discarded).
 */
export interface InboundKeepAlive {
  type: 'keep_alive';
}

/**
 * Union of all inbound message types from the SDK.
 */
export type InboundMessage =
  | InboundUserMessage
  | InboundControlRequest
  | InboundControlResponse
  | InboundControlCancelRequest
  | HostActionEvent
  | InboundKeepAlive;

const inboundUserEnvelopeSchema = z.object({
  type: z.literal('user'),
  message: z.object({ role: z.literal('user'), content: z.unknown() }),
  parent_tool_use_id: z.string().nullable().default(null),
  custom_context: z.record(z.string(), z.string()).optional(),
  extra_headers: z.record(z.string(), z.string()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  client_composed: z.boolean().optional(),
  selected_skills: z.array(z.object({ name: z.string(), arguments: z.string().optional() })).optional(),
  request_set_id: z.string().optional(),
  isSynthetic: z.boolean().optional(),
  tool_use_result: z.unknown().optional(),
  priority: z.enum(['now', 'next', 'later']).optional(),
  shouldQuery: z.boolean().optional(),
  timestamp: z.string().optional(),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  commandMode: z.enum(['prompt', 'bash', 'task-notification', 'orphaned-permission']).optional(),
  isMeta: z.boolean().optional(),
  stopHookActive: z.boolean().optional(),
  origin: z.union([
    z.object({ kind: z.literal('human') }),
    z.object({ kind: z.literal('task-notification') }),
    z.object({ kind: z.literal('coordinator') }),
    z.object({ kind: z.literal('bridge'), sessionId: z.string().optional() }),
    z.object({
      kind: z.literal('peer'), from: z.string(),
      senderTaskId: z.string().optional(), name: z.string().optional(), body: z.string().optional(),
      transport: z.literal('uds').optional(), msgId: z.string().optional(),
      fromMode: z.enum(['bypass', 'prompting']).optional(), hopChain: z.array(z.string()).optional(),
      attachmentCount: z.number().optional(), selfSent: z.boolean().optional(), knownPeer: z.boolean().optional(),
    }),
  ]).optional(),
});

/** SDK 帧只在真实入口解码，队列与会话内不再携带协议内容块。 */
export function parseInboundUserMessage(value: unknown): InboundUserMessage | undefined {
  const result = inboundUserEnvelopeSchema.safeParse(value);
  if (!result.success) return undefined;
  const input = parseSdkUserContent(result.data.message.content);
  if (!input) return undefined;
  return {
    ...result.data,
    message: { role: 'user', content: input.content },
    ...(input.toolResults.length ? { toolResults: input.toolResults } : {}),
  };
}

// ---------------------------------------------------------------------------
// StructuredIOReader
// ---------------------------------------------------------------------------

export interface StructuredIOReaderOptions {
  /** Readable stream to read from (defaults to process.stdin). */
  input?: NodeJS.ReadableStream;
}

/** 协议错误不携带原始输入或 JSON.parse 的正文片段。 */
export class StructuredInputError extends Error {
  constructor(
    readonly code: 'invalid_stream_json',
    readonly lineNumber: number,
    readonly charCount: number,
  ) {
    super(`${code}: stream-json input line ${lineNumber} (${charCount} chars)`);
    this.name = 'StructuredInputError';
  }
}

/**
 * NDJSON reader that parses stdin line-by-line and yields typed messages.
 *
 * Usage:
 * ```ts
 * const reader = new StructuredIOReader();
 * for await (const msg of reader.messages()) {
 *   switch (msg.type) {
 *     case 'user': handleUserMessage(msg); break;
 *     case 'control_request': handleControlRequest(msg); break;
 *   }
 * }
 * ```
 */
export class StructuredIOReader {
  private readonly input: NodeJS.ReadableStream;
  private stream: PassThrough | null = null;
  private detachInput: (() => void) | undefined;
  private closed = false;

  constructor(options?: StructuredIOReaderOptions) {
    this.input = options?.input ?? process.stdin;
  }

  /**
   * Async generator that yields parsed inbound messages.
   *
   * The generator completes when:
   * - The input stream closes (SDK process exited or stdin ended)
   * - close() is called
   */
  async *messages(): AsyncGenerator<InboundMessage, void, unknown> {
    let lineNumber = 0;
    try {
      for await (const line of this.lines()) {
        if (this.closed) break;
        lineNumber++;
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          throw new StructuredInputError(
            'invalid_stream_json',
            lineNumber,
            line.length,
          );
        }

        // Validate that it has a `type` field
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
          runLogger.warn(
            '[StructuredIOReader] Skipping message without type field:',
            { lineNumber, charCount: line.length },
          );
          continue;
        }

        const type = parsed['type'];

        switch (type) {
          case 'user': {
            const message = parseInboundUserMessage(parsed);
            if (!message) {
              runLogger.warn('[StructuredIOReader] Rejecting malformed user message', {
                lineNumber, charCount: line.length,
              });
              continue;
            }
            yield message;
            break;
          }
          case 'feedback': {
            const result = HostActionEventSchema().safeParse(parsed);
            if (!result.success) {
              runLogger.warn(
                '[StructuredIOReader] Rejecting malformed feedback/action event',
                { lineNumber, charCount: line.length },
              );
              continue;
            }
            yield result.data;
            break;
          }
          case 'control_request': {
            const result = SDKControlRequestEnvelopeSchema().safeParse(parsed);
            if (!result.success) {
              runLogger.warn(
                '[StructuredIOReader] Rejecting malformed control_request:',
                { lineNumber, charCount: line.length },
              );
              continue;
            }
            yield result.data as unknown as InboundMessage;
            break;
          }
          case 'control_response': {
            const result = SDKControlResponseEnvelopeSchema().safeParse(parsed);
            if (!result.success) {
              runLogger.warn(
                '[StructuredIOReader] Rejecting malformed control_response:',
                { lineNumber, charCount: line.length },
              );
              continue;
            }
            yield result.data as unknown as InboundMessage;
            break;
          }
          case 'control_cancel_request':
          case 'control_cancel': {
            const result = SDKControlCancelRequestSchema().safeParse(parsed);
            if (!result.success) {
              runLogger.warn(
                '[StructuredIOReader] Rejecting malformed control_cancel:',
                { lineNumber, charCount: line.length },
              );
              continue;
            }
            yield result.data as unknown as InboundMessage;
            break;
          }
          case 'keep_alive': {
            const result = SDKKeepAliveSchema().safeParse(parsed);
            if (!result.success) continue;
            yield result.data as unknown as InboundMessage;
            break;
          }
          default:
            runLogger.warn('[StructuredIOReader] Unknown message type', {
              lineNumber,
              charCount: line.length,
            });
            break;
        }
      }
    } catch (error) {
      if (error instanceof StructuredInputError) {
        runLogger.warn(`[StructuredIOReader] ${error.message}`);
      }
      throw error;
    } finally {
      this.cleanup();
    }
  }

  /**
   * Close the reader. Stops the async generator.
   */
  close(): void {
    this.closed = true;
    this.cleanup();
  }

  private async *lines(): AsyncGenerator<string> {
    if (this.closed || this.input.readable === false) return;
    // 独立流负责 UTF-8 跨块解码和背压；关闭读取器不销毁调用方的 stdin。
    const stream = new PassThrough();
    stream.setEncoding('utf8');
    this.stream = stream;
    const onError = (error: Error) => stream.destroy(error);
    const onClose = () => stream.end();
    this.input.on('error', onError);
    this.input.on('close', onClose);
    this.detachInput = () => {
      this.input.unpipe(stream);
      this.input.off('error', onError);
      this.input.off('close', onClose);
    };
    this.input.pipe(stream);

    let parts: string[] = [];
    try {
      for await (const chunk of stream) {
        if (this.closed) return;
        const text = String(chunk);
        let start = 0;
        for (;;) {
          const newline = text.indexOf('\n', start);
          const part = text.slice(start, newline === -1 ? undefined : newline);
          if (part) parts.push(part);
          if (newline === -1) break;
          yield parts.join('');
          if (this.closed) return;
          parts = [];
          start = newline + 1;
        }
      }
      // 兼容合法的无换行 EOF 尾部；异常关闭不会把残缺消息当成成功 EOF。
      if (!this.closed && parts.length > 0) yield parts.join('');
    } catch (error) {
      if (!this.closed) throw error;
    }
  }

  private cleanup(): void {
    this.detachInput?.();
    this.detachInput = undefined;
    this.stream?.destroy();
    this.stream = null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract prompt text from InboundUserMessage
// ---------------------------------------------------------------------------

/**
 * Extract the text prompt from an InboundUserMessage.
 *
 * The SDK sends user messages with content blocks. This helper concatenates
 * all text blocks into a single prompt string.
 *
 * @returns The concatenated text, or empty string if no text blocks found.
 */
export function extractPromptText(msg: InboundUserMessage): string {
  const content = msg.message.content;
  if (typeof content === 'string') return content;
  return content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}
