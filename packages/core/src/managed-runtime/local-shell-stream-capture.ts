/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:os';
import type { ShellRawCaptureSink } from '../services/shellExecutionService.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import {
  impliedStatus,
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_LIMITS,
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultManifest,
  parseToolResultManifestBytes,
  parseToolResultPage,
  type ToolResultContentDescriptor,
  type ToolResultEnvelope,
  type ToolResultPageReference,
  type ToolResultSegment,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';

// H3 of #12827: the open-ended counterpart of LocalShellResultCapture. A
// foreground invocation seals once at exit; a background Shell keeps writing
// for its whole life, so this sink publishes bounded segments and pages as
// they arrive and refreshes the manifest into the next revision at each
// page, keeping `executionStatus: 'unknown'` and streams `open` until exit,
// so a reader never waits for the process to end. Exit seals the streams
// and publishes the final revision with the physical fields. Worker
// replacement does not continue a stream here — the pipe died with the old
// worker; recovery attaches the unit and caps the stream (see
// docs/design/2026-10-03-managed-shell-monitor-runtime.md).

const SEGMENT_BYTES = 1024 * 1024;
const SEGMENTS_PER_PAGE = 512;

type StreamId = 'stdout' | 'stderr';
const BOTH: readonly StreamId[] = ['stdout', 'stderr'];

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
  ended: boolean;
  sealed: boolean;
  queue: Promise<void>;
  /** Serializes every page flush of this stream — its own page closes and
   * the flush a manifest build performs — so a descriptor is only ever
   * frozen at a point where pages, digest, byte length and the pending
   * batch form one consistent boundary. */
  flushChain: Promise<void>;
  /** The descriptor as its last flush froze it: an append after the
   * boundary opens a fresh page rather than touching the snapshot. */
  frozenSnapshot: ToolResultContentDescriptor;
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
    ended: false,
    sealed: false,
    queue: Promise.resolve(),
    flushChain: Promise.resolve(),
    frozenSnapshot: {
      streamId: id,
      role: id,
      mimeType: 'application/octet-stream',
      state: 'open',
      byteLength: 0,
      digest: createHash('sha256').digest('hex'),
      missingRanges: [],
      body: { pages: [] },
    },
  };
}

interface BrokenCapture {
  readonly reason: 'quota_exhausted' | 'size_limit' | 'storage_failed';
}

export class LocalShellStreamCapture implements ShellRawCaptureSink {
  private readonly streams = {
    stdout: stream('stdout'),
    stderr: stream('stderr'),
  };
  private started = false;
  private broken: BrokenCapture | null = null;
  private revision = 0;
  private manifestRef: ManagedSessionDurableRef | null = null;
  private finalEnvelope: ToolResultEnvelope | null = null;
  private processOutcome: {
    readonly exitCode: number | null;
    readonly signalName: string | null;
  } | null = null;

  constructor(
    private readonly store: ToolResultSegmentStore,
    private readonly resources: ManagedSessionResourceStore,
    readonly identity: ToolResultExpectedIdentity,
    private readonly assertWritable: () => Promise<void> = async () => {},
    private readonly options: { readonly segmentsPerPage: number } = {
      segmentsPerPage: SEGMENTS_PER_PAGE,
    },
  ) {}

  setStarted(_pid: number): void {
    this.started = true;
  }

  /** The caller's explicit broken mark, matching the foreground sink API. */
  failCapture(): void {
    this.fail(new Error('Capture transport failed.'));
  }

  setProcessResult(result: {
    exitCode: number | null;
    signal: number | null;
  }): void {
    this.processOutcome = {
      exitCode: result.exitCode,
      signalName: signalName(result.signal),
    };
  }

  get brokenReason(): BrokenCapture | null {
    return this.broken;
  }

  get currentManifest(): ManagedSessionDurableRef | null {
    return this.manifestRef;
  }

  async open(): Promise<ManagedSessionDurableRef> {
    if (this.manifestRef !== null) return this.manifestRef;
    return await this.publish('unknown', null, null);
  }

  write(id: StreamId, chunk: Buffer): Promise<void> {
    const state = this.streams[id];
    return (state.queue = state.queue.then(() => this.append(state, chunk)));
  }

