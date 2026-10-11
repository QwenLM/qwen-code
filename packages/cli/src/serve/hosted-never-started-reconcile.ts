/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseChildShellRun,
  type ChildRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import type { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import {
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import type { HostedChildRunSession } from './hosted-child-run-session.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

// Issue #13801 (finding A3 of the #13532 acceptance): a `child_run`
// record whose dispatch was claimed can stay `dispatch_started` forever
// — no in-turn arm survives the daemon that claimed it. The physical
// proof of "never started" is definitive: the `:process` ledger row is
// admitted at execute-admission, strictly before the dispatch begins, so
// its durable absence (HTTP 404, and only that) means no dispatch ever
// happened and no process or cgroup unit could exist. Anything else
// (row present, unknown outcome, Broker unreachable) is ambiguous and
// the record must stay as-is. Reload-only; ambiguity is never widened
// into a proven answer.

export interface NeverStartedReconcileResult {
  readonly scanned: number;
  readonly settled: readonly string[];
  readonly skipped: readonly string[];
}

function asDurableRef(value: unknown): ManagedSessionDurableRef | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const ref = value as Record<string, unknown>;
  return typeof ref['resourceId'] === 'string' &&
    typeof ref['kind'] === 'string' &&
    typeof ref['schemaVersion'] === 'number' &&
    typeof ref['byteLength'] === 'number' &&
    typeof ref['digest'] === 'string'
    ? (value as ManagedSessionDurableRef)
    : undefined;
}

async function runtimeSessionIdOfRoute(
  resources: { read(ref: ManagedSessionDurableRef): Promise<Buffer> },
  routeRef: ManagedSessionDurableRef,
  harnessSessionId: string,
): Promise<string | undefined> {
  if (routeRef.kind !== 'managed-tool-input') return undefined;
  const route = JSON.parse(
    (await resources.read(routeRef)).toString('utf8'),
  ) as { harnessSessionId?: unknown; runtimeSessionId?: unknown };
  if (
    route.harnessSessionId !== harnessSessionId ||
    typeof route.runtimeSessionId !== 'string'
  )
    return undefined;
  return assertManagedSessionStableId(
    route.runtimeSessionId,
    'recovered Runtime owner',
  );
}

export async function reconcileNeverStartedChildRuns(input: {
  readonly authority: LocalManagedSessionAuthority;
  readonly resources: {
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
  readonly childRuns: HostedChildRunSession;
  readonly brokerOptions: HostedWorkspaceBrokerOptions;
}): Promise<NeverStartedReconcileResult> {
  const sessionKey: ManagedSessionKey =
    input.authority.sessionHeader.sessionKey;
  const candidates: ChildRun[] = [];
  for (const entry of input.authority.extensionRecordsInDomain('child_run')) {
    const body = entry.record;
    if (
      body === null ||
      typeof body !== 'object' ||
      (body as Record<string, unknown>)['kind'] !== 'shell'
    )
      continue;
    const record = parseChildShellRun(body);
    if (record.stopRequested) continue;
    if (record.run.execution !== 'dispatch_started') continue;
    candidates.push(record);
  }
  if (candidates.length === 0) {
    return { scanned: 0, settled: [], skipped: [] };
  }
  // Every tool.intent pins the runtime-session identity its execution was
  // claimed under, so a stranded record can rebuild its own Broker probe
  // without trusting an in-memory horror.
  const intents = new Map<string, ManagedSessionDurableRef>();
  for (const event of input.authority.eventsInSequenceRange(
    1,
    input.authority.committedSequence,
  )) {
    if (event.kind !== 'tool.intent') continue;
    const executionCallId = event.payload['executionCallId'];
    if (typeof executionCallId !== 'string') continue;
    const argsRef = asDurableRef(event.payload['argsRef']);
    if (argsRef !== undefined) {
      intents.set(executionCallId, argsRef);
    }
  }
  const settled: string[] = [];
  const skipped: string[] = [];
  const groups = new Map<string, ChildRun[]>();
  for (const record of candidates) {
    const executionCallId = record.run.executionCallId ?? record.shellId;
    let runtimeSessionId: string | undefined;
    try {
      const routeRef = intents.get(executionCallId);
      runtimeSessionId =
        routeRef === undefined
          ? undefined
          : await runtimeSessionIdOfRoute(
              input.resources,
              routeRef,
              sessionKey.sessionId,
            );
    } catch {
      runtimeSessionId = undefined;
    }
    if (runtimeSessionId === undefined) {
      skipped.push(record.shellId);
      continue;
    }
    const group = groups.get(runtimeSessionId);
    if (group === undefined) {
      groups.set(runtimeSessionId, [record]);
    } else {
      group.push(record);
    }
  }
  for (const [runtimeSessionId, group] of groups) {
    const broker = new HostedWorkspaceBroker(
      input.brokerOptions,
      sessionKey,
      runtimeSessionId,
    );
    // Session liveness never moves this proof either way: the Broker's
    // durable execution lookup (`requireOwnedExecution`) runs by id before
    // any Session-lifecycle requirement, so a missing `:process` row
    // answers 404 even after the original runtime was RELEASED (turn
    // cancellation settles the turn and releases the Session without
    // settling these records), where a mandatory re-acquire would wedge
    // forever on `runtime_session_not_acquirable` instead. No acquire:
    // the proof never needs one.
    for (const record of group) {
      const executionCallId = record.run.executionCallId ?? record.shellId;
      let answer: { state: string } | undefined;
      try {
        answer = await broker.status(`${executionCallId}:process`);
      } catch {
        skipped.push(record.shellId);
        continue;
      }
      if (answer !== undefined) {
        skipped.push(record.shellId);
        continue;
      }
      await input.childRuns.settleFailed(record.shellId, {
        stopReason: 'start_failed',
        started: false,
      });
      settled.push(record.shellId);
    }
  }
  if (skipped.length > 0) {
    writeStderrLineSafe(
      `qwen serve: ${skipped.length} stranded child run(s) stayed ` +
        `unsettled on reload (not proven never-started): ${skipped.join(', ')}.`,
    );
  }
  if (settled.length > 0) {
    writeStderrLineSafe(
      `qwen serve: settled ${settled.length} stranded child run(s) as ` +
        `never-started on reload: ${settled.join(', ')}.`,
    );
  }
  return { scanned: candidates.length, settled, skipped };
}
