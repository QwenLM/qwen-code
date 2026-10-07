/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_EXTENSION_DELIVERY_TARGETS,
  MANAGED_EXTENSION_STATE_LINES,
  isExtensionRunStart,
  isExtensionRunSuccessor,
  isMonitorRunStart,
  parseExtensionRun,
} from './managed-extension-record.js';
import {
  MANAGED_EXTENSION_RECORD_BODIES,
  MANAGED_TASK_KINDS,
  MANAGED_TASK_RUNTIME_STATES,
  MANAGED_TASK_STATES,
  extensionExecutionOf,
  isExtensionDeliveryPending,
  managedExtensionRecordKey,
  managedTaskId,
  projectManagedTask,
  type ManagedRuntimeExecutionView,
  type ManagedTaskProjection,
} from './managed-extension-projection.js';
import {
  MANAGED_SESSION_ENABLED_DOMAINS,
  MANAGED_SESSION_ENVELOPE_DOMAINS,
  type ManagedSessionDomain,
} from './managed-session-records.js';

interface Revision {
  readonly occurredAt: number;
  readonly run: unknown;
  readonly view: ManagedTaskProjection;
  readonly deliveryPending: boolean;
  readonly stopRequested?: boolean;
}

interface FixtureSuite {
  readonly contractVersion: 1;
  // child_run's entry is the per-kind map the body dispatches on.
  readonly recordBodies: Record<
    string,
    string | null | Record<string, string | null>
  >;
  /** The bodies H6 added to the projection contract after H4. */
  readonly additionalRecordBodies: Record<string, string | null>;
  readonly taskStates: readonly string[];
  readonly pendingDeliveryStates: readonly string[];
  readonly runtimeStates: readonly string[];
  readonly taskKinds: readonly string[];
  readonly taskIdCases: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly domain: ManagedSessionDomain;
    readonly recordId: string;
    readonly recordKey: string;
    readonly taskId: string;
  }>;
  readonly runStartCases: ReadonlyArray<{
    readonly id: string;
    readonly valid: boolean;
    readonly run: unknown;
  }>;
  readonly monitorRunStartCases: ReadonlyArray<{
    readonly id: string;
    readonly valid: boolean;
    readonly monitorRun: unknown;
  }>;
  readonly viewCases: ReadonlyArray<
    { readonly id: string } & Omit<Revision, 'view'> & {
        readonly view: ManagedTaskProjection;
      }
  >;
  readonly historyCases: ReadonlyArray<{
    readonly id: string;
    readonly revisions: readonly Revision[];
  }>;
  readonly brokerExecutionCases: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly executionStatus: string | null;
    readonly dispatchGeneration: number;
    readonly execution: string;
    readonly inspection: ManagedRuntimeExecutionView;
    readonly harnessExecution: string;
  }>;
}

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-extension-projection-v1.fixtures.json',
    ),
    'utf8',
  ),
) as FixtureSuite;

