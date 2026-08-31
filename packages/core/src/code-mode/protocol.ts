/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeModeToolResult } from './tool-call-runtime.js';

export const CODE_MODE_MAX_FRAME_BYTES = 1_048_576;
export const CODE_MODE_MAX_SOURCE_CHARS = 131_072;
export const CODE_MODE_MAX_OUTPUT_CHARS = 100_000;
export const CODE_MODE_TIMEOUT_MS = 30_000;

export interface ExecuteMessage {
  type: 'execute';
  source: string;
  tools: Array<{
    name: string;
    jsName: string;
    description: string;
    deferred: boolean;
  }>;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  ok: boolean;
  result?: CodeModeToolResult;
  error?: string;
}

export type ParentMessage = ExecuteMessage | ToolResultMessage;

export interface ToolCallMessage {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface CompleteMessage {
  type: 'complete';
  output: string;
  value?: unknown;
  content?: Array<{ type: 'image' | 'audio'; value: unknown }>;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
}

export type HostMessage = ToolCallMessage | CompleteMessage | ErrorMessage;

export function encodeFrame(message: ParentMessage | HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.byteLength > CODE_MODE_MAX_FRAME_BYTES) {
    throw new Error('Code mode protocol frame exceeds the size limit.');
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder<T> {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): T[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: T[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > CODE_MODE_MAX_FRAME_BYTES) {
        throw new Error('Code mode protocol frame exceeds the size limit.');
      }
      if (this.buffer.byteLength < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      messages.push(JSON.parse(body.toString('utf8')) as T);
    }
    return messages;
  }
}
