/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { ShellExecutionResult } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import { LocalShellStreamCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-capture.js';
import { ResourceToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
  type ManagedDeliveryEntry,
  type ManagedDeliveryResource,
  type ManagedMonitorStopReason,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-delivery-entry.js';
import { monitorNotificationText } from './hosted-monitor-notification.js';
import type {
  ManagedShellCaptureSink,
  ToolResultAcknowledgement,
} from './managed-runtime-tool-executor.js';
import type { ShellPublisherDescriptor } from './managed-shell-publisher.js';

// Phase 3b of #17453, Slice 1: the worker owns the background capture. The
// running SHA-256 lives in this process for the stream's whole life, so a
// Harness restart continues the same capture instead of reporting
// producer_lost. Everything that must become durable is a numbered delivery
// entry; the worker drops an entry only after a consumer acknowledges it.

// A delivery entry carries its resources base64-encoded inside a request
// bounded by MANAGED_DELIVERY_REQUEST_LIMIT_BYTES (512 KiB), and an entry
// larger than that can never be pushed at all. Every segment publishes its
// own revision, which re-publishes the stream's open page of up to 256
// segment descriptors (~25 KB), so the largest entry — a segment and a page
// per stream plus one manifest of at most 64 KiB — stays under 510 KB once
// encoded. The 64-page bound then holds 16,384 segments per stream, so idle
// partial flushes spend ordinals instead of exhausting pages.
const BACKGROUND_SEGMENT_BYTES = 128 * 1024;
const BACKGROUND_SEGMENTS_PER_PAGE = 256;
const PARTIAL_FLUSH_MS = 250;
/** Per-run outbox budget, sized above the largest single flush batch. */
const RUN_OUTBOX_BYTES = 8 * 1024 * 1024;
const PUSH_RETRY_BASE_MS = 1000;
const PUSH_RETRY_MAX_MS = 30_000;
const MONITOR_DEBOUNCE_FLOOR_MS = 1000;
const EVENT_LINE_TRUNCATE = 2000;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface BufferedResource {
  readonly index: number;
  readonly ref: ManagedSessionDurableRef;
  readonly bytes: Buffer;
}

/**
 * The worker's local resource store: it computes every complete
 * ManagedSessionDurableRef without contacting the Store, buffers the bytes,
 * and tracks insertion order so each manifest revision can carry exactly the
 * resources it introduced. Republishing under the same ID and digest is a
 * no-op; a different digest under the same ID is a conflict.
 */
export class WorkerDeliveryResourceStore {
  private readonly byId = new Map<string, BufferedResource>();
  private readonly ordered: BufferedResource[] = [];
  private nextIndex = 0;

  async publish(
    kind: string,
    bytes: Buffer,
    resourceId?: string,
  ): Promise<ManagedSessionDurableRef> {
    const id = resourceId ?? randomUUID();
    const digest = sha256(bytes);
    const existing = this.byId.get(id);
    if (existing) {
      if (
        existing.ref.digest !== digest ||
        existing.ref.byteLength !== bytes.byteLength ||
        existing.ref.kind !== kind
      ) {
        throw new Error('Worker delivery resource identity conflicts.');
      }
      return existing.ref;
    }
    const ref: ManagedSessionDurableRef = {
      resourceId: id,
      kind,
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest,
    };
    const entry: BufferedResource = {
      index: this.nextIndex++,
      ref,
      bytes: Buffer.from(bytes),
    };
    this.byId.set(id, entry);
    this.ordered.push(entry);
    return ref;
  }

  async read(ref: ManagedSessionDurableRef): Promise<Buffer> {
    const entry = this.byId.get(ref.resourceId);
    if (!entry) throw new Error('Worker delivery resource is unavailable.');
    return Buffer.from(entry.bytes);
  }

  /** The resources published strictly after the marker, in insertion order. */
  since(marker: number): ManagedDeliveryResource[] {
    return this.ordered
      .filter((entry) => entry.index > marker)
      .map((entry) => ({
        ref: entry.ref,
        bytesBase64: entry.bytes.toString('base64'),
        shape:
          entry.ref.kind === MANAGED_TOOL_RESULT_KINDS.content
            ? ('published' as const)
            : ('referenced' as const),
      }));
  }

  get watermark(): number {
    return this.nextIndex - 1;
  }
}

function entryBytes(entry: ManagedDeliveryEntry): number {
  return Buffer.byteLength(JSON.stringify(entry));
}

export type DeliveryMode = 'attached' | 'held';

export type ObservationPullStatus = 'held' | 'attached' | 'superseded';

export interface ObservationPullBatch {
  readonly status: ObservationPullStatus;
  readonly ackedThrough: number;
  readonly closed: boolean;
  readonly entries: readonly ManagedDeliveryEntry[];
}

/**
 * One background run's ordered outbox and its delivery state. The worker
 * pushes to the resident Harness while attached; a failed push switches to
 * held, keeps the entries until a consumer acknowledges them, and retries
 * the installed publisher with backoff.
 */
export class BackgroundDeliveryRun {
  private readonly outbox: ManagedDeliveryEntry[] = [];
  private nextSeq = 1;
  private outboxBytes = 0;
  private appliedThrough = 0;
  private harnessAppliedThrough = 0;
  private stagedThrough = 0;
  private mode: DeliveryMode = 'held';
  private descriptor: ShellPublisherDescriptor | undefined;
  private writerGeneration = 0;
  private pushing: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private stopping = false;
  private tailDropped = false;
  private terminalEmitted = false;
  private terminalReceipt: ToolResultAcknowledgement | undefined;
  private readonly receiptWaiters: Array<
    (receipt: ToolResultAcknowledgement) => void
  > = [];
  private readonly roomWaiters: Array<() => void> = [];
  private stageWaiter:
    | {
        readonly afterSeq: number;
        readonly maxEntries: number;
        readonly timer: ReturnType<typeof setTimeout>;
        readonly resolve: (batch: ObservationPullBatch) => void;
      }
    | undefined;
  private closed = false;

  constructor(
    readonly executionCallId: string,
    readonly bindingGeneration: string,
    readonly recordDomain: 'child_run' | 'monitor_run',
    private readonly onBackpressure?: (paused: boolean) => void,
  ) {}

  get deliveryMode(): DeliveryMode {
    return this.mode;
  }

  get lastApplied(): number {
    return this.appliedThrough;
  }

  get lastHarnessApplied(): number {
    return this.harnessAppliedThrough;
  }

  get lastStaged(): number {
    return this.stagedThrough;
  }

  get pendingCount(): number {
    return this.outbox.length;
  }

  get isClosedOrTerminal(): boolean {
    return this.closed || this.terminalEmitted;
  }

  /** A newer (or same) writer generation replaces the publisher; older refused. */
  attach(
    descriptor: ShellPublisherDescriptor,
    writerGeneration: number,
  ): boolean {
    if (writerGeneration < this.writerGeneration) return false;
    this.descriptor = descriptor;
    this.writerGeneration = writerGeneration;
    this.mode = 'attached';
    this.retryAttempt = 0;
    this.finishStageWaiter('attached', []);
    void this.pushPending();
    return true;
  }

  detach(writerGeneration?: number): boolean {
    if (
      writerGeneration !== undefined &&
      writerGeneration < this.writerGeneration
    ) {
      return false;
    }
    if (writerGeneration !== undefined) {
      this.writerGeneration = writerGeneration;
    }
    this.mode = 'held';
    this.descriptor = undefined;
    this.wakeStageWaiterIfReady();
    return true;
  }

  /** A forced stop (§4.4): release the write queue parked on the byte
   * budget so the stop's finish and finalize never wait on a process
   * blocked on its own output pipes. The reserved terminal slot stays
   * open; whether the unqueued tail is dropped is decided per entry by
   * `waitForRoom`, only while the outbox is actually full. */
  requestStop(): void {
    this.stopping = true;
    for (const waiter of this.roomWaiters.splice(0)) waiter();
  }

  /** Resolves once the outbox has room for `size` more bytes. The capture's
   * write queue awaits this, so a full outbox pauses the process through its
   * own pipe backpressure — bounded and visible, never a silent loss.
   * Returns false when the entry must be dropped: a closed run, or a
   * forced stop whose full outbox drops the unqueued tail. The first such
   * drop latches `tailDropped`, so the tail is one contiguous suffix — a
   * later entry can never resume past a dropped one and break the
   * sequence contiguity the consumer enforces. */
  private async waitForRoom(size: number): Promise<boolean> {
    while (
      !this.closed &&
      !this.stopping &&
      this.outboxBytes + size > RUN_OUTBOX_BYTES &&
      this.outbox.length > 0
    ) {
      this.onBackpressure?.(true);
      await new Promise<void>((resolve) => this.roomWaiters.push(resolve));
    }
    if (this.closed || this.tailDropped) return false;
    if (
      this.outboxBytes + size <= RUN_OUTBOX_BYTES ||
      this.outbox.length === 0
    ) {
      return true;
    }
    this.tailDropped = true;
    return false;
  }

  private enqueue(entry: ManagedDeliveryEntry): void {
    if (this.closed) return;
    const size = entryBytes(entry);
    this.outbox.push(entry);
    this.outboxBytes += size;
    if (this.mode === 'held') {
      this.wakeStageWaiterIfReady();
    } else {
      void this.pushPending();
    }
  }

  nextDeliverySeq(): number {
    return this.nextSeq++;
  }

  /** Returns whether the entry was enqueued; a dropped entry consumes no
   * deliverySeq, so the next enqueued entry stays contiguous. */
  async enqueueOutput(
    manifestRef: ManagedSessionDurableRef,
    manifestRevision: number,
    resources: ManagedDeliveryResource[],
  ): Promise<boolean> {
    const body = {
      executionCallId: this.executionCallId,
      bindingGeneration: this.bindingGeneration,
      kind: 'output' as const,
      manifestRef,
      manifestRevision,
      resources,
    };
    // Size with the sequence the entry would draw now; the budget is a
    // soft bound, so a digit gained while parked never matters.
    if (
      !(await this.waitForRoom(
        entryBytes({ ...body, deliverySeq: this.nextSeq }),
      ))
    ) {
      return false;
    }
    this.enqueue({ ...body, deliverySeq: this.nextDeliverySeq() });
    return true;
  }

  async enqueueObservation(
    sequence: number,
    lines: readonly string[],
    notification: {
      inputId: string;
      turnId: string;
      contentRef: ManagedSessionDurableRef;
      admissionRef: ManagedSessionDurableRef;
    } | null,
    resources: ManagedDeliveryResource[],
  ): Promise<boolean> {
    const body = {
      executionCallId: this.executionCallId,
      bindingGeneration: this.bindingGeneration,
      kind: 'observation' as const,
      sequence,
      lines,
      notification,
      resources,
    };
    if (
      !(await this.waitForRoom(
        entryBytes({ ...body, deliverySeq: this.nextSeq }),
      ))
    ) {
      return false;
    }
    this.enqueue({ ...body, deliverySeq: this.nextDeliverySeq() });
    return true;
  }

  /** The reserved terminal slot: a forced stop always gets through. */
  enqueueTerminal(
    envelope: ToolResultEnvelope,
    evidence: { exitCode: number | null; exitSignal: string | null } | null,
    stopRequested: boolean,
    executionStatus: 'success' | 'error' | 'cancelled',
    manifestRef: ManagedSessionDurableRef | null,
    resources: ManagedDeliveryResource[],
    monitorStopReason?: ManagedMonitorStopReason,
  ): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    // On a forced stop with a full outbox, drop the unqueued tail: the exit
    // proof must never wait on a process blocked on its own output pipes.
    this.enqueue({
      deliverySeq: this.nextDeliverySeq(),
      executionCallId: this.executionCallId,
      bindingGeneration: this.bindingGeneration,
      kind: 'terminal',
      envelope,
      evidence,
      stopRequested,
      executionStatus,
      manifestRef,
      resources,
      ...(monitorStopReason ? { monitorStopReason } : {}),
    });
  }

  /** Pushes to the installed publisher; held with one installed is a push
   * that failed, so the retry timer drives this too. A newer attach during
   * a push takes over once that push returns. */
  private async pushPending(): Promise<void> {
    if (this.pushing || !this.descriptor || this.outbox.length === 0) return;
    const descriptor = this.descriptor;
    this.pushing = (async () => {
      try {
        while (this.outbox.length > 0 && this.descriptor === descriptor) {
          // Size the batch as it is sent: the request wrapper plus a comma
          // between entries.
          const request = {
            operation: 'deliver',
            executionCallId: this.executionCallId,
            entries: [] as ManagedDeliveryEntry[],
          };
          let requestBytes = Buffer.byteLength(JSON.stringify(request));
          for (const entry of this.outbox) {
            const size =
              entryBytes(entry) + (request.entries.length > 0 ? 1 : 0);
            if (
              request.entries.length > 0 &&
              requestBytes + size > MANAGED_DELIVERY_REQUEST_LIMIT_BYTES
            ) {
              break;
            }
            request.entries.push(entry);
            requestBytes += size;
          }
          const reply = await deliverRpc(descriptor, request);
          const appliedThrough = Number(reply['appliedThrough']);
          if (!Number.isSafeInteger(appliedThrough)) {
            throw new Error('Delivery acknowledgement is invalid.');
          }
          this.acknowledge(appliedThrough);
          this.retryAttempt = 0;
          if (this.mode === 'held' && this.descriptor === descriptor) {
            this.mode = 'attached';
            this.finishStageWaiter('attached', []);
          }
          const receipt = reply['receipt'];
          if (receipt && typeof receipt === 'object') {
            this.terminalReceipt = receipt as ToolResultAcknowledgement;
            for (const waiter of this.receiptWaiters.splice(0)) {
              waiter(this.terminalReceipt);
            }
          }
        }
      } catch {
        // A failed push is not a capture failure: switch to held, keep the
        // entries for the next consumer and retry this publisher, unless a
        // newer attach already owns delivery. Any waiter on the terminal
        // receipt is released as blocked rather than hanging.
        if (this.descriptor === descriptor) {
          this.mode = 'held';
          this.wakeStageWaiterIfReady();
          this.scheduleRetry();
        }
        for (const waiter of this.receiptWaiters.splice(0)) {
          waiter({
            executionCallId: this.executionCallId,
            manifest: null,
            deliveryStatus: 'blocked',
            historyRevision: null,
          });
        }
      } finally {
        this.pushing = undefined;
        if (this.descriptor !== descriptor) void this.pushPending();
      }
    })();
    return this.pushing;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    const delay = Math.min(
      PUSH_RETRY_MAX_MS,
      PUSH_RETRY_BASE_MS * 2 ** this.retryAttempt,
    );
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.pushPending();
    }, delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  private advanceAckedPrefix(ackedThrough: number): void {
    if (ackedThrough <= this.appliedThrough) return;
    this.appliedThrough = ackedThrough;
    while (
      this.outbox.length > 0 &&
      this.outbox[0].deliverySeq <= ackedThrough
    ) {
      const dropped = this.outbox.shift()!;
      this.outboxBytes -= entryBytes(dropped);
    }
    if (this.outboxBytes < RUN_OUTBOX_BYTES) {
      this.onBackpressure?.(false);
      for (const waiter of this.roomWaiters.splice(0)) waiter();
    }
  }

  private acknowledge(appliedThrough: number): void {
    if (appliedThrough > this.harnessAppliedThrough) {
      this.harnessAppliedThrough = appliedThrough;
    }
    this.advanceAckedPrefix(appliedThrough);
  }

  /** The Broker's staging acknowledgement (Slice 2). */
  acknowledgeStaged(stagedThrough: number): void {
    if (stagedThrough > this.stagedThrough) this.stagedThrough = stagedThrough;
    this.advanceAckedPrefix(stagedThrough);
  }

  private selectStageBatch(
    afterSeq: number,
    maxEntries: number,
  ): ManagedDeliveryEntry[] {
    const cursor = Math.max(afterSeq, this.stagedThrough);
    const batch: ManagedDeliveryEntry[] = [];
    let batchBytes = 0;
    for (const entry of this.outbox) {
      if (entry.deliverySeq <= cursor) continue;
      const size = entryBytes(entry);
      if (
        batch.length > 0 &&
        (batch.length >= maxEntries ||
          batchBytes + size > MANAGED_DELIVERY_REQUEST_LIMIT_BYTES)
      ) {
        break;
      }
      batch.push(entry);
      batchBytes += size;
      if (
        batch.length >= maxEntries ||
        batchBytes > MANAGED_DELIVERY_REQUEST_LIMIT_BYTES
      ) {
        break;
      }
    }
    return batch;
  }

  private finishStageWaiter(
    status: ObservationPullStatus,
    entries: readonly ManagedDeliveryEntry[],
  ): void {
    const waiter = this.stageWaiter;
    if (!waiter) return;
    this.stageWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve({
      status,
      ackedThrough: this.appliedThrough,
      closed: this.isClosedOrTerminal && this.outbox.length === 0,
      entries,
    });
  }

  private wakeStageWaiterIfReady(): void {
    const waiter = this.stageWaiter;
    if (!waiter) return;
    if (this.mode === 'attached') {
      this.finishStageWaiter('attached', []);
      return;
    }
    const batch = this.selectStageBatch(waiter.afterSeq, waiter.maxEntries);
    if (batch.length > 0 || this.isClosedOrTerminal) {
      this.finishStageWaiter('held', batch);
    }
  }

  /**
   * Lease-fenced Broker staging pull. Keeps only the newest waiting long poll
   * per run so a fresh pull immediately supersedes an older waiting pull.
   */
  pullForStage(params: {
    readonly afterSeq: number;
    readonly ackThrough?: number;
    readonly waitMs?: number;
    readonly maxEntries?: number;
  }): Promise<ObservationPullBatch> {
    this.finishStageWaiter('superseded', []);
    // A Harness holding a publisher applies the outbox itself and may not
    // have drained what the Broker staged meanwhile, so only a run no
    // Harness holds lets a staging acknowledgement trim it.
    if (
      params.ackThrough !== undefined &&
      params.ackThrough > 0 &&
      !this.descriptor
    ) {
      this.acknowledgeStaged(params.ackThrough);
    }
    const maxEntries = Math.max(1, Math.min(params.maxEntries ?? 64, 256));
    if (this.mode === 'attached') {
      return Promise.resolve({
        status: 'attached',
        ackedThrough: this.appliedThrough,
        closed: this.isClosedOrTerminal && this.outbox.length === 0,
        entries: [],
      });
    }
    const immediate = this.selectStageBatch(params.afterSeq, maxEntries);
    const waitMs = Math.max(0, Math.min(params.waitMs ?? 0, 30_000));
    if (immediate.length > 0 || waitMs === 0 || this.isClosedOrTerminal) {
      return Promise.resolve({
        status: 'held',
        ackedThrough: this.appliedThrough,
        closed: this.isClosedOrTerminal && this.outbox.length === 0,
        entries: immediate,
      });
    }
    return new Promise<ObservationPullBatch>((resolve) => {
      const timer = setTimeout(() => {
        if (this.stageWaiter?.resolve === resolve) {
          const entries =
            this.mode === 'held'
              ? this.selectStageBatch(params.afterSeq, maxEntries)
              : [];
          this.finishStageWaiter(
            this.mode === 'attached' ? 'attached' : 'held',
            entries,
          );
        }
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.stageWaiter = {
        afterSeq: params.afterSeq,
        maxEntries,
        timer,
        resolve,
      };
    });
  }

  /** Resolves with the terminal receipt once the terminal entry is applied. */
  async terminalAcknowledgement(): Promise<ToolResultAcknowledgement> {
    if (this.terminalReceipt) return this.terminalReceipt;
    if (this.mode === 'held' || !this.descriptor) {
      // No live consumer: the entry stays in the outbox; report blocked with
      // the manifest the worker already sealed, exactly as a lost publisher
      // does today, without failing the capture.
      return {
        executionCallId: this.executionCallId,
        manifest: null,
        deliveryStatus: 'blocked',
        historyRevision: null,
      };
    }
    return new Promise((resolve) => {
      this.receiptWaiters.push(resolve);
      void this.pushPending();
    });
  }

  close(): void {
    this.closed = true;
    this.mode = 'held';
    this.descriptor = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.wakeStageWaiterIfReady();
    for (const waiter of this.roomWaiters.splice(0)) waiter();
    for (const waiter of this.receiptWaiters.splice(0)) {
      waiter({
        executionCallId: this.executionCallId,
        manifest: null,
        deliveryStatus: 'blocked',
        historyRevision: null,
      });
    }
  }
}

async function deliverRpc(
  descriptor: ShellPublisherDescriptor,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > MANAGED_DELIVERY_REQUEST_LIMIT_BYTES) {
    throw new Error('Delivery request is too large.');
  }
  const response = await fetch(descriptor.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.headers.get('cache-control') !== 'no-store') {
    await response.body?.cancel();
    throw new Error('Delivery was refused.');
  }
  return (await response.json()) as Record<string, unknown>;
}

function signalName(value: number | null): string | null {
  if (value === null) return null;
  return (
    Object.entries(constants.signals).find(
      ([name, number]) => name.startsWith('SIG') && number === value,
    )?.[0] ?? null
  );
}

/**
 * The worker-owned background capture sink. It runs LocalShellStreamCapture
 * over a local segment store and resource buffer, turns each manifest
 * revision into an output delivery entry, and the finalize into a terminal
 * entry. Push failure never fails the capture.
 */
export class WorkerBackgroundCaptureSink implements ManagedShellCaptureSink {
  readonly resources: WorkerDeliveryResourceStore;
  readonly capture: LocalShellStreamCapture;
  private readonly segmentStore: ResourceToolResultSegmentStore;
  private lastResourceMarker = -1;
  private stopRequested = false;
  private processResult: ShellExecutionResult | null = null;
  private readonly flushTimers = {
    stdout: undefined as ReturnType<typeof setTimeout> | undefined,
    stderr: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  private monitorPolicy: WorkerMonitorPolicy | undefined;

  constructor(
    readonly identity: ToolResultExpectedIdentity,
    readonly run: BackgroundDeliveryRun,
  ) {
    this.resources = new WorkerDeliveryResourceStore();
    this.segmentStore = new ResourceToolResultSegmentStore(this.resources);
    this.capture = new LocalShellStreamCapture(
      this.segmentStore,
      this.resources,
      identity,
      async () => {},
      {
        segmentBytes: BACKGROUND_SEGMENT_BYTES,
        segmentsPerPage: BACKGROUND_SEGMENTS_PER_PAGE,
        revisionPerSegment: true,
        onRevision: (ref) => this.onRevision(ref),
      },
    );
  }

  private async onRevision(ref: ManagedSessionDurableRef): Promise<void> {
    const resources = this.resources.since(this.lastResourceMarker);
    const marker = this.resources.watermark;
    const manifest = JSON.parse(
      (await this.resources.read(ref)).toString('utf8'),
    ) as { revision: number };
    if (await this.run.enqueueOutput(ref, manifest.revision, resources)) {
      this.lastResourceMarker = marker;
    } else {
      // A dropped revision means the stop found the outbox full: freeze
      // the capture so the buffered tail is dropped and the final revision
      // declares the gap (§4.4). The marker stays put so the terminal
      // entry carries the dropped revision's resources — the manifest it
      // settles must never name bytes the applier did not receive.
      this.capture.cancelCapture();
    }
  }

  setStarted(pid: number): void {
    this.capture.setStarted(pid);
  }

  setProcessResult(result: ShellExecutionResult): void {
    this.processResult = result;
    this.capture.setProcessResult({
      exitCode: result.exitCode,
      signal: result.signal,
    });
  }

  setStopRequested(): void {
    this.stopRequested = true;
    this.run.requestStop();
  }

  failCapture(): void {
    this.capture.failCapture();
  }

  isLostCaptureResult(_envelope: ToolResultEnvelope): boolean {
    return false;
  }

  recordPublisherLoss(_envelope: ToolResultEnvelope): boolean {
    return false;
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer): Promise<void> {
    this.armPartialFlush(stream);
    if (this.monitorPolicy && stream === 'stdout') {
      this.monitorPolicy.onChunk(chunk);
    }
    return this.capture.write(stream, chunk);
  }

  private armPartialFlush(stream: 'stdout' | 'stderr'): void {
    if (this.flushTimers[stream]) clearTimeout(this.flushTimers[stream]);
    this.flushTimers[stream] = setTimeout(() => {
      this.flushTimers[stream] = undefined;
      void this.capture.flushPartial(stream);
    }, PARTIAL_FLUSH_MS);
    if (typeof this.flushTimers[stream]!.unref === 'function') {
      this.flushTimers[stream]!.unref();
    }
  }

  finish(stream: 'stdout' | 'stderr', complete: boolean): Promise<void> {
    if (this.flushTimers[stream]) {
      clearTimeout(this.flushTimers[stream]);
      this.flushTimers[stream] = undefined;
    }
    return this.capture.finish(stream, complete);
  }

  async finalize(
    executionStatus: ToolResultEnvelope['executionStatus'],
    responseParts: readonly unknown[],
    error?: { readonly message: string; readonly type?: string },
  ): Promise<ToolResultEnvelope> {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.flushTimers[stream]) {
        clearTimeout(this.flushTimers[stream]);
        this.flushTimers[stream] = undefined;
      }
    }
    const status =
      executionStatus === 'not_started' ? 'cancelled' : executionStatus;
    const envelope = await this.capture.finalize(status, responseParts, error);
    // Flush the monitor's tail window before the terminal entry, so the last
    // observation lands ahead of the settle exactly as the resident loop does.
    let monitorStopReason: ManagedMonitorStopReason | undefined;
    if (this.monitorPolicy) {
      monitorStopReason = await this.monitorPolicy.flushTail();
    }
    const physical = this.processResult;
    const evidence =
      physical && (physical.exitCode !== null || physical.signal !== null)
        ? {
            exitCode: physical.exitCode,
            exitSignal: signalName(physical.signal),
          }
        : null;
    const manifestRef = envelope.capture?.manifest ?? null;
    // Of the revisions a forced stop dropped, only the settled manifest is
    // ever read; their other manifests would only crowd the request limit.
    const resources = manifestRef
      ? this.resources
          .since(this.lastResourceMarker)
          .filter(
            ({ ref }) =>
              ref.kind !== MANAGED_TOOL_RESULT_KINDS.manifest ||
              ref.resourceId === manifestRef.resourceId,
          )
      : [];
    this.lastResourceMarker = this.resources.watermark;
    this.run.enqueueTerminal(
      envelope,
      evidence,
      this.stopRequested,
      status,
      manifestRef,
      resources,
      monitorStopReason,
    );
    return envelope;
  }

  attachMonitorPolicy(policy: WorkerMonitorPolicy): void {
    this.monitorPolicy = policy;
  }

  async close(): Promise<void> {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.flushTimers[stream]) clearTimeout(this.flushTimers[stream]);
    }
    this.monitorPolicy?.disarm();
    await this.segmentStore.close();
  }
}

