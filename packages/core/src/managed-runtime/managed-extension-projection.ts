/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedToolInvocationStatus } from '../tools/managed-tool-runtime.js';
import {
  isMonitorRunStart,
  isMonitorRunSuccessor,
  isTerminalRunState,
  parseMonitorRun,
  type ExtensionExecutionState,
  type ExtensionRun,
  type ExtensionRunState,
} from './managed-extension-record.js';
import {
  MANAGED_SESSION_ENVELOPE_DOMAINS,
  type ManagedSessionDomain,
} from './managed-session-records.js';
import {
  isMcpConfigurationStart,
  isMcpConfigurationSuccessor,
  isMcpOperationStart,
  isMcpOperationSuccessor,
  parseMcpConfiguration,
  parseMcpOperation,
} from './managed-mcp-record.js';
import {
  isHookRegistrationStart,
  isHookRegistrationSuccessor,
  isHookExecutionStart,
  isHookExecutionSuccessor,
  parseHookRegistration,
  parseHookExecution,
} from './managed-hook-record.js';
import {
  isChildRunStart,
  isChildRunSuccessor,
  parseChildRun,
  type AnyChildRun,
} from './managed-child-run-record.js';
import {
  isChannelDeliveryStart,
  isChannelDeliverySuccessor,
  isChannelRouteStart,
  isChannelRouteSuccessor,
  parseChannelDelivery,
  parseChannelRoute,
} from './managed-channel-record.js';
import {
  isAutomationRunStart,
  isAutomationRunSuccessor,
  isScheduleStart,
  isScheduleSuccessor,
  parseAutomationRunRecord,
  parseScheduleRecord,
} from './managed-automation-record.js';
import {
  isChildAcceptanceStart,
  isChildAcceptanceSuccessor,
  parseChildAcceptance,
} from './managed-child-acceptance-record.js';

// H0c of #12827: how the Session authority keys, chains and projects the
// Stage H records of managed-extension-record/1. The shared fixtures in
// contracts/managed-extension-projection-v1.fixtures.json pin it, and
// ManagedExtensionProjection in packages/sdk-java/managed-agent-server
// replays the same cases.

export const MANAGED_TASK_KINDS = [
  'child_agent',
  'workflow',
  'background_shell',
  'monitor',
  'automation_run',
] as const;
export const MANAGED_TASK_STATES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'degraded',
  'recovery_blocked',
] as const;
export const MANAGED_TASK_RUNTIME_STATES = [
  'unbound',
  'provisioning',
  'ready',
  'draining',
  'lost',
] as const;

export type ManagedTaskKind = (typeof MANAGED_TASK_KINDS)[number];
export type ManagedTaskState = (typeof MANAGED_TASK_STATES)[number];
export type ManagedTaskRuntimeState =
  (typeof MANAGED_TASK_RUNTIME_STATES)[number];

/**
 * A Stage H record body the authority can commit. `parse` returns the
 * identity that keys the record's revision chain and the run it embeds.
 * `taskKindOf` gives the task kind of one parsed record — a constant for
 * every body so far except `child_run`, whose kind follows the body's own
 * `kind` field — and null for a body that projects no task.
 */
export interface ManagedExtensionRecordBody {
  readonly taskKindOf: (record: unknown) => ManagedTaskKind | null;
  /** The parsed body is closed and frozen; the authority stores exactly it. */
  parse(value: unknown): {
    readonly record: unknown;
    readonly recordId: string;
    readonly run: ExtensionRun;
  };
  isStart(value: unknown): boolean;
  isSuccessor(previous: unknown, next: unknown): boolean;
}

/**
 * The record bodies defined so far. A domain joins when its slice defines
 * its body; enabling it for submission remains a separate step. A body
 * never joins a domain that is already enabled for envelope commits: the
 * envelopes `commitDomainRecord` wrote for it predate the body, and every
 * closed body rejects their keys.
 */
export const MANAGED_EXTENSION_RECORD_BODIES: Readonly<
  Partial<Record<ManagedSessionDomain, ManagedExtensionRecordBody>>
