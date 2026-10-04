/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from './managed-session-assembly.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import type { LocalShellCaptureRequest } from './managed-shell-result-session.js';
import type {
  ToolResultExpectedIdentity,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';
import { parseChildRun } from './managed-child-run-record.js';
import { LocalShellStreamCapture } from './local-shell-stream-capture.js';

// H3 of #12827: the post-start counterpart of ManagedShellResultSession
// for a background Shell. The model-call checkpoint proves a foreground
// invocation; a background one is proven by its child_run record, which
// the turn committed before the process started. This class admits the
// open-ended capture of exactly that record, publishes the running
// manifest revisions as private Session resources, and never produces a
// second tool.receipt — the record's own revisions carry those facts.
// See docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export interface LocalShellStreamAdmission {
  readonly identity: ToolResultExpectedIdentity;
  readonly sink: LocalShellStreamCapture;
}

export class LocalShellStreamResultSession {
  private readonly activation: ManagedSession['activation'];
  private readonly prepared = new Map<string, string>();

  constructor(
    private readonly session: ManagedSession,
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
      throw new Error(
        'Background Shell capture binding generation is invalid.',
      );
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

  /**
   * Admits the open-ended capture of a proven background start. The
   * record must exist with a live (non-terminal) run naming this same
   * start call — anything else is a transport conflict, not a new record.
   */
  async prepare(
    request: LocalShellCaptureRequest & {
      readonly capture: { readonly background?: boolean };
    },
  ): Promise<LocalShellStreamAdmission> {
    await this.assertWritable();
    const { reference, capture } = request;
    const key = this.session.authority.sessionHeader.sessionKey;
    if (
      capture.tenantId !== key.tenantId ||
      capture.sessionId !== key.sessionId ||
      reference.sessionId !== this.runtimeSessionId ||
      capture.bindingGeneration !== this.bindingGeneration ||
      capture.capturePolicy !== 'complete_required' ||
      capture.background !== true
    ) {
      throw new Error(
        'Background Shell capture belongs to another Session or binding.',
      );
    }
    const record = this.session.authority.extensionRecord(
      'child_run',
      capture.executionCallId,
    );
    if (!record) {
      throw new Error('Background Shell record is missing on the Session.');
    }
    const run = parseChildRun(record.record).run;
    if (
      run.executionCallId !== capture.executionCallId ||
      (run.execution !== 'dispatch_started' &&
        run.execution !== 'running_attached')
    ) {
      throw new Error(
        'Background Shell capture does not match its proven start.',
      );
    }
    const captureId = createHash('sha256')
      .update(
        JSON.stringify([
          key,
          capture.executionCallId,
          capture.bindingGeneration,
        ]),
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
      throw new Error('Background Shell capture identity conflicts.');
    }
    this.prepared.set(capture.executionCallId, encoded);
    return {
      identity,
      sink: new LocalShellStreamCapture(
        this.store,
        this.captureResources,
        identity,
        () => this.assertWritable(),
      ),
    };
  }
}
