/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { parseHarnessCheckpointV1 } from './managed-harness-checkpoint.js';
import type { ManagedSession } from './managed-session-assembly.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
} from './managed-session-records.js';
import { assertManagedSessionDurableRef } from './managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_LIMITS,
  parseToolResultEnvelope,
  parseToolResultManifestBytes,
  type ToolResultEnvelope,
} from './managed-tool-result.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';
import { LocalShellResultCapture } from './local-shell-result-capture.js';

export interface LocalShellCaptureRequest {
  readonly reference: {
    readonly sessionId: string;
    readonly promptId: string;
    readonly callId: string;
    readonly argsDigest: string;
  };
  readonly capture: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly executionCallId: string;
    readonly bindingGeneration: string;
    readonly capturePolicy: 'complete_required';
  };
}

interface SavedOutcome {
  readonly version: 1;
  readonly identity: ToolResultExpectedIdentity;
  readonly decision: 'committed' | 'blocked';
  readonly envelope: ToolResultEnvelope;
}

export interface LocalShellReceipt {
  readonly executionCallId: string;
  readonly manifest: ManagedSessionDurableRef | null;
  readonly deliveryStatus: 'committed' | 'blocked';
  readonly historyRevision: number | null;
  readonly outcomeRef: ManagedSessionDurableRef;
}

