/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseChildRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import type { ManagedDeliveryEntry } from '@qwen-code/qwen-code-core/managed-runtime/managed-delivery-entry.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { DurableToolResultResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import type { HostedChildRunSession } from './hosted-child-run-session.js';
import type { HostedMonitorSession } from './hosted-monitor-session.js';
import { HostedShellPublisher } from './hosted-shell-publisher.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

export interface BackgroundDeliveryRecoveryLane {
  publisher?: HostedShellPublisher;
  readonly resources: DurableToolResultResourceStore;
  readonly assertWritable: () => Promise<void>;
  monitorWakeKick?: () => void;
  observationBindings?: Set<string>;
}

export interface BackgroundDeliveryRecoveryInput {
  readonly managed: ManagedSession;
  readonly lane: BackgroundDeliveryRecoveryLane;
  readonly writerOwner: {
    owner(): Promise<{
      readonly writerId: string;
      readonly writerGeneration: number;
    }>;
  };
  readonly brokerOptions: HostedWorkspaceBrokerOptions;
  readonly childRuns?: HostedChildRunSession;
  readonly monitors?: HostedMonitorSession;
}

interface KnownBackgroundRun {
  readonly executionCallId: string;
  readonly domain: 'child_run' | 'monitor_run';
  readonly outputRef: ManagedSessionDurableRef | null;
  readonly settled: boolean;
  readonly runtime: {
    readonly runtimeBindingId: string;
    readonly generation: string;
  } | null;
}

function collectKnownRuns(managed: ManagedSession): KnownBackgroundRun[] {
  const runs: KnownBackgroundRun[] = [];
  for (const entry of managed.authority.extensionRecordsInDomain('child_run')) {
    const parsed = parseChildRun(entry.record);
    if (parsed.kind !== 'shell' || !parsed.run.executionCallId) continue;
    runs.push({
      executionCallId: parsed.run.executionCallId,
      domain: 'child_run',
      outputRef: parsed.outputRef,
      settled: ['settled', 'not_started_proven'].includes(
        parsed.run.execution ?? '',
      ),
      runtime: parsed.run.runtime,
    });
  }
  for (const entry of managed.authority.extensionRecordsInDomain(
    'monitor_run',
  )) {
    const parsed = parseMonitorRun(entry.record);
    if (!parsed.run.executionCallId) continue;
    runs.push({
      executionCallId: parsed.run.executionCallId,
      domain: 'monitor_run',
      outputRef: parsed.outputRef,
      settled: ['settled', 'not_started_proven'].includes(
        parsed.run.execution ?? '',
      ),
      runtime: parsed.run.runtime,
    });
  }
  return runs;
}

export async function resolveBackgroundRuntimeSessions(
  managed: ManagedSession,
  executionCallIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const runtimeSessionIds = new Set<string>();
  if (executionCallIds.size === 0) return runtimeSessionIds;
  const sessionId = managed.authority.sessionHeader.sessionKey.sessionId;
  const sequence = managed.authority.committedSequence;
  for (const event of managed.authority.eventsInSequenceRange(1, sequence)) {
    if (event.kind !== 'tool.intent') continue;
    const callId = event.payload['executionCallId'];
    if (typeof callId !== 'string' || !executionCallIds.has(callId)) continue;
    const rawRef = event.payload['argsRef'];
    if (!rawRef || typeof rawRef !== 'object') continue;
    const ref = assertManagedSessionDurableRef(rawRef, 'background tool route');
    if (ref.kind !== 'managed-tool-input') continue;
    const route = JSON.parse(
      (await managed.resources.read(ref)).toString('utf8'),
    ) as { harnessSessionId?: unknown; runtimeSessionId?: unknown };
    if (
      route.harnessSessionId === sessionId &&
      typeof route.runtimeSessionId === 'string'
    ) {
      runtimeSessionIds.add(
        assertManagedSessionStableId(
          route.runtimeSessionId,
          'background Runtime Session',
        ),
      );
    }
  }
  return runtimeSessionIds;
}

function isIgnorableReattachRejection(cause: unknown): boolean {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    [404, 409, 501, 503].includes(cause.status)
  );
}

function isUnmountedStageRoute(cause: unknown): boolean {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    (cause.status === 501 ||
      (cause.status === 404 &&
        !String(cause.code ?? '').startsWith('runtime_stage_')))
  );
}

/**
 * Phase 3b (§4.9): waits for in-flight pushes, then detaches each Runtime
 * Session's publisher through the Broker with the Harness's final applied
 * watermark. The Broker deletes staged rows up to that point in the same
 * transaction and the worker switches the run to held, so no separate
 * ack-then-detach race exists. A refused detach fails the teardown: the
 * admission check is what keeps an incapable worker out of this path.
 */
