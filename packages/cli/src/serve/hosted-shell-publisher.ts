/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:os';
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
  // H3: the open-ended background capture of a proven child_run start, with
  // the manifest revisions it has already forwarded to the record.
  background?: {
    sink?: LocalShellStreamCapture;
    lastManifest: ManagedSessionDurableRef | null;
  };
}

type BackgroundCaptureRequest = LocalShellCaptureRequest & {
  readonly capture: { readonly background?: boolean };
};

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
    const admission = backgroundRequested
      ? new LocalShellStreamResultSession(
          this.session,
          store,
          request.capture.bindingGeneration,
          this.assertWritable,
          request.reference.sessionId,
          this.session.resources,
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
      ...(backgroundRequested ? { background: { lastManifest: null } } : {}),
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
      await this.advanceBackgroundManifest(entry, String(id));
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
      await this.advanceBackgroundManifest(entry, String(id));
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
        entry.envelope = await entry.finalizing;
        return entry.envelope;
      }
      entry.finalizing = this.finalize(entry, body);
      entry.envelope = await entry.finalizing;
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
   * Forwards the latest published manifest revision of the background
   * capture to its record, always after the awaited write or finish that
   * edged the manifest and always only forward.
   */
  private async advanceBackgroundManifest(
    entry: RegisteredCapture,
    executionCallId: string,
  ): Promise<void> {
    const background = entry.background;
    if (!background?.sink || !this.childRuns) return;
    const current = background.sink.currentManifest;
    if (current && current !== background.lastManifest) {
      background.lastManifest = current;
      await this.childRuns.advanceOutput(executionCallId, current);
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
    // A background capture outlives its registering turn; the ordered
    // close drain in H3's fifth slice settles its store properly.
    await Promise.all(
      [...this.captures.values()]
        .filter((entry) => entry.background === undefined)
        .map((entry) => entry.store.close()),
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
