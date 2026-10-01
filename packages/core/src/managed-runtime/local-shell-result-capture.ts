/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:os';
import type {
  ShellExecutionResult,
  ShellRawCaptureSink,
} from '../services/shellExecutionService.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_LIMITS,
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultManifest,
  parseToolResultPage,
  type ToolResultContentDescriptor,
  type ToolResultEnvelope,
  type ToolResultPageReference,
  type ToolResultSegment,
} from './managed-tool-result.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';

const SEGMENT_BYTES = 1024 * 1024;
const SEGMENTS_PER_PAGE = 512;

type StreamId = 'stdout' | 'stderr';

interface StreamState {
  readonly id: StreamId;
  buffer: Buffer;
  readonly hash: ReturnType<typeof createHash>;
  readonly pages: ToolResultPageReference[];
  readonly pendingSegments: ToolResultSegment[];
  used: number;
  byteLength: number;
  ordinal: number;
  pageOffset: number;
  pageOrdinal: number;
  observed: number;
  ended: boolean;
  sealed: boolean;
  /** Serializes buffer use: the pipe pause is advisory, and Node resumes it on exit. */
  queue: Promise<void>;
}

function stream(id: StreamId): StreamState {
  return {
    id,
    buffer: Buffer.allocUnsafe(SEGMENT_BYTES),
    hash: createHash('sha256'),
    pages: [],
    pendingSegments: [],
    used: 0,
    byteLength: 0,
    ordinal: 0,
    pageOffset: 0,
    pageOrdinal: 0,
    observed: 0,
    ended: false,
    sealed: false,
    queue: Promise.resolve(),
  };
}

function signalName(value: number | null): string | null {
  if (value === null) return null;
  return (
    Object.entries(constants.signals).find(
      ([name, number]) => name.startsWith('SIG') && number === value,
    )?.[0] ?? null
  );
}

/** Captures one foreground Shell invocation into retained Session segments. */
export class LocalShellResultCapture implements ShellRawCaptureSink {
  private readonly streams = {
    stdout: stream('stdout'),
    stderr: stream('stderr'),
  };
  private started = false;
  private processResult: ShellExecutionResult | null = null;
  private failed = false;
  private failureReason:
    | 'storage_failed'
    | 'size_limit'
    | 'quota_exhausted'
    | null = null;
  private finalEnvelope: ToolResultEnvelope | null = null;

  constructor(
    private readonly store: ToolResultSegmentStore,
    private readonly resources: ManagedSessionResourceStore,
    readonly identity: ToolResultExpectedIdentity,
    private readonly assertWritable: () => Promise<void> = async () => {},
  ) {
    if (identity.revision !== 1) {
      throw new Error('Foreground Shell capture requires revision 1.');
    }
  }

  setStarted(_pid: number): void {
    this.started = true;
  }

  setProcessResult(result: ShellExecutionResult): void {
    this.processResult = result;
  }

  failCapture(): void {
    this.fail(new Error('Capture transport failed.'));
  }

  write(id: StreamId, chunk: Buffer): Promise<void> {
    const state = this.streams[id];
    state.observed += chunk.byteLength;
    return (state.queue = state.queue.then(() => this.append(state, chunk)));
  }

  private async append(state: StreamState, chunk: Buffer): Promise<void> {
    if (this.failed || state.ended) return;
    try {
      for (let offset = 0; offset < chunk.byteLength; ) {
        const length = Math.min(
          SEGMENT_BYTES - state.used,
          chunk.byteLength - offset,
        );
        chunk.copy(state.buffer, state.used, offset, offset + length);
        state.used += length;
        offset += length;
        if (state.used === SEGMENT_BYTES) await this.publishSegment(state);
      }
    } catch (cause) {
      this.fail(cause);
    }
  }

  finish(id: StreamId, complete: boolean): Promise<void> {
    const state = this.streams[id];
    return (state.queue = state.queue.then(() => this.end(state, complete)));
  }

  private async end(state: StreamState, complete: boolean): Promise<void> {
    const id = state.id;
    if (state.ended) return;
    state.ended = true;
    try {
      if (!this.failed && state.used > 0) await this.publishSegment(state);
      if (!this.failed && complete) {
        const sealed = await this.store.seal({
          captureId: this.identity.captureId,
          streamId: id,
          segmentCount: state.ordinal,
          byteLength: state.byteLength,
          digest: state.hash.copy().digest('hex'),
        });
        if (sealed.status !== 'ok') throw new Error(sealed.code);
        state.sealed = true;
      }
    } catch (cause) {
      this.fail(cause);
    } finally {
      // Later writes are ignored; the retained bytes live in the store.
      state.buffer = Buffer.alloc(0);
      state.used = 0;
    }
  }

  private fail(cause: unknown): void {
    this.failed = true;
    this.failureReason =
      cause instanceof Error && cause.message === 'size_limit'
        ? 'size_limit'
        : cause instanceof Error && cause.message === 'quota_exhausted'
          ? 'quota_exhausted'
          : 'storage_failed';
  }

