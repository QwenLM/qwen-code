/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type {
  MonitorRun,
  MonitorStopReason,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type {
  ManagedSessionActor,
  ManagedSessionCommand,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

// H3 of #12827: the hosted orchestrator of a Session's monitor_run records,
// the mirror of HostedChildRunSession. The managed-runtime worker owns the
// watch loop; the dual path puts every product record on the hosted
// authority, so this funnel commits the record line as watch facts arrive:
// the start call's intent before any side effect, dispatch and the set-once
// start receipt after the watch starts, observations only while attached
// with a watermark that never goes back, and settlement only on the run's
// proven end. Writes are serialized and replay-safe by command id, exactly
// like the Shell orchestrator. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** The narrow authority/resource pair a HostedMonitorSession commits through. */
export interface HostedMonitorStore {
  readonly authority: {
    extensionRecord(
      domain: 'monitor_run',
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: { readonly domain: 'monitor_run'; readonly record: unknown },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
  };
}

export interface MonitorRuntimeBinding {
  readonly runtimeBindingId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly generation: string;
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export class HostedMonitorSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedMonitorStore,
    private readonly key: ManagedSessionKey,
  ) {}

  /** The last committed body of one Monitor, parsed. */
  record(monitorId: string): MonitorRun | undefined {
    const existing = this.store.authority.extensionRecord(
      'monitor_run',
      monitorId,
    );
    return existing ? parseMonitorRun(existing.record) : undefined;
  }

  /** Revision 1: the watch call's intent, before any physical side effect. */
  async admit(params: {
    readonly monitorId: string;
    readonly ownerScopeId: string;
    readonly executionCallId: string;
    readonly args: Record<string, unknown>;
    readonly maxEvents: number;
    readonly idleTimeoutMs: number;
    readonly debounceMs: number;
  }): Promise<ManagedSessionDurableRef> {
    const commandRef = await this.store.resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify(params.args), 'utf8'),
    );
    await this.commit(params.monitorId, {
      monitorId: params.monitorId,
      ownerScopeId: params.ownerScopeId,
      commandRef,
      maxEvents: params.maxEvents,
      idleTimeoutMs: params.idleTimeoutMs,
      debounceMs: params.debounceMs,
      startReceiptRef: null,
      observationSequence: 0,
      lastObservationRef: null,
      notifiedThrough: 0,
      stopReason: null,
      outputRef: null,
      run: {
        state: 'admitted',
        reason: null,
        definition: null,
        executionCallId: params.executionCallId,
        effectId: null,
        dispatchId: null,
        deliveryId: null,
        execution: 'intent',
        runtime: null,
        delivery: null,
      },
    });
    return commandRef;
  }

  /** The watch call was dispatched onto a Runtime binding. */
  dispatchStarted(
    monitorId: string,
    runtime: MonitorRuntimeBinding,
  ): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      run: { ...previous.run, execution: 'dispatch_started', runtime },
    }));
  }

  /** The watch is running under its binding; the start receipt sets once. */
  attach(
    monitorId: string,
    runtime: MonitorRuntimeBinding,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    return this.reviseAsync(monitorId, async (previous) => {
      const startReceiptRef = await this.store.resources.publish(
        'managed-runtime-receipt',
        Buffer.from(JSON.stringify(receipt), 'utf8'),
      );
      return {
        ...previous,
        startReceiptRef,
        run: {
          ...previous.run,
          state: 'running',
          execution: 'running_attached',
          runtime,
        },
      };
    });
  }

  /** An accepted observation, only while attached, sequence moving forward. */
  observe(
    monitorId: string,
    observation: Record<string, unknown>,
  ): Promise<void> {
    return this.reviseAsync(monitorId, async (previous) => {
      const lastObservationRef = await this.store.resources.publish(
        'managed-monitor-observation',
        Buffer.from(JSON.stringify(observation), 'utf8'),
      );
      return {
        ...previous,
        observationSequence: previous.observationSequence + 1,
        lastObservationRef,
      };
    });
  }

  /** The output manifest advanced; only ever to a newer revision of it. */
  advanceOutput(
    monitorId: string,
    outputRef: ManagedSessionDurableRef,
  ): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      outputRef,
    }));
  }

  /** A started watch ended on its own terms. */
  settleQuiet(
    monitorId: string,
    stopReason: Extract<
      MonitorStopReason,
      'exited' | 'max_events' | 'idle_timeout'
    >,
  ): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      stopReason,
      run: { ...previous.run, state: 'settled', execution: 'settled' },
    }));
  }

  /** A proven failure; a never-started failure lands on not_started_proven. */
  settleFailed(
    monitorId: string,
    params: {
      readonly stopReason: Extract<
        MonitorStopReason,
        'start_failed' | 'watch_failed'
      >;
      readonly started: boolean;
    },
  ): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      stopReason: params.stopReason,
      run: {
        ...previous.run,
        state: 'failed',
        execution: params.started ? 'settled' : 'not_started_proven',
      },
    }));
  }

  /** The stop call was honored; `notifiedThrough` may still advance after. */
  settleStopRequested(monitorId: string): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      stopReason: 'stop_requested',
      run: { ...previous.run, state: 'cancelled', execution: 'settled' },
    }));
  }

  private revise(
    monitorId: string,
    step: (previous: MonitorRun) => MonitorRun,
  ): Promise<void> {
    return this.reviseAsync(monitorId, (previous) => step(previous));
  }

  private reviseAsync(
    monitorId: string,
    step: (previous: MonitorRun) => MonitorRun | Promise<MonitorRun>,
  ): Promise<void> {
    return this.commit(monitorId, async (previous) => {
      if (!previous)
        throw new Error(`Monitor ${monitorId} has no record to revise.`);
      return await step(previous);
    });
  }

  private commit(
    monitorId: string,
    record:
      | MonitorRun
      | ((previous: MonitorRun | undefined) => Promise<MonitorRun>),
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'monitor_run',
        monitorId,
      );
      const previous = existing ? parseMonitorRun(existing.record) : undefined;
      const next =
        typeof record === 'function' ? await record(previous) : record;
      if (previous && isDeepStrictEqual(previous, next)) return;
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitMonitorRun',
          commandId: previous
            ? `${monitorId}:${existing!.revision + 1}`
            : monitorId,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        { domain: 'monitor_run', record: next },
        TRUSTED,
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
