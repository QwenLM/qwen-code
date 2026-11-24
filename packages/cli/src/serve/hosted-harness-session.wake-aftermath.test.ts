/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BOOT_ID,
  SESSION_ID,
  app,
  headers,
  settleTimeoutMs,
  state,
  store,
  useHostedTextSession,
} from './hosted-harness-session.test-helper.js';
import {
  AUTOMATION_ID,
  AUTOMATION_SLOT,
  capturedWakeSession,
  fireBody,
  mockRepairBroker,
  prewriteAutomationCrashedTurnSession,
  prewriteAutomationParkedWakeSession,
  prewriteAutomationSession,
} from './hosted-harness-session-wake.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { settleCrashedWakeTurnAftermath } from './hosted-harness-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { hostedRuntimeSessionId } from './hosted-workspace-tool-turn.js';
import { HostedAutomationSession } from './hosted-automation-session.js';
import { automationRunId } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { HostedMonitorWakeScheduler } from './hosted-monitor-wake.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedTeamSession } from './hosted-team-session.js';

describe('Hosted Harness no-tool session', () => {
  useHostedTextSession();

  it('registers a wake Runtime a background run still holds, for the close drain (#13856 R1-28)', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      // The wake turn started a background Shell that still holds its Runtime,
      // so the routine release refuses `runtime_session_held`. The aftermath
      // must read that as the designed hold — register it for the close's
      // drain and keep settling — never drain (that would stop a run the user
      // meant to keep), and never wedge the Session on the refusal.
      const repair = mockRepairBroker();
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockImplementation(
        () =>
          Promise.reject(
            new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
          ),
      );
      repair.unlatch();
      const heldRuntimeTurns = new Set<string>();
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
        heldRuntimeTurns,
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://127.0.0.1:8080' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      expect(heldRuntimeTurns.has(inputId)).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  // H4e-b1: a wake Turn that died after a team call committed and before
  // its tool_result landed: the aftermath answers it from its record before
  // the Turn settles, so the next Turn's model is never told to retry it.
  it('answers a committed team call of a crashed wake Turn from its record', async () => {
    const inputId = await prewriteAutomationCrashedTurnSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      await managed.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: state.root,
        version: 'hosted-harness/1',
        daemonPromptId: inputId,
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'team_create',
                args: { team_name: 'review' },
              },
            },
          ],
        },
      });
      const teams = new HostedTeamSession(
        { authority: managed.authority, resources: managed.resources },
        key,
        new HostedChildAgentSession(
          { authority: managed.authority, resources: managed.resources },
          key,
        ),
      );
      await teams.run(
        'team_create',
        { team_name: 'review' },
        `${inputId}:call-1`,
      );
      const session = {
        managed,
        teams,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      expect(
        await settleCrashedWakeTurnAftermath({
          session,
          sessionId: SESSION_ID,
          cwd: state.root,
          brokerOptions: undefined,
          turnId: inputId,
        }),
      ).toBe('settled');
      const answer = (await managed.sink.project())
        .filter(
          (record) =>
            record.daemonPromptId === inputId && record.type === 'tool_result',
        )
        .flatMap((record) => record.message?.parts ?? [])
        .find((part) => part.functionResponse?.id === 'call-1');
      expect(JSON.stringify(answer?.functionResponse?.response)).toContain(
        'committed its team change',
      );
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('settles the journal side of a deterministically declined wake park and still unblocks', async () => {
    // A shell tool on a hooks-defined Session: the recovery machinery
    // reads the decline deterministically, so the session must not wedge
    // in a permanent retry loop — the journal side settles anyway (lane
    // B audit round 1).
    const inputId =
      await prewriteAutomationParkedWakeSession('run_shell_command');
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://broker' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      const automations = new HostedAutomationSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        key,
      );
      const run = automations
        .runs()
        .find((each) => each.occurrenceKey === AUTOMATION_SLOT);
      expect(run?.run.state).toBe('failed');
      expect(run?.run.execution).toBe('outcome_unknown');
      const checkpoint =
        await createManagedHarnessHandle(managed).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
      const projected = await managed.sink.project();
      expect(
        projected.filter(
          (entry) =>
            entry.type === 'tool_result' &&
            entry.daemonPromptId === inputId &&
            (entry.message?.parts ?? []).some(
              (part) =>
                part.functionResponse?.response?.['executionStatus'] ===
                'cancelled',
            ),
        ),
      ).toHaveLength(1);
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('keeps a wake park pending when its checkpoint read was erased, settling nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      // The checkpoint read blipped: a `missing_state` verdict WITH its
      // message, erasure that proves nothing. Settling over it would skip
      // the stop/release but still consume the input, closing every
      // retry channel the park has.
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockResolvedValue({
        status: 'blocked',
        reason: 'missing_state',
        message: 'managed session store answered 503',
      } as never);
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: '', baseUrl: 'http://broker' } as never,
        turnId: inputId,
      });
      expect(aftermath).toBe('pending');
      // Nothing consumed, nothing settled: every retry channel still
      // sees the park.
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'input.accepted' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(false);
      expect(
        (await managed.sink.project()).filter(
          (entry) =>
            entry.daemonPromptId === inputId && entry.type === 'tool_result',
        ),
      ).toHaveLength(0);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('journals a Broker-fenced wake park as unobserved, never a witnessed cancellation', async () => {
    // R10-1: the aftermath's stop counts the fenced execution into the
    // unobserved carry, and the settle must receive it — otherwise the
    // reclaimed record certifies a cancellation nobody observed.
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockResolvedValue({
        state: 'abandoned',
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(aftermath).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('unknown');
      expect(String(response?.['error'])).toContain('could not be observed');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('keeps a crashed wake turn unsettled while its settle cannot verify the park', async () => {
    // R11-1: the stop proves cleanly, but the settle's own authorization
    // re-read faults transiently — a retry-inviting refusal the aftermath
    // must answer 'pending' with, never a terminal record over parked
    // executions the settle journaled nothing for.
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // The aftermath's own read and the stop's read pass; every read
      // behind the stop's first Broker poll — the settle's own re-read —
      // faults into an erased verdict.
      let blockSettleReads = false;
      const original =
        LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        if (blockSettleReads)
          return {
            status: 'blocked',
            reason: 'missing_state',
            message: 'Session Store answered 503',
          } as never;
        return original.call(this);
      });
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => {
          blockSettleReads = true;
          return { state: 'settled' } as never;
        },
      );
      const release = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'release')
        .mockResolvedValue();
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const aftermath = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(aftermath).toBe('pending');
      // No terminal record over a park the settle could not verify, and
      // the lease stays for the retry that can.
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(false);
      expect(release).not.toHaveBeenCalled();
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('carries an unobserved stop across aftermath retries, never certifying it witnessed', async () => {
    // R10-1: a stop that throws after counting the fenced execution must
    // hand the id to the pump's retry — the reclaimed record reads as
    // already-stopped there, and a fresh per-pass carry would let the
    // settle journal a cancellation nobody witnessed.
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // Pass 1's pre-cancel read faults after the id is counted; by pass 2
      // the Broker has reclaimed the record, which is no witness.
      let statusCalls = 0;
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        async () => {
          statusCalls += 1;
          if (statusCalls === 1)
            throw new TypeError('Runtime Broker status lost to a 503');
          return undefined as never;
        },
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const first = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(first).toBe('pending');
      const second = await settleCrashedWakeTurnAftermath({
        session,
        sessionId: SESSION_ID,
        cwd: state.root,
        brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
        turnId: inputId,
      });
      expect(second).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('unknown');
      expect(String(response?.['error'])).toContain('could not be observed');
      // The durable settle discharged the carry; it must not outlive the
      // Turn.
      const carried = (
        session as unknown as { recoveryUnobserved?: Map<string, Set<string>> }
      ).recoveryUnobserved;
      expect(carried?.has(inputId) ?? false).toBe(false);
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('forgets a carried id a later pass positively witnesses settled', async () => {
    // R10-1 (round 12): the carry write-back must delete a pruned-to-empty
    // entry — an upsert-only write leaves the previous pass's stale set
    // behind, and the next pass journals a positively witnessed stop as
    // unobservable.
    const inputId = await prewriteAutomationParkedWakeSession();
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const managed = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        async function (this: HostedWorkspaceBroker) {
          this.runtime = {
            bindingId: 'binding',
            generation: '1',
            workspaceGeneration: '1',
          };
        },
      );
      // Pass 1 faults the pre-cancel read, counting the id; pass 2
      // positively witnesses the stop (pruning the carry empty) but its
      // settle cannot verify the park; pass 3 reads the reclaimed record.
      let blockSettleReads = false;
      const reads: Array<() => Promise<{ state: string } | undefined>> = [
        () =>
          Promise.reject(new TypeError('Runtime Broker status lost to a 503')),
        () => {
          blockSettleReads = true;
          return Promise.resolve({ state: 'settled' });
        },
        () => Promise.resolve(undefined),
      ];
      vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
        () => (reads.shift() ?? (() => Promise.resolve(undefined)))() as never,
      );
      vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
      const original =
        LocalManagedSessionAuthority.prototype.harnessRunAuthorization;
      vi.spyOn(
        LocalManagedSessionAuthority.prototype,
        'harnessRunAuthorization',
      ).mockImplementation(async function (this: LocalManagedSessionAuthority) {
        if (blockSettleReads)
          return {
            status: 'blocked',
            reason: 'missing_state',
            message: 'Session Store answered 503',
          } as never;
        return original.call(this);
      });
      const session = {
        managed,
        automations: new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          key,
        ),
      } as never;
      const drive = () =>
        settleCrashedWakeTurnAftermath({
          session,
          sessionId: SESSION_ID,
          cwd: state.root,
          brokerOptions: { token: 'test', baseUrl: 'http://127.0.0.1:1' },
          turnId: inputId,
        });
      const carry = () =>
        (
          session as unknown as {
            recoveryUnobserved?: Map<string, Set<string>>;
          }
        ).recoveryUnobserved;
      expect(await drive()).toBe('pending');
      expect([...(carry()?.get(inputId) ?? [])]).toEqual(['ex-wake-1']);
      expect(await drive()).toBe('pending');
      // The positive witness pruned the carry; the session entry must be
      // gone with it — an upsert-only write-back keeps the stale id.
      expect(carry()?.has(inputId) ?? false).toBe(false);
      blockSettleReads = false;
      expect(await drive()).toBe('settled');
      const toolResults = (await managed.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === inputId && entry.type === 'tool_result',
      );
      expect(toolResults).toHaveLength(1);
      const response = toolResults[0]?.message?.parts?.[0]?.functionResponse
        ?.response as Record<string, unknown> | undefined;
      expect(response?.['executionStatus']).toBe('cancelled');
      expect(String(response?.['error'])).toContain('cancelled with its owner');
    } finally {
      await managed.close().catch(() => undefined);
    }
  });

  it('refuses a prompt retriably when the wake park probe read nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    const kick = vi
      .spyOn(HostedMonitorWakeScheduler.prototype, 'kick')
      .mockImplementation(() => {});
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    // Only the route's checkpoint probe takes this spy: an erased verdict
    // must not answer "no park" over state nobody read.
    const checkpointRead = vi
      .spyOn(LocalManagedSessionAuthority.prototype, 'harnessRunAuthorization')
      .mockResolvedValue({
        status: 'blocked',
        reason: 'missing_state',
        message: 'managed session store answered 503',
      } as never);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const prompt = [{ type: 'text', text: 'hello' }];
    const payloadDigest = `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`;
    const refused = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/prompt`),
    ).send({
      prompt,
      promptId: randomUUID(),
      payloadDigest,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hosted_turn_recovery_in_progress');
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['source'] === 'hosted-harness',
      ),
    ).toBe(false);
    repair.unlatch();
    // Drain the parked settle before teardown: an unsettled park keeps the
    // wake pump retrying past this test's end, and its settle failures land
    // in later tests' stderr spies. The pump's own view is the journal —
    // watch the consume, not a route.
    checkpointRead.mockRestore();
    kick.mockRestore();
    capturedWakeSession().monitorWake!.kick();
    await vi.waitFor(
      async () => {
        const journal = await LocalJsonlManagedSessionJournalStore.read({
          transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
          runtimeBaseDir: state.root,
          sessionKey: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            sessionId: SESSION_ID,
          },
        });
        expect(
          journal.events.some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === inputId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);

  it('settles the parked runtime after a broker fault, releasing its lease and unblocking', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const slot = 'schedule:2026-03-08T11:00:00Z';
    // The classification's own block is the verified starting point, not
    // a race against it.
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: 15_000 },
    );
    // While the Broker keeps faulting, the crash's aftermath stays
    // pending: the Session holds its block rather than letting a fire run
    // against an unsettled park.
    await vi.waitFor(
      async () => {
        const refused = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('hosted_session_blocked');
      },
      { timeout: 15_000 },
    );
    repair.unlatch();
    // The pump's blocked cycle retries the same settle: the parked
    // execution is cancelled durably, the wake session's lease goes back,
    // the input is consumed, and the Session takes the next fire in
    // process.
    repair.script.push({ state: 'running' }, { state: 'settled' });
    await vi.waitFor(
      async () => {
        const accepted = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(accepted.status).toBe(202);
      },
      { timeout: 15_000 },
    );
    expect(HostedWorkspaceBroker.prototype.release).toHaveBeenCalled();
    // The cold Broker's space is not assumed: an adoption must precede
    // every status poll and every release on it (audit round: the parked
    // status query and the release otherwise answer 404 and 503). Order
    // asserts only have teeth once adoption HAPPENED (-1 < anything).
    expect(repair.order).toContain('acquire');
    expect(repair.order.indexOf('acquire')).toBeLessThan(
      repair.order.indexOf('status'),
    );
    expect(repair.order.indexOf('acquire')).toBeLessThan(
      repair.order.indexOf('release'),
    );
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody(1, slot) });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('settled');
      },
      { timeout: 15_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ),
    ).toBe(true);
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 15_000 },
    );
    const zombieRun = automationRunId(AUTOMATION_ID, slot);
    expect(
      journal.events
        .filter(
          (event) =>
            event.kind === 'domain.committed' &&
            String(event.payload['operationId']).startsWith(`${zombieRun}:`),
        )
        .map((event) => event.payload['operationId']),
    ).toEqual([`${zombieRun}:1`, `${zombieRun}:2`, `${zombieRun}:3`]);
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    // The parked call's cancelled tool_result is durably paired with its
    // call, and the checkpoint left await_runtime for good.
    const reopened = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const projected = await reopened.sink.project();
      const cancelled = projected.filter(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.daemonPromptId === inputId &&
          (entry.message?.parts ?? []).some(
            (part) =>
              part.functionResponse?.response?.['executionStatus'] ===
              'cancelled',
          ),
      );
      expect(cancelled).toHaveLength(1);
      const checkpoint =
        await createManagedHarnessHandle(reopened).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
    } finally {
      await reopened.close().catch(() => undefined);
    }
  }, 45_000);

  it.each([
    // A cold (replacement) Broker reads the RELEASING row.
    'runtime_session_not_acquirable',
    // The live Broker whose worker release failed still holds the
    // session in process and answers from its ready check.
    'runtime_session_not_ready',
  ])(
    'finishes the release after a transient release failure, in the very next pass (adopt refused %s)',
    async (refusal) => {
      const inputId = await prewriteAutomationParkedWakeSession();
      const repair = mockRepairBroker();
      // The first pass commits the cancelled results, and the worker's
      // release dies on its way: the aftermath is `pending` and the session
      // is RELEASING. The adopt then answers 409 — a RELEASING session
      // refuses it too — and only the explicit release on the second pass
      // completes the condition; acquire's 409 is no proof by itself.
      vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
        () => {
          repair.order.push('acquire');
          return Promise.reject(
            new HostedWorkspaceBrokerRejection(409, refusal),
          );
        },
      );
      vi.mocked(HostedWorkspaceBroker.prototype.release).mockImplementationOnce(
        async () => {
          repair.order.push('release');
          throw new TypeError('worker release died on its way');
        },
      );
      repair.unlatch();
      const server = await app(true);
      const loaded = await headers(
        supertest(server).post(`/session/${SESSION_ID}/load`),
      ).send({ managedSessionStore: store() });
      expect(loaded.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          loaded.body.clientId as string,
        );
      // The classification's block is the verified starting point: only
      // after it does the aftermath retry, so the order assertions below
      // read a settled, complete sequence, never one mid-flight.
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.recoveryBlocked).toBe(true);
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.recoveryBlocked).toBe(false);
        },
        { timeout: 15_000 },
      );
      // Two passes: the 409-refused adopt leaves nothing to stop (no poll),
      // the release block's own adopt then meets a dying release (pending);
      // the next pass repeats both adopts and the release completes —
      // exactly the affirmative release result the consume depends on.
      expect(repair.order).toEqual([
        'acquire',
        'acquire',
        'release',
        'acquire',
        'release',
      ]);
      expect(repair.order).not.toContain('status');
      expect(repair.order).not.toContain('cancel');
      const key = {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      };
      const journal = await LocalJsonlManagedSessionJournalStore.read({
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
        runtimeBaseDir: state.root,
        sessionKey: key,
      });
      expect(
        journal.events.some(
          (event) =>
            event.kind === 'turn.settled' &&
            event.payload['turnId'] === inputId,
        ),
      ).toBe(true);
      const refreshed = await authorize(
        supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
      ).send({ operationId: randomUUID(), ...fireBody() });
      expect(refreshed.status).toBe(202);
      expect(refreshed.body.run.state).toBe('failed');
      expect(refreshed.body.run.execution).toBe('outcome_unknown');
      await headers(supertest(server).delete(`/session/${SESSION_ID}`));
    },
    45_000,
  );

  it('settles the aftermath over a Broker that reports the wake session released, polling nothing', async () => {
    const inputId = await prewriteAutomationParkedWakeSession();
    const repair = mockRepairBroker();
    // The lease is gone for good: the adopt refuses 409
    // runtime_session_not_acquirable and every status poll would answer
    // 404 runtime_session_not_found — the pair the real Broker answers
    // for a released identity. The aftermath must not let that 404
    // escape as a failed pass: nothing remains to stop, so it polls
    // nothing, and the 409-aware release block completes the park.
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      () => {
        repair.order.push('acquire');
        return Promise.reject(
          new HostedWorkspaceBrokerRejection(
            409,
            'runtime_session_not_acquirable',
          ),
        );
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'status').mockImplementation(
      () => {
        repair.order.push('status');
        return Promise.reject(
          new HostedWorkspaceBrokerRejection(404, 'runtime_session_not_found'),
        );
      },
    );
    // The consume's turn_result write gates the end of the settle: the
    // classification, the adopt refusals, the cancelled-results commit
    // and the release have all completed when it enters, so the order
    // assertions read a settled sequence however fast the runner is —
    // never the mid-flight of a blocked window that may already be gone.
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    let releaseConsume!: () => void;
    let consumeEntered = false;
    const consuming = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    vi.spyOn(ManagedSessionRecordSink.prototype, 'write').mockImplementation(
      function (this: ManagedSessionRecordSink, record) {
        if (record.type === 'system' && record.subtype === 'turn_result') {
          consumeEntered = true;
          return consuming.then(() => originalWrite.call(this, record));
        }
        return originalWrite.call(this, record);
      },
    );
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    await vi.waitFor(
      () => {
        expect(consumeEntered).toBe(true);
      },
      { timeout: 15_000 },
    );
    // One pass: the refused adopt stops nothing, the release block's own
    // adopt tolerates the same 409, and the explicit release completes
    // it. A single poll would have met the 404 above and wedged the
    // Session behind a read that can never answer.
    expect(repair.order).toEqual(['acquire', 'acquire', 'release']);
    releaseConsume();
    await vi.waitFor(
      async () => {
        const status = await authorize(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        );
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: 15_000 },
    );
    const key = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: SESSION_ID,
    };
    const journal = await LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      runtimeBaseDir: state.root,
      sessionKey: key,
    });
    expect(
      journal.events.some(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === inputId,
      ),
    ).toBe(true);
    const refreshed = await authorize(
      supertest(server).post(`/session/${SESSION_ID}/automations/operations`),
    ).send({ operationId: randomUUID(), ...fireBody() });
    expect(refreshed.status).toBe(202);
    expect(refreshed.body.run.state).toBe('failed');
    expect(refreshed.body.run.execution).toBe('outcome_unknown');
    // The released-session answers are the probe's fixture, not the
    // close path's: the delete below re-acquires the lease it hands
    // back, so the Broker goes back to answering adoptable first.
    vi.mocked(HostedWorkspaceBroker.prototype.acquire).mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        repair.order.push('acquire');
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.mocked(HostedWorkspaceBroker.prototype.status).mockResolvedValue({
      state: 'settled',
    } as never);
    await vi.waitFor(
      async () => {
        const closed = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(closed.status).toBe(204);
      },
      { timeout: 15_000 },
    );
    // The parked call's cancelled tool_result is durably paired with its
    // call, and the checkpoint left await_runtime for good.
    const reopened = await openManagedSession({
      runtimeBaseDir: state.root,
      transcriptPath: '',
      sessionId: SESSION_ID,
      sessionKey: key,
      cwd: state.root,
      version: 'hosted-harness/1',
      workerId: BOOT_ID,
      activationLeaseDurationMs: 60_000,
      journalStore: new LocalJsonlManagedSessionJournalStore({
        runtimeBaseDir: state.root,
        sessionId: SESSION_ID,
        transcriptPath: path.join(state.root, `${SESSION_ID}.jsonl`),
      }),
      resourceStore: LocalManagedSessionResourceStore.create({
        runtimeBaseDir: state.root,
        sessionKey: key,
      }),
    });
    try {
      const projected = await reopened.sink.project();
      const cancelled = projected.filter(
        (entry) =>
          entry.type === 'tool_result' &&
          entry.daemonPromptId === inputId &&
          (entry.message?.parts ?? []).some(
            (part) =>
              part.functionResponse?.response?.['executionStatus'] ===
              'cancelled',
          ),
      );
      expect(cancelled).toHaveLength(1);
      const checkpoint =
        await createManagedHarnessHandle(reopened).ensureRunnable();
      expect(checkpoint.continuation.phase).not.toBe('await_runtime');
    } finally {
      await reopened.close().catch(() => undefined);
    }
  }, 45_000);

  it('maps non-path-safe turn ids to stable path-safe Broker ids', () => {
    const colon = `arun_${'a'.repeat(32)}:input`;
    const mapped = hostedRuntimeSessionId(colon);
    expect(mapped).toMatch(/^wake-[0-9a-f]{64}$/);
    expect(mapped).toBe(hostedRuntimeSessionId(colon));
    // The mapped form is path-safe itself, so a second layer is inert.
    expect(hostedRuntimeSessionId(mapped)).toBe(mapped);
    expect(hostedRuntimeSessionId('<mon_1>:notify:3')).toMatch(
      /^wake-[0-9a-f]{64}$/,
    );
    const plain = 'prompt-1_ok.2';
    expect(hostedRuntimeSessionId(plain)).toBe(plain);
    expect(hostedRuntimeSessionId('..')).not.toBe('..');
  });

  it('runs a tool-calling wake turn under a path-safe Broker session id', async () => {
    const inputId = await prewriteAutomationSession('hosted-workspace-files/1');
    await writeFile(
      path.join(state.root, 'wake-target.txt'),
      'the wake file content',
    );
    const acquired: string[] = [];
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        acquired.push(this.runtimeSessionId);
        this.runtime = {
          bindingId: 'binding',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    // The wake turn's model asks for a file: the tool turn must not die
    // at the Broker's path-safe Runtime Session id rule.
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'read_file',
        callId: 'wake-tool',
        args: { file_path: 'wake-target.txt' },
        isClientInitiated: false,
        prompt_id: inputId,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'read it', model: 'test-model' };
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    const authorize = (request: supertest.Test) =>
      headers(request).set('X-Qwen-Client-Id', loaded.body.clientId as string);
    const runId = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    // The discriminating point of the F6 wall: which id reaches acquire.
    await vi.waitFor(() => expect(acquired.length).toBeGreaterThan(0), {
      timeout: settleTimeoutMs(),
      interval: 50,
    });
    const expected = `wake-${createHash('sha256').update(`${runId}:input`).digest('hex')}`;
    expect(acquired).toContain(expected);
    expect(acquired).not.toContain(`${runId}:input`);
    expect(acquired.every((id) => /^[A-Za-z0-9._-]{1,512}$/.test(id))).toBe(
      true,
    );
    // The turn went past the acquisition the production refusal stopped:
    // in this brokerless test bed the turn ends recovery-blocked instead
    // of passing acquisition at all, and the F3 path settles the run.
    await vi.waitFor(
      async () => {
        const replayed = await authorize(
          supertest(server).post(
            `/session/${SESSION_ID}/automations/operations`,
          ),
        ).send({ operationId: randomUUID(), ...fireBody() });
        expect(replayed.status).toBe(202);
        expect(replayed.body.run.state).toBe('failed');
        expect(replayed.body.run.execution).toBe('outcome_unknown');
      },
      { timeout: 15_000, interval: 50 },
    );
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  });

  it('keeps the mapped Runtime identity through the Tool v3 publication lane of a wake shell turn', async () => {
    const inputId = await prewriteAutomationSession(
      'hosted-workspace-shell/1',
      1024 * 1024,
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockImplementation(
      async function (this: HostedWorkspaceBroker) {
        this.runtime = {
          bindingId: 'binding-1',
          generation: '1',
          workspaceGeneration: '1',
        };
      },
    );
    vi.spyOn(HostedWorkspaceBroker.prototype, 'prepareV3').mockResolvedValue({
      executionCallId: 'shell-execution',
      runtimeBindingId: 'binding-1',
      bindingGeneration: '1',
    });
    vi.spyOn(HostedWorkspaceBroker.prototype, 'executeV3').mockResolvedValue({
      executionStatus: 'success',
      responseParts: [{ text: 'hi' }],
      capture: {
        captureStatus: 'detached',
        captureReason: null,
        manifest: null,
        previewTruncated: false,
        deliveryStatus: 'pending',
      },
    });
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'acknowledgeV3',
    ).mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    const grants: Array<{ binding?: { reference?: Record<string, unknown> } }> =
      [];
    state.publicationRequest.mockImplementation(
      async (_resources, route, body) => {
        if (route === '/grants') {
          grants.push(
            body as {
              binding?: { reference?: Record<string, unknown> };
            },
          );
          return { state: 'OPEN' };
        }
        throw new Error('Unexpected publication route ' + route);
      },
    );
    state.model.mockImplementationOnce(async ({ toolTurn, signal }) => {
      const call = {
        name: 'run_shell_command',
        callId: 'wake-shell',
        args: { command: 'cat wake-target.txt' },
        isClientInitiated: false,
        prompt_id: inputId,
      };
      await toolTurn!.execute(
        [call],
        [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
        'test-model',
        signal,
      );
      return { text: 'read it', model: 'test-model' };
    });
    const server = await app(true);
    const loaded = await headers(
      supertest(server).post(`/session/${SESSION_ID}/load`),
    ).send({ managedSessionStore: store() });
    expect(loaded.status).toBe(200);
    await vi.waitFor(() => expect(grants.length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
    // The discriminating point of the Tool v3 identity wall: binding
    // reference names the Broker's mapped execution session AND the
    // checkpoint's logical prompt id — one pair, two axes; each answers
    // the compare that owns it, and neither sits in the other's seat.
    const runId = automationRunId(AUTOMATION_ID, AUTOMATION_SLOT);
    const mapped = `wake-${createHash('sha256').update(`${runId}:input`).digest('hex')}`;
    const references = grants
      .filter((grant) => grant.binding !== undefined)
      .map((grant) => grant.binding!.reference ?? {});
    // The reserve must be among them: a renew body legitimately has no
    // binding, and assertions over an empty set prove nothing.
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference['sessionId']).toBe(mapped);
      expect(reference['promptId']).toBe(`${runId}:input`);
      expect(reference['sessionId']).not.toBe(`${runId}:input`);
      expect(reference['promptId']).not.toBe(mapped);
    }
    await headers(supertest(server).delete(`/session/${SESSION_ID}`));
  }, 45_000);
});