  private async publishSegment(state: StreamState): Promise<void> {
    await this.assertWritable();
    if (state.ordinal > MANAGED_TOOL_RESULT_LIMITS.maxOrdinal) {
      throw new Error('size_limit');
    }
    const bytes = state.buffer.subarray(0, state.used);
    const published = await this.store.publish({
      captureId: this.identity.captureId,
      streamId: state.id,
      ordinal: state.ordinal,
      bytes,
    });
    if (published.status !== 'ok') throw new Error(published.code);
    state.hash.update(bytes);
    state.byteLength += bytes.byteLength;
    state.pendingSegments.push({
      byteLength: published.result.byteLength,
      digest: published.result.digest,
    });
    state.ordinal++;
    state.used = 0;
    if (state.pendingSegments.length === SEGMENTS_PER_PAGE) {
      await this.publishPage(state);
    }
  }

  private async publishPage(state: StreamState): Promise<void> {
    if (state.pendingSegments.length === 0) return;
    await this.assertWritable();
    if (state.pages.length >= MANAGED_TOOL_RESULT_LIMITS.maxPagesPerStream) {
      this.failureReason = 'size_limit';
      throw new Error('size_limit');
    }
    const page = parseToolResultPage({
      toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
      type: 'page',
      captureId: this.identity.captureId,
      streamId: state.id,
      firstOrdinal: state.pageOrdinal,
      offset: state.pageOffset,
      segments: state.pendingSegments,
    });
    const bytes = Buffer.from(JSON.stringify(page));
    if (bytes.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxPageBytes) {
      this.failureReason = 'size_limit';
      throw new Error('size_limit');
    }
    const ref = await this.resources.publish(
      MANAGED_TOOL_RESULT_KINDS.page,
      bytes,
    );
    const byteLength = state.pendingSegments.reduce(
      (length, segment) => length + segment.byteLength,
      0,
    );
    state.pages.push({
      ref,
      segmentCount: state.pendingSegments.length,
      byteLength,
    });
    state.pageOffset += byteLength;
    state.pageOrdinal += state.pendingSegments.length;
    state.pendingSegments.length = 0;
  }

  async finalize(
    executionStatus: ToolResultEnvelope['executionStatus'],
    responseParts: readonly unknown[],
    error?: { readonly message: string; readonly type?: string },
  ): Promise<ToolResultEnvelope> {
    if (this.finalEnvelope) return this.finalEnvelope;
    if (!this.started) {
      this.finalEnvelope = {
        executionStatus: 'not_started',
        responseParts,
        ...(error ? { error } : {}),
        capture: null,
      };
      return this.finalEnvelope;
    }
    if (!this.processResult) {
      throw new Error('Started Shell has no physical outcome.');
    }
    if (executionStatus === 'not_started') {
      throw new Error('Started Shell cannot have a not_started result.');
    }
    let pagesAvailable = !this.failed;
    if (pagesAvailable) {
      for (const state of Object.values(this.streams)) {
        try {
          await this.publishPage(state);
        } catch (cause) {
          this.fail(cause);
          pagesAvailable = false;
          break;
        }
      }
    }
    const contents: ToolResultContentDescriptor[] = pagesAvailable
      ? Object.values(this.streams).map((state) => ({
          streamId: state.id,
          role: state.id,
          mimeType: 'application/octet-stream',
          state: state.sealed ? 'sealed' : 'incomplete',
          byteLength: state.byteLength,
          digest: state.hash.copy().digest('hex'),
          missingRanges: state.sealed
            ? []
            : [{ start: state.byteLength, end: null }],
          body: { pages: state.pages },
        }))
      : [];
    const captureStatus =
      contents.length === 0 ||
      contents.every(
        (entry) => entry.state === 'incomplete' && entry.byteLength === 0,
      )
        ? 'unavailable'
        : contents.every((entry) => entry.state === 'sealed')
          ? 'complete'
          : 'partial';
    const captureReason =
      captureStatus === 'complete'
        ? null
        : (this.failureReason ?? 'producer_lost');
    let manifestRef = null;
    try {
      const manifest = parseToolResultManifest({
        toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
        type: 'manifest',
        ...this.identity,
        executionStatus,
        exitCode: this.processResult.exitCode,
        signal: signalName(this.processResult.signal),
        captureScope: 'process_pipes',
        capturePolicy: 'complete_required',
        captureStatus,
        captureReason,
        upstreamTruncated: false,
        contents,
      });
      const bytes = Buffer.from(JSON.stringify(manifest));
      if (bytes.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes) {
        throw new Error('size_limit');
      }
      await this.assertWritable();
      manifestRef = await this.resources.publish(
        MANAGED_TOOL_RESULT_KINDS.manifest,
        bytes,
      );
    } catch (cause) {
      this.fail(cause);
    }
    const status = manifestRef ? captureStatus : 'unavailable';
    this.finalEnvelope = {
      executionStatus,
      responseParts,
      ...(error ? { error } : {}),
      capture: {
        captureStatus: status,
        captureReason: manifestRef
          ? captureReason
          : (this.failureReason ?? 'storage_failed'),
        manifest: manifestRef,
        previewTruncated:
          this.streams.stdout.observed + this.streams.stderr.observed >
          Math.min(this.processResult.rawOutput.byteLength, 30_000),
        deliveryStatus: 'pending',
      },
    };
    return this.finalEnvelope;
  }
}