export async function detachBackgroundPublishers(
  input: BackgroundDeliveryRecoveryInput,
): Promise<void> {
  const publisher = input.lane.publisher;
  if (!publisher) return;
  await publisher.quiesce();
  const unsettled = new Set(
    collectKnownRuns(input.managed)
      .filter((run) => !run.settled)
      .map((run) => run.executionCallId),
  );
  if (unsettled.size === 0) return;
  const runtimeSessionIds = await resolveBackgroundRuntimeSessions(
    input.managed,
    unsettled,
  );
  if (runtimeSessionIds.size === 0) return;
  const writer = await input.writerOwner.owner();
  const appliedThrough = publisher.appliedWatermarks();
  const sessionKey = input.managed.authority.sessionHeader.sessionKey;
  for (const runtimeSessionId of runtimeSessionIds) {
    await new HostedWorkspaceBroker(
      input.brokerOptions,
      sessionKey,
      runtimeSessionId,
    ).detachPublisher(writer.writerGeneration, appliedThrough);
  }
}

/**
 * Phase 3b (§4.6): re-attaches the fresh Harness publisher on each Runtime
 * Session owning an unsettled background run, then drains and acknowledges
 * staged deliveries from the Broker while holding live worker pushes behind
 * the publisher's delivery gate.
 */
export async function reattachAndDrainBackgroundDeliveries(
  input: BackgroundDeliveryRecoveryInput,
): Promise<void> {
  const knownRuns = collectKnownRuns(input.managed);
  if (knownRuns.length === 0) return;

  const sessionKey = input.managed.authority.sessionHeader.sessionKey;
  const writer = await input.writerOwner.owner();
  const created = !input.lane.publisher;
  const publisher = (input.lane.publisher ??= new HostedShellPublisher(
    input.managed,
    input.lane.resources,
    input.lane.assertWritable,
    input.childRuns,
    input.monitors,
    () => input.lane.monitorWakeKick?.(),
  ));

  const releaseGate = publisher.holdDeliveries();
  try {
    for (const run of knownRuns) {
      publisher.restoreBackgroundCapture(
        run.executionCallId,
        run.domain,
        run.outputRef,
      );
    }

    const unsettledIds = new Set(
      knownRuns.filter((run) => !run.settled).map((run) => run.executionCallId),
    );
    const observedRuns: Record<string, number> = {};
    if (unsettledIds.size > 0) {
      const runtimeSessionIds = await resolveBackgroundRuntimeSessions(
        input.managed,
        unsettledIds,
      );
      if (runtimeSessionIds.size > 0) {
        const descriptor = await publisher.start();
        for (const runtimeSessionId of runtimeSessionIds) {
          const broker = new HostedWorkspaceBroker(
            input.brokerOptions,
            sessionKey,
            runtimeSessionId,
          );
          try {
            await broker.registerPublisher(descriptor, writer.writerGeneration);
            Object.assign(observedRuns, broker.observedRuns);
            // What dispatch records for a new run: only a worker that owns
            // the observation and still holds the run can answer its pull.
            if (broker.observationOwned) {
              for (const run of knownRuns) {
                if (
                  !run.settled &&
                  run.runtime &&
                  Object.hasOwn(broker.observedRuns, run.executionCallId)
                ) {
                  (input.lane.observationBindings ??= new Set()).add(
                    `${run.runtime.runtimeBindingId}@${run.runtime.generation}`,
                  );
                }
              }
            }
          } catch (cause) {
            if (!isIgnorableReattachRejection(cause)) {
              throw cause;
            }
          }
        }
      }
    }

    const stageBroker = new HostedWorkspaceBroker(
      input.brokerOptions,
      sessionKey,
      sessionKey.sessionId,
    );
    let staged: ManagedDeliveryEntry[];
    try {
      staged = await stageBroker.listStagedDeliveries(writer);
    } catch (cause) {
      if (isUnmountedStageRoute(cause)) {
        staged = [];
      } else {
        throw cause;
      }
    }
    if (staged.length > 0 || Object.keys(observedRuns).length > 0) {
      await publisher.applyStagedDeliveries(
        staged,
        observedRuns,
        (executionCallId, throughSeq) =>
          stageBroker.acknowledgeStagedDeliveries(
            writer,
            executionCallId,
            throughSeq,
          ),
      );
    }
  } catch (cause) {
    if (created) {
      // A failed load must not leak the listener this call started. Release
      // the gate first so close drains gated pushes instead of waiting on
      // them forever.
      releaseGate();
      await publisher.close();
      input.lane.publisher = undefined;
    }
    throw cause;
  } finally {
    releaseGate();
  }
}