describe('managed-extension-projection/1 fixtures', () => {
  it('pins the record bodies, task states and outbox states', () => {
    expect(fixtures.contractVersion).toBe(1);
    expect(
      Object.fromEntries(
        Object.entries(MANAGED_EXTENSION_RECORD_BODIES).map(
          ([domain, body]) => [
            domain,
            // child_run's task kind follows the body's own kind; every other
            // body is a constant or projects no task at all. The probing
            // record carries managed identity field names, so a mapping
            // that regressed into reading one cannot answer constant-by-luck.
            domain === 'child_run'
              ? {
                  shell: body?.taskKindOf({ kind: 'shell' }),
                  child_agent: body?.taskKindOf({ kind: 'child_agent' }),
                }
              : body?.taskKindOf({
                  configurationId: 'probe',
                  registrationId: 'probe',
                  occurrenceId: 'probe',
                  serverId: 'probe',
                }),
          ],
        ),
      ),
    ).toEqual({
      ...fixtures.recordBodies,
      ...fixtures.additionalRecordBodies,
    });
    expect([...MANAGED_TASK_STATES]).toEqual(fixtures.taskStates);
    expect([...MANAGED_TASK_RUNTIME_STATES].sort()).toEqual(
      fixtures.runtimeStates,
    );
    expect([...MANAGED_TASK_KINDS].sort()).toEqual(fixtures.taskKinds);
    const pending = new Set<string>();
    for (const [target, states] of Object.entries(
      MANAGED_EXTENSION_DELIVERY_TARGETS,
    )) {
      for (const state of states) {
        const run = parseExtensionRun({
          state: 'settled',
          reason: null,
          definition: null,
          executionCallId: null,
          effectId: null,
          dispatchId: null,
          deliveryId: target === 'channel' ? 'delivery-1' : null,
          execution: null,
          runtime: null,
          delivery: { target, state },
        });
        if (isExtensionDeliveryPending(run)) pending.add(state);
      }
    }
    expect([...pending].sort()).toEqual(fixtures.pendingDeliveryStates);
  });

  it('partitions the enabled domains between the bodies and the envelope list', () => {
    // Every enabled domain commits either through the envelope path (the
    // list) or through a Stage H body. monitor_run's body is registered
    // while its domain stays disabled, so the partition is over the
    // enabled names only.
    const bodied = new Set(Object.keys(MANAGED_EXTENSION_RECORD_BODIES));
    expect(
      MANAGED_SESSION_ENABLED_DOMAINS.filter((domain) => !bodied.has(domain)),
    ).toEqual(MANAGED_SESSION_ENVELOPE_DOMAINS);
  });

  it('refuses to load over a body registered for an envelope domain', async () => {
    // The tripwire runs once, at module load, over the real registry, so
    // the test rebuilds the module graph around a registry whose envelope
    // list names a body-bearing domain.
    vi.resetModules();
    vi.doMock('./managed-session-records.js', async () => {
      const actual = await vi.importActual<
        typeof import('./managed-session-records.js')
      >('./managed-session-records.js');
      return {
        ...actual,
        MANAGED_SESSION_ENVELOPE_DOMAINS: [
          ...actual.MANAGED_SESSION_ENVELOPE_DOMAINS,
          'monitor_run',
        ],
      };
    });
    try {
      await expect(import('./managed-extension-projection.js')).rejects.toThrow(
        /stay out of the envelope/,
      );
    } finally {
      vi.doUnmock('./managed-session-records.js');
      vi.resetModules();
    }
  });

  it('keeps every case id unique', () => {
    const lists = Object.entries(fixtures).filter(([name]) =>
      name.endsWith('Cases'),
    );
    // The name set pins the lists the fixture must carry, so deleting one
    // or adding another is loud, and no replayed list may be empty (an
    // it.each over an empty list registers zero tests).
    expect(lists.map(([name]) => name).sort()).toEqual([
      'brokerExecutionCases',
      'historyCases',
      'monitorChainCases',
      'monitorChainRejectCases',
      'monitorRunStartCases',
      'runStartCases',
      'taskIdCases',
      'viewCases',
    ]);
    for (const [, list] of lists) {
      const cases = list as ReadonlyArray<{ readonly id: string }>;
      expect(cases.length).toBeGreaterThan(0);
      const ids = cases.map((each) => each.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it.each(fixtures.taskIdCases)('derives the task id: $id', (each) => {
    const key = managedExtensionRecordKey(
      each.sessionId,
      each.domain,
      each.recordId,
    );
    expect(key).toBe(each.recordKey);
    expect(managedTaskId(key)).toBe(each.taskId);
  });

  it.each(fixtures.runStartCases)('judges a run start: $id', (each) => {
    expect(isExtensionRunStart(each.run)).toBe(each.valid);
  });

  it.each(fixtures.monitorRunStartCases)(
    'judges a monitor start: $id',
    (each) => {
      expect(isMonitorRunStart(each.monitorRun)).toBe(each.valid);
      expect(
        MANAGED_EXTENSION_RECORD_BODIES.monitor_run?.isStart(each.monitorRun),
      ).toBe(each.valid);
    },
  );

  it.each(fixtures.viewCases)('projects one revision: $id', (each) => {
    const run = parseExtensionRun(each.run);
    expect(
      projectManagedTask(
        null,
        run,
        each.occurredAt,
        each.stopRequested ?? false,
      ),
    ).toEqual(each.view);
    expect(isExtensionDeliveryPending(run)).toBe(each.deliveryPending);
  });

  it('settles and unbinds every run state whose line ends', () => {
    // The projection's terminal set is the run line's own: a run state
    // whose successors are empty must stamp `settledAt` and no runtime.
    // The execution proven to have ended carries the state, so only the
    // terminality of the line itself can force the runtime out — without
    // it the assertion short-circuits on `execution === null`.
    for (const [state, successors] of Object.entries(
      MANAGED_EXTENSION_STATE_LINES.run.transitions,
    )) {
      if (successors.length > 0) continue;
      const run = parseExtensionRun({
        state,
        reason: null,
        definition: null,
        executionCallId: 'call-1',
        effectId: null,
        dispatchId: null,
        deliveryId: null,
        execution: 'settled',
        runtime: null,
        delivery: null,
      });
      const view = projectManagedTask(null, run, 1_000);
      expect(view.settledAt).not.toBeNull();
      expect(view.runtimeState).toBeNull();
    }
  });

  it.each(fixtures.historyCases)('projects a history: $id', (each) => {
    const [first, ...later] = each.revisions;
    expect(isExtensionRunStart(first.run)).toBe(true);
    // The projection adds or drops no field: its own record components.
    const VIEW_KEYS = [
      'createdAt',
      'definitionRevision',
      'runtimeState',
      'settledAt',
      'startedAt',
      'state',
    ] as const;
    let previous: ManagedTaskProjection | null = null;
    let previousRun: unknown = null;
    for (const revision of [first, ...later]) {
      if (previousRun !== null) {
        expect(isExtensionRunSuccessor(previousRun, revision.run)).toBe(true);
      }
      const run = parseExtensionRun(revision.run);
      expect(Object.keys(revision.view).sort()).toEqual([...VIEW_KEYS]);
      const view = projectManagedTask(previous, run, revision.occurredAt);
      expect(view).toEqual(revision.view);
      expect(isExtensionDeliveryPending(run)).toBe(revision.deliveryPending);
      previous = view;
      previousRun = revision.run;
    }
  });

  // Java maps the Broker state; the Harness sees only what the Broker's HTTP
  // API reports for it, which the Broker's own contract test pins to these
  // cases.
  it.each(fixtures.brokerExecutionCases)(
    'reads what the Broker reports for a $id execution',
    (each) => {
      expect(extensionExecutionOf(each.inspection)).toBe(each.harnessExecution);
    },
  );

  // The wire folds a claimed but unsent dispatch into `executing` and
  // carries no dispatch generation, so the record reading of Java diverges
  // from the wire reading in exactly these two cases.
  it('reads the Broker as Java does except where the wire hides a claim or a generation', () => {
    expect(
      fixtures.brokerExecutionCases
        .filter((each) => each.harnessExecution !== each.execution)
        .map((each) => each.id),
    ).toEqual(['dispatching', 'settled-cancelled-unclaimed']);
  });
});