> = Object.freeze({
  mcp_configuration: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseMcpConfiguration(value);
      return { record, recordId: record.configurationId, run: record.run };
    },
    isStart: isMcpConfigurationStart,
    isSuccessor: isMcpConfigurationSuccessor,
  }),
  mcp_operation: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseMcpOperation(value);
      return { record, recordId: record.operationId, run: record.run };
    },
    isStart: isMcpOperationStart,
    isSuccessor: isMcpOperationSuccessor,
  }),
  hook_registration: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseHookRegistration(value);
      return { record, recordId: record.registrationId, run: record.run };
    },
    isStart: isHookRegistrationStart,
    isSuccessor: isHookRegistrationSuccessor,
  }),
  hook_execution: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseHookExecution(value);
      return { record, recordId: record.hookExecutionId, run: record.run };
    },
    isStart: isHookExecutionStart,
    isSuccessor: isHookExecutionSuccessor,
  }),
  monitor_run: Object.freeze({
    taskKindOf: () => 'monitor',
    parse: (value: unknown) => {
      const monitor = parseMonitorRun(value);
      return { record: monitor, recordId: monitor.monitorId, run: monitor.run };
    },
    isStart: isMonitorRunStart,
    isSuccessor: isMonitorRunSuccessor,
  }),
  child_run: Object.freeze({
    taskKindOf: (record: unknown) =>
      (record as AnyChildRun).kind === 'shell'
        ? 'background_shell'
        : 'child_agent',
    parse: (value: unknown) => {
      const record = parseChildRun(value);
      return {
        record,
        recordId: record.kind === 'shell' ? record.shellId : record.childRunId,
        run: record.run,
      };
    },
    isStart: isChildRunStart,
    isSuccessor: isChildRunSuccessor,
  }),
  channel_route: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseChannelRoute(value);
      return { record, recordId: record.routeId, run: record.run };
    },
    isStart: isChannelRouteStart,
    isSuccessor: isChannelRouteSuccessor,
  }),
  channel_delivery: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseChannelDelivery(value);
      return { record, recordId: record.deliveryId, run: record.run };
    },
    isStart: isChannelDeliveryStart,
    isSuccessor: isChannelDeliverySuccessor,
  }),
  child_acceptance: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseChildAcceptance(value);
      return { record, recordId: record.childRunId, run: record.run };
    },
    isStart: isChildAcceptanceStart,
    isSuccessor: isChildAcceptanceSuccessor,
  }),
  schedule: Object.freeze({
    taskKindOf: () => null,
    parse: (value: unknown) => {
      const record = parseScheduleRecord(value);
      return { record, recordId: record.scheduleId, run: record.run };
    },
    isStart: isScheduleStart,
    isSuccessor: isScheduleSuccessor,
  }),
  automation_run: Object.freeze({
    taskKindOf: () => 'automation_run',
    parse: (value: unknown) => {
      const record = parseAutomationRunRecord(value);
      return { record, recordId: record.automationRunId, run: record.run };
    },
    isStart: isAutomationRunStart,
    isSuccessor: isAutomationRunSuccessor,
  }),
});

// An envelope domain's commits predates any body a later slice could
// register, and every closed body would reject them; refuse the collision
// at build time rather than at the Sessions' next open.
const envelopeBodyCollision = Object.keys(
  MANAGED_EXTENSION_RECORD_BODIES,
).filter((domain) =>
  (MANAGED_SESSION_ENVELOPE_DOMAINS as readonly string[]).includes(domain),
);
if (envelopeBodyCollision.length > 0) {
  throw new Error(
    `record bodies stay out of the envelope domains: ${envelopeBodyCollision.join(', ')}`,
  );
}

/**
 * The key of one record's revision chain: SHA-256 over the Session ID, the
 * domain and the record's own identity, joined by NUL. The task ID is the
 * same key with a `task_` prefix, so both sides derive it without a lookup.
 */
