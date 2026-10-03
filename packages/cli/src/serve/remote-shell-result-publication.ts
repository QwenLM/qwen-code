/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Application, Request, Response } from 'express';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionJsonValue } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-inbox.js';
import { parseToolPublicationBinding } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-publication.js';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import {
  parseToolResultPrefixRequest,
  parseToolResultPublishRequest,
  parseToolResultSealRequest,
  type ToolResultEnvelope,
  type ToolResultStoreCode,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
} from './managed-runtime-attestation-contract.js';
import type { ManagedContextBoot } from './managed-context-envelope.js';

export const PUBLICATION_INSTALL_ROUTE = Object.freeze({
  key: 'publication-install',
  method: 'POST',
  path: '/internal/managed-runtime/v3/publications:install',
  protocolVersion: 3,
  requestBodyLimitBytes: 64 * 1024,
  responseBodyLimitBytes: 16 * 1024,
  cacheControl: 'no-store',
});

interface InstalledPublication {
  readonly publicationId: string;
  readonly publicationToken: string;
  readonly serviceBaseUrl: string;
  readonly binding: Record<string, unknown>;
}

class PublicationRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('Publication service rejected HTTP ' + status + '.');
  }
}

function refusal(error: unknown): ToolResultStoreCode | null {
  if (!(error instanceof PublicationRejection)) return null;
  return error.code === 'managed_tool_result_invalid' ||
    error.code === 'managed_tool_result_conflict' ||
    error.code === 'managed_tool_result_digest_mismatch'
    ? error.code
    : null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Publication record is invalid.');
  return value as Record<string, unknown>;
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      ))
  )
    throw new Error('Publication service URL is invalid.');
  return url;
}

async function boundedJson(
  response: globalThis.Response,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Publication service returned no response.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > 1024 * 1024)
          throw new Error('Publication response is too large.');
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (failure) {
    if (!response.ok)
      throw new PublicationRejection(response.status, 'unknown');
    throw failure;
  }
  if (!response.ok) {
    const failure = body['error'];
    const code =
      failure && typeof failure === 'object' && !Array.isArray(failure)
        ? String((failure as Record<string, unknown>)['code'] ?? 'unknown')
        : 'unknown';
    if (code === 'managed_tool_publication_quota_exhausted')
      throw new Error('quota_exhausted');
    throw new PublicationRejection(response.status, code);
  }
  return body;
}