  private async append(state: StreamState, chunk: Buffer): Promise<void> {
    if (this.broken || state.ended) return;
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
    if (state.ended) return;
    state.ended = true;
    try {
      if (!this.broken && state.used > 0)
        await this.publishSegment(state, true);
      if (!this.broken && complete) {
        await this.withConflictRetry(() =>
          this.store.seal({
            captureId: this.identity.captureId,
            streamId: state.id,
            segmentCount: state.ordinal,
            byteLength: state.byteLength,
            digest: state.hash.copy().digest('hex'),
          }),
        );
        state.sealed = true;
      }
      // The revision of an ended stream publishes only after its seal
      // decision: a sealed-or-incomplete descriptor may never change again.
      if (!this.broken && state.pendingSegments.length > 0) {
        await this.publishPage(state);
      }
    } catch (cause) {
      this.fail(cause);
    } finally {
      state.buffer = Buffer.alloc(0);
      state.used = 0;
    }
  }

  private fail(cause: unknown): void {
    if (this.broken) return;
    this.broken = {
      reason:
        cause instanceof Error && cause.message === 'size_limit'
          ? 'size_limit'
          : cause instanceof Error && cause.message === 'quota_exhausted'
            ? 'quota_exhausted'
            : 'storage_failed',
    };
    // The latch is silent forever, but the manifest must stop advertising
    // a healthy open capture the moment the stream goes blind: mark every
    // stream blind here and queue one sole announcement behind the
    // left-most stream's in-flight work, so the degradation revision
    // publishes ahead of every settle attempt — finalize awaits it.
    for (const id of BOTH) this.streams[id].ended = true;
    const owner = this.streams['stdout'];
    this.announcing = owner.queue = owner.queue.then(() =>
      this.announceBroken(),
    );
  }

  private announcing: Promise<void> | undefined;
  private announced = false;
  /**
   * A landed blind-capture revision must push the record forward itself,
   * so nothing keeps advertising a healthy capture past the break.
   */
  onBrokenAnnounce?: (ref: ManagedSessionDurableRef) => Promise<void>;

  private async announceBroken(): Promise<void> {
    if (this.announced) return;
    this.announced = true;
    try {
      const ref = await this.publish('unknown', null, null);
      if (this.onBrokenAnnounce) await this.onBrokenAnnounce(ref);
    } catch {
      // The announcement is itself best-effort: the last revision that did
      // publish stands, and finalize stays the sole writer of the settled
      // envelope — a later successful publish replaces this one's ref.
    }
  }