export function managedExtensionRecordKey(
  sessionId: string,
  domain: ManagedSessionDomain,
  recordId: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}\u0000${domain}\u0000${recordId}`, 'utf8')
    .digest('hex');
}

export function managedTaskId(recordKey: string): string {
  return `task_${recordKey}`;
}

/** The part of `SessionTaskView` that the record revisions determine. */
export interface ManagedTaskProjection {
  readonly state: ManagedTaskState;
  readonly runtimeState: ManagedTaskRuntimeState | null;
  readonly definitionRevision: number | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
}

/** `SessionTaskView` without the fields no H0c record produces yet. */
export interface ManagedSessionTaskView extends ManagedTaskProjection {
  readonly taskId: string;
  readonly sessionId: string;
  readonly kind: ManagedTaskKind;
}

/**
 * Run states that mean the work began. A blocked run may still prove that it
 * never started, so it sets no start of its own.
 */
const STARTED: readonly ExtensionRunState[] = ['running', 'waiting', 'settled'];
/** Delivery states that still need the dispatcher: to send, or to find out. */
const PENDING_DELIVERY = new Set([
  'planned',
  'sending',
  'partial',
  'accepting',
  'unknown',
]);

function taskState(run: ExtensionRun): ManagedTaskState {
  switch (run.state) {
    case 'reserved':
    case 'admitted':
      return 'pending';
    case 'running':
    case 'waiting':
      // Only a recovery reason fits these states: the run goes on degraded.
      return run.reason === null ? run.state : 'degraded';
    case 'settled':
      return 'completed';
    default:
      return run.state;
  }
}

function runtimeState(
  run: ExtensionRun,
  stopRequested: boolean,
): ManagedTaskRuntimeState | null {
  if (isTerminalRunState(run.state) || run.execution === null) return null;
  if (run.runtime === null) return 'unbound';
  if (run.execution === 'running_attached') {
    return stopRequested ? 'draining' : 'ready';
  }
  if (run.reason === 'runtime_lost') return 'lost';
  if (run.execution === 'intent' || run.execution === 'dispatch_started') {
    return stopRequested ? 'draining' : 'provisioning';
  }
  return null;
}

/**
 * The task view after one more committed revision of its record, from the
 * view before it (null for the first revision), the revision's run and the
 * time its `domain.committed` event occurred. The times come from the
 * journal, so a rebuild yields the same view; a writer's clock may run
 * behind the one before it, so a time never precedes an earlier one. A
 * stop-requested record whose run is attached (`running_attached`) or
 * still provisioning (`intent`/`dispatch_started`) projects its Runtime as
 * `draining`; a lost, terminal or unbound row keeps its own Runtime state
 * (H3's `child_run`; every earlier record passes false).
 */
export function projectManagedTask(
  previous: ManagedTaskProjection | null,
  run: ExtensionRun,
  occurredAt: number,
  stopRequested = false,
): ManagedTaskProjection {
  const createdAt = previous?.createdAt ?? occurredAt;
  const startedAt =
    previous?.startedAt ??
    (STARTED.includes(run.state) ? Math.max(occurredAt, createdAt) : null);
  const settledAt =
    previous?.settledAt ??
    (isTerminalRunState(run.state)
      ? Math.max(occurredAt, startedAt ?? createdAt)
      : null);
  return Object.freeze({
    state: taskState(run),
    runtimeState: runtimeState(run, stopRequested),
    definitionRevision: run.definition?.definitionRevision ?? null,
    createdAt,
    startedAt,
    settledAt,
  });
}

/** Whether the run's delivery is in the outbox: still to send or reconcile. */
export function isExtensionDeliveryPending(run: ExtensionRun): boolean {
  return run.delivery !== null && PENDING_DELIVERY.has(run.delivery.state);
}

/** What the Broker reports for one tool execution, as the Harness sees it. */
export type ManagedRuntimeExecutionView =
  | {
      readonly outcome: 'known';
      readonly status: Pick<ManagedToolInvocationStatus, 'state' | 'result'>;
    }
  | { readonly outcome: 'unknown' };

/**
 * The physical execution state a Broker report proves. The wire folds a
 * claimed but unsent dispatch into `executing`, so this side reads it as
 * dispatched: taking a call that may have been sent for an unsent one could
 * run it twice, while the reverse still ends in a proof either way.
 */
export function extensionExecutionOf(
  view: ManagedRuntimeExecutionView,
): ExtensionExecutionState {
  if (view.outcome === 'unknown') return 'outcome_unknown';
  switch (view.status.state) {
    case 'prepared':
      return 'intent';
    case 'executing':
    case 'cancel_requested':
      return 'dispatch_started';
    case 'settled':
      return view.status.result?.executionStatus === 'not_started'
        ? 'not_started_proven'
        : 'settled';
    default: {
      const exhaustive: never = view.status.state;
      return exhaustive;
    }
  }
}
