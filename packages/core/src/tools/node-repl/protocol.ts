/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StringDecoder } from 'node:string_decoder';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface TrustedPackageFile {
  path: string;
  sha256: string;
}

export interface TrustedPackagePolicyEntry {
  root: string;
  packageName: string;
  entryPath: string;
  entrySha256: string;
  additionalFiles?: TrustedPackageFile[];
  dependencies?: string[];
  allowModelImport?: boolean;
}

export interface TrustedPackageEntry {
  root: string;
  packageName: string;
  packageDir: string;
  entryPath: string;
  entrySha256: string;
  additionalFiles: TrustedPackageFile[];
  dependencies: string[];
  allowModelImport: boolean;
}

export interface InitMessage {
  type: 'init';
  generation: number;
  capabilityToken: string;
  cwd: string;
  homeDir: string;
  tmpDir: string;
  moduleRoots: string[];
  trustedPackages: TrustedPackageEntry[];
  readableRoots: string[];
}

export interface ExecMessage {
  type: 'exec';
  execId: string;
  source: string;
  previousBindingNames: string[];
  bindingExports: Array<{
    bindingName: string;
    exportName: string;
  }>;
  snapshotExportName: string;
  resultExportName?: string;
  requestMeta: Record<string, unknown>;
}

export interface AddModuleRootMessage {
  type: 'addModuleRoot';
  requestId: string;
  path: string;
}

export interface CapabilityResultMessage {
  type: 'capabilityResult';
  capabilityRequestId: string;
  ok: boolean;
  resultJson?: string;
  error?: string;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type HostToKernelMessage =
  | InitMessage
  | ExecMessage
  | AddModuleRootMessage
  | CapabilityResultMessage
  | ShutdownMessage;

export interface ReadyMessage {
  type: 'ready';
  generation: number;
  pid: number;
}

export interface TextOutputMessage {
  type: 'output';
  execId: string | null;
  kind: 'write' | 'console' | 'result';
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
  responseMeta?: Record<string, unknown>;
}

export interface AddModuleRootResultMessage {
  type: 'addModuleRootResult';
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface CapabilityRequestMessage {
  type: 'capabilityRequest';
  capabilityToken: string;
  generation: number;
  execId: string | null;
  capabilityRequestId: string;
  operation: string;
  argsJson: string;
}

export interface TrustedModuleAuditMessage {
  type: 'audit';
  event: 'trustedModuleLoaded';
  generation: number;
  execId: string | null;
  packageName: string;
  modulePath: string;
  version: string | null;
  moduleSha256: string;
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
  | CapabilityRequestMessage
  | TrustedModuleAuditMessage
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
  private utf8 = new StringDecoder('utf8');

  constructor(
    private readonly onFrame: FrameHandler,
    private readonly onError: FrameErrorHandler,
  ) {}

  push(chunk: string | Buffer): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.bufferedBytes += bytes.length;
    const previousLength = this.buffer.length;
    this.buffer += this.utf8.write(bytes);

    let newlineIndex = this.buffer.indexOf('\n', previousLength);
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

    if (this.bufferedBytes > MAX_FRAME_BYTES) {
      this.buffer = '';
      this.bufferedBytes = 0;
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
