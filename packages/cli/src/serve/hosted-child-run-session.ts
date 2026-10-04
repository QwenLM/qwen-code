/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ChildRun,
  ChildRunStopReason,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type {
  ManagedSessionActor,
  ManagedSessionCommand,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { manifestRevision } from './managed-output-revision.js';

// H3 of #12827: the hosted orchestrator of a Session's child_run records
// (kind shell). The managed-runtime worker owns the process; the dual path
// puts every product record on the hosted authority, so this funnel commits
// the record line as physical facts arrive: the start call's intent before
// any side effect, dispatch and the set-once supervisor receipt after
// start, output-manifest advancement only forward, settlement only on
// proven exit evidence or a committed stop. Writes are serialized and
// replay-safe by command id, exactly like the Hook orchestrator. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** The narrow authority/resource pair a HostedChildRunSession commits through. */
export interface HostedChildRunStore {
  readonly authority: {
    extensionRecord(
      domain: 'child_run',
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: { readonly domain: 'child_run'; readonly record: unknown },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
}

export interface ChildRunRuntimeBinding {
  readonly runtimeBindingId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly generation: string;
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export class HostedChildRunSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedChildRunStore,
    private readonly key: ManagedSessionKey,
  ) {}

  /** The last committed body of one Shell, parsed. */
  record(shellId: string): ChildRun | undefined {
    const existing = this.store.authority.extensionRecord('child_run', shellId);
    return existing ? parseChildRun(existing.record) : undefined;
  }

  /** Revision 1: the start call's intent, before any physical side effect. */
  async admit(params: {
    readonly shellId: string;
    readonly ownerScopeId: string;
    readonly executionCallId: string;
    readonly args: Record<string, unknown>;
  }): Promise<ManagedSessionDurableRef> {
    const commandRef = await this.store.resources.publish(
      'managed-tool-args',
      Buffer.from(JSON.stringify(params.args), 'utf8'),
    );
    await this.commit(params.shellId, {
      kind: 'shell',
      shellId: params.shellId,
      ownerScopeId: params.ownerScopeId,
      commandRef,
      startReceiptRef: null,
      outputRef: null,
      stopReason: null,
      stopRequested: false,
      exitCode: null,
      exitSignal: null,
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

  /** The start call was dispatched onto a Runtime binding. */
  dispatchStarted(
    shellId: string,
    runtime: ChildRunRuntimeBinding,
  ): Promise<void> {
    return this.revise(shellId, (previous) => ({
      ...previous,
      run: {
        ...previous.run,
        state: 'running',
        execution: 'dispatch_started',
        runtime,
      },
    }));
  }

  /** The supervisor's physical start receipt, set once after the process starts. */
  attach(
    shellId: string,
    runtime: ChildRunRuntimeBinding,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    return this.reviseAsync(shellId, async (previous) => {
      const startReceiptRef = await this.store.resources.publish(
        'managed-runtime-receipt',
        Buffer.from(JSON.stringify(receipt), 'utf8'),
      );
      return {
        ...previous,
        startReceiptRef,
        run: {
          ...previous.run,
          ...this.step(previous.run.state),
          execution: 'running_attached',
          runtime,
        },
      };
    });
  }

  /** The output manifest advanced; only ever to a newer revision of it. */
  advanceOutput(
    shellId: string,
    outputRef: ManagedSessionDurableRef,
  ): Promise<void> {
    return this.reviseAsync(shellId, async (previous) => {
      // A replay of the very same reference is the no-op the deep-equal
      // skip already owns; any other reference must be a strictly newer
      // revision, so a lost or reordered delivery can never walk the
      // output back.
      if (
        previous.outputRef !== null &&
        !isDeepStrictEqual(previous.outputRef, outputRef)
      ) {
        const before = manifestRevision(
          await this.store.resources.read(previous.outputRef),
          'Shell output manifest',
        );
        const after = manifestRevision(
          await this.store.resources.read(outputRef),
          'Shell output manifest',
        );
        if (after <= before) {
          throw new Error(`Shell ${shellId} output may only advance forward.`);
        }
      }
      return {
        ...previous,
        outputRef,
        run: { ...previous.run, ...this.step(previous.run.state) },
      };
    });
  }

  /** A stop was requested of the owner; set once, never cleared. */
  requestStop(shellId: string): Promise<void> {
    return this.revise(shellId, (previous) => ({
      ...previous,
      stopRequested: true,
      run: { ...previous.run, ...this.step(previous.run.state) },
    }));
  }

  /** Natural exit proven by the supervisor: code, signal, or both. */
  settleExited(
    shellId: string,
    exit: {
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
    },
  ): Promise<void> {
    return this.revise(shellId, (previous) => ({
      ...previous,
      stopReason: 'exited',
      exitCode: exit.exitCode,
      exitSignal: exit.exitSignal,
      run: { ...previous.run, state: 'settled', execution: 'settled' },
    }));
  }

  /** A proven failure; a pre-start failure lands on not_started_proven. */
  settleFailed(
    shellId: string,
    params: {
      readonly stopReason: Extract<
        ChildRunStopReason,
        'start_failed' | 'process_failed' | 'quota_exceeded'
      >;
      readonly started: boolean;
    },
  ): Promise<void> {
    return this.revise(shellId, (previous) => ({
      ...previous,
      stopReason: params.stopReason,
      run: {
        ...previous.run,
        state: 'failed',
        execution: params.started ? 'settled' : 'not_started_proven',
      },
    }));
  }

  /** The committed stop request was honored. */
  settleStopRequested(shellId: string): Promise<void> {
    return this.revise(shellId, (previous) => ({
      ...previous,
      stopReason: 'stop_requested',
      run: { ...previous.run, state: 'cancelled', execution: 'settled' },
    }));
  }

  /** A live run line never loops: identical steps alternate the two live
   * states, and a terminal line is never stepped back to life. */
  private step(state: ChildRun['run']['state']): {
    readonly state: ChildRun['run']['state'];
  } {
    if (state === 'settled' || state === 'failed' || state === 'cancelled') {
      return { state };
    }
    return { state: state === 'running' ? 'waiting' : 'running' };
  }

  private revise(
    shellId: string,
    step: (previous: ChildRun) => ChildRun,
  ): Promise<void> {
    return this.reviseAsync(shellId, (previous) => step(previous));
  }

  private reviseAsync(
    shellId: string,
    step: (previous: ChildRun) => ChildRun | Promise<ChildRun>,
  ): Promise<void> {
    return this.commit(shellId, async (previous) => {
      if (!previous)
        throw new Error(`Background Shell ${shellId} has no record to revise.`);
      return await step(previous);
    });
  }

  private commit(
    shellId: string,
    record: ChildRun | ((previous: ChildRun | undefined) => Promise<ChildRun>),
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const existing = this.store.authority.extensionRecord(
        'child_run',
        shellId,
      );
      const previous = existing ? parseChildRun(existing.record) : undefined;
      const next =
        typeof record === 'function' ? await record(previous) : record;
      if (previous && isDeepStrictEqual(previous, next)) return;
      await this.store.authority.commitExtensionRecord(
        {
          operation: 'commitChildRunRecord',
          commandId: previous
            ? `${shellId}:${existing!.revision + 1}`
            : shellId,
          sessionKey: this.key,
          contentDigest: digest(next),
        },
        { domain: 'child_run', record: next },
        TRUSTED,
      );
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
