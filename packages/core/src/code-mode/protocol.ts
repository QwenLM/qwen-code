/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeModeToolResult } from './tool-call-runtime.js';

export const CODE_MODE_MAX_CONTROL_FRAME_BYTES = 1_048_576;
export const CODE_MODE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CODE_MODE_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const CODE_MODE_MAX_MEDIA_ITEMS = 16;
export const CODE_MODE_MAX_SOURCE_CHARS = 131_072;
export const CODE_MODE_MAX_OUTPUT_CHARS = 100_000;
export const CODE_MODE_TIMEOUT_MS = 30_000;

export interface CodeModeContentItem {
  type: 'image' | 'audio';
  mimeType: string;
  data: string;
}

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
  content?: CodeModeContentItem[];
}

export interface ErrorMessage {
  type: 'error';
  error: string;
}

export type HostMessage = ToolCallMessage | CompleteMessage | ErrorMessage;

function hasBoundedImageContent(message: ParentMessage | HostMessage): boolean {
  if (message.type !== 'tool_result') return false;
  const content = message.result?.content;
  if (
    !Array.isArray(content) ||
    content.length === 0 ||
    content.length > CODE_MODE_MAX_MEDIA_ITEMS
  ) {
    return false;
  }
  let decodedBytes = 0;
  for (const item of content) {
    if (
      item?.type !== 'image' ||
      typeof item.mimeType !== 'string' ||
      !item.mimeType.toLowerCase().startsWith('image/') ||
      typeof item.data !== 'string' ||
      item.data.length === 0
    ) {
      return false;
    }
    const padding = item.data.endsWith('==')
      ? 2
      : item.data.endsWith('=')
        ? 1
        : 0;
    decodedBytes += Math.floor((item.data.length * 3) / 4) - padding;
    if (decodedBytes > CODE_MODE_MAX_MEDIA_BYTES) return false;
  }
  return true;
}

function maxFrameBytes(message: ParentMessage | HostMessage): number {
  if (message.type === 'complete') return CODE_MODE_MAX_FRAME_BYTES;
  if (hasBoundedImageContent(message)) return CODE_MODE_MAX_FRAME_BYTES;
  return CODE_MODE_MAX_CONTROL_FRAME_BYTES;
}

export function encodeFrame(message: ParentMessage | HostMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  if (body.byteLength > maxFrameBytes(message)) {
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
      const message = JSON.parse(body.toString('utf8')) as T;
      if (length > maxFrameBytes(message as ParentMessage | HostMessage)) {
        throw new Error('Code mode protocol frame exceeds the size limit.');
      }
      messages.push(message);
    }
    return messages;
  }
}