/**
 * The Monitor policy in the worker: line splitting, debounce windows, the
 * idle timeout and maxEvents. It assigns the observation sequence when the
 * observation is made, so the notification identity is fixed then, not at
 * commit. A quota or idle stop terminates the unit and emits the terminal
 * entry with its stop reason.
 */
export class WorkerMonitorPolicy {
  private readonly decoder = new StringDecoder('utf8');
  private remainder = '';
  private buffered: string[] = [];
  private sequence: number;
  private window: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private stopReason: ManagedMonitorStopReason = 'exited';
  /** Its own store, so an observation carries only its notification and
   * never the capture's output. */
  private readonly resources = new WorkerDeliveryResourceStore();
  private lastResourceMarker = -1;

  constructor(
    private readonly run: BackgroundDeliveryRun,
    private readonly params: {
      readonly monitorId: string;
      readonly executionCallId: string;
      readonly description: string;
      readonly maxEvents: number;
      readonly idleTimeoutMs: number;
      readonly debounceMs: number;
      readonly startSequence: number;
    },
    private readonly terminate: () => Promise<boolean>,
    private readonly onNotification?: () => void,
  ) {
    this.sequence = params.startSequence;
    this.armWindow();
    this.armIdle();
  }

  onChunk(chunk: Buffer): void {
    if (this.ended) return;
    this.remainder += this.decoder.write(chunk);
    let at = this.remainder.indexOf('\n');
    while (at >= 0) {
      const line = this.remainder.slice(0, at);
      this.remainder = this.remainder.slice(at + 1);
      if (line.length > 0) this.buffered.push(line);
      at = this.remainder.indexOf('\n');
    }
    if (this.remainder.length > 4096) {
      this.buffered.push(this.remainder.slice(0, 4096) + '...');
      this.remainder = '';
    }
  }

