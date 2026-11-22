/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  ManagedShellResultSession,
  type LocalShellCaptureRequest,
  type LocalShellReceipt,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import { LocalShellStreamResultSession } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-result-session.js';
import type { LocalShellStreamCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-stream-capture.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type { HostedChildRunSession } from './hosted-child-run-session.js';
import type { HostedMonitorSession } from './hosted-monitor-session.js';
import { buildMonitorNotificationInput } from './hosted-monitor-notification.js';
import type { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import {
  ResourceToolResultSegmentStore,
  type DurableToolResultResourceStore,
} from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import {
  parseToolResultEnvelope,
  parseToolResultManifest,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
  parseManagedDeliveryEntry,
  type ManagedDeliveryEntry,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-delivery-entry.js';
import type { ManagedSessionInputRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  boundedShellPreview,
  HOSTED_SHELL_PUBLISHER_PATH,
  SHELL_PUBLISHER_BODY_LIMIT,
  publisherFields,
  publisherObject,
  type ShellPublisherDescriptor,
} from './managed-shell-publisher.js';

interface RegisteredCapture {
  readonly request?: LocalShellCaptureRequest;
  readonly modelCallId?: string;
  readonly admission?:
    | ManagedShellResultSession
    | LocalShellStreamResultSession;
  readonly restored?: boolean;
  readonly store: ResourceToolResultSegmentStore;
  readonly offsets: { stdout: number; stderr: number };
  readonly ended: { stdout: boolean; stderr: boolean };
  prepared?: Promise<{
    identity: ToolResultExpectedIdentity;
    sink: LocalShellResultCapture | LocalShellStreamCapture;
  }>;
  sink?: LocalShellResultCapture | LocalShellStreamCapture;
  envelope?: ToolResultEnvelope;
  finalizing?: Promise<ToolResultEnvelope>;
  accepting?: Promise<LocalShellReceipt>;
  // H3: the open-ended background capture of a proven child_run or
  // monitor_run start, with the manifest revisions it has already
  // forwarded to the record. A Monitor watch also carries the observer
  // the hosted observation loop registers on it. A finalize the record's
  // state refused is remembered as `refusedBody` until `settleAttached`
  // re-drives it, so a watch that ended before its start receipt landed
  // still completes its own settle without any client retry.
  background?: {
    sink?: LocalShellStreamCapture;
    lastManifest: ManagedSessionDurableRef | null;
    recordDomain: 'child_run' | 'monitor_run';
    remainder: string;
    decoder: StringDecoder;
    refusedBody?: Record<string, unknown>;
    // A refused finalize whose record is already attached re-drives
    // itself: the route's stash alone cannot heal a stranded record whose
    // worker finalized exactly once and moved on. Attempts are bounded,
    // and any in-flight attempt joins the drain's wait set so a Session
    // close can never outrun it.
    redrive?: NodeJS.Timeout;
    redriveAttempts?: number;
    redriveInFlight?: Promise<void>;
    observer?: {
      onLine: (line: string) => void;
      // stopRequested marks a platform-driven stop (#13856 A8).
      onExit: (
        failed: boolean,
        stopRequested?: boolean,
      ) => Promise<void> | void;
    };
  };
}

type BackgroundCaptureRequest = LocalShellCaptureRequest & {
  readonly capture: { readonly background?: boolean };
};

// Bounded self re-drive of a refused finalize: one transient 5xx cannot
// strand an attached record, and neither can a brief store outage.
const MAX_REDRIVE_ATTEMPTS = 3;
const REDRIVE_BACKOFF_MS = 250;

export class HostedShellPublisher {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly captures = new Map<string, RegisteredCapture>();
  /** Phase 3b: the highest contiguous delivery sequence applied per run. */
  private readonly appliedThrough = new Map<string, number>();
  private readonly operations = new Set<Promise<unknown>>();
  private deliveryGate: Promise<void> | undefined;
  private server?: Server;
  private descriptor?: ShellPublisherDescriptor;
  private closing = false;
  private lifecyclePrepared = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly session: ManagedSession,
    private readonly resources: DurableToolResultResourceStore,
    private readonly assertWritable: () => Promise<void>,
    private readonly childRuns?: HostedChildRunSession,
    private readonly monitors?: HostedMonitorSession,
    private readonly onNotification?: () => void,
  ) {}

  prepareLifecycle(): void {
    this.lifecyclePrepared = true;
  }

  async start(): Promise<ShellPublisherDescriptor> {
    if (this.closing) throw new Error('Shell publisher is closed.');
    if (this.descriptor) return this.descriptor;
    const app = express();
    app.disable('x-powered-by');
    app.post(
      HOSTED_SHELL_PUBLISHER_PATH,
      (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const authorization = req.get('Authorization');
        const token = Buffer.from(
          authorization?.startsWith('Bearer ') ? authorization.slice(7) : '',
        );
        const expected = Buffer.from(this.token);
        if (
          token.length !== expected.length ||
          !timingSafeEqual(token, expected)
        ) {
          res.sendStatus(401);
          return;
        }
        if (this.closing) {
          res.sendStatus(503);
          return;
        }
        next();
      },
      express.json({
        limit: Math.max(
          SHELL_PUBLISHER_BODY_LIMIT,
          MANAGED_DELIVERY_REQUEST_LIMIT_BYTES,
        ),
        strict: true,
        inflate: false,
      }),
      (req, res) => {
        const operation = this.handle(req.body);
        this.operations.add(operation);
        void operation
          .then(
            (result) => res.json(result),
            () =>
              res.status(409).json({ code: 'hosted_shell_publication_failed' }),
          )
          .finally(() => this.operations.delete(operation));
      },
    );
    app.use(
      (
        _cause: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(400).json({ code: 'hosted_shell_publication_invalid' });
      },
    );
    this.server = createServer(app);
    this.server.maxHeadersCount = 16;
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (this.server.address() as AddressInfo).port;
    this.descriptor = {
      url: `http://127.0.0.1:${port}${HOSTED_SHELL_PUBLISHER_PATH}`,
      token: this.token,
    };
    return this.descriptor;
  }

  register(
    request: BackgroundCaptureRequest,
    modelCallId: string,
    callerPromptId: string,
  ): void {
    if (this.closing)
      throw new Error('Shell publisher Runtime Session conflicts.');
    // Foreground guards how the model call fits the registering turn; a
    // background capture is admitted by its child_run record instead.
    if (
      request.capture.background !== true &&
      request.reference.sessionId !== callerPromptId
    )
      throw new Error('Shell publisher Runtime Session conflicts.');
    const id = request.capture.executionCallId;
    const previous = this.captures.get(id);
    if (previous) {
      if (
        previous.restored ||
        !previous.request ||
        managedToolDigest(previous.request) !== managedToolDigest(request) ||
        previous.modelCallId !== modelCallId
      )
        throw new Error('Shell publisher execution conflicts.');
      return;
    }
    const store = new ResourceToolResultSegmentStore(this.resources);
    const backgroundRequested =
      (request as BackgroundCaptureRequest).capture.background === true;
    if (backgroundRequested && this.childRuns === undefined) {
      throw new Error(
        'Background Shell capture was not registered with its orchestrator.',
      );
    }
    const monitoringRequested =
      backgroundRequested && request.capture.monitoring === true;
    if (monitoringRequested && this.monitors === undefined) {
      throw new Error(
        'Monitor capture was not registered with its orchestrator.',
      );
    }
    const admission = backgroundRequested
      ? new LocalShellStreamResultSession(
          this.session,
          store,
          request.capture.bindingGeneration,
          this.assertWritable,
          request.reference.sessionId,
          this.session.resources,
          monitoringRequested ? 'monitor_run' : 'child_run',
        )
      : new ManagedShellResultSession(
          this.session,
          store,
          request.capture.bindingGeneration,
          this.assertWritable,
          request.reference.sessionId,
          this.resources,
        );
    this.captures.set(id, {
      request: structuredClone(request),
      modelCallId,
      store,
      admission,
      offsets: { stdout: 0, stderr: 0 },
      ended: { stdout: false, stderr: false },
      ...(backgroundRequested
        ? {
            background: {
              lastManifest: null,
              recordDomain: monitoringRequested ? 'monitor_run' : 'child_run',
              remainder: '',
              decoder: new StringDecoder('utf8'),
            },
          }
        : {}),
    });
  }

  /**
   * Restores a reloaded background capture slot for Phase 3b re-attach and
   * staged-delivery drain without opening a new legacy stream session.
   */
  restoreBackgroundCapture(
    executionCallId: string,
    recordDomain: 'child_run' | 'monitor_run',
    lastManifest: ManagedSessionDurableRef | null = null,
  ): void {
    if (this.captures.has(executionCallId)) return;
    this.captures.set(executionCallId, {
      restored: true,
      store: new ResourceToolResultSegmentStore(this.resources),
      offsets: { stdout: 0, stderr: 0 },
      ended: { stdout: false, stderr: false },
      background: {
        lastManifest,
        recordDomain,
        remainder: '',
        decoder: new StringDecoder('utf8'),
      },
    });
  }

  /**
   * Holds incoming worker delivery pushes while re-attach drains staged rows,
   * so staged entries commit before live pushes without flipping back to held.
   */
  holdDeliveries(): () => void {
    let release!: () => void;
    const previous = this.deliveryGate;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous ? previous.then(() => current) : current;
    this.deliveryGate = chained;
    return () => {
      release();
      if (this.deliveryGate === chained) {
        this.deliveryGate = undefined;
      }
    };
  }

  appliedWatermarks(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.appliedThrough.entries());
  }

  async applyStagedDeliveries(
    stagedEntries: readonly ManagedDeliveryEntry[],
    observedRuns: Readonly<Record<string, number>>,
    acknowledgeRun: (
      executionCallId: string,
      throughSeq: number,
    ) => Promise<void>,
  ): Promise<void> {
    const byRun = new Map<string, ManagedDeliveryEntry[]>();
    for (const entry of stagedEntries) {
      let group = byRun.get(entry.executionCallId);
      if (!group) {
        group = [];
        byRun.set(entry.executionCallId, group);
      }
      group.push(entry);
    }
    for (const [executionCallId, group] of byRun) {
      group.sort((a, b) => a.deliverySeq - b.deliverySeq);
      const capture = this.captures.get(executionCallId);
      if (!capture?.background) {
        throw new Error(
          'Staged delivery names an unregistered background capture: ' +
            executionCallId,
        );
      }
      let applied =
        this.appliedThrough.get(executionCallId) ?? group[0].deliverySeq - 1;
      for (const delivered of group) {
        if (delivered.deliverySeq <= applied) continue;
        if (delivered.deliverySeq !== applied + 1) {
          throw new Error('Staged delivery sequence is not contiguous.');
        }
        // The Broker stored a staged entry's resources itself and stripped
        // them from the row, so only the entry applies here.
        await this.applyDeliveryEntry(capture, delivered, executionCallId);
        applied = delivered.deliverySeq;
        this.appliedThrough.set(executionCallId, applied);
      }
      await acknowledgeRun(executionCallId, applied);
    }
    for (const [executionCallId, acked] of Object.entries(observedRuns)) {
      if (acked > (this.appliedThrough.get(executionCallId) ?? 0)) {
        this.appliedThrough.set(executionCallId, acked);
      }
    }
  }

  private async handle(candidate: unknown): Promise<unknown> {
    const body = publisherObject(candidate);
    if (body['operation'] === 'prepare') {
      publisherFields(body, ['operation', 'request']);
      const request = publisherObject(body['request']);
      const capture = publisherObject(request['capture']);
      const entry = this.captures.get(String(capture['executionCallId']));
      if (
        !entry ||
        entry.restored ||
        !entry.request ||
        !entry.admission ||
        managedToolDigest(entry.request) !== managedToolDigest(request)
      )
        throw new Error('Unregistered Shell capture.');
      await entry.admission.assertWritable();
      if (entry.background) {
        const streamAdmission =
          entry.admission as LocalShellStreamResultSession;
        const prepared = (entry.prepared ??= streamAdmission.prepare(
          entry.request as BackgroundCaptureRequest,
        ));
        entry.sink = (await prepared).sink;
        entry.background.sink = entry.sink as LocalShellStreamCapture;
        entry.background.sink.onBrokenAnnounce = async () => {
          await this.advanceBackgroundManifest(
            entry,
            String(capture['executionCallId']),
          );
        };
        // The open manifest is what any reader sees before exit.
        await entry.background.sink.open();
        await this.advanceBackgroundManifest(
          entry,
          String(capture['executionCallId']),
        );
        return entry.sink.identity;
      }
      const foreground = entry.admission as ManagedShellResultSession;
      const prepared = (entry.prepared ??= foreground.prepare(
        entry.request,
        entry.modelCallId,
      ));
      entry.sink = (await prepared).sink;
      return entry.sink.identity;
    }
    if (body['operation'] === 'deliver') {
      return this.applyDelivery(body);
    }
    const id = body['executionCallId'];
    const entry = typeof id === 'string' ? this.captures.get(id) : undefined;
    if (!entry?.sink || !entry.admission)
      throw new Error('Shell capture was not prepared.');
    await entry.admission.assertWritable();
    const sink = entry.sink;
    if (body['operation'] === 'write') {
      publisherFields(body, [
        'operation',
        'executionCallId',
        'stream',
        'offset',
        'bytesBase64',
      ]);
      const stream = this.stream(body['stream']);
      if (
        entry.envelope ||
        entry.finalizing ||
        entry.ended[stream] ||
        body['offset'] !== entry.offsets[stream] ||
        typeof body['bytesBase64'] !== 'string'
      ) {
        sink.failCapture();
        throw new Error('Shell write conflicts.');
      }
      const bytes = Buffer.from(body['bytesBase64'], 'base64');
      if (
        !bytes.byteLength ||
        bytes.byteLength > 64 * 1024 ||
        bytes.toString('base64') !== body['bytesBase64']
      ) {
        sink.failCapture();
        throw new Error('Invalid Shell bytes.');
      }
      entry.offsets[stream] += bytes.byteLength;
      await sink.write(stream, bytes);
      try {
        await this.advanceBackgroundManifest(entry, String(id));
      } catch {
        // A record-side forward failure never poisons a byte that already
        // landed: the next edging write retries the forward. The tray's
        // settle arms keep their fail-stop, which is where integrity lives.
      }
      if (
        entry.background?.recordDomain === 'monitor_run' &&
        stream === 'stdout'
      )
        this.fanMonitorLines(entry.background, bytes);
      return { accepted: true };
    }
    if (body['operation'] === 'finish') {
      publisherFields(body, [
        'operation',
        'executionCallId',
        'stream',
        'complete',
      ]);
      const stream = this.stream(body['stream']);
      if (
        typeof body['complete'] !== 'boolean' ||
        entry.finalizing ||
        entry.envelope
      )
        throw new Error('Invalid Shell finish.');
      entry.ended[stream] = true;
      await sink.finish(stream, body['complete']);
      try {
        await this.advanceBackgroundManifest(entry, String(id));
      } catch {
        // Same retry rule as the write op: the stream's durable seal
        // landed, the record forward retries on the next arm.
      }
      return { accepted: true };
    }
    if (body['operation'] === 'finalize') {
      publisherFields(body, [
        'operation',
        'executionCallId',
        'started',
        'failed',
        'process',
        'executionStatus',
        'responseParts',
        'previewTruncated',
        'error',
      ]);
      if (entry.finalizing) return entry.finalizing;
      if (entry.background) {
        entry.finalizing = this.finalizeBackground(entry, body, String(id));
        try {
          entry.envelope = await entry.finalizing;
          entry.background.refusedBody = undefined;
        } catch (cause) {
          // A rejected finalize must never pin the capture: a retry after
          // the cause resolved reads a clean settle attempt, not this
          // permanent refusal. The refused body stays remembered too, so
          // the settle the record's state missed — a watch that ended
          // before its start receipt landed — completes on attach without
          // any client retry.
          entry.finalizing = undefined;
          entry.background.refusedBody = body;
          const owner =
            entry.background.recordDomain === 'monitor_run'
              ? this.monitors?.record(String(id))
              : this.childRuns?.record(String(id));
          // An attached record that missed the final forward otherwise
          // strands forever: the worker finalizes once and drops the hold.
          // The same stash re-drives itself, bounded and drain-aware, so a
          // brief store outage cannot strand it either; a retry the client
          // or the attach path already owns guards this out.
          if (owner?.startReceiptRef) {
            entry.background.redriveAttempts = 1;
            this.scheduleRedrive(String(id), entry);
          }
          throw cause;
        }
        return entry.envelope;
      }
      entry.finalizing = this.finalize(entry, body);
      try {
        entry.envelope = await entry.finalizing;
      } catch (cause) {
        entry.finalizing = undefined;
        throw cause;
      }
      return entry.envelope;
    }
    if (body['operation'] === 'accept') {
      publisherFields(body, ['operation', 'executionCallId', 'envelope']);
      const envelope = parseToolResultEnvelope(body['envelope']);
      if (
        !entry.envelope ||
        JSON.stringify(envelope) !== JSON.stringify(entry.envelope)
      )
        throw new Error('Shell result changed.');
      if (entry.background) {
        // The detached family: the exit commit lives on the record, so the
        // client acknowledges exactly the manifest it was shown, blocked.
        const manifestRef =
          entry.envelope.capture?.manifest ?? entry.background.lastManifest;
        const outcomeRef =
          manifestRef ??
          (await this.session.resources.publish(
            'managed-tool-outcome',
            Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                decision: 'blocked',
                envelope,
                manifestRef: null,
              }),
            ),
          ));
        const receipt: LocalShellReceipt = {
          executionCallId: String(id),
          manifest: manifestRef,
          deliveryStatus: 'blocked',
          historyRevision: null,
          outcomeRef,
        };
        return receipt;
      }
      entry.accepting ??= (entry.admission as ManagedShellResultSession)
        .accept(sink.identity as ToolResultExpectedIdentity, envelope)
        .catch((cause: unknown) => {
          entry.accepting = undefined;
          throw cause;
        });
      return entry.accepting;
    }
    throw new Error('Unknown Shell publisher operation.');
  }

  private stream(value: unknown): 'stdout' | 'stderr' {
    if (value !== 'stdout' && value !== 'stderr')
      throw new Error('Invalid Shell stream.');
    return value;
  }

  private async finalize(
    entry: RegisteredCapture,
    body: Record<string, unknown>,
  ): Promise<ToolResultEnvelope> {
    const sink = entry.sink!;
    if (
      typeof body['started'] !== 'boolean' ||
      typeof body['failed'] !== 'boolean' ||
      typeof body['previewTruncated'] !== 'boolean' ||
      !Array.isArray(body['responseParts'])
    )
      throw new Error('Invalid Shell finalization.');
    if (body['failed']) sink.failCapture();
    if (body['started']) {
      const physical = publisherFields(body['process'], [
        'exitCode',
        'signal',
        'previewBytes',
      ]);
      if (
        (physical['exitCode'] !== null &&
          !Number.isInteger(physical['exitCode'])) ||
        (physical['signal'] !== null &&
          !Number.isInteger(physical['signal'])) ||
        !Number.isSafeInteger(physical['previewBytes']) ||
        (physical['previewBytes'] as number) < 0 ||
        (physical['previewBytes'] as number) > 64 * 1024
      )
        throw new Error('Invalid Shell physical result.');
      sink.setStarted(1);
      sink.setProcessResult({
        exitCode: physical['exitCode'] as number | null,
        signal: physical['signal'] as number | null,
        rawOutput: Buffer.alloc(physical['previewBytes'] as number),
        output: '',
        error: null,
        aborted: body['executionStatus'] === 'cancelled',
        pid: undefined,
        executionMethod: 'child_process',
      });
      for (const stream of ['stdout', 'stderr'] as const) {
        if (!entry.ended[stream]) {
          sink.failCapture();
          await sink.finish(stream, false);
        }
      }
    } else {
      if (
        body['process'] !== null ||
        entry.offsets.stdout ||
        entry.offsets.stderr
      ) {
        throw new Error('Unstarted Shell has a physical result.');
      }
      await Promise.all([
        sink.finish('stdout', false),
        sink.finish('stderr', false),
      ]);
    }
    const preview = boundedShellPreview(body['responseParts']);
    const fields = parseToolResultEnvelope({
      executionStatus: body['started']
        ? body['executionStatus']
        : 'not_started',
      responseParts: preview,
      ...(body['error'] === null ? {} : { error: body['error'] }),
      capture: body['started']
        ? {
            captureStatus: 'unavailable',
            captureReason: 'storage_failed',
            manifest: null,
            previewTruncated: false,
            deliveryStatus: 'pending',
          }
        : null,
    });
    const envelope = await sink.finalize(
      fields.executionStatus as Exclude<
        ToolResultEnvelope['executionStatus'],
        'not_started'
      >,
      preview,
      fields.error,
    );
    return envelope.capture && body['previewTruncated']
      ? {
          ...envelope,
          capture: { ...envelope.capture, previewTruncated: true },
        }
      : envelope;
  }

  /**
   * Registers the monitor watch's observation loop behind one admitted
   * capture: lines the capture publishes land as its onLine, its final
   * end as onExit.
   */
  setMonitorObserver(
    executionCallId: string,
    observer: {
      readonly onLine: (line: string) => void;
      readonly onExit: (
        failed: boolean,
        stopRequested?: boolean,
      ) => Promise<void> | void;
    },
  ): void {
    const background = this.captures.get(executionCallId)?.background;
    if (!background || background.recordDomain !== 'monitor_run')
      throw new Error(
        `Monitor ${executionCallId} has no registered observation watch.`,
      );
    background.observer = observer;
    // Lines that arrived before the observation arm attached were kept in
    // the remainder rather than dropped; they replay here, in order.
    if (background.remainder.length > 0) {
      this.fanMonitorLines(background, Buffer.alloc(0));
    }
  }

  /**
   * Forwards whole observation lines from the watch's durable stream to
   * the hosted loop. A StringDecoder keeps a multi-byte rune intact when
   * a chunk ends inside it; a blank line consumes no observation, exactly
   * like the Legacy emit path (the durable stream holds its bytes
   * regardless); the watch-side remainder survives across chunks, and the
   * Legacy partial-line cap is honored. Until an observer registers, the
   * decoded text accumulates in the remainder — the start-to-attach
   * window is small — so those lines replay instead of dying unseen.
   */
  private fanMonitorLines(
    background: {
      remainder: string;
      decoder: StringDecoder;
      observer?: {
        onLine: (line: string) => void;
        onExit: (
          failed: boolean,
          stopRequested?: boolean,
        ) => Promise<void> | void;
      };
    },
    chunk: Buffer,
  ): void {
    background.remainder += background.decoder.write(chunk);
    const observer = background.observer;
    if (!observer) return;
    let at = background.remainder.indexOf('\n');
    while (at >= 0) {
      const line = background.remainder.slice(0, at);
      background.remainder = background.remainder.slice(at + 1);
      // A blank line consumes no observation, exactly like the Legacy
      // emit path; the durable stream already holds its bytes.
      if (line.length > 0) observer.onLine(line);
      at = background.remainder.indexOf('\n');
    }
    if (background.remainder.length > 4096) {
      // The Legacy partial-line cap force-emits: the truncated prefix with
      // an ellipsis becomes one observation and the rest of the overlong
      // line is gone by design — never a silent clear that loses it all,
      // and never an observation for only some of it later.
      const truncated = background.remainder.slice(0, 4096) + '...';
      background.remainder = '';
      if (observer) observer.onLine(truncated);
      else background.remainder = truncated;
    }
  }

  /**
   * Forwards the latest published manifest revision of the background
   * capture to its record, always after the awaited write or finish that
   * edged the manifest and always only forward.
   */
  private async advanceBackgroundManifest(
    entry: RegisteredCapture,
    executionCallId: string,
  ): Promise<void> {
    const background = entry.background;
    if (!background?.sink) return;
    const current = background.sink.currentManifest;
    if (current && current !== background.lastManifest) {
      // The open manifest exists for readers from its first page on, but
      // the record quotes it only once a start receipt exists: output
      // before a start receipt is a parse-level refusal, never a commit.
      const owner =
        background.recordDomain === 'monitor_run'
          ? this.monitors?.record(executionCallId)
          : this.childRuns?.record(executionCallId);
      if (!owner) {
        throw new Error(
          `The ${background.recordDomain} record for ${executionCallId} is missing.`,
        );
      }
      if (owner.startReceiptRef === null) return;
      if (background.recordDomain === 'monitor_run') {
        if (!this.monitors) return;
        await this.monitors.advanceOutput(executionCallId, current);
      } else {
        if (!this.childRuns) return;
        await this.childRuns.advanceOutput(executionCallId, current);
      }
      // Advance mark comes last: a thrown forward is retried by the next
      // edging write with the same or a newer manifest — never latched
      // permanently ahead of the record.
      background.lastManifest = current;
    }
  }

  /**
   * The background settle: seals the stream capture with the physical
   * evidence, rings the manifest forward one last time, then settles the
   * record with exactly that evidence — one evidence object, one exit
   * fact, named identically in the manifest and the record.
   */
  private async finalizeBackground(
    entry: RegisteredCapture,
    body: Record<string, unknown>,
    executionCallId: string,
  ): Promise<ToolResultEnvelope> {
    const background = entry.background!;
    const sink = background.sink!;
    if (
      typeof body['started'] !== 'boolean' ||
      typeof body['failed'] !== 'boolean' ||
      !Array.isArray(body['responseParts'])
    )
      throw new Error('Invalid Shell finalization.');
    if (body['failed']) sink.failCapture();
    let evidence: {
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
    } | null = null;
    // A8 (#13856): the platform asked for this stop (a drain's terminate,
    // a Session close, a worker close) — never a natural exit.
    let stopRequested = false;
    if (body['started']) {
      // The A8 marker rides the process block as the one optional key: the
      // field set stays closed, but its absence is a natural exit (the
      // worker always sends it; older fixtures may not).
      const physical = publisherObject(body['process']);
      for (const key of Object.keys(physical)) {
        if (
          !['exitCode', 'signal', 'previewBytes', 'stopRequested'].includes(key)
        )
          throw new Error('Invalid Shell physical result.');
      }
      if (
        (physical['exitCode'] !== null &&
          !Number.isInteger(physical['exitCode'])) ||
        (physical['signal'] !== null && !Number.isInteger(physical['signal']))
      ) {
        throw new Error('Invalid Shell physical result.');
      }
      if (
        physical['stopRequested'] !== undefined &&
        typeof physical['stopRequested'] !== 'boolean'
      ) {
        throw new Error('Invalid Shell physical result.');
      }
      stopRequested = physical['stopRequested'] === true;
      evidence = {
        exitCode: physical['exitCode'] as number | null,
        exitSignal: physicalSignalName(physical['signal'] as number | null),
      };
      // A null pair is no evidence at all: the worker's end-without-proof
      // path reports exactly that, and settling it as an exit would either
      // be refused by the record or would record an exit nothing proved.
      if (evidence.exitCode === null && evidence.exitSignal === null) {
        evidence = null;
      }
      sink.setStarted(1);
      sink.setProcessResult({
        exitCode: physical['exitCode'] as number | null,
        signal: physical['signal'] as number | null,
      });
    } else {
      if (
        body['process'] !== null ||
        entry.offsets.stdout ||
        entry.offsets.stderr
      ) {
        throw new Error('Unstarted Shell has a physical result.');
      }
    }
    const executionStatus = body['executionStatus'];
    if (
      executionStatus !== 'success' &&
      executionStatus !== 'error' &&
      executionStatus !== 'cancelled'
    ) {
      throw new Error('Invalid Shell execution status.');
    }
    const envelope = await sink.finalize(
      executionStatus,
      body['responseParts'] as readonly unknown[],
      (body['error'] as
        | { readonly message: string; readonly type?: string }
        | null
        | undefined) ?? undefined,
    );
    await this.advanceBackgroundManifest(entry, executionCallId);
    const observer =
      background.recordDomain === 'monitor_run'
        ? background.observer
        : undefined;
    if (background.recordDomain === 'monitor_run') {
      background.remainder += background.decoder.end();
    }
    if (observer && background.remainder.length > 0) {
      observer.onLine(background.remainder);
      background.remainder = '';
    }
    if (background.recordDomain === 'monitor_run') {
      const exit = observer?.onExit(evidence === null, stopRequested);
      if (exit !== undefined) {
        // An observed capture's loop owns the terminal settle: flush →
        // settle lands inside this one chain, so the last window is
        // committed before anything can settle the record, and its
        // commit failures surface here instead of dying in the void.
        await exit;
      } else if (this.monitors) {
        // An end whose observation arm never attached still commits the
        // tail its stream already decoded: the final window lands as its
        // own observation revision with its own wake input, and only then
        // does the record settle. An empty end takes no observation, as
        // the Legacy emit-at-zero shape held.
        const record = this.monitors.record(executionCallId);
        if (record === undefined) {
          throw new Error(
            `The monitor_run record for ${executionCallId} is missing.`,
          );
        }
        // A parked record's observation period already ended (its quota or
        // idle window passed the stop unproven): the capture tail that
        // follows is not a new observation, and committing it would be
        // refused as an over-quota or illegal-successor revision ahead of the
        // settle. The real exit evidence settles the parked record directly
        // (#13856 R1-55).
        if (record.run.state === 'recovery_blocked') {
          if (evidence !== null) {
            if (stopRequested) {
              await this.monitors.settleStopRequested(executionCallId);
            } else {
              await this.monitors.settleQuiet(executionCallId, 'exited');
            }
          }
          // An unproven end over a parked watch changes nothing: the park
          // already recorded runtime_lost.
          return envelope;
        }
        const windowLines = background.remainder
          .split('\n')
          .filter((line) => line.length > 0);
        if (windowLines.length > 0) {
          const args = JSON.parse(
            (
              await this.monitors.resourceStore.read(record.commandRef)
            ).toString('utf8'),
          ) as Record<string, unknown>;
          const description =
            typeof args['description'] === 'string' &&
            args['description'].trim()
              ? (args['description'] as string)
              : typeof args['command'] === 'string'
                ? (args['command'] as string)
                : executionCallId;
          const input = this.lifecyclePrepared
            ? undefined
            : await buildMonitorNotificationInput({
                monitorId: executionCallId,
                toolUseId: record.run.executionCallId,
                description,
                sequence: record.observationSequence + 1,
                lines: windowLines,
                resourceStore: this.monitors.resourceStore,
              });
          await this.monitors.observe(
            executionCallId,
            { lines: windowLines },
            input && !this.lifecyclePrepared ? { input } : undefined,
          );
          // Consume the tail only once its observation committed: a refused
          // commit (the record is not attached yet) keeps the lines for the
          // retry that settles this watch after the start receipt lands.
          background.remainder = '';
          if (input && !this.lifecyclePrepared) this.onNotification?.();
        }
        const last =
          windowLines.length > 0
            ? record.observationSequence + 1
            : record.observationSequence;
        if (evidence === null) {
          // An unproven end is a failure, marked or not — the marker can
          // never mint a stop nobody proved (the shell lane's
          // process_failed is the same rule).
          await this.monitors.settleFailed(executionCallId, {
            stopReason: 'watch_failed',
            started: true,
          });
        } else if (stopRequested) {
          // A platform stop is the fact the model needs, ahead of the
          // quiet reasons the same end could also claim (#13856 A8).
          await this.monitors.settleStopRequested(executionCallId);
        } else if (last >= record.maxEvents) {
          await this.monitors.settleQuiet(executionCallId, 'max_events');
        } else {
          await this.monitors.settleQuiet(executionCallId, 'exited');
        }
      } else {
        // A monitor_run capture is admitted only where its Session record
        // exists, so a finalize without the Session handle can never
        // settle it — refuse loudly rather than skipping the settle.
        throw new Error(
          `The monitor_run record for ${executionCallId} has no monitor session to settle it.`,
        );
      }
      return envelope;
    }
    if (evidence === null) {
      // The record proves the process started; without physical facts the
      // finalize path never reports an exit either.
      await this.childRuns?.settleFailed(executionCallId, {
        stopReason: 'process_failed',
        started: true,
      });
    } else if (stopRequested) {
      // A8 (#13856): a platform-driven stop projects as a requested stop,
      // not a bare exit — the contract takes the request revision first.
      await this.childRuns?.requestStop(executionCallId);
      await this.childRuns?.settleStopRequested(executionCallId);
    } else {
      await this.childRuns?.settleExited(executionCallId, evidence);
    }
    return envelope;
  }

  async receipt(
    executionCallId: string,
    deliveredEnvelope: ToolResultEnvelope,
  ): Promise<LocalShellReceipt> {
    const entry = this.captures.get(executionCallId);
    if (!entry?.sink || !entry.envelope || !deliveredEnvelope.capture)
      throw new Error('Shell has no admitted result.');
    const pending = parseToolResultEnvelope({
      ...deliveredEnvelope,
      capture: { ...deliveredEnvelope.capture, deliveryStatus: 'pending' },
    });
    if (JSON.stringify(pending) !== JSON.stringify(entry.envelope))
      throw new Error('Delivered Shell result conflicts.');
    const receipt = await (
      entry.admission as ManagedShellResultSession
    ).recorded((entry.sink as LocalShellResultCapture).identity);
    if (
      !receipt ||
      receipt.deliveryStatus !== deliveredEnvelope.capture.deliveryStatus
    )
      throw new Error('Shell result has no matching durable receipt.');
    return receipt;
  }

  /**
   * Re-drives a finalize the record's pre-attach state refused. The
   * refused body stays on the entry, and once the record carries its start
   * receipt the exact same chain — manifest advance, tail observation,
   * record settle — completes without any client retry. A retry the client
   * already drives owns the attempt and is never duplicated here.
   */
  async settleAttached(executionCallId: string): Promise<void> {
    const entry = this.captures.get(executionCallId);
    const background = entry?.background;
    const body = background?.refusedBody;
    if (!entry || !background || body === undefined) return;
    if (entry.finalizing) return;
    if (background.redrive !== undefined) {
      clearTimeout(background.redrive);
      background.redrive = undefined;
    }
    background.redriveAttempts = undefined;
    background.refusedBody = undefined;
    entry.finalizing = this.finalizeBackground(entry, body, executionCallId);
    try {
      entry.envelope = await entry.finalizing;
    } catch (cause) {
      entry.finalizing = undefined;
      background.refusedBody ??= body;
      throw cause;
    }
  }

  private scheduleRedrive(executionCallId: string, entry: RegisteredCapture) {
    const background = entry.background;
    if (!background || background.redrive !== undefined) return;
    const attempt = background.redriveAttempts ?? 1;
    const redrive = setTimeout(
      () => {
        background.redrive = undefined;
        background.redriveInFlight = this.settleAttached(executionCallId)
          .then(() => undefined)
          .catch(() => {
            if (
              background.refusedBody !== undefined &&
              attempt < MAX_REDRIVE_ATTEMPTS
            ) {
              background.redriveAttempts = attempt + 1;
              this.scheduleRedrive(executionCallId, entry);
            }
          })
          .finally(() => {
            background.redriveInFlight = undefined;
          });
      },
      (attempt - 1) * REDRIVE_BACKOFF_MS,
    );
    if (typeof redrive.unref === 'function') redrive.unref();
    background.redrive = redrive;
  }

  /**
   * Phase 3b: applies a batch of worker-owned delivery entries in order.
   * Each entry carries the complete resources it introduces; the applier
   * publishes them idempotently, then advances or settles the record exactly
   * as the resident capture path does. A gap is refused; the worker re-sends
   * from its oldest unacknowledged entry.
   */
  private async applyDelivery(body: Record<string, unknown>): Promise<unknown> {
    if (this.deliveryGate) {
      await this.deliveryGate;
    }
    publisherFields(body, ['operation', 'executionCallId', 'entries']);
    const executionCallId = String(body['executionCallId']);
    const entry = this.captures.get(executionCallId);
    if (!entry?.background) {
      throw new Error('Delivery names an unregistered background capture.');
    }
    if (!Array.isArray(body['entries']) || body['entries'].length === 0) {
      throw new Error('Delivery batch is empty.');
    }
    const entries = body['entries'].map(parseManagedDeliveryEntry);
    let applied = this.appliedThrough.get(executionCallId) ?? 0;
    let receipt: LocalShellReceipt | undefined;
    for (const delivered of entries) {
      if (delivered.executionCallId !== executionCallId) {
        throw new Error('Delivery entry names another execution.');
      }
      if (delivered.deliverySeq <= applied) continue; // already applied
      if (delivered.deliverySeq !== applied + 1) {
        throw new Error('Delivery sequence is not contiguous.');
      }
      await this.publishDeliveryResources(delivered);
      receipt = await this.applyDeliveryEntry(
        entry,
        delivered,
        executionCallId,
      );
      applied = delivered.deliverySeq;
      this.appliedThrough.set(executionCallId, applied);
    }
    return {
      appliedThrough: applied,
      ...(receipt ? { receipt } : {}),
    };
  }

  private async publishDeliveryResources(
    entry: ManagedDeliveryEntry,
  ): Promise<void> {
    for (const resource of entry.resources) {
      await this.resources.publish(
        resource.ref.kind,
        Buffer.from(resource.bytesBase64, 'base64'),
        resource.ref.resourceId,
      );
    }
  }

  private async applyDeliveryEntry(
    entry: RegisteredCapture,
    delivered: ManagedDeliveryEntry,
    executionCallId: string,
  ): Promise<LocalShellReceipt | undefined> {
    const background = entry.background!;
    const domain = background.recordDomain;
    const owner =
      domain === 'monitor_run'
        ? this.monitors?.record(executionCallId)
        : this.childRuns?.record(executionCallId);
    if (!owner) {
      throw new Error(
        `The ${domain} record for ${executionCallId} is missing.`,
      );
    }
    if (delivered.kind === 'output') {
      if (owner.startReceiptRef === null || owner.run.execution === 'settled') {
        return undefined;
      }
      if (
        owner.outputRef !== null &&
        (await this.manifestRevisionAtLeast(
          owner.outputRef,
          delivered.manifestRevision,
        ))
      ) {
        background.lastManifest = owner.outputRef;
        return undefined;
      }
      if (domain === 'monitor_run') {
        await this.monitors!.advanceOutput(
          executionCallId,
          delivered.manifestRef,
        );
      } else {
        await this.childRuns!.advanceOutput(
          executionCallId,
          delivered.manifestRef,
        );
      }
      background.lastManifest = delivered.manifestRef;
      return undefined;
    }
    if (delivered.kind === 'observation') {
      if (domain !== 'monitor_run' || !this.monitors) {
        throw new Error('Observation delivery requires a monitor_run record.');
      }
      if (owner.run.execution === 'settled') {
        return undefined;
      }
      const currentSeq = (owner as { observationSequence: number })
        .observationSequence;
      if (delivered.sequence <= currentSeq) {
        return undefined;
      }
      if (delivered.sequence !== currentSeq + 1) {
        throw new Error('Observation sequence is not contiguous.');
      }
      const input: ManagedSessionInputRequest | undefined =
        delivered.notification && !this.lifecyclePrepared
          ? {
              inputId: delivered.notification.inputId,
              turnId: delivered.notification.turnId,
              source: 'monitor',
              contentRef: delivered.notification.contentRef,
              admissionRef: delivered.notification.admissionRef,
              deadline: null,
              wakeReason: 'input',
            }
          : undefined;
      await this.monitors.observe(
        executionCallId,
        { lines: delivered.lines },
        input ? { input } : undefined,
      );
      if (input) this.onNotification?.();
      return undefined;
    }
    // terminal: advance the final manifest, then settle the record (idempotent
    // if an earlier attempt committed before acknowledging).
    if (
      delivered.manifestRef &&
      owner.startReceiptRef !== null &&
      owner.run.execution !== 'settled'
    ) {
      const targetManifest = parseToolResultManifest(
        JSON.parse(
          (await this.resources.read(delivered.manifestRef)).toString('utf8'),
        ),
      );
      const alreadyAdvanced =
        owner.outputRef !== null &&
        (await this.manifestRevisionAtLeast(
          owner.outputRef,
          targetManifest.revision,
        ));
      if (!alreadyAdvanced) {
        if (domain === 'monitor_run') {
          await this.monitors!.advanceOutput(
            executionCallId,
            delivered.manifestRef,
          );
        } else {
          await this.childRuns!.advanceOutput(
            executionCallId,
            delivered.manifestRef,
          );
        }
      }
      background.lastManifest = delivered.manifestRef;
    }
    entry.envelope = delivered.envelope;
    if (owner.run.execution === 'settled') {
      const settledRef =
        delivered.manifestRef ?? owner.outputRef ?? background.lastManifest;
      return {
        executionCallId,
        manifest: settledRef,
        deliveryStatus: 'blocked',
        historyRevision: null,
        outcomeRef:
          settledRef ??
          (await this.session.resources.publish(
            'managed-tool-outcome',
            Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                decision: 'blocked',
                envelope: delivered.envelope,
                manifestRef: null,
              }),
            ),
          )),
      };
    }
    if (domain === 'monitor_run') {
      if (!this.monitors) {
        throw new Error(
          `The monitor_run record for ${executionCallId} has no session.`,
        );
      }
      const record = this.monitors.record(executionCallId);
      if (record?.run.state === 'recovery_blocked') {
        if (delivered.evidence !== null) {
          if (delivered.stopRequested) {
            await this.monitors.settleStopRequested(executionCallId);
          } else {
            await this.monitors.settleQuiet(executionCallId, 'exited');
          }
        }
      } else if (delivered.evidence === null) {
        await this.monitors.settleFailed(executionCallId, {
          stopReason: 'watch_failed',
          started: true,
        });
      } else if (delivered.stopRequested) {
        await this.monitors.settleStopRequested(executionCallId);
      } else {
        await this.monitors.settleQuiet(
          executionCallId,
          delivered.monitorStopReason ?? 'exited',
        );
      }
    } else if (delivered.evidence === null) {
      await this.childRuns?.settleFailed(executionCallId, {
        stopReason: 'process_failed',
        started: true,
      });
    } else if (delivered.stopRequested) {
      await this.childRuns?.requestStop(executionCallId);
      await this.childRuns?.settleStopRequested(executionCallId);
    } else {
      await this.childRuns?.settleExited(executionCallId, delivered.evidence);
    }
    const manifestRef = delivered.manifestRef ?? background.lastManifest;
    return {
      executionCallId,
      manifest: manifestRef,
      deliveryStatus: 'blocked',
      historyRevision: null,
      outcomeRef:
        manifestRef ??
        (await this.session.resources.publish(
          'managed-tool-outcome',
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              decision: 'blocked',
              envelope: delivered.envelope,
              manifestRef: null,
            }),
          ),
        )),
    };
  }

  private async manifestRevisionAtLeast(
    ref: ManagedSessionDurableRef,
    revision: number,
  ): Promise<boolean> {
    const manifest = parseToolResultManifest(
      JSON.parse((await this.resources.read(ref)).toString('utf8')),
    );
    return manifest.revision >= revision;
  }

  /**
   * Waits for the deliveries already in flight without closing the listener,
   * so a suspension detach can carry the final applied watermark (§4.9).
   * Deliberately one bounded round, not a wait for silence: a loud Shell
   * keeps pushing while it is attached, and a push that lands after this
   * snapshot is either applied before the close or refused and re-sent.
   */
  async quiesce(): Promise<void> {
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled(
      [...this.captures.values()].map(
        (entry) => entry.background?.redriveInFlight,
      ),
    );
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.drain());
  }

  private async drain(): Promise<void> {
    this.closing = true;
    if (this.server) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await Promise.allSettled([...this.operations]);
    // The stranded-write fail stop stands, but a re-drive already on its
    // way lands inside the drain: no close answers ahead of it either. A
    // backoff timer armed before the close may fire while these waits run
    // and start its own in-flight attempt behind the first snapshot, so
    // the drain keeps collecting until a whole round shows no in-flight
    // attempt anywhere. Each attempt's own finally clears its slot before
    // allSettled settles the observed promise, so a quiet round is exact.
    for (;;) {
      await Promise.allSettled(
        [...this.captures.values()].map(
          (entry) => entry.background?.redriveInFlight,
        ),
      );
      if (
        [...this.captures.values()].every(
          (entry) => entry.background?.redriveInFlight === undefined,
        )
      )
        break;
    }
    for (const entry of this.captures.values()) {
      if (entry.background?.redrive) clearTimeout(entry.background.redrive);
    }
    // The publisher closes only at the Session's ordered close, after the
    // last finalization landed (or accurately did not), so every capture
    // store closes here — background families included.
    await Promise.all(
      [...this.captures.values()].map((entry) => entry.store.close()),
    );
  }
}

function physicalSignalName(value: number | null): string | null {
  if (value === null) return null;
  return (
    Object.entries(constants.signals).find(
      ([name, number]) => name.startsWith('SIG') && number === value,
    )?.[0] ?? null
  );
}
