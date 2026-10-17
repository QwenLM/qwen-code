/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { ShellExecutionResult } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import {
  MANAGED_TOOL_RESULT_PROTOCOL,
  parseToolResultEnvelope,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  authorizeManagedRuntime,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  handleManagedRuntimeJsonError,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import type {
  ManagedShellCapturePublisher,
  ManagedShellCaptureSink,
  ToolResultAcknowledgement,
} from './managed-runtime-tool-executor.js';
import { processGroupLiveness } from './managed-runtime-ledger.js';

export const HOSTED_SHELL_PUBLISHER_PATH =
  '/internal/hosted-shell-publisher/v1';
export const MANAGED_SHELL_PUBLISHER_ROUTE = Object.freeze({
  key: 'publisher',
  method: 'POST',
  path: '/internal/managed-runtime/v3/publisher',
  protocolVersion: 3,
  requestBodyLimitBytes: 16 * 1024,
  responseBodyLimitBytes: 16 * 1024,
  cacheControl: 'no-store',
} as const);
const PREFIX = { protocolVersion: 3, toolResult: MANAGED_TOOL_RESULT_PROTOCOL };
export const SHELL_PUBLISHER_BODY_LIMIT = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;
const debugLogger = createDebugLogger('ManagedShellPublisher');

export interface ShellPublisherDescriptor {
  readonly url: string;
  readonly token: string;
}

export function publisherObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Shell publisher object.');
  }
  return value as Record<string, unknown>;
}

export function publisherFields(
  value: unknown,
  fields: string[],
): Record<string, unknown> {
  const object = publisherObject(value);
  if (Object.keys(object).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error('Invalid Shell publisher fields.');
  }
  return object;
}

export function parseShellPublisher(value: unknown): ShellPublisherDescriptor {
  const fields = publisherFields(value, ['url', 'token']);
  if (
    typeof fields['url'] !== 'string' ||
    typeof fields['token'] !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(fields['token'])
  ) {
    throw new Error('Invalid Shell publisher descriptor.');
  }
  const match =
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/internal\/hosted-shell-publisher\/v1$/.exec(
      fields['url'],
    );
  if (!match || Number(match[1]) > 65535)
    throw new Error('Invalid Shell publisher URL.');
  return { url: fields['url'], token: fields['token'] };
}