  /** One transient conflict gets two more asks before it latches. */
  private async withConflictRetry<Result>(
    call: () => Promise<ToolResultStoreOutcome<Result>>,
  ): Promise<Result> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await call();
      if (outcome.status === 'ok') return outcome.result;
      if (outcome.code !== 'managed_tool_result_conflict' || attempt === 3)
        throw new Error(outcome.code);
    }
  }

  private async publishSegment(
    state: StreamState,
    deferPageClose = false,
  ): Promise<void> {
    await this.assertWritable();
    if (state.ordinal > MANAGED_TOOL_RESULT_LIMITS.maxOrdinal) {
      throw new Error('size_limit');
    }
    const bytes = state.buffer.subarray(0, state.used);
    const published = await this.withConflictRetry(() =>
      this.store.publish({
        captureId: this.identity.captureId,
        streamId: state.id,
        ordinal: state.ordinal,
        bytes,
      }),
    );
    state.hash.update(bytes);
    state.byteLength += bytes.byteLength;
    state.pendingSegments.push({
      byteLength: published.byteLength,
      digest: published.digest,
    });
    state.ordinal++;
    state.used = 0;
    if (
      state.pendingSegments.length === this.options.segmentsPerPage &&
      !deferPageClose
    ) {
      await this.publishPage(state);
    }
  }

  private async publishPage(state: StreamState): Promise<void> {
    if (state.pendingSegments.length === 0) return;
    await this.flushQueued(state);
    await this.publish('unknown', null, null);
  }

  /**
   * Every page flush runs on the stream's own chain: a flush arriving
   * while another is mid-publish runs strictly after it, so the empty-
   * pending early return never freezes live counters against pages an
   * in-flight sibling has not yet committed. The chain itself must never
   * latch on one flush's refusal — flushPage already restored its batch.
   */
  private flushQueued(state: StreamState): Promise<void> {
    const task = state.flushChain.then(() => this.flushPage(state));
    state.flushChain = task.catch(() => undefined);
    return task;
  }

  /**
   * Publishes the contents of the pending page without refreshing the
   * manifest. Every accounting read derives from the batch spliced out up
   * front: an append landing mid-`await` — possible when a manifest
   * revision flushes this stream from the other stream's queue — starts a
   * fresh pending page instead of being counted here and then discarded.
   * Every call — empty or after a complete page — freezes the descriptor
   * snapshot at its own boundary, so the snapshot the revision built
   * later still names exactly what this particular flush had at hand.
   */
  private freezeSnapshot(
    state: StreamState,
    digest: string,
    byteLength: number,
  ): void {
    state.frozenSnapshot = {
      streamId: state.id,
      role: state.id,
      mimeType: 'application/octet-stream',
      state: state.sealed ? 'sealed' : state.ended ? 'incomplete' : 'open',
      // The used buffer is still in memory, so its bytes sit behind the
      // running digest chain: byteLength counts only published segments.
      byteLength,
      digest,
      // Only an ended-but-unsealed stream reports a missing tail: an
      // open stream has nothing provably missing yet.
      missingRanges:
        state.ended && !state.sealed ? [{ start: byteLength, end: null }] : [],
      body: {
        pages: [...state.pages],
      } as ToolResultContentDescriptor['body'],
    };
  }

  private async flushPage(state: StreamState): Promise<void> {
    if (state.pendingSegments.length === 0) {
      this.freezeSnapshot(
        state,
        state.hash.copy().digest('hex'),
        state.byteLength,
      );
      return;
    }
    await this.assertWritable();
    if (state.pages.length >= MANAGED_TOOL_RESULT_LIMITS.maxPagesPerStream) {
      throw new Error('size_limit');
    }
    const segments = state.pendingSegments.splice(0);
    // The two integers that freeze must carry come from exactly this
    // boundary: anything appended meanwhile opens a fresh page, never
    // sneaks into the revision being built right now.
    const frozenDigest = state.hash.copy().digest('hex');
    const frozenByteLength = state.byteLength;
    const page = parseToolResultPage({
      toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
      type: 'page',
      captureId: this.identity.captureId,
      streamId: state.id,
      firstOrdinal: state.pageOrdinal,
      offset: state.pageOffset,
      segments,
    });
    const bytes = Buffer.from(JSON.stringify(page));
    if (bytes.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxPageBytes) {
      throw new Error('size_limit');
    }
    try {
      const ref = await this.resources.publish(
        MANAGED_TOOL_RESULT_KINDS.page,
        bytes,
      );
      const byteLength = segments.reduce(
        (length, segment) => length + segment.byteLength,
        0,
      );
      state.pages.push({
        ref,
        segmentCount: segments.length,
        byteLength,
      });
      state.pageOffset += byteLength;
      state.pageOrdinal += segments.length;
      this.freezeSnapshot(state, frozenDigest, frozenByteLength);
    } catch (cause) {
      // A refused page write restores its batch so the degradation
      // announcement and any later settle flush can try again; a spliced
      // batch that stayed lost would make every later revision's descriptor
      // irreconcilable with its pages.
      state.pendingSegments.unshift(...segments);
      throw cause;
    }
  }

  /**
   * Publishes the next manifest revision: `unknown` and `open` while
   * running, settled fields once sealed. A pending revision's successor
   * may only extend what it recorded, and a fully sealed revision gets
   * exactly one settled leg, by the shared `isToolResultManifestSuccessor`
   * rules. The manifest validator requires each descriptor's pages to sum
   * to its byte length, so each stream's hash and byte length freeze at
   * the splice boundary of its own flush — an append after the boundary
   * opens a fresh page, never lands inside this revision. The publish
   * itself is single-flight: revision numbers only ever advance in commit
   * order, so two overlapping flushes can never collide or skip.
   */
  private async publish(
    executionStatus: 'success' | 'error' | 'cancelled' | 'unknown',
    exitCode: number | null,
    signal: string | null,
  ): Promise<ManagedSessionDurableRef> {
    const task = this.publishChain.then(() =>
      this.publishSnapshot(executionStatus, exitCode, signal),
    );
    // A failed publish must not wedge the chain: the next publish retries
    // its same step fresh, with a new snapshot under the same revision
    // slot — fail-stop stays inside the attempt that failed.
    this.publishChain = task.catch(() => undefined);
    return task;
  }

  private publishChain: Promise<unknown> = Promise.resolve();

  private async publishSnapshot(
    executionStatus: 'success' | 'error' | 'cancelled' | 'unknown',
    exitCode: number | null,
    signal: string | null,
  ): Promise<ManagedSessionDurableRef> {
    const contents: ToolResultContentDescriptor[] = [];
    for (const id of BOTH) {
      const state = this.streams[id];
      await this.flushQueued(state);
      contents.push(state.frozenSnapshot);
    }
    const broken = this.broken;
    const captureStatus = impliedStatus(contents);
    const manifest = parseToolResultManifest({
      toolResult: MANAGED_TOOL_RESULT_PROTOCOL,
      type: 'manifest',
      ...this.identity,
      revision: this.revision + 1,
      executionStatus,
      exitCode,
      signal,
      captureScope: 'process_pipes',
      capturePolicy: 'complete_required',
      captureStatus,
      captureReason:
        captureStatus === 'pending' || captureStatus === 'complete'
          ? null
          : (broken?.reason ?? 'producer_lost'),
      upstreamTruncated: false,
      contents,
    });
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes) {
      throw new Error('size_limit');
    }
    await this.assertWritable();
    this.manifestRef = await this.resources.publish(
      MANAGED_TOOL_RESULT_KINDS.manifest,
      bytes,
    );
    this.revision += 1;
    return this.manifestRef;
  }

  async finalize(
    executionStatus: Exclude<
      ToolResultEnvelope['executionStatus'],
      'not_started'
    >,
    responseParts: readonly unknown[],
    error: { readonly message: string; readonly type?: string } | undefined,
    outcome?: {
      readonly exitCode: number | null;
      readonly signalName: string | null;
    },
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
    const settled = outcome ?? this.processOutcome;
    if (!settled) {
      throw new Error('Finalized Shell capture has no physical outcome.');
    }
    for (const id of BOTH) {
      if (!this.streams[id].ended) await this.finish(id, false);
    }
    // The last revision contracts the unfinished tail to the boundary of
    // the sealed, retained prefix; anything lost mid-write is a gap, not
    // admitted bytes. A writability failure at settle time must not escape:
    // the last published revision stands (the cap rule for a dying worker),
    // and the envelope degrades to unavailable with the named reason.
    await this.announcing;
    try {
      const ref = await this.publish(
        executionStatus,
        settled.exitCode,
        settled.signalName,
      );
      const contents = parseToolResultManifestBytes(
        await this.resources.read(ref),
      );
      const captureStatus: Exclude<
        (typeof contents)['captureStatus'],
        'pending'
      > =
        contents.captureStatus === 'pending'
          ? 'partial'
          : contents.captureStatus;
      this.finalEnvelope = {
        executionStatus,
        responseParts,
        ...(error ? { error } : {}),
        capture: {
          captureStatus,
          captureReason: contents.captureReason,
          manifest: ref,
          previewTruncated: false,
          deliveryStatus: 'pending',
        },
      };
    } catch (cause) {
      this.fail(cause);
      this.finalEnvelope = {
        executionStatus,
        responseParts,
        ...(error ? { error } : {}),
        capture: {
          captureStatus: 'unavailable',
          captureReason: this.broken?.reason ?? 'storage_failed',
          manifest: null,
          previewTruncated: false,
          deliveryStatus: 'pending',
        },
      };
    }
    return this.finalEnvelope;
  }
}

function signalName(value: number | null): string | null {
  if (value === null) return null;
  return (
    Object.entries(constants.signals).find(
      ([name, number]) => name.startsWith('SIG') && number === value,
    )?.[0] ?? null
  );
}
