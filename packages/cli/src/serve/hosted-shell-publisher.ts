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
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  boundedShellPreview,
  HOSTED_SHELL_PUBLISHER_PATH,
  SHELL_PUBLISHER_BODY_LIMIT,
  publisherFields,
  publisherObject,
  type ShellPublisherDescriptor,
} from './managed-shell-publisher.js';

interface RegisteredCapture {
  readonly request: LocalShellCaptureRequest;
  readonly modelCallId: string;
  readonly admission: ManagedShellResultSession | LocalShellStreamResultSession;
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
      onExit: (failed: boolean) => void;
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
  private readonly operations = new Set<Promise<unknown>>();
  private server?: Server;
  private descriptor?: ShellPublisherDescriptor;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly session: ManagedSession,
    private readonly resources: DurableToolResultResourceStore,
    private readonly assertWritable: () => Promise<void>,
    private readonly childRuns?: HostedChildRunSession,
    private readonly monitors?: HostedMonitorSession,
    private readonly onNotification?: () => void,
  ) {}

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
        limit: SHELL_PUBLISHER_BODY_LIMIT,
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

  private async handle(candidate: unknown): Promise<unknown> {
    const body = publisherObject(candidate);
    if (body['operation'] === 'prepare') {
      publisherFields(body, ['operation', 'request']);
      const request = publisherObject(body['request']);
      const capture = publisherObject(request['capture']);
      const entry = this.captures.get(String(capture['executionCallId']));
      if (
        !entry ||
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
    const id = body['executionCallId'];
    const entry = typeof id === 'string' ? this.captures.get(id) : undefined;
    if (!entry?.sink) throw new Error('Shell capture was not prepared.');
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
      readonly onExit: (failed: boolean) => void;
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
        onExit: (failed: boolean) => void;
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
    if (body['started']) {
      const physical = publisherFields(body['process'], [
        'exitCode',
        'signal',
        'previewBytes',
      ]);
      if (
        (physical['exitCode'] !== null &&
          !Number.isInteger(physical['exitCode'])) ||
        (physical['signal'] !== null && !Number.isInteger(physical['signal']))
      ) {
        throw new Error('Invalid Shell physical result.');
      }
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
      const exit = observer?.onExit(evidence === null);
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
          const input = await buildMonitorNotificationInput({
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
            { input },
          );
          // Consume the tail only once its observation committed: a refused
          // commit (the record is not attached yet) keeps the lines for the
          // retry that settles this watch after the start receipt lands.
          background.remainder = '';
          this.onNotification?.();
        }
        const last =
          windowLines.length > 0
            ? record.observationSequence + 1
            : record.observationSequence;
        if (last >= record.maxEvents) {
          await this.monitors.settleQuiet(executionCallId, 'max_events');
        } else if (evidence === null) {
          await this.monitors.settleFailed(executionCallId, {
            stopReason: 'watch_failed',
            started: true,
          });
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