async function rpc(
  descriptor: ShellPublisherDescriptor,
  request: Record<string, unknown>,
): Promise<unknown> {
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > SHELL_PUBLISHER_BODY_LIMIT)
    throw new Error('Shell publisher request is too large.');
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
  if (
    !response.ok ||
    response.headers.get('cache-control') !== 'no-store' ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('Shell publisher refused the request.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > SHELL_PUBLISHER_BODY_LIMIT) {
        await reader.cancel();
        throw new Error('Shell publisher reply is too large.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function publisherUnreachable(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.cause instanceof Error &&
    'code' in cause.cause &&
    cause.cause.code === 'ECONNREFUSED'
  );
}

const PREVIEW_BYTES = 8 * 1024;
const PREVIEW_HEAD_BYTES = 2 * 1024;
const PREVIEW_GAP =
  '\n[... preview truncated; end of buffered output follows ...]\n';

function shellPreview(parts: readonly unknown[]): {
  parts: unknown[];
  truncated: boolean;
} {
  const text = parts
    .map((part) =>
      part &&
      typeof part === 'object' &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= PREVIEW_BYTES)
    return { parts: text ? [{ text }] : [], truncated: false };
  // Shell failures and the exit status are reported last: keep both ends.
  const head = new TextDecoder().decode(bytes.subarray(0, PREVIEW_HEAD_BYTES), {
    stream: true,
  });
  let start =
    bytes.byteLength -
    (PREVIEW_BYTES - PREVIEW_HEAD_BYTES - Buffer.byteLength(PREVIEW_GAP));
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return {
    parts: [
      { text: head + PREVIEW_GAP + bytes.subarray(start).toString('utf8') },
    ],
    truncated: true,
  };
}

export function boundedShellPreview(parts: readonly unknown[]): unknown[] {
  return shellPreview(parts).parts;
}

class RemoteShellCapture implements ManagedShellCaptureSink {
  private started = false;
  private startedPid?: number;
  private lostCaptureResult?: ToolResultEnvelope;
  private finalizedResult?: ToolResultEnvelope;
  private processResult: ShellExecutionResult | null = null;
  private failed = false;
  private stopRequested = false;
  private readonly offsets = { stdout: 0, stderr: 0 };
  private readonly ended = { stdout: false, stderr: false };
  // Node may resume paused pipes on exit before prior write ACKs arrive.
  private readonly queues = {
    stdout: Promise.resolve(),
    stderr: Promise.resolve(),
  };

  constructor(
    readonly identity: ToolResultExpectedIdentity,
    private readonly descriptor: ShellPublisherDescriptor,
  ) {}
  setStarted(pid: number): void {
    this.started = true;
    this.startedPid = Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  }
  isLostCaptureResult(envelope: ToolResultEnvelope): boolean {
    return (
      this.lostCaptureResult !== undefined &&
      this.lostCaptureResult === envelope
    );
  }
  recordPublisherLoss(envelope: ToolResultEnvelope): boolean {
    if (
      this.finalizedResult === undefined ||
      this.finalizedResult !== envelope ||
      !this.isStoppedCancellation(envelope.executionStatus)
    )
      return false;
    this.lostCaptureResult = envelope;
    return true;
  }
  private isStoppedCancellation(
    executionStatus: ToolResultEnvelope['executionStatus'],
  ): boolean {
    const physical = this.processResult;
    return (
      executionStatus === 'cancelled' &&
      physical?.aborted === true &&
      physical.promoted !== true &&
      this.startedPid !== undefined &&
      (physical.pid === undefined
        ? physical.executionMethod === 'child_process'
        : physical.pid === this.startedPid) &&
      process.platform !== 'win32' &&
      processGroupLiveness(this.startedPid) === 'gone'
    );
  }
  setProcessResult(result: ShellExecutionResult): void {
    this.processResult = result;
  }
  setStopRequested(): void {
    this.stopRequested = true;
  }
  failCapture(): void {
    this.failed = true;
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer): Promise<void> {
    return (this.queues[stream] = this.queues[stream].then(() =>
      this.append(stream, chunk),
    ));
  }

  private async append(
    stream: 'stdout' | 'stderr',
    chunk: Buffer,
  ): Promise<void> {
    if (this.failed || this.ended[stream]) return;
    try {
      for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
        if (this.failed) return;
        const bytes = chunk.subarray(offset, offset + CHUNK_BYTES);
        const reply = await rpc(this.descriptor, {
          operation: 'write',
          executionCallId: this.identity.executionCallId,
          stream,
          offset: this.offsets[stream],
          bytesBase64: bytes.toString('base64'),
        });
        if (publisherObject(reply)['accepted'] !== true)
          throw new Error('Shell write was not accepted.');
        this.offsets[stream] += bytes.byteLength;
      }
    } catch {
      this.failCapture();
    }
  }

  finish(stream: 'stdout' | 'stderr', complete: boolean): Promise<void> {
    return (this.queues[stream] = this.queues[stream].then(() =>
      this.end(stream, complete),
    ));
  }

  private async end(
    stream: 'stdout' | 'stderr',
    complete: boolean,
  ): Promise<void> {
    if (this.ended[stream]) return;
    this.ended[stream] = true;
    try {
      const reply = await rpc(this.descriptor, {
        operation: 'finish',
        executionCallId: this.identity.executionCallId,
        stream,
        complete: complete && !this.failed,
      });
      if (publisherObject(reply)['accepted'] !== true)
        throw new Error('Shell stream did not finish.');
    } catch {
      this.failCapture();
    }
  }

  async finalize(
    executionStatus: ToolResultEnvelope['executionStatus'],
    responseParts: readonly unknown[],
    error?: { readonly message: string; readonly type?: string },
  ): Promise<ToolResultEnvelope> {
    await Promise.all(Object.values(this.queues));
    const physical = this.processResult;
    const preview = shellPreview(responseParts);
    const boundedError = error
      ? {
          message: new TextDecoder().decode(
            Buffer.from(error.message).subarray(0, 1024),
            { stream: true },
          ),
          ...(error.type ? { type: error.type.slice(0, 128) } : {}),
        }
      : undefined;
    try {
      return (this.finalizedResult = parseToolResultEnvelope(
        await rpc(this.descriptor, {
          operation: 'finalize',
          executionCallId: this.identity.executionCallId,
          started: this.started,
          failed: this.failed,
          process:
            this.started && physical
              ? {
                  exitCode: physical.exitCode,
                  signal: physical.signal,
                  previewBytes: physical.rawOutput.byteLength,
                  // Present only when the platform asked for the stop: the
                  // foreground lane's exact key set never sees it (#13856 A8).
                  ...(this.stopRequested ? { stopRequested: true } : {}),
                }
              : null,
          executionStatus: this.started ? executionStatus : 'not_started',
          responseParts: preview.parts,
          previewTruncated: preview.truncated,
          error: boundedError ?? null,
        }),
      ));
    } catch (cause) {
      // Capture loss cannot erase a witnessed cancellation, but a leader's
      // exit alone cannot certify that its original process group stopped.
      if (
        !publisherUnreachable(cause) ||
        !this.isStoppedCancellation(executionStatus)
      )
        throw cause;
      debugLogger.debug(
        `Managed Shell publisher connection refused while finalizing ${this.identity.executionCallId}.`,
        cause,
      );
      return (this.lostCaptureResult = parseToolResultEnvelope({
        executionStatus: 'cancelled',
        responseParts: preview.parts,
        error: {
          ...boundedError,
          message:
            boundedError?.message ||
            'The command was cancelled, but its captured output is unavailable.',
        },
        capture: {
          captureStatus: 'unavailable',
          captureReason: 'producer_lost',
          manifest: null,
          previewTruncated: true,
          deliveryStatus: 'blocked',
        },
      }));
    }
  }
}