function equalRef(
  left: ManagedSessionDurableRef | null,
  right: ManagedSessionDurableRef | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Admits captured Shell results under their original Managed Session. */
export class ManagedShellResultSession {
  private readonly activation: ManagedSession['activation'];
  private readonly prepared = new Map<string, string>();

  constructor(
    protected readonly session: ManagedSession,
    private readonly store: ToolResultSegmentStore,
    private readonly bindingGeneration: string,
    private readonly assertWriter: () => Promise<void>,
    private readonly runtimeSessionId: string,
    private readonly captureResources: ManagedSessionResourceStore = session.resources,
  ) {
    if (
      !/^[1-9][0-9]{0,18}$/.test(bindingGeneration) ||
      BigInt(bindingGeneration) > 2n ** 63n - 1n
    ) {
      throw new Error('Shell capture binding generation is invalid.');
    }
    this.activation = session.activation;
  }

  private assertActivation(): void {
    const current = this.session.authority.currentActivation;
    if (
      !current ||
      current.activationId !== this.activation.activationId ||
      current.epoch !== this.activation.epoch ||
      current.phase !== 'active' ||
      current.expiresAt <= Date.now()
    ) {
      throw new Error('Managed Session activation is no longer writable.');
    }
  }

  async assertWritable(): Promise<void> {
    this.assertActivation();
    await this.assertWriter();
    this.assertActivation();
  }

  async prepare(
    request: LocalShellCaptureRequest,
    modelCallId = request.reference.callId,
  ): Promise<{
    identity: ToolResultExpectedIdentity;
    sink: LocalShellResultCapture;
  }> {
    await this.assertWritable();
    const { reference, capture } = request;
    const key = this.session.authority.sessionHeader.sessionKey;
    if (
      capture.tenantId !== key.tenantId ||
      capture.sessionId !== key.sessionId ||
      reference.sessionId !== this.runtimeSessionId ||
      capture.bindingGeneration !== this.bindingGeneration ||
      capture.capturePolicy !== 'complete_required'
    ) {
      throw new Error('Tool result belongs to another Session or binding.');
    }
    const checkpointBytes = await this.session.authority.readCheckpointState();
    if (!checkpointBytes)
      throw new Error('Runtime dispatch has no checkpoint.');
    const checkpoint = parseHarnessCheckpointV1(checkpointBytes);
    const item = checkpoint.tools?.items.find(
      (each) => each.executionCallId === capture.executionCallId,
    );
    if (
      checkpoint.continuation.phase !== 'await_runtime' ||
      checkpoint.identity.activationId !== this.activation.activationId ||
      checkpoint.identity.turnId !== capture.turnId ||
      checkpoint.identity.promptId !== reference.promptId ||
      item?.state !== 'in_progress' ||
      item.functionCallId !== modelCallId ||
      reference.argsDigest.replace(/^sha256:/, '') !== item.inputDigest ||
      item.toolName !== 'run_shell_command'
    ) {
      throw new Error(
        'Original Shell execution was not committed before dispatch.',
      );
    }
    const intent = this.session.authority
      .eventsInSequenceRange(1, this.session.authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.intent' &&
          event.payload['executionCallId'] === capture.executionCallId &&
          event.sequence <= checkpoint.identity.coveredSequence &&
          event.subject?.type === 'activation' &&
          event.subject.activationId === this.activation.activationId &&
          event.subject.epoch === this.activation.epoch,
      );
    if (!intent) throw new Error('Original tool intent is missing.');
    if (modelCallId !== reference.callId) {
      const binding = checkpoint.runtime?.bindings.find(
        (entry) => entry.executionCallId === capture.executionCallId,
      );
      if (
        binding?.invocationBindingId !== reference.callId ||
        binding.state !== 'dispatch'
      ) {
        throw new Error('Original Shell runtime call mapping conflicts.');
      }
    }
    const argsRef = assertManagedSessionDurableRef(
      intent.payload['argsRef'],
      'tool.intent.argsRef',
    );
    const originalArgs = JSON.parse(
      (await this.session.resources.read(argsRef)).toString(),
    );
    if (
      managedToolDigest(originalArgs) !==
      reference.argsDigest.replace(/^sha256:/, '')
    ) {
      throw new Error('Original tool arguments conflict with capture.');
    }
    const captureId = createHash('sha256')
      .update(
        JSON.stringify([key, capture.executionCallId, this.bindingGeneration]),
      )
      .digest('hex')
      .slice(0, 32);
    const identity: ToolResultExpectedIdentity = {
      tenantId: key.tenantId,
      sessionId: key.sessionId,
      turnId: capture.turnId,
      executionCallId: capture.executionCallId,
      callId: reference.callId,
      invocationDigest: reference.argsDigest,
      bindingGeneration: this.bindingGeneration,
      captureId,
      revision: 1,
    };
    await this.assertWritable();
    const encoded = JSON.stringify(identity);
    const prior = this.prepared.get(capture.executionCallId);
    if (prior && prior !== encoded) {
      throw new Error('Original Shell capture identity conflicts.');
    }
    this.prepared.set(capture.executionCallId, encoded);
    return {
      identity,
      sink: new LocalShellResultCapture(
        this.store,
        this.captureResources,
        identity,
        () => this.assertWritable(),
      ),
    };
  }

  private receiptEvent(
    executionCallId: string,
  ): ManagedSessionEvent | undefined {
    return this.session.authority
      .eventsInSequenceRange(1, this.session.authority.committedSequence)
      .find(
        (event) =>
          event.kind === 'tool.receipt' &&
          event.payload['executionCallId'] === executionCallId,
      );
  }

  private async saved(event: ManagedSessionEvent): Promise<SavedOutcome> {
    const ref = assertManagedSessionDurableRef(
      event.payload['toolOutcomeRef'],
      'tool.receipt.toolOutcomeRef',
    );
    const parsed = JSON.parse(
      (await this.session.resources.read(ref)).toString(),
    );
    if (
      parsed.version !== 1 ||
      (parsed.decision !== 'committed' && parsed.decision !== 'blocked')
    ) {
      throw new Error('Stored Shell outcome is invalid.');
    }
    return {
      version: 1,
      identity: parsed.identity as ToolResultExpectedIdentity,
      decision: parsed.decision,
      envelope: parseToolResultEnvelope(parsed.envelope),
    };
  }

  async recorded(
    identity: ToolResultExpectedIdentity,
  ): Promise<LocalShellReceipt | null> {
    const event = this.receiptEvent(identity.executionCallId);
    if (!event) return null;
    const saved = await this.saved(event);
    if (JSON.stringify(saved.identity) !== JSON.stringify(identity)) {
      throw new Error('Original Shell receipt identity conflicts.');
    }
    const manifest = saved.envelope.capture?.manifest ?? null;
    if (
      event.payload['historyRevision'] !== event.sequence ||
      !equalRef(
        event.payload['resultRef'] as ManagedSessionDurableRef | null,
        saved.decision === 'committed' ? manifest : null,
      ) ||
      (saved.decision === 'committed' && !manifest) ||
      JSON.stringify(event.payload['resources']) !==
        JSON.stringify(manifest ? [manifest] : [])
    ) {
      throw new Error('Original Shell receipt manifest conflicts.');
    }
    return {
      executionCallId: identity.executionCallId,
      manifest,
      deliveryStatus: saved.decision,
      historyRevision: saved.decision === 'committed' ? event.sequence : null,
      outcomeRef: assertManagedSessionDurableRef(
        event.payload['toolOutcomeRef'],
        'tool.receipt.toolOutcomeRef',
      ),
    };
  }

  async accept(
    identity: ToolResultExpectedIdentity,
    candidate: ToolResultEnvelope,
  ): Promise<LocalShellReceipt> {
    const envelope = parseToolResultEnvelope(candidate);
    if (envelope.capture?.deliveryStatus !== 'pending') {
      throw new Error('Only an unacknowledged Shell result can be accepted.');
    }
    const original = await this.recorded(identity);
    if (original) {
      const event = this.receiptEvent(identity.executionCallId)!;
      const saved = await this.saved(event);
      if (JSON.stringify(saved.envelope) !== JSON.stringify(envelope)) {
        throw new Error(
          'Original Shell result conflicts with committed receipt.',
        );
      }
      return original;
    }
    const manifestRef = envelope.capture?.manifest ?? null;
    if (
      this.prepared.get(identity.executionCallId) !== JSON.stringify(identity)
    ) {
      throw new Error('Shell result was not prepared by this Session owner.');
    }
    await this.assertWritable();
    let complete = envelope.capture?.captureStatus === 'complete';
    if (manifestRef) {
      const manifest = parseToolResultManifestBytes(
        await this.captureResources.read(manifestRef),
      );
      if (
        Object.entries(identity).some(
          ([key, value]) =>
            manifest[key as keyof ToolResultExpectedIdentity] !== value,
        ) ||
        manifest.executionStatus !== envelope.executionStatus ||
        manifest.captureScope !== 'process_pipes' ||
        manifest.capturePolicy !== 'complete_required' ||
        manifest.upstreamTruncated ||
        manifest.captureStatus !== envelope.capture?.captureStatus ||
        manifest.captureReason !== envelope.capture.captureReason ||
        (complete &&
          (manifest.contents.length !== 2 ||
            !manifest.contents.some(
              (entry) =>
                entry.streamId === 'stdout' &&
                entry.role === 'stdout' &&
                entry.state === 'sealed',
            ) ||
            !manifest.contents.some(
              (entry) =>
                entry.streamId === 'stderr' &&
                entry.role === 'stderr' &&
                entry.state === 'sealed',
            )))
      ) {
        throw new Error('Shell manifest does not bind the original execution.');
      }
      for (const entry of manifest.contents) {
        if (complete) {
          if (!('pages' in entry.body)) {
            throw new Error('Complete Shell stream has no segment pages.');
          }
          const prefix = await this.store.prefix({
            captureId: identity.captureId,
            streamId: entry.streamId,
          });
          if (
            prefix.status !== 'ok' ||
            !prefix.result.sealed ||
            prefix.result.byteLength !== entry.byteLength ||
            prefix.result.digest !== entry.digest ||
            prefix.result.segmentCount !==
              entry.body.pages.reduce(
                (total, page) => total + page.segmentCount,
                0,
              )
          ) {
            throw new Error('Complete Shell stream is not sealed.');
          }
        }
        const hash = createHash('sha256');
        for (
          let offset = 0;
          offset < entry.byteLength;
          offset += MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes
        ) {
          const read = await this.store.readRange({
            manifestRef,
            expectedIdentity: identity,
            streamId: entry.streamId,
            offset,
            length: Math.min(
              MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes,
              entry.byteLength - offset,
            ),
          });
          if (read.status !== 'ok') throw new Error(read.code);
          hash.update(read.result);
        }
        if (hash.digest('hex') !== entry.digest) {
          throw new Error('Shell capture digest does not match manifest.');
        }
      }
    } else {
      complete = false;
    }
    const decision = complete ? 'committed' : 'blocked';
    const outcome: SavedOutcome = { version: 1, identity, decision, envelope };
    const outcomeBytes = Buffer.from(JSON.stringify(outcome));
    const outcomeRef = await this.session.resources.publish(
      'managed-tool-outcome',
      outcomeBytes,
    );
    const commandId = identity.executionCallId;
    const digest = createHash('sha256').update(outcomeBytes).digest('hex');
    await this.session.authority.appendExecutionEvent(
      {
        operation: 'recordToolResult',
        commandId,
        sessionKey: this.session.authority.sessionHeader.sessionKey,
        contentDigest: digest,
      },
      (sequence) => {
        this.assertActivation();
        return {
          v: 1,
          sequence,
          eventId: `tool-receipt:${commandId}`,
          sessionKey: this.session.authority.sessionHeader.sessionKey,
          kind: 'tool.receipt',
          occurredAt: Date.now(),
          payload: {
            executionCallId: commandId,
            toolOutcomeRef: outcomeRef,
            resultRef: decision === 'committed' ? manifestRef : null,
            resources: manifestRef ? [manifestRef] : [],
            historyRevision: sequence,
          },
        };
      },
      { class: 'trusted_entry' },
    );
    const receipt = await this.recorded(identity);
    if (!receipt) throw new Error('Committed Shell receipt disappeared.');
    return receipt;
  }
}
