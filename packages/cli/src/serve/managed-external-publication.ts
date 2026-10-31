/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import { LocalShellResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-capture.js';
import { LocalToolResultSegmentStore } from '@qwen-code/qwen-code-core/managed-runtime/local-managed-tool-result-store.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import {
  parseToolResultManifestBytes,
  type ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  authorizeManagedRuntime,
  managedRuntimeNoStore,
  managedRuntimeJsonBody,
  handleManagedRuntimeJsonError,
} from './managed-runtime-attestation-contract.js';
import {
  parseManagedToolReference,
  parseManagedShellCapture,
} from './managed-runtime-tool-v3-routes.js';
import { publisherFields } from './managed-shell-publisher.js';
import type { ManagedExternalContextBoot } from './managed-external-storage.js';
import type {
  ManagedShellCapturePublisher,
  ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';

const PREFIX = '/internal/managed-runtime/v2/publication:';
const READ_BYTES = 32 * 1024;
const CLOSED = 'Managed Runtime publication is closed.';
export const EXTERNAL_PUBLICATION_ROUTES = Object.freeze(
  ['begin', 'read', 'stop-drained'].map((key) =>
    Object.freeze({
      key,
      method: 'POST',
      path: PREFIX + key,
      protocolVersion: 2,
      requestBodyLimitBytes: 64 * 1024,
      responseBodyLimitBytes: 64 * 1024,
      cacheControl: 'no-store',
    }),
  ),
);

type Stream = 'stdout' | 'stderr';
interface Channel {
  readonly requestDigest: string;
  readonly expiresAt: number;
  readonly identity: ToolResultExpectedIdentity;
  readonly capture: LocalShellResultCapture;
  readonly resources: LocalManagedSessionResourceStore;
  readonly store: LocalToolResultSegmentStore;
  readonly lease: SessionWriterLease;
  readonly delivered: Record<Stream, number>;
  readonly acknowledged: Record<Stream, number>;
  final?: ToolResultEnvelope;
  finalReceipt?: ManagedSessionDurableRef;
}

function requestDigest(request: LocalShellCaptureRequest): string {
  const { reference: r, capture: c } = request;
  return createHash('sha256')
    .update(
      JSON.stringify([
        r.sessionId,
        r.promptId,
        r.callId,
        r.argsDigest,
        c.tenantId,
        c.sessionId,
        c.turnId,
        c.executionCallId,
        c.bindingGeneration,
        c.capturePolicy,
      ]),
    )
    .digest('hex');
}

/** Foreground captures are local O1a stores; only the authenticated reader is remote. */
export class ManagedExternalPublication
  implements ManagedShellCapturePublisher
{
  private readonly channels = new Map<string, Channel>();
  private readonly executions = new Map<string, string>();
  private readonly retirementId = randomUUID();
  private sealed = false;
  private stopped = false;
  private drainProof?: ManagedSessionDurableRef;
  private readonly proofResources: LocalManagedSessionResourceStore;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly directory: string,
    private readonly boot: ManagedExternalContextBoot,
  ) {
    this.proofResources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: directory,
      sessionKey: {
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        sessionId: randomUUID(),
      },
    });
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private live(channel: Channel): void {
    if (channel.expiresAt <= Date.now()) throw new Error(CLOSED);
  }

  async begin(
    request: LocalShellCaptureRequest,
    expiresAt: number,
  ): Promise<string> {
    return this.serialize(async () => {
      if (
        this.sealed ||
        request.capture.tenantId !== this.boot.tenantId ||
        request.capture.background ||
        request.capture.monitoring ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now()
      )
        throw new Error(CLOSED);
      const digest = requestDigest(request);
      const priorId = this.executions.get(request.capture.executionCallId);
      if (priorId) {
        const prior = this.channels.get(priorId)!;
        this.live(prior);
        if (prior.requestDigest !== digest || prior.expiresAt !== expiresAt)
          throw new Error(CLOSED);
        return priorId;
      }
      if (this.channels.size >= 64) throw new Error(CLOSED);
      const channelId = randomUUID();
      const directory = await mkdtemp(path.join(this.directory, 'channel-'));
      const sessionKey = {
        tenantId: this.boot.tenantId,
        workspaceId: this.boot.workspaceId,
        sessionId: request.capture.sessionId,
      };
      const lease = await SessionWriterLease.acquire({
        runtimeBaseDir: directory,
        sessionId: sessionKey.sessionId,
        transcriptPath: path.join(directory, 'capture.jsonl'),
        reclaimPolicy: 'never',
        takeoverPolicy: 'never',
      });
      let store: LocalToolResultSegmentStore | undefined;
      try {
        store = await LocalToolResultSegmentStore.openWritable({
          sessionKey,
          lease,
        });
        const resources = LocalManagedSessionResourceStore.create({
          runtimeBaseDir: directory,
          sessionKey,
        });
        const identity: ToolResultExpectedIdentity = {
          tenantId: sessionKey.tenantId,
          sessionId: sessionKey.sessionId,
          turnId: request.capture.turnId,
          executionCallId: request.capture.executionCallId,
          callId: request.reference.callId,
          invocationDigest: request.reference.argsDigest.replace(
            /^sha256:/,
            '',
          ),
          bindingGeneration: request.capture.bindingGeneration,
          captureId: channelId,
          revision: 1,
        };
        const capture = new LocalShellResultCapture(
          store,
          resources,
          identity,
          async () => {
            if (expiresAt <= Date.now()) throw new Error(CLOSED);
            await lease.assertOwnedAndUnchanged();
          },
        );
        await resources.publish(
          'external-publication',
          Buffer.from(
            JSON.stringify({
              type: 'begin',
              identity,
              requestDigest: digest,
              expiresAt,
            }),
          ),
        );
        if (this.sealed || expiresAt <= Date.now()) throw new Error(CLOSED);
        this.channels.set(channelId, {
          requestDigest: digest,
          expiresAt,
          identity,
          capture,
          resources,
          store,
          lease,
          delivered: { stdout: -1, stderr: -1 },
          acknowledged: { stdout: -1, stderr: -1 },
        });
        this.executions.set(request.capture.executionCallId, channelId);
        return channelId;
      } catch (error) {
        await store?.close();
        await lease.release();
        throw error;
      }
    });
  }

  async prepare(request: LocalShellCaptureRequest) {
    const id = this.executions.get(request.capture.executionCallId);
    const channel = id && this.channels.get(id);
    if (
      !channel ||
      this.sealed ||
      channel.requestDigest !== requestDigest(request)
    )
      throw new Error(CLOSED);
    this.live(channel);
    return { identity: channel.identity, sink: channel.capture };
  }

  async finish(
    identity: ToolResultExpectedIdentity,
    result: ToolResultEnvelope,
  ): Promise<void> {
    const channel = this.channels.get(identity.captureId);
    if (!channel || channel.identity !== identity) throw new Error(CLOSED);
    this.live(channel);
    channel.finalReceipt = await channel.resources.publish(
      'external-publication',
      Buffer.from(
        JSON.stringify({
          type: 'final',
          identity,
          capture: result.capture,
          executionStatus: result.executionStatus,
        }),
      ),
    );
    channel.final = result;
  }

  private async manifest(channel: Channel) {
    const ref = channel.final?.capture?.manifest;
    if (!ref || channel.final?.capture?.captureStatus !== 'complete')
      throw new Error(CLOSED);
    return {
      ref,
      value: parseToolResultManifestBytes(await channel.resources.read(ref)),
    };
  }

  async read(
    channelId: string,
    streamId: Stream,
    sequence: number,
    acknowledgedSequence: number,
  ) {
    return this.serialize(async () => {
      const channel = this.channels.get(channelId);
      if (!channel) throw new Error(CLOSED);
      this.live(channel);
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !Number.isSafeInteger(acknowledgedSequence) ||
        acknowledgedSequence < -1 ||
        acknowledgedSequence > channel.delivered[streamId] ||
        sequence >
          Math.max(channel.acknowledged[streamId], acknowledgedSequence) + 1
      )
        throw new Error(CLOSED);
      if (!channel.final) return { state: 'pending' as const };
      const manifest = await this.manifest(channel);
      const stream = manifest.value.contents.find(
        (content) => content.streamId === streamId,
      );
      if (!stream) throw new Error(CLOSED);
      const endSequence = Math.ceil(stream.byteLength / READ_BYTES);
      if (sequence > endSequence) throw new Error(CLOSED);
      const offset = sequence * READ_BYTES;
      const length = Math.min(
        READ_BYTES,
        Math.max(0, stream.byteLength - offset),
      );
      let bytes = Buffer.alloc(0);
      if (length) {
        const result = await channel.store.readRange({
          manifestRef: manifest.ref,
          expectedIdentity: channel.identity,
          streamId,
          offset,
          length,
        });
        if (result.status !== 'ok') throw new Error(CLOSED);
        bytes = result.result;
      }
      if (acknowledgedSequence > channel.acknowledged[streamId]) {
        await channel.resources.publish(
          'external-publication',
          Buffer.from(
            JSON.stringify({
              type: 'ack',
              channelId,
              streamId,
              sequence: acknowledgedSequence,
            }),
          ),
        );
        channel.acknowledged[streamId] = acknowledgedSequence;
      }
      const receipt = {
        channelId,
        streamId,
        sequence,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
        eof: sequence === endSequence,
      };
      if (sequence > channel.delivered[streamId]) {
        await channel.resources.publish(
          'external-publication',
          Buffer.from(JSON.stringify({ type: 'read', ...receipt })),
        );
        channel.delivered[streamId] = sequence;
      }
      this.live(channel);
      return {
        state: 'ready' as const,
        receipt,
        bytes: bytes.toString('base64'),
      };
    });
  }

  async stopDrained(executor: ManagedToolExecutor) {
    this.sealed = true;
    executor.sealAdmission(this.retirementId);
    return this.serialize(async () => {
      const pending: string[] = [];
      for (const [id, channel] of this.channels) {
        this.live(channel);
        if (!channel.final) {
          pending.push(id);
          continue;
        }
        const manifest = await this.manifest(channel);
        if (
          manifest.value.contents.some(
            (stream) =>
              channel.acknowledged[stream.streamId as Stream] !==
              Math.ceil(stream.byteLength / READ_BYTES),
          )
        )
          pending.push(id);
      }
      if (pending.length)
        return { state: 'undrained' as const, channels: pending };
      try {
        if (!this.stopped) {
          await executor.retireSsh(this.retirementId);
          this.stopped = true;
        }
        this.drainProof ??= await this.proofResources.publish(
          'external-publication',
          Buffer.from(
            JSON.stringify({
              type: 'stop-drained',
              leaseId: this.boot.leaseId,
              epoch: this.boot.epoch,
              runtimeIncarnation: this.boot.runtimeIncarnation,
              registrationRevision: this.boot.storage.registrationRevision,
              retirementId: this.retirementId,
              channels: [...this.channels].map(([id, channel]) => ({
                id,
                final: channel.finalReceipt,
                acknowledged: channel.acknowledged,
              })),
            }),
          ),
        );
      } catch {
        return { state: 'unknown' as const };
      }
      for (const channel of this.channels.values()) this.live(channel);
      return {
        state: 'drained' as const,
        proof: this.drainProof,
        receipts: [...this.channels].map(([channelId, channel]) => ({
          channelId,
          receipt: channel.finalReceipt,
        })),
      };
    });
  }

  register(app: Application, executor: ManagedToolExecutor): void {
    for (const route of EXTERNAL_PUBLICATION_ROUTES) {
      app.post(
        route.path,
        managedRuntimeNoStore,
        authorizeManagedRuntime(this.boot),
        managedRuntimeJsonBody(route.requestBodyLimitBytes),
        async (req: Request, res: Response) => {
          try {
            if (
              req.get('X-Qwen-Managed-Storage-Revision') !==
                String(this.boot.storage.registrationRevision) ||
              req.get('X-Qwen-Managed-Runtime-Incarnation') !==
                this.boot.runtimeIncarnation
            )
              throw new Error(CLOSED);
            if (route.key === 'begin') {
              const body = publisherFields(req.body, [
                'protocolVersion',
                'reference',
                'capture',
                'expiresAt',
              ]);
              const reference = parseManagedToolReference(body['reference']);
              const capture = parseManagedShellCapture(body['capture']);
              if (
                body['protocolVersion'] !== 2 ||
                !reference ||
                !capture ||
                typeof body['expiresAt'] !== 'number'
              )
                throw new Error(CLOSED);
              const channelId = await this.begin(
                { reference, capture },
                body['expiresAt'],
              );
              res.json({ protocolVersion: 2, channelId });
            } else if (route.key === 'read') {
              const body = publisherFields(req.body, [
                'protocolVersion',
                'channelId',
                'streamId',
                'sequence',
                'acknowledgedSequence',
              ]);
              if (
                body['protocolVersion'] !== 2 ||
                typeof body['channelId'] !== 'string' ||
                (body['streamId'] !== 'stdout' &&
                  body['streamId'] !== 'stderr') ||
                typeof body['sequence'] !== 'number' ||
                typeof body['acknowledgedSequence'] !== 'number'
              )
                throw new Error(CLOSED);
              res.json({
                protocolVersion: 2,
                ...(await this.read(
                  body['channelId'],
                  body['streamId'],
                  body['sequence'],
                  body['acknowledgedSequence'],
                )),
              });
            } else {
              const body = publisherFields(req.body, [
                'protocolVersion',
                'channel',
              ]);
              if (body['protocolVersion'] !== 2 || body['channel'] !== 'all')
                throw new Error(CLOSED);
              res.json({
                protocolVersion: 2,
                ...(await this.stopDrained(executor)),
              });
            }
          } catch {
            res.status(409).json({
              code: 'managed_runtime_publication_closed',
              error: CLOSED,
            });
          }
        },
        handleManagedRuntimeJsonError,
      );
    }
  }

  async close(): Promise<void> {
    this.sealed = true;
    await this.tail;
    for (const channel of this.channels.values()) {
      await channel.store.close();
      await channel.lease.release();
    }
  }
}
