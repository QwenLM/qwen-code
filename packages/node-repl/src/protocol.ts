/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StringDecoder } from 'node:string_decoder';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type NodeReplBindingKind = 'const' | 'let' | 'var';

export interface NodeReplBindingDescriptor {
  name: string;
  kind: NodeReplBindingKind;
}

export interface NodeReplModuleRoot {
  path: string;
  canonicalPath: string;
}

export interface InitMessage {
  type: 'init';
  generation: number;
  cwd: string;
  homeDir: string;
  tmpDir: string;
  moduleRoots: NodeReplModuleRoot[];
  readableRoots: string[];
}

export interface ExecMessage {
  type: 'exec';
  execId: string;
  source: string;
  previousBindings: NodeReplBindingDescriptor[];
  bindingExports: Array<{
    bindingName: string;
    bindingKind: NodeReplBindingKind;
    exportName: string;
  }>;
  snapshotExportName: string;
}

export interface AddModuleRootMessage {
  type: 'addModuleRoot';
  requestId: string;
  root: NodeReplModuleRoot;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type HostToKernelMessage =
  | InitMessage
  | ExecMessage
  | AddModuleRootMessage
  | ShutdownMessage;

export interface ReadyMessage {
  type: 'ready';
  generation: number;
  pid: number;
}

export interface TextOutputMessage {
  type: 'output';
  execId: string | null;
  kind: 'write' | 'console';
  level?: string;
  text: string;
}

export interface ImageMessage {
  type: 'image';
  execId: string | null;
  data: string;
  mimeType: string;
}

export interface ExecResultMessage {
  type: 'execResult';
  execId: string;
  status: 'ok' | 'error';
  bindingNames: string[];
  rawTextTruncated?: boolean;
  imagesDropped?: number;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
}

export interface AddModuleRootResultMessage {
  type: 'addModuleRootResult';
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface FatalMessage {
  type: 'fatal';
  message: string;
}

export type KernelToHostMessage =
  | ReadyMessage
  | TextOutputMessage
  | ImageMessage
  | ExecResultMessage
  | AddModuleRootResultMessage
  | FatalMessage;

export function encodeFrame(message: object): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_FRAME_BYTES) {
    throw new Error(`protocol frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return `${line}\n`;
}

export type FrameHandler = (frame: unknown) => void;
export type FrameErrorHandler = (error: Error) => void;

export class FrameDecoder {
  private buffer = '';
  private bufferedBytes = 0;
  private scanFrom = 0;
  private utf8 = new StringDecoder('utf8');

  constructor(
    private readonly onFrame: FrameHandler,
    private readonly onError: FrameErrorHandler,
  ) {}

  push(chunk: string | Buffer): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.bufferedBytes += bytes.length;
    // Where to begin scanning for the next newline. Normally the retained
    // buffer is a newline-free partial frame, so we can skip it. If a previous
    // drain was interrupted (a throwing frame handler), complete frames may
    // still be buffered and we must rescan from the start.
    const searchFrom = this.scanFrom;
    this.buffer += this.utf8.write(bytes);

    let drained = false;
    try {
      let newlineIndex = this.buffer.indexOf('\n', searchFrom);
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        const frameBytes = Buffer.byteLength(line, 'utf8') + 1;
        this.bufferedBytes = Math.max(0, this.bufferedBytes - frameBytes);
        if (frameBytes > MAX_FRAME_BYTES) {
          this.onError(
            new Error(`protocol frame exceeds ${MAX_FRAME_BYTES} bytes`),
          );
        } else if (line.trim().length > 0) {
          this.decodeLine(line);
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
      drained = true;
    } finally {
      this.scanFrom = drained ? this.buffer.length : 0;
    }

    if (this.bufferedBytes > MAX_FRAME_BYTES) {
      this.buffer = '';
      this.bufferedBytes = 0;
      this.scanFrom = 0;
      this.utf8 = new StringDecoder('utf8');
      this.onError(
        new Error(
          `protocol stream exceeded ${MAX_FRAME_BYTES} bytes without a terminator`,
        ),
      );
    }
  }

  private decodeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onError(
        new Error(
          `undecodable protocol frame (${Buffer.byteLength(line, 'utf8')} bytes)`,
        ),
      );
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      this.onError(new Error('protocol frame missing string "type"'));
      return;
    }
    this.onFrame(parsed);
  }
}
