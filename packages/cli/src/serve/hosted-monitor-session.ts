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
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { isShellCommandReadOnlyASTInDirectory } from '@qwen-code/qwen-code-core/utils/shellAstParser.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  isToolResultManifestChainLink,
  parseToolResultManifestBytes,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';

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
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
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

// H3 rebuild policy: only a Monitor whose command is known read-only may
// be restarted after a Runtime loss — anything else keeps its blocked
// holds, so the answer the session gives stays accurate rather than
// invented. See docs/design/2026-10-03-managed-shell-monitor-runtime.md.
export async function monitorRebuildAllowed(
  command: string,
  cwd: string,
): Promise<boolean> {
  if (typeof command !== 'string' || !command.trim()) return false;
  return isShellCommandReadOnlyASTInDirectory(command, cwd);
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

  /** The Session resource store notification bodies publish through. */
  get resourceStore(): HostedMonitorStore['resources'] {
    return this.store.resources;
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
    notification?: { readonly input: ManagedSessionInputRequest },
  ): Promise<void> {
    return this.commit(
      monitorId,
      async (previous) => {
        if (!previous)
          throw new Error(`Monitor ${monitorId} has no record to revise.`);
        const lastObservationRef = await this.store.resources.publish(
          'managed-monitor-observation',
          Buffer.from(JSON.stringify(observation), 'utf8'),
        );
        const sequence = previous.observationSequence + 1;
        return {
          ...previous,
          observationSequence: sequence,
          lastObservationRef,
          notifiedThrough: notification ? sequence : previous.notifiedThrough,
        };
      },
      notification?.input,
    );
  }

  /** The output manifest advanced; only ever along this capture's lineage. */
  advanceOutput(
    monitorId: string,
    outputRef: ManagedSessionDurableRef,
  ): Promise<void> {
    return this.reviseAsync(monitorId, async (previous) => {
      // A replay of the very same reference is the no-op the deep-equal
      // skip already owns; anything else must continue this capture. A
      // higher revision from another capture would chain the record's
      // output to bytes that do not exist there, and a skipped revision
      // loses pages — both are funnel wiring faults, not delivery noise.
      if (
        previous.outputRef !== null &&
        isDeepStrictEqual(previous.outputRef, outputRef)
      )
        return previous;
      const after = parseToolResultManifestBytes(
        await this.store.resources.read(outputRef),
      );
      if (after.executionCallId !== previous.run.executionCallId) {
        throw new Error(`Monitor ${monitorId} output names another call.`);
      }
      if (previous.outputRef !== null) {
        const before = parseToolResultManifestBytes(
          await this.store.resources.read(previous.outputRef),
        );
        if (!isToolResultManifestChainLink(before, after)) {
          throw new Error(
            `Monitor ${monitorId} output manifest lineage broke.`,
          );
        }
      }
      return { ...previous, outputRef };
    });
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

  /**
   * The watch's Runtime is gone and nothing proved its end: the run
   * blocks accurately with runtime_lost until a read-only rebuild (or
   * a close drain) decides what happens next. The project view reads
   * degraded meanwhile; the Runtime binding stays named as lost.
   */
  blockedRuntimeLost(monitorId: string): Promise<void> {
    return this.revise(monitorId, (previous) => ({
      ...previous,
      run: {
        ...previous.run,
        state: 'recovery_blocked',
        reason: 'runtime_lost',
        execution: 'outcome_unknown',
      },
    }));
  }

  /**
   * A rebuild from runtime_lost alone, and only then: a new Runtime
   * generation starts a fresh watch, mints its own start receipt, and
   * the observation watermark never replays what it already covered.
   * Every other state refuses because the H0b rule says a rebuild
   * starts from outcome_unknown and from no other line.
   */
  async rebuildFromRuntimeLost(
    monitorId: string,
    runtime: MonitorRuntimeBinding,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    const previous = this.record(monitorId);
    if (!previous) throw new Error(`Monitor ${monitorId} has no record.`);
    if (
      previous.run.execution !== 'outcome_unknown' ||
      previous.run.reason !== 'runtime_lost'
    ) {
      throw new Error(
        `Monitor ${monitorId} cannot rebuild from its current state.`,
      );
    }
    const startReceiptRef = await this.store.resources.publish(
      'managed-runtime-receipt',
      Buffer.from(JSON.stringify(receipt), 'utf8'),
    );
    await this.revise(monitorId, (current) => ({
      ...current,
      startReceiptRef,
      run: {
        ...current.run,
        state: 'running',
        reason: 'runtime_lost',
        execution: 'running_attached',
        runtime,
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
    input?: ManagedSessionInputRequest,
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'monitor_run',
        monitorId,
      );
      const previous = existing ? parseMonitorRun(existing.record) : undefined;
      const next =
        typeof record === 'function' ? await record(previous) : record;
      if (previous && isDeepStrictEqual(previous, next) && input === undefined)
        return;
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitMonitorRun',
          commandId: previous
            ? `${monitorId}:${existing!.revision + 1}`
            : monitorId,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        {
          domain: 'monitor_run',
          record: next,
          ...(input !== undefined ? { input } : {}),
        },
        TRUSTED,
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
