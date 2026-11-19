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
  ['begin', 'read', 'renew', 'stop-drained'].map((key) =>
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
  /**
   * The grant's horizon, which the Broker renews for as long as it owns the
   * Session. A foreground Shell may outlive one horizon, so this is not fixed
   * at `begin`: the Broker pushes each renewed value on `publication:renew`.
   */
  readonly horizon: { expiresAt: number };
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

function requestDigest(
  request: LocalShellCaptureRequest,
  captureId: string,
): string {
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
        captureId,
      ]),
    )
    .digest('hex');
}

/** The publication token rule, shared by the binding and every manifest. */
const CAPTURE_ID_PATTERN = /^[a-z0-9_-]{1,128}$/;

/** Foreground captures are local O1a stores; only the authenticated reader is remote. */
export class ManagedExternalPublication
  implements ManagedShellCapturePublisher
{
  /**
   * This lane's proof is the drained stop below, not an acknowledgement: the
   * worker holds no control-plane credential, so the Broker acknowledges its
   * sequences out of band and no ACK ever reaches its journal.
   */
  readonly retiresOnDrainProof = true;
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
    if (channel.horizon.expiresAt <= Date.now()) throw new Error(CLOSED);
  }

  async begin(
    request: LocalShellCaptureRequest,
    expiresAt: number,
    captureId: string,
  ): Promise<string> {
    return this.serialize(async () => {
      if (
        this.sealed ||
        request.capture.tenantId !== this.boot.tenantId ||
        request.capture.background ||
        request.capture.monitoring ||
        !CAPTURE_ID_PATTERN.test(captureId) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now()
      )
        throw new Error(CLOSED);
      const digest = requestDigest(request, captureId);
      const priorId = this.executions.get(request.capture.executionCallId);
      if (priorId) {
        const prior = this.channels.get(priorId)!;
        // A lapsed horizon is not terminal on this path: the recovered
        // dispatch is the channel's owner, and its fresh `expiresAt` plus the
        // identical request digest are the authorization. The write gate and
        // the drain below still re-check the horizon.
        // The captured input is fixed for the execution's life; the horizon is
        // not, because the grant that bounds it is renewed. A recovered
        // dispatch therefore offers its own current horizon.
        if (prior.requestDigest !== digest) throw new Error(CLOSED);
        prior.horizon.expiresAt = Math.max(prior.horizon.expiresAt, expiresAt);
        return priorId;
      }
      if (this.channels.size >= 64) throw new Error(CLOSED);
      const channelId = randomUUID();
      const directory = await mkdtemp(path.join(this.directory, 'channel-'));
      // Shared with the channel so `publication:renew` moves the capture's own
      // write gate forward while a long command is still writing.
      const horizon = { expiresAt };
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
          // The manifest identity is the publication binding's own wire
          // digest, prefix included: the control plane compares it against
          // `binding.reference.argsDigest` verbatim, so a stripped digest here
          // would refuse every finished capture.
          invocationDigest: request.reference.argsDigest.startsWith('sha256:')
            ? request.reference.argsDigest
            : `sha256:${request.reference.argsDigest}`,
          bindingGeneration: request.capture.bindingGeneration,
          // The Broker's publication binding already fixed this token before
          // dispatch, and the control plane compares every finished manifest
          // against it verbatim. A worker-chosen id could never match.
          captureId,
          revision: 1,
        };
        const capture = new LocalShellResultCapture(
          store,
          resources,
          identity,
          async () => {
            if (horizon.expiresAt <= Date.now()) throw new Error(CLOSED);
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
          horizon,
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
      channel.requestDigest !==
        requestDigest(request, channel.identity.captureId)
    )
      throw new Error(CLOSED);
    this.live(channel);
    return { identity: channel.identity, sink: channel.capture };
  }

  async finish(
    identity: ToolResultExpectedIdentity,
    result: ToolResultEnvelope,
  ): Promise<void> {
    const id = this.executions.get(identity.executionCallId);
    const channel = id && this.channels.get(id);
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

  /**
   * Extends one channel to the Broker's current grant horizon. The grant is
   * bounded by the writer lease, which the Harness renews, while a foreground
   * Shell may run far longer than one lease; without this the capture would
   * close mid-command and the drain could never complete.
   */
  async renew(channelId: string, expiresAt: number): Promise<void> {
    const channel = this.channels.get(channelId);
    if (
      !channel ||
      this.sealed ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new Error(CLOSED);
    // A lapsed horizon is recoverable here for the same reason as on the
    // re-begin path: the renewing Broker is the channel's owner, and this
    // fresh `expiresAt` is its authorization.
    channel.horizon.expiresAt = Math.max(channel.horizon.expiresAt, expiresAt);
    await channel.resources.publish(
      'external-publication',
      Buffer.from(
        JSON.stringify({
          type: 'renew',
          channelId,
          expiresAt: channel.horizon.expiresAt,
        }),
      ),
    );
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
      let bytes: Buffer = Buffer.alloc(0);
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
        // The empty EOF sequence follows the last block instead of sharing it:
        // `acknowledgedSequence` must stay below the sequence being read, so an
        // EOF that coincided with a block could never be acknowledged and every
        // drain would report undrained.
        eof: sequence === endSequence && bytes.length === 0,
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
        // The Broker rebuilds the result manifest from these bytes, and the
        // envelope it settles carries no process facts: without them the
        // rebuilt manifest would record an unknown exit for every call.
        exitCode: manifest.value.exitCode,
        signal: manifest.value.signal,
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
        route.path.replace(':', '\\:'),
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
                'captureId',
              ]);
              const reference = parseManagedToolReference(body['reference']);
              const capture = parseManagedShellCapture(body['capture']);
              if (
                body['protocolVersion'] !== 2 ||
                !reference ||
                !capture ||
                typeof body['expiresAt'] !== 'number' ||
                typeof body['captureId'] !== 'string'
              )
                throw new Error(CLOSED);
              const channelId = await this.begin(
                { reference, capture },
                body['expiresAt'],
                body['captureId'],
              );
              res.json({ protocolVersion: 2, channelId });
            } else if (route.key === 'renew') {
              const body = publisherFields(req.body, [
                'protocolVersion',
                'channelId',
                'expiresAt',
              ]);
              if (
                body['protocolVersion'] !== 2 ||
                typeof body['channelId'] !== 'string' ||
                typeof body['expiresAt'] !== 'number'
              )
                throw new Error(CLOSED);
              await this.renew(body['channelId'], body['expiresAt']);
              res.json({ protocolVersion: 2, renewed: true });
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