class PublicationClient {
  private readonly base: URL;
  private readonly key: Record<string, unknown>;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly installed: InstalledPublication) {
    this.base = endpoint(installed.serviceBaseUrl);
    this.key = record(installed.binding['sessionKey']);
  }

  private url(suffix: string): URL {
    const sessionId = encodeURIComponent(String(this.key['sessionId']));
    const publicationId = encodeURIComponent(this.installed.publicationId);
    const url = new URL(
      `/internal/managed-tool-publications/v1/sessions/${sessionId}/publications/${publicationId}${suffix}`,
      this.base,
    );
    url.searchParams.set('workspaceId', String(this.key['workspaceId']));
    return url;
  }

  private async request(
    suffix: string,
    operationId: string,
    body?: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.url(suffix), {
      method: body ? 'POST' : 'GET',
      headers: {
        'X-Qwen-Tenant-Id': String(this.key['tenantId']),
        'X-Qwen-Tool-Publication-Token': this.installed.publicationToken,
        'X-Qwen-Tool-Publication-Operation': operationId,
        'Cache-Control': 'no-store',
        ...headers,
      },
      ...(body ? { body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    return boundedJson(response);
  }

  async operation(
    suffix: string,
    operationId: string,
    body: Buffer,
    headers?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.performOperation(suffix, operationId, body, headers);
    } finally {
      release();
    }
  }

  private async performOperation(
    suffix: string,
    operationId: string,
    body: Buffer,
    headers?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 30 * 60_000;
    let recoveries = 0;
    const statusPath = `/operations/${encodeURIComponent(operationId)}`;
    const resumableRefusal = (failure: PublicationRejection): boolean =>
      failure.status === 409 &&
      [
        'managed_tool_publication_operation_expired',
        'managed_tool_publication_claim_expired',
        'managed_tool_publication_claim_lost',
        'managed_tool_publication_busy',
      ].includes(failure.code);
    const retryable = (failure: unknown): boolean =>
      failure instanceof PublicationRejection
        ? failure.status === 429 ||
          failure.status >= 500 ||
          (failure.status === 409 &&
            failure.code === 'managed_tool_publication_busy')
        : failure instanceof TypeError ||
          (failure instanceof DOMException &&
            ['AbortError', 'TimeoutError'].includes(failure.name));
    const observe = async (): Promise<Record<string, unknown> | null> => {
      while (Date.now() < deadline) {
        try {
          return await this.request(statusPath, operationId);
        } catch (failure) {
          if (
            failure instanceof PublicationRejection &&
            failure.code === 'managed_tool_publication_operation_unknown'
          )
            return null;
          if (!retryable(failure)) throw failure;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      throw new Error(
        'Publication operation exceeded its observation deadline.',
      );
    };
    while (Date.now() < deadline) {
      let initial: Record<string, unknown>;
      try {
        initial = await this.request(suffix, operationId, body, headers);
      } catch (failure) {
        if (failure instanceof Error && failure.message === 'quota_exhausted')
          throw failure;
        if (
          failure instanceof PublicationRejection &&
          failure.code === 'managed_tool_publication_storage_denied'
        )
          throw failure;
        const status = await observe();
        if (status !== null) {
          if (
            failure instanceof PublicationRejection &&
            failure.status >= 400 &&
            failure.status < 500 &&
            failure.status !== 429 &&
            !resumableRefusal(failure) &&
            status['state'] !== 'SUCCEEDED'
          )
            throw failure;
          initial = status;
        } else {
          if (!retryable(failure)) throw failure;
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }
      if (initial['state'] === undefined) return initial;
      let status = initial;
      while (Date.now() < deadline) {
        if (status['state'] === 'SUCCEEDED') return record(status['receipt']);
        if (status['state'] === 'RETRYABLE') break;
        if (status['state'] === 'EXPIRED' && recoveries < 3) {
          recoveries++;
          try {
            status = await this.request(
              `${statusPath}/recover`,
              operationId,
              Buffer.from('{}'),
            );
          } catch (failure) {
            if (!retryable(failure)) throw failure;
            if (
              failure instanceof PublicationRejection &&
              [409, 429].includes(failure.status) &&
              failure.code === 'managed_tool_publication_busy'
            )
              recoveries--;
            await new Promise((resolve) => setTimeout(resolve, 250));
            status = (await observe()) ?? status;
          }
          continue;
        }
        if (status['state'] !== 'PENDING')
          throw new Error(
            `Publication operation ended as ${String(status['state'])}.`,
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = await observe();
        if (current === null)
          throw new Error(
            'Publication operation disappeared during observation.',
          );
        status = current;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Publication operation exceeded its observation deadline.');
  }
}

/** The selected worker receives one token, never the Session writer token. */
export class RemoteShellResultPublisher {
  private readonly grants = new Map<string, InstalledPublication>();
  private readonly clients = new Map<string, PublicationClient>();

  hasExecution(executionCallId: string): boolean {
    return this.grants.has(executionCallId);
  }

  install(value: unknown, boot: ManagedContextBoot): void {
    const body = record(value);
    if (
      !same(Object.keys(body).sort(), [
        'binding',
        'protocolVersion',
        'publication',
        'publicationId',
        'publicationToken',
        'serviceBaseUrl',
      ]) ||
      body['protocolVersion'] !== 3 ||
      body['publication'] !== 'managed-tool-publication/1' ||
      typeof body['publicationId'] !== 'string' ||
      !/^[a-z0-9_-]{1,128}$/u.test(body['publicationId']) ||
      typeof body['publicationToken'] !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(body['publicationToken']) ||
      typeof body['serviceBaseUrl'] !== 'string'
    )
      throw new Error('Publication installation is invalid.');
    endpoint(body['serviceBaseUrl']);
    const binding = parseToolPublicationBinding(body['binding']);
    const key = record(binding['sessionKey']);
    const reference = record(binding['reference']);
    if (
      binding['publicationId'] !== body['publicationId'] ||
      binding['publication'] !== 'managed-tool-publication/1' ||
      key['tenantId'] !== boot.tenantId ||
      key['workspaceId'] !== boot.workspaceId ||
      (reference['sessionId'] !== undefined &&
        typeof reference['sessionId'] !== 'string') ||
      binding['captureScope'] !== 'process_pipes' ||
      binding['capturePolicy'] !== 'complete_required' ||
      binding['revision'] !== 1 ||
      typeof binding['executionCallId'] !== 'string' ||
      typeof binding['captureId'] !== 'string'
    )
      throw new Error('Publication binding conflicts with this worker.');
    const grant = { ...body, binding } as unknown as InstalledPublication;
    const prior = this.grants.get(binding['executionCallId']);
    if (prior && !same(prior, grant))
      throw new Error('Original publication installation conflicts.');
    this.grants.set(binding['executionCallId'], grant);
    if (!prior)
      this.clients.set(
        binding['executionCallId'],
        new PublicationClient(grant),
      );
  }

  prepare(request: LocalShellCaptureRequest): Promise<{
    identity: ToolResultExpectedIdentity;
    sink: LocalShellResultCapture;
  }> {
    const grant = this.grants.get(request.capture.executionCallId);
    if (!grant) throw new Error('Original publication grant is missing.');
    const binding = grant.binding;
    const key = record(binding['sessionKey']);
    const reference = record(binding['reference']);
    if (
      request.reference.sessionId !== reference['sessionId'] ||
      request.reference.promptId !== reference['promptId'] ||
      request.reference.callId !== reference['callId'] ||
      request.reference.argsDigest !== reference['argsDigest'] ||
      request.capture.tenantId !== key['tenantId'] ||
      request.capture.sessionId !== key['sessionId'] ||
      request.capture.turnId !== binding['turnId'] ||
      request.capture.bindingGeneration !== binding['bindingGeneration'] ||
      request.capture.capturePolicy !== 'complete_required'
    )
      throw new Error('Shell invocation conflicts with its publication grant.');
    const identity: ToolResultExpectedIdentity = {
      tenantId: request.capture.tenantId,
      sessionId: request.capture.sessionId,
      turnId: request.capture.turnId,
      executionCallId: request.capture.executionCallId,
      callId: request.reference.callId,
      invocationDigest: request.reference.argsDigest,
      bindingGeneration: request.capture.bindingGeneration,
      captureId: String(binding['captureId']),
      revision: 1,
    };
    const client = this.clients.get(request.capture.executionCallId);
    if (!client) throw new Error('Original publication client is missing.');
    const store: ToolResultSegmentStore = {
      publish: async (raw) => {
        let item;
        try {
          item = parseToolResultPublishRequest(raw);
        } catch (cause) {
          if (cause instanceof ManagedSessionRecordError)
            return { status: 'refused', code: 'managed_tool_result_invalid' };
          throw cause;
        }
        if (item.captureId !== identity.captureId)
          return { status: 'refused', code: 'managed_tool_result_conflict' };
        if (!['stdout', 'stderr'].includes(item.streamId))
          return { status: 'refused', code: 'managed_tool_result_invalid' };
        const stream = item.streamId;
        const ordinal = item.ordinal;
        const bytes = Buffer.from(item.bytes);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (item.expectedDigest && item.expectedDigest !== digest)
          return {
            status: 'refused',
            code: 'managed_tool_result_digest_mismatch',
          };
        let receipt: Record<string, unknown>;
        try {
          receipt = await client.operation(
            `/segments/${stream}/${ordinal}`,
            `seg-${stream}-${ordinal}`,
            bytes,
            { 'X-Qwen-Tool-Segment-Digest': digest },
          );
        } catch (cause) {
          const code = refusal(cause);
          if (code) return { status: 'refused', code };
          throw cause;
        }
        if (
          receipt['ordinal'] !== ordinal ||
          receipt['byteLength'] !== bytes.length ||
          receipt['digest'] !== digest ||
          receipt['captureId'] !== identity.captureId ||
          receipt['streamId'] !== stream
        )
          throw new Error('Original segment receipt conflicts.');
        return {
          status: 'ok',
          result: { ordinal, byteLength: bytes.length, digest },
        } as const;
      },
      seal: async (raw) => {
        let item;
        try {
          item = parseToolResultSealRequest(raw);
        } catch (cause) {
          if (cause instanceof ManagedSessionRecordError)
            return { status: 'refused', code: 'managed_tool_result_invalid' };
          throw cause;
        }
        if (item.captureId !== identity.captureId)
          return { status: 'refused', code: 'managed_tool_result_conflict' };
        if (!['stdout', 'stderr'].includes(item.streamId))
          return { status: 'refused', code: 'managed_tool_result_invalid' };
        const stream = item.streamId;
        const body = Buffer.from(
          JSON.stringify({
            segmentCount: item['segmentCount'],
            byteLength: item['byteLength'],
            digest: item['digest'],
          }),
        );
        let receipt: Record<string, unknown>;
        try {
          receipt = await client.operation(
            `/streams/${stream}/seal`,
            'seal-' +
              stream +
              '-' +
              createHash('sha256').update(body).digest('hex').slice(0, 32),
            body,
            { 'Content-Type': 'application/json' },
          );
        } catch (cause) {
          const code = refusal(cause);
          if (code) return { status: 'refused', code };
          throw cause;
        }
        if (
          receipt['segmentCount'] !== item['segmentCount'] ||
          receipt['byteLength'] !== item['byteLength'] ||
          receipt['digest'] !== item['digest']
        )
          throw new Error('Original seal receipt conflicts.');
        return {
          status: 'ok',
          result: {
            segmentCount: item.segmentCount,
            byteLength: item.byteLength,
            digest: item.digest,
          },
        } as const;
      },
      prefix: async (raw) => {
        let item;
        try {
          item = parseToolResultPrefixRequest(raw);
        } catch (cause) {
          if (cause instanceof ManagedSessionRecordError)
            return { status: 'refused', code: 'managed_tool_result_invalid' };
          throw cause;
        }
        if (item.captureId !== identity.captureId)
          return { status: 'refused', code: 'managed_tool_result_conflict' };
        if (!['stdout', 'stderr'].includes(item.streamId))
          return {
            status: 'ok',
            result: {
              segmentCount: 0,
              byteLength: 0,
              digest: createHash('sha256').digest('hex'),
              sealed: false,
            },
          };
        let receipt: Record<string, unknown>;
        try {
          receipt = await client.operation(
            `/streams/${item.streamId}/prefix`,
            'prefix-' + item.streamId + '-' + randomUUID(),
            Buffer.alloc(0),
          );
        } catch (cause) {
          const code = refusal(cause);
          if (code) return { status: 'refused', code };
          throw cause;
        }
        if (
          !Number.isSafeInteger(receipt['segmentCount']) ||
          !Number.isSafeInteger(receipt['byteLength']) ||
          typeof receipt['digest'] !== 'string' ||
          typeof receipt['sealed'] !== 'boolean'
        )
          throw new Error('Original prefix receipt is invalid.');
        return {
          status: 'ok',
          result: {
            segmentCount: receipt['segmentCount'] as number,
            byteLength: receipt['byteLength'] as number,
            digest: receipt['digest'],
            sealed: receipt['sealed'],
          },
        };
      },
      readRange: async () => {
        throw new Error('Worker range lookup is unavailable.');
      },
      close: async () => {},
    };
    const resources: ManagedSessionResourceStore = {
      publish: async (kind, bytes) => {
        const metadata = record(JSON.parse(bytes.toString('utf8')));
        const slot =
          kind === 'managed-tool-result-manifest'
            ? 'manifest:1'
            : `page:${String(metadata['streamId'])}:${String(metadata['firstOrdinal'])}`;
        const published = await client.operation(
          `/resources/${kind}/${encodeURIComponent(slot)}`,
          `res-${slot.replaceAll(':', '-')}`,
          bytes,
        );
        const ref = assertManagedSessionDurableRef(
          published as unknown as ManagedSessionJsonValue,
          'published result resource',
        );
        if (
          ref.kind !== kind ||
          ref.byteLength !== bytes.length ||
          ref.digest !== createHash('sha256').update(bytes).digest('hex')
        )
          throw new Error('Original resource receipt conflicts.');
        return ref as ManagedSessionDurableRef;
      },
      read: async () => {
        throw new Error('Worker resource reads are unavailable.');
      },
    };
    return Promise.resolve({
      identity,
      sink: new LocalShellResultCapture(store, resources, identity),
    });
  }

  async finish(
    identity: ToolResultExpectedIdentity,
    envelope: ToolResultEnvelope,
  ): Promise<void> {
    const grant = this.grants.get(identity.executionCallId);
    if (!grant || grant.binding['captureId'] !== identity.captureId)
      throw new Error('Original publication grant changed.');
    const bytes = Buffer.from(JSON.stringify(envelope));
    const client = this.clients.get(identity.executionCallId);
    if (!client) throw new Error('Original publication client is missing.');
    const receipt = await client.operation('/finish', 'finish', bytes, {
      'Content-Type': 'application/json',
    });
    const terminal = record(receipt['terminal']);
    if (
      receipt['producerPhase'] !== 'FINISHED' ||
      terminal['byteLength'] !== bytes.length ||
      terminal['digest'] !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('Publication finish was not confirmed.');
  }

  registerInstallRoute(app: Application, boot: ManagedContextBoot): void {
    app.post(
      PUBLICATION_INSTALL_ROUTE.path,
      managedRuntimeNoStore,
      authorizeManagedRuntime(boot),
      managedRuntimeJsonBody(PUBLICATION_INSTALL_ROUTE.requestBodyLimitBytes),
      (req: Request, res: Response) => {
        try {
          this.install(req.body, boot);
          res.json({
            protocolVersion: 3,
            publication: 'managed-tool-publication/1',
            installed: true,
          });
        } catch {
          res.status(409).json({
            code: 'managed_tool_publication_conflict',
            error: 'Publication installation conflicts.',
          });
        }
      },
      handleManagedRuntimeJsonError,
    );
  }
}
