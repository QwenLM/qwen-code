/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  readonly admission: ManagedShellResultSession;
  readonly store: ResourceToolResultSegmentStore;
  readonly offsets: { stdout: number; stderr: number };
  readonly ended: { stdout: boolean; stderr: boolean };
  prepared?: Promise<{ sink: LocalShellResultCapture }>;
  sink?: LocalShellResultCapture;
  envelope?: ToolResultEnvelope;
  finalizing?: Promise<ToolResultEnvelope>;
  accepting?: Promise<LocalShellReceipt>;
}

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
    private readonly runtimeSessionId: string,
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

  register(request: LocalShellCaptureRequest, modelCallId: string): void {
    if (this.closing || request.reference.sessionId !== this.runtimeSessionId)
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
    const admission = new ManagedShellResultSession(
      this.session,
      store,
      request.capture.bindingGeneration,
      this.assertWritable,
      this.runtimeSessionId,
      this.resources,
    );
    this.captures.set(id, {
      request: structuredClone(request),
      modelCallId,
      store,
      admission,
      offsets: { stdout: 0, stderr: 0 },
      ended: { stdout: false, stderr: false },
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
      const prepared = (entry.prepared ??= entry.admission.prepare(
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
      entry.accepting ??= entry.admission
        .accept(sink.identity, envelope)
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
      fields.executionStatus,
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
    const receipt = await entry.admission.recorded(entry.sink.identity);
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
    await Promise.all(
      [...this.captures.values()].map((entry) => entry.store.close()),
    );
  }
}