export class ManagedShellPublisherRegistry
  implements ManagedShellCapturePublisher
{
  private readonly sessions = new Map<string, ShellPublisherDescriptor>();
  private readonly executions = new Map<
    string,
    { descriptor: ShellPublisherDescriptor; sink: RemoteShellCapture }
  >();

  get hasInstalledPublication(): boolean {
    return this.sessions.size > 0 || this.executions.size > 0;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  register(
    app: Application,
    identity: ManagedRuntimeRequestIdentity,
    available: (sessionId: string) => boolean,
  ): void {
    app.post(
      MANAGED_SHELL_PUBLISHER_ROUTE.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(identity),
      managedRuntimeJsonBody(
        MANAGED_SHELL_PUBLISHER_ROUTE.requestBodyLimitBytes,
      ),
      (req: Request, res: Response) => {
        let sessionId: string;
        let publisher: ShellPublisherDescriptor;
        try {
          const body = publisherFields(req.body, [
            'protocolVersion',
            'toolResult',
            'sessionId',
            'publisher',
          ]);
          if (
            body['protocolVersion'] !== 3 ||
            body['toolResult'] !== MANAGED_TOOL_RESULT_PROTOCOL ||
            typeof body['sessionId'] !== 'string' ||
            !body['sessionId'] ||
            body['sessionId'].length > 512
          )
            throw new Error('Invalid registration.');
          sessionId = body['sessionId'];
          publisher = parseShellPublisher(body['publisher']);
        } catch {
          res.status(400).json({ code: 'managed_runtime_attestation_invalid' });
          return;
        }
        const previous = this.sessions.get(sessionId);
        if (
          !available(sessionId) ||
          (previous && JSON.stringify(previous) !== JSON.stringify(publisher))
        ) {
          res.status(409).json({ code: 'managed_runtime_identity_conflict' });
          return;
        }
        this.sessions.set(sessionId, previous ?? publisher);
        res.json({ ...PREFIX, sessionId, installed: true });
      },
      handleManagedRuntimeJsonError,
    );
  }

  async prepare(request: LocalShellCaptureRequest): Promise<{
    identity: ToolResultExpectedIdentity;
    sink: ManagedShellCaptureSink;
  }> {
    const descriptor = this.sessions.get(request.reference.sessionId);
    if (!descriptor) throw new Error('Shell publisher is not registered.');
    const identity = publisherObject(
      await rpc(descriptor, { operation: 'prepare', request }),
    ) as unknown as ToolResultExpectedIdentity;
    if (
      identity.executionCallId !== request.capture.executionCallId ||
      identity.sessionId !== request.capture.sessionId ||
      identity.tenantId !== request.capture.tenantId ||
      identity.turnId !== request.capture.turnId ||
      identity.callId !== request.reference.callId ||
      identity.invocationDigest !== request.reference.argsDigest ||
      identity.bindingGeneration !== request.capture.bindingGeneration ||
      identity.revision !== 1 ||
      typeof identity.captureId !== 'string' ||
      !/^[a-z0-9_-]{1,128}$/.test(identity.captureId)
    )
      throw new Error('Shell publisher identity changed.');
    const previous = this.executions.get(identity.executionCallId);
    if (previous && previous.descriptor !== descriptor)
      throw new Error('Shell publisher execution conflicts.');
    const sink = previous?.sink ?? new RemoteShellCapture(identity, descriptor);
    this.executions.set(identity.executionCallId, { descriptor, sink });
    return { identity, sink };
  }

  async accept(
    identity: ToolResultExpectedIdentity,
    envelope: ToolResultEnvelope,
  ): Promise<ToolResultAcknowledgement> {
    const execution = this.executions.get(identity.executionCallId);
    if (!execution) throw new Error('Shell capture was not prepared.');
    const blocked = (): ToolResultAcknowledgement => ({
      executionCallId: identity.executionCallId,
      manifest: envelope.capture?.manifest ?? null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    if (execution.sink.isLostCaptureResult(envelope)) return blocked();
    let response: unknown;
    try {
      response = await rpc(execution.descriptor, {
        operation: 'accept',
        executionCallId: identity.executionCallId,
        envelope,
      });
    } catch (cause) {
      if (
        !publisherUnreachable(cause) ||
        !execution.sink.recordPublisherLoss(envelope)
      )
        throw cause;
      debugLogger.debug(
        `Managed Shell publisher connection refused while accepting ${identity.executionCallId}.`,
        cause,
      );
      return blocked();
    }
    const receipt = publisherObject(
      response,
    ) as unknown as ToolResultAcknowledgement;
    if (
      receipt.executionCallId !== identity.executionCallId ||
      JSON.stringify(receipt.manifest) !==
        JSON.stringify(envelope.capture?.manifest) ||
      (receipt.deliveryStatus !== 'committed' &&
        receipt.deliveryStatus !== 'blocked') ||
      (receipt.deliveryStatus === 'committed'
        ? !Number.isSafeInteger(receipt.historyRevision) ||
          (receipt.historyRevision ?? 0) < 1
        : receipt.historyRevision !== null)
    )
      throw new Error('Shell publisher receipt changed.');
    return receipt;
  }
}