  private armWindow(): void {
    const ms = Math.max(this.params.debounceMs, MONITOR_DEBOUNCE_FLOOR_MS);
    this.window = setTimeout(() => {
      void this.flush().then(async () => {
        if (this.ended) return;
        if (this.sequence >= this.params.maxEvents) {
          await this.autoStop('max_events');
        } else {
          this.armWindow();
        }
      });
    }, ms);
    if (typeof this.window.unref === 'function') this.window.unref();
  }

  private armIdle(): void {
    if (this.ended) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      void this.autoStop('idle_timeout');
    }, this.params.idleTimeoutMs);
    if (typeof this.idle.unref === 'function') this.idle.unref();
  }

  private async flush(): Promise<void> {
    if (this.ended || this.buffered.length === 0) return;
    const lines = this.buffered;
    this.buffered = [];
    this.sequence += 1;
    const inputId = `${this.params.monitorId}:notify:${this.sequence}`;
    const contentRef = await this.resources.publish(
      'managed-input',
      Buffer.from(
        JSON.stringify({
          text: monitorNotificationText({
            monitorId: this.params.monitorId,
            toolUseId: this.params.executionCallId,
            description: this.params.description,
            eventCount: this.sequence,
            lines,
          }),
        }),
        'utf8',
      ),
    );
    const admissionRef = await this.resources.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    );
    const resources = this.resources.since(this.lastResourceMarker);
    const marker = this.resources.watermark;
    if (
      await this.run.enqueueObservation(
        this.sequence,
        lines,
        { inputId, turnId: inputId, contentRef, admissionRef },
        resources,
      )
    ) {
      this.lastResourceMarker = marker;
    }
    this.onNotification?.();
    this.armIdle();
  }

  private async autoStop(reason: ManagedMonitorStopReason): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.stopReason = reason;
    this.disarm();
    await this.terminate();
  }

  /**
   * The exit's tail window: commit it unless a quota or idle stop already
   * ended observing, then report the policy stop reason. As in the resident
   * loop, the physical end supersedes the quota. It never terminates the
   * unit: it runs on that unit's completion path, which terminate awaits.
   */
  async flushTail(): Promise<ManagedMonitorStopReason> {
    this.remainder += this.decoder.end();
    if (this.remainder.length > 0) {
      this.buffered.push(this.remainder);
      this.remainder = '';
    }
    await this.flush();
    this.ended = true;
    this.disarm();
    return this.stopReason;
  }

  disarm(): void {
    if (this.window) clearTimeout(this.window);
    if (this.idle) clearTimeout(this.idle);
    this.window = undefined;
    this.idle = undefined;
  }
}

export { EVENT_LINE_TRUNCATE };
