/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatRecord,
  TurnResultRecordPayload,
} from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { ManagedSessionStoreHttpError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  AUTOMATION_INPUT_SOURCE,
  AUTOMATION_RESOURCE_KINDS,
  AUTOMATION_RUN_INSTRUCTION,
  automationInputId,
  automationRunClaimBody,
  automationRunId,
  decodeAutomationGateOutput,
  decodeAutomationInputEnvelope,
  encodeAutomationGateOutput,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import { settlePendingMonitorInputs } from './hosted-monitor-wake.js';
import {
  AutomationNotFoundError,
  AutomationOperationConflictError,
  AutomationQuotaError,
  AutomationGateUnsupportedError,
  AutomationRetiredError,
  AutomationRevisionStaleError,
  HostedAutomationSession,
  type HostedAutomationSessionOptions,
} from './hosted-automation-session.js';
import {
  HostedAutomationGateHeld,
  type HostedAutomationGateRequest,
  type HostedAutomationGateResult,
} from './hosted-automation-gate.js';

// The H6b gates are real: both domains are enabled and the persistent mode
// is admitted, so this suite drives the hosted funnel with no enablement
// mock.
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const SCHEDULE_ID = 'asch_0123456789abcdef0123456789abcdef';
const SLOT_KEY = 'schedule:2026-03-08T07:00:00Z';

/** Every fresh request relays a fresh operation identity. */
function nextOperationId(): string {
  return randomUUID();
}

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  readonly records: ChatRecord[];
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-auto-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    records: [],
    now: 1_000,
  };
}

async function withSession<T>(
  harness: Harness,
  run: (
    automations: HostedAutomationSession,
    authority: LocalManagedSessionAuthority,
  ) => Promise<T>,
  options: { create?: boolean } & HostedAutomationSessionOptions = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      journal: LocalJsonlManagedSessionJournalStore.fromLease(
        lease,
        sessionKey,
      ),
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
      ...(create === undefined ? {} : { create }),
    });
    const automations = new HostedAutomationSession(
      {
        authority,
        resources: harness.store,
        sink: { project: async () => [...harness.records] },
      },
      sessionKey,
      {
        ...(options.gate ? { gate: options.gate } : {}),
        ...(options.releaseGate ? { releaseGate: options.releaseGate } : {}),
        ...(options.shellAvailable
          ? { shellAvailable: options.shellAvailable }
          : {}),
        ...(options.hooksConfigured
          ? { hooksConfigured: options.hooksConfigured }
          : {}),
      },
    );
    return await run(automations, authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const definition = {
  goal: 'Nightly build',
  cron: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  prompt: 'Run the build.',
};

function fireParams(definitionRevision = 1, occurrenceKey = SLOT_KEY) {
  return {
    scheduleId: SCHEDULE_ID,
    definitionRevision,
    occurrenceKey,
    trigger: 'scheduled' as const,
    firedAt: Date.parse('2026-03-08T07:00:05Z'),
  };
}

function turnRecord(
  harness: Harness,
  turnId: string,
  type: 'user' | 'assistant',
): ChatRecord {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    type,
    cwd: '/workspace',
    version: 'hosted-harness/1',
    daemonPromptId: turnId,
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text: 'x' }],
    },
  };
}

function turnResult(
  turnId: string,
  state: 'completed' | 'error' | 'cancelled',
): ChatRecord {
  const systemPayload: TurnResultRecordPayload = {
    promptId: turnId,
    state,
    stopReason: state === 'completed' ? 'end_turn' : state,
    endedAt: Date.now(),
  };
  return {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    type: 'system',
    cwd: '/workspace',
    version: 'hosted-harness/1',
    subtype: 'turn_result',
    systemPayload,
  };
}

describe('hosted automation definitions', () => {
  it('persists a targeted cancel across reopen without retiring the schedule', async () => {
    const harness = await createHarness();
    const runId = automationRunId(SCHEDULE_ID, SLOT_KEY);
    const siblingId = automationRunId(SCHEDULE_ID, 'manual:sibling');
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition,
      });
      await automations.fire(fireParams());
      await automations.fire(fireParams(1, 'manual:sibling'));
      await automations.requestCancel(runId);
      const before = authority.committedSequence;
      await automations.requestCancel(runId);
      expect(authority.committedSequence).toBe(before);
      expect(automations.cancelRequested(automationInputId(runId))).toBe(true);
      expect(automations.cancelRequested(automationInputId(siblingId))).toBe(
        false,
      );
      expect(automations.run(runId)?.run.state).toBe('running');
      expect(automations.schedule(SCHEDULE_ID)?.enabled).toBe(true);
    });
    await withSession(
      harness,
      async (automations) => {
        expect(automations.cancelRequested(automationInputId(runId))).toBe(
          true,
        );
        expect(automations.cancelRequested(automationInputId(siblingId))).toBe(
          false,
        );
        expect(automations.schedule(SCHEDULE_ID)?.enabled).toBe(true);
      },
      { create: false },
    );
  });

  it('keeps a naturally completed result when cancellation arrives later', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition,
      });
      const fired = await automations.fire(fireParams());
      harness.records.push(
        turnRecord(harness, fired.inputId, 'user'),
        turnResult(fired.inputId, 'completed'),
      );
      expect(
        (await automations.requestCancel(fired.run!.automationRunId)).run.state,
      ).toBe('settled');
      expect(automations.cancelRequested(fired.inputId)).toBe(false);
      const before = authority.committedSequence;
      await automations.requestCancel(fired.run!.automationRunId);
      expect(authority.committedSequence).toBe(before);
    });
  });

  it('cancels a claim before dispatch without admitting an input or retiring its definition', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition,
      });
      const claim = automationRunClaimBody({
        schedule: opened.schedule,
        occurrenceKey: SLOT_KEY,
      });
      await authority.commitExtensionRecord(
        {
          operation: 'fireRun',
          commandId: `${claim.automationRunId}:1`,
          sessionKey,
          contentDigest: 'd'.repeat(64),
        },
        { domain: 'automation_run', record: claim },
        { class: 'trusted_entry' },
      );
      const cancelled = await automations.requestCancel(claim.automationRunId);
      expect(cancelled.run).toMatchObject({
        state: 'cancelled',
        execution: 'not_started_proven',
      });
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ),
      ).toEqual([]);
      expect(automations.schedule(SCHEDULE_ID)?.enabled).toBe(true);
      expect((await automations.fire(fireParams())).run).toEqual(cancelled);
      expect(
        (await automations.fire(fireParams(1, 'manual:next'))).run!.run.state,
      ).toBe('running');
    });
  });

  it('refuses a missing run without writing a cancellation', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const before = authority.committedSequence;
      await expect(
        automations.requestCancel(automationRunId(SCHEDULE_ID, SLOT_KEY)),
      ).rejects.toThrow(AutomationNotFoundError);
      expect(authority.committedSequence).toBe(before);
    });
  });

  it('opens, revises append-only, replays unchanged content and retires', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      expect(opened.replayed).toBe(false);
      expect(opened.revision).toBe(1);
      expect(opened.schedule.definitionRevision).toBe(1);
      expect(opened.schedule.targetSessionId).toBe(sessionId);
      expect(opened.schedule.sessionMode).toBe('persistent');
      expect(opened.schedule.overlap).toBe('skip');
      expect(opened.schedule.catchUp).toBe('none');
      expect(opened.schedule.enabled).toBe(true);
      expect(await automations.promptOf(opened.schedule)).toBe(
        'Run the build.',
      );
      // The same content again appends nothing.
      const same = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      expect(same.replayed).toBe(true);
      expect(same.revision).toBe(1);
      // A partial revision keeps the prompt and the other fields.
      const revised = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { cron: '30 2 * * *', enabled: false },
      });
      expect(revised.replayed).toBe(false);
      expect(revised.revision).toBe(2);
      expect(revised.schedule.definitionRevision).toBe(2);
      expect(revised.schedule.cron).toBe('30 2 * * *');
      expect(revised.schedule.enabled).toBe(false);
      expect(revised.schedule.goal).toBe('Nightly build');
      expect(revised.schedule.promptRef).toEqual(opened.schedule.promptRef);
      // A prompt change publishes a new prompt resource.
      const reprompted = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { prompt: 'Run the build and report.' },
      });
      expect(reprompted.schedule.promptRef).not.toEqual(
        opened.schedule.promptRef,
      );
      expect(await automations.promptOf(reprompted.schedule)).toBe(
        'Run the build and report.',
      );
      // Retire ends and freezes the chain.
      const retired = await automations.retire(SCHEDULE_ID, nextOperationId());
      expect(retired.replayed).toBe(false);
      expect(retired.schedule.run.state).toBe('cancelled');
      expect(retired.schedule.enabled).toBe(false);
      expect(
        (await automations.retire(SCHEDULE_ID, nextOperationId())).replayed,
      ).toBe(true);
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition,
        }),
      ).rejects.toThrow(AutomationRetiredError);
      expect(authority.extensionRecord('schedule', SCHEDULE_ID)?.revision).toBe(
        4,
      );
    });
  });

  it('refuses what the contract and the gates refuse, and the quota', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations) => {
      const publish = vi.spyOn(harness.store, 'publish');
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { ...definition, sessionMode: 'per_run' },
        }),
      ).rejects.toThrow(/schedule session mode per_run is not enabled/);
      // A define the mode gate refuses publishes nothing — no orphan
      // prompt body outlives it.
      expect(
        publish.mock.calls.filter(
          ([kind]) => kind === 'managed-automation-prompt',
        ),
      ).toHaveLength(0);
      publish.mockRestore();
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { ...definition, cron: '0 25 * * *' },
        }),
      ).rejects.toThrow(ManagedSessionRecordError);
      await expect(
        automations.retire(SCHEDULE_ID, nextOperationId()),
      ).rejects.toThrow(AutomationNotFoundError);
      for (let index = 0; index < 32; index += 1) {
        await automations.define({
          scheduleId: `asch_${index.toString(16).padStart(32, '0')}`,
          operationId: nextOperationId(),
          definition,
        });
      }
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition,
        }),
      ).rejects.toThrow(AutomationQuotaError);
      // A retired definition frees its slot.
      await automations.retire(`asch_${'0'.repeat(32)}`, nextOperationId());
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition,
        }),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });

  it('clears the catch-up limit when the policy stops being bounded', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations) => {
      const bounded = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { ...definition, catchUp: 'bounded', catchUpLimit: 3 },
      });
      expect(bounded.schedule.catchUp).toBe('bounded');
      expect(bounded.schedule.catchUpLimit).toBe(3);
      // A revision that leaves bounded drops the limit by itself: the
      // contract pins the limit to bounded, and the caller named none.
      const none = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { catchUp: 'none' },
      });
      expect(none.revision).toBe(2);
      expect(none.schedule.catchUp).toBe('none');
      expect(none.schedule.catchUpLimit).toBeNull();
      // Back to bounded needs the limit named again.
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { catchUp: 'bounded' },
        }),
      ).rejects.toThrow(ManagedSessionRecordError);
      const again = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { catchUp: 'bounded', catchUpLimit: 5 },
      });
      expect(again.revision).toBe(3);
      expect(again.schedule.catchUpLimit).toBe(5);
      // Under bounded the limit is kept unless the caller names one; an
      // explicit null there, or a limit under latest, is the contract's
      // refusal, not a silent rewrite.
      expect(
        (
          await automations.define({
            scheduleId: SCHEDULE_ID,
            operationId: nextOperationId(),
            definition: { goal: 'Nightly build' },
          })
        ).replayed,
      ).toBe(true);
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { catchUpLimit: null },
        }),
      ).rejects.toThrow(ManagedSessionRecordError);
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { catchUp: 'latest', catchUpLimit: 2 },
        }),
      ).rejects.toThrow(ManagedSessionRecordError);
      const latest = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { catchUp: 'latest' },
      });
      expect(latest.revision).toBe(4);
      expect(latest.schedule.catchUpLimit).toBeNull();
    });
  });

  it('answers a retried mutation with its original result, never the moved chain', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const createOp = randomUUID();
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      expect(opened.revision).toBe(1);
      const moved = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition: { cron: '15 3 * * *' },
      });
      expect(moved.revision).toBe(2);
      // The Harness committed the create, its answer was lost, and the
      // control plane re-drives it: the retry answers revision 1 with the
      // revision-1 record, and the second request's revision stays put.
      const retried = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      expect(retried.replayed).toBe(true);
      expect(retried.revision).toBe(1);
      expect(retried.schedule.definitionRevision).toBe(1);
      expect(retried.schedule.cron).toBe(definition.cron);
      expect(retried.schedule.promptRef).toEqual(opened.schedule.promptRef);
      const chain = automations.schedule(SCHEDULE_ID)!;
      expect(chain.definitionRevision).toBe(2);
      expect(chain.cron).toBe('15 3 * * *');
      expect(authority.extensionRecord('schedule', SCHEDULE_ID)?.revision).toBe(
        2,
      );
      // A retried retire answers its own cancel revision, once.
      const retireOp = randomUUID();
      const retired = await automations.retire(SCHEDULE_ID, retireOp);
      expect(retired.replayed).toBe(false);
      const retriedRetire = await automations.retire(SCHEDULE_ID, retireOp);
      expect(retriedRetire.replayed).toBe(true);
      expect(retriedRetire.revision).toBe(retired.revision);
      expect(retriedRetire.schedule.run.state).toBe('cancelled');
      // The lost-answer retry of the original create still answers its
      // first revision — it never re-opens the retired chain.
      const afterRetire = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      expect(afterRetire.replayed).toBe(true);
      expect(afterRetire.revision).toBe(1);
      expect(authority.extensionRecord('schedule', SCHEDULE_ID)?.revision).toBe(
        3,
      );
    });
  });

  it('replays a retried mutation after a reopen', async () => {
    const harness = await createHarness();
    const createOp = randomUUID();
    await withSession(harness, async (automations) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
    });
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: randomUUID(),
          definition: { cron: '45 4 * * *' },
        });
        // A retry of the create relayed before the restart still answers
        // the first revision and moves nothing.
        const retried = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: createOp,
          definition,
        });
        expect(retried.replayed).toBe(true);
        expect(retried.revision).toBe(1);
        expect(retried.schedule.definitionRevision).toBe(1);
        expect(automations.schedule(SCHEDULE_ID)?.definitionRevision).toBe(2);
      },
      { create: false },
    );
  });

  it('refuses a definition whose final execution input cannot be published', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const before = authority.committedSequence;
      // A 64 KiB ASCII prompt admits itself, but the wrapped input the
      // fire would publish already exceeds the inline resource bound.
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: {
            ...definition,
            prompt: 'x'.repeat(64 * 1024),
          },
        }),
      ).rejects.toThrow(/final execution input would exceed/);
      // A newline-only prompt of 33 KiB escapes past it, too.
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: {
            ...definition,
            prompt: '\n'.repeat(33_792),
          },
        }),
      ).rejects.toThrow(/final execution input would exceed/);
      expect(automations.schedule(SCHEDULE_ID)).toBeUndefined();
      expect(authority.committedSequence).toBe(before);
      // A prompt that carries the wrapping defines and fires.
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { ...definition, prompt: 'x'.repeat(48 * 1024) },
      });
      const fired = await automations.fire(fireParams());
      expect(fired.run!.run.execution).toBe('dispatch_started');
    });
  });

  it('commits a no-op honor, and answers its retry after the chain moved', async () => {
    const harness = await createHarness();
    const noopOp = randomUUID();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition,
      });
      // A new key asking exactly what is committed appends nothing, but
      // the honor itself is committed: its retry answers it, whatever the
      // chain does since.
      const before = authority.committedSequence;
      const honored = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: noopOp,
        definition,
      });
      expect(honored.replayed).toBe(true);
      expect(honored.revision).toBe(1);
      expect(
        authority
          .eventsInSequenceRange(before + 1, authority.committedSequence)
          .map((event) => event.kind),
      ).toEqual(['operation.replayed']);
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition: { cron: '10 5 * * *' },
      });
      const retried = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: noopOp,
        definition,
      });
      expect(retried.replayed).toBe(true);
      expect(retried.revision).toBe(1);
      expect(retried.schedule.definitionRevision).toBe(1);
      expect(retried.schedule.cron).toBe(definition.cron);
      expect(automations.schedule(SCHEDULE_ID)?.definitionRevision).toBe(2);
      expect(automations.schedule(SCHEDULE_ID)?.cron).toBe('10 5 * * *');
      // The marker and the moved chain are all that committed since.
      expect(authority.committedSequence).toBe(before + 2);
      // A no-op retire on a frozen chain honors the same way.
      const beforeRetire = authority.committedSequence;
      const retired = await automations.retire(SCHEDULE_ID, randomUUID());
      expect(retired.replayed).toBe(false);
      const again = await automations.retire(SCHEDULE_ID, randomUUID());
      expect(again.replayed).toBe(true);
      expect(
        authority
          .eventsInSequenceRange(beforeRetire + 1, authority.committedSequence)
          .map((event) => event.kind),
      ).toEqual(['domain.committed', 'operation.replayed']);
    });
    // The honored replay survives a reopen, over the moved chain.
    await withSession(
      harness,
      async (automations) => {
        const retried = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: noopOp,
          definition,
        });
        expect(retried.replayed).toBe(true);
        expect(retried.schedule.cron).toBe(definition.cron);
        expect(automations.schedule(SCHEDULE_ID)?.run.state).toBe('cancelled');
      },
      { create: false },
    );
  });

  it('refuses a replay naming another target or another content', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const otherId = `asch_${'f'.repeat(32)}`;
      const retireOp = randomUUID();
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: randomUUID(),
        definition,
      });
      await automations.define({
        scheduleId: otherId,
        operationId: randomUUID(),
        definition,
      });
      await automations.retire(SCHEDULE_ID, retireOp);
      // The same operation identity against another definition is a
      // conflict: it cannot be answered with the first one's cancel.
      await expect(automations.retire(otherId, retireOp)).rejects.toThrow(
        AutomationOperationConflictError,
      );
      expect(automations.schedule(otherId)?.run.state).toBe('admitted');
      // A define under one identity commits; the same identity with
      // another body conflicts, the chain untouched.
      const defineOp = randomUUID();
      const committed = await automations.define({
        scheduleId: otherId,
        operationId: defineOp,
        definition: { goal: 'Pinned goal' },
      });
      expect(committed.replayed).toBe(false);
      const before = authority.committedSequence;
      await expect(
        automations.define({
          scheduleId: otherId,
          operationId: defineOp,
          definition: { cron: '20 6 * * *' },
        }),
      ).rejects.toThrow(AutomationOperationConflictError);
      expect(authority.committedSequence).toBe(before);
      expect(automations.schedule(otherId)?.definitionRevision).toBe(2);
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: defineOp,
          definition,
        }),
      ).rejects.toThrow(AutomationOperationConflictError);
      // The honest retry of the pinned goal answers its revision.
      const honest = await automations.define({
        scheduleId: otherId,
        operationId: defineOp,
        definition: { goal: 'Pinned goal' },
      });
      expect(honest.replayed).toBe(true);
      expect(honest.schedule.goal).toBe('Pinned goal');
    });
  });

  it('answers a retried mutation with the record revision, not the domain counter', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const createA = randomUUID();
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createA,
        definition,
      });
      // A second definition moves the per-domain counter away from the
      // first record's own revision.
      await automations.define({
        scheduleId: `asch_${'e'.repeat(32)}`,
        operationId: randomUUID(),
        definition,
      });
      expect(authority.domainRecord('schedule')?.revision).toBe(2);
      const retried = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createA,
        definition,
      });
      expect(retried.replayed).toBe(true);
      expect(retried.revision).toBe(1);
    });
  });

  it('refuses a mutation retried under the other operation kind with the same identity', async () => {
    const harness = await createHarness();
    const createOp = randomUUID();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      // One idempotency key is one operation on the public surface: the
      // same identity under the other kind conflicts, never retires.
      await expect(
        automations.retire(SCHEDULE_ID, createOp),
      ).rejects.toBeInstanceOf(AutomationOperationConflictError);
      expect(automations.schedule(SCHEDULE_ID)?.run.state).not.toBe(
        'cancelled',
      );
      expect(authority.extensionRecord('schedule', SCHEDULE_ID)?.revision).toBe(
        1,
      );
    });
    await withSession(
      harness,
      async (automations, authority) => {
        // Across a reopen the journal still holds the operation, so a
        // control plane that lost its own command row sees the same
        // refusal instead of cancelling the definition.
        await expect(
          automations.retire(SCHEDULE_ID, createOp),
        ).rejects.toBeInstanceOf(AutomationOperationConflictError);
        expect(
          authority.extensionRecord('schedule', SCHEDULE_ID)?.revision,
        ).toBe(1);
        const retried = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: createOp,
          definition,
        });
        expect(retried.replayed).toBe(true);
        expect(retried.revision).toBe(1);
      },
      { create: false },
    );
  });

  it('lets a store fault through a replay content check as itself, never a conflict', async () => {
    const harness = await createHarness();
    const createOp = randomUUID();
    await withSession(harness, async (automations) => {
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      const promptResourceId = opened.schedule.promptRef.resourceId;
      const read = harness.store.read.bind(harness.store);
      harness.store.read = async (ref) => {
        if (ref.resourceId === promptResourceId) {
          throw new ManagedSessionStoreHttpError(
            503,
            'store_unavailable',
            'store down',
          );
        }
        return read(ref);
      };
      try {
        // The retry cannot re-read the committed prompt: infrastructure —
        // the store's own 503 travels upward, never a conflict.
        await expect(
          automations.define({
            scheduleId: SCHEDULE_ID,
            operationId: createOp,
            definition,
          }),
        ).rejects.toBeInstanceOf(ManagedSessionStoreHttpError);
      } finally {
        harness.store.read = read;
      }
      const retried = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: createOp,
        definition,
      });
      expect(retried.replayed).toBe(true);
      expect(retried.revision).toBe(1);
    });
  });
});

describe('hosted automation runs', () => {
  it('fires one run with its input and wake, and replays the occurrence', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      const before = authority.committedSequence;
      const fired = await automations.fire(fireParams());
      const runId = automationRunId(SCHEDULE_ID, SLOT_KEY);
      expect(fired.replayed).toBe(false);
      expect(fired.run!.automationRunId).toBe(runId);
      expect(fired.run!.run.state).toBe('running');
      expect(fired.run!.run.execution).toBe('dispatch_started');
      expect(fired.inputId).toBe(automationInputId(runId));
      const events = authority.eventsInSequenceRange(
        before + 1,
        authority.committedSequence,
      );
      expect(events.map((event) => event.kind)).toEqual([
        'domain.committed',
        'domain.committed',
        'input.accepted',
        'wake.requested',
      ]);
      const [pending] = pendingSessionInputs(events);
      expect(pending?.source).toBe(AUTOMATION_INPUT_SOURCE);
      expect(pending?.turnId).toBe(fired.inputId);
      // The committed envelope decodes under its own contract, so the
      // journal's input is one any conforming reader can take.
      const envelope = decodeAutomationInputEnvelope(
        await harness.store.read(
          assertManagedSessionDurableRef(
            pending!.contentRef,
            'automation input contentRef',
          ),
        ),
      );
      expect(envelope.automationRunId).toBe(fired.run!.automationRunId);
      expect(envelope.scheduleId).toBe(SCHEDULE_ID);
      expect(envelope.definitionRevision).toBe(1);
      expect(envelope.firedAt).toBe(fireParams().firedAt);
      expect(envelope.occurrenceKey).toBe(SLOT_KEY);
      expect(envelope.trigger).toBe('scheduled');
      expect(envelope.text).toContain('Scheduled automation: Nightly build');
      expect(envelope.text).toContain(`Automation ID: ${SCHEDULE_ID}`);
      expect(envelope.text).toContain(AUTOMATION_RUN_INSTRUCTION);
      expect(envelope.text.endsWith('Run the build.')).toBe(true);
      // The same occurrence again is the committed run, nothing new.
      const again = await automations.fire(fireParams());
      expect(again.replayed).toBe(true);
      expect(again.run).toEqual(fired.run);
      expect(authority.committedSequence).toBe(before + 4);
      // Another occurrence is another run; a manual one keys by command.
      const manual = await automations.fire({
        ...fireParams(1, 'manual:key-1'),
        trigger: 'manual',
      });
      expect(manual.run!.automationRunId).toBe(
        automationRunId(SCHEDULE_ID, 'manual:key-1'),
      );
      expect(automations.runs()).toHaveLength(2);
    });
  });

  it('completes a dispatch a crash left out, from the committed claim', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      const claim = automationRunClaimBody({
        schedule: opened.schedule,
        occurrenceKey: SLOT_KEY,
      });
      await authority.commitExtensionRecord(
        {
          operation: 'fireRun',
          commandId: `${claim.automationRunId}:1`,
          sessionKey,
          contentDigest: 'd'.repeat(64),
        },
        { domain: 'automation_run', record: claim },
        { class: 'trusted_entry' },
      );
      const before = authority.committedSequence;
      const fired = await automations.fire(fireParams());
      expect(fired.replayed).toBe(true);
      expect(fired.run!.run.execution).toBe('dispatch_started');
      expect(
        authority
          .eventsInSequenceRange(before + 1, authority.committedSequence)
          .map((event) => event.kind),
      ).toEqual(['domain.committed', 'input.accepted', 'wake.requested']);
    });
  });

  it('refuses a stale revision, a retired or missing definition', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations) => {
      await expect(automations.fire(fireParams())).rejects.toThrow(
        AutomationNotFoundError,
      );
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      await expect(automations.fire(fireParams(2))).rejects.toThrow(
        AutomationRevisionStaleError,
      );
      await expect(
        automations.fire(fireParams(1, 'webhook:e-1')),
      ).rejects.toThrow(ManagedSessionRecordError);
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { enabled: false },
      });
      await expect(automations.fire(fireParams(1))).rejects.toThrow(
        /revision 1 admits nothing/,
      );
      await automations.retire(SCHEDULE_ID, nextOperationId());
      await expect(automations.fire(fireParams(3))).rejects.toThrow(
        AutomationRetiredError,
      );
      expect(automations.runs()).toHaveLength(0);
    });
  });

  it('replays a dispatched run after its definition moved or retired', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      const fired = await automations.fire(fireParams());
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: { goal: 'Moved' },
      });
      const sequence = authority.committedSequence;
      // A scanner re-driving its claim names the revision it pinned: the
      // committed run answers; nothing is refused, nothing appended.
      const moved = await automations.fire(fireParams(1));
      expect(moved.replayed).toBe(true);
      expect(moved.run).toEqual(fired.run);
      expect(authority.committedSequence).toBe(sequence);
      // A new occurrence at the old revision is still stale.
      await expect(
        automations.fire(fireParams(1, 'schedule:2026-03-09T07:00:00Z')),
      ).rejects.toThrow(AutomationRevisionStaleError);
      await automations.retire(SCHEDULE_ID, nextOperationId());
      const retired = await automations.fire(fireParams(1));
      expect(retired.replayed).toBe(true);
      expect(retired.run).toEqual(fired.run);
      await expect(
        automations.fire({
          ...fireParams(3, 'manual:late'),
          trigger: 'manual',
        }),
      ).rejects.toThrow(AutomationRetiredError);
      expect(automations.runs()).toHaveLength(1);
    });
  });

  it('fails a run whose turn stopped unproven, once, with execution unknown', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      const fired = await automations.fire(fireParams());
      const before = authority.committedSequence;
      const failed = await automations.settleRunFailedUnknown(fired.inputId);
      expect(failed?.run.state).toBe('failed');
      expect(failed?.run.execution).toBe('outcome_unknown');
      expect(failed?.automationRunId).toBe(fired.run!.automationRunId);
      expect(
        authority
          .eventsInSequenceRange(before + 1, authority.committedSequence)
          .map((event) => event.kind),
      ).toEqual(['domain.committed']);
      // Terminal and idempotent: calling again, reconciling, or reading the
      // turn result commits nothing more.
      expect(
        await automations.settleRunFailedUnknown(fired.inputId),
      ).toBeUndefined();
      expect(await automations.settleRun(fired.inputId)).toBeUndefined();
      expect(await automations.reconcileRuns()).toEqual([]);
      expect(authority.committedSequence).toBe(before + 1);
      // The slot frees at once: the definition fires its next occurrence.
      const next = await automations.fire(
        fireParams(1, 'schedule:2026-03-08T07:01:00Z'),
      );
      expect(next.run!.run.state).toBe('running');
    });
  });

  it('ends a claim its definition retired under as cancelled, never started', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations, authority) => {
      const opened = await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      const claim = automationRunClaimBody({
        schedule: opened.schedule,
        occurrenceKey: SLOT_KEY,
      });
      await authority.commitExtensionRecord(
        {
          operation: 'fireRun',
          commandId: `${claim.automationRunId}:1`,
          sessionKey,
          contentDigest: 'd'.repeat(64),
        },
        { domain: 'automation_run', record: claim },
        { class: 'trusted_entry' },
      );
      await automations.retire(SCHEDULE_ID, nextOperationId());
      const before = authority.committedSequence;
      const ended = await automations.fire(fireParams());
      expect(ended.replayed).toBe(true);
      expect(ended.run!.run.state).toBe('cancelled');
      expect(ended.run!.run.execution).toBe('not_started_proven');
      // One settle revision, no input, no wake: nothing of this
      // occurrence ever reached a turn.
      expect(
        authority
          .eventsInSequenceRange(before + 1, authority.committedSequence)
          .map((event) => event.kind),
      ).toEqual(['domain.committed']);
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ),
      ).toEqual([]);
      // Asked again: the ended run, nothing more.
      expect((await automations.fire(fireParams())).run).toEqual(ended.run);
      expect(authority.committedSequence).toBe(before + 1);
    });
  });

  it('settles a run from its turn result, once, on the settle path and on open', async () => {
    const harness = await createHarness();
    const runId = automationRunId(SCHEDULE_ID, SLOT_KEY);
    const turnId = automationInputId(runId);
    await withSession(harness, async (automations) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      await automations.fire(fireParams());
      // Nothing settled yet.
      expect(await automations.settleRun(turnId)).toBeUndefined();
      harness.records.push(
        turnRecord(harness, turnId, 'user'),
        turnRecord(harness, turnId, 'assistant'),
        turnResult(turnId, 'completed'),
      );
      const settled = await automations.settleRun(turnId);
      expect(settled?.run.state).toBe('settled');
      expect(settled?.run.execution).toBe('settled');
      expect(await automations.settleRun(turnId)).toBeUndefined();
      expect(await automations.reconcileRuns()).toEqual([]);
    });
    // A second run whose settle revision was lost reconciles on open.
    const secondKey = 'schedule:2026-03-09T06:30:00Z';
    const secondTurn = automationInputId(
      automationRunId(SCHEDULE_ID, secondKey),
    );
    await withSession(
      harness,
      async (automations) => {
        await automations.fire(fireParams(1, secondKey));
        harness.records.push(
          turnRecord(harness, secondTurn, 'user'),
          turnResult(secondTurn, 'error'),
        );
      },
      { create: false },
    );
    await withSession(
      harness,
      async (automations) => {
        expect(await automations.reconcileRuns()).toEqual([
          automationRunId(SCHEDULE_ID, secondKey),
        ]);
        const run = automations.run(automationRunId(SCHEDULE_ID, secondKey));
        expect(run?.run.state).toBe('failed');
        expect(run?.run.execution).toBe('settled');
        expect(await automations.reconcileRuns()).toEqual([]);
      },
      { create: false },
    );
  });

  it('ends a run whose input the close path settled model-free', async () => {
    const harness = await createHarness();
    const runId = automationRunId(SCHEDULE_ID, SLOT_KEY);
    await withSession(harness, async (automations, authority) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition,
      });
      await automations.fire(fireParams());
      const sink = {
        project: async () => [...harness.records],
        write: async (record: ChatRecord) => {
          harness.records.push(record);
        },
      };
      expect(
        await settlePendingMonitorInputs({
          authority,
          sink: sink as never,
          sessionId,
          cwd: '/workspace',
          sources: ['monitor', AUTOMATION_INPUT_SOURCE],
        }),
      ).toBe(1);
      expect(await automations.reconcileRuns()).toEqual([runId]);
      const run = automations.run(runId);
      expect(run?.run.state).toBe('cancelled');
      expect(run?.run.execution).toBe('not_started_proven');
      // Without the automation source, the close path leaves it alone.
      expect(
        await settlePendingMonitorInputs({
          authority,
          sink: sink as never,
          sessionId,
          cwd: '/workspace',
        }),
      ).toBe(0);
    });
  });
});

/** Hands each probe the next scripted result and records what it was asked. */
function scriptedGate(results: HostedAutomationGateResult[]) {
  const calls: HostedAutomationGateRequest[] = [];
  const runner = async (request: HostedAutomationGateRequest) => {
    calls.push(request);
    const next = results.shift();
    if (next === undefined) throw new Error('unscripted gate probe');
    return next;
  };
  return { runner, calls };
}

const gated = { ...definition, gate: './probe.sh --gate' };

describe('hosted automation gates', () => {
  it('retains unknown release debt after the release-key cache overflows', async () => {
    const harness = await createHarness();
    let failing = true;
    const releaseGate = vi.fn(async () => {});
    const occurrences = Array.from(
      { length: 1025 },
      (_, index) =>
        `schedule:${new Date(Date.UTC(2026, 2, 8 + index, 7))
          .toISOString()
          .replace('.000Z', 'Z')}`,
    );
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        expect(automations.hasPendingGateReleases).toBe(false);
        for (const occurrence of occurrences) {
          await expect(
            automations.fire(fireParams(1, occurrence)),
          ).rejects.toThrow('unreleased Runtime');
        }
        failing = false;
        for (const occurrence of occurrences.slice(1)) {
          expect(
            (await automations.fire(fireParams(1, occurrence))).gate,
          ).toEqual({
            outcome: 'quiet',
            durationMs: 0,
          });
        }
        expect(releaseGate).toHaveBeenCalledTimes(1024);
        expect(automations.hasPendingGateReleases).toBe(true);
      },
      {
        gate: async () => {
          if (failing) throw new Error('unreleased Runtime');
          return { kind: 'quiet', durationMs: 0 };
        },
        releaseGate,
      },
    );
  });

  it('withholds a quiet fire with no claim, input or wake', async () => {
    const harness = await createHarness();
    const gate = scriptedGate([{ kind: 'quiet', durationMs: 12 }]);
    await withSession(
      harness,
      async (automations, authority) => {
        const defined = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        expect(defined.schedule.gate).toBe('./probe.sh --gate');
        const before = authority.committedSequence;
        const fired = await automations.fire(fireParams());
        expect(fired).toEqual({
          inputId: automationInputId(automationRunId(SCHEDULE_ID, SLOT_KEY)),
          replayed: false,
          gate: { outcome: 'quiet', durationMs: 12 },
        });
        expect(authority.committedSequence).toBe(before);
        expect(automations.runs()).toHaveLength(0);
        expect(gate.calls).toEqual([
          expect.objectContaining({
            automationRunId: automationRunId(SCHEDULE_ID, SLOT_KEY),
            definitionRevision: 1,
            gate: './probe.sh --gate',
          }),
        ]);
      },
      { gate: gate.runner },
    );
  });

  it('releases the probe Session of the pinned revision when the fire ends without probing it again', async () => {
    // An attempt that could not release its probe Session left that to the
    // next attempt; a revision since, a retire or a deletion means no next
    // attempt probes under that revision.
    const harness = await createHarness();
    const released: Array<[string, number]> = [];
    const runId = automationRunId(SCHEDULE_ID, SLOT_KEY);
    await withSession(
      harness,
      async (automations) => {
        await expect(automations.fire(fireParams(4))).rejects.toThrow(
          AutomationNotFoundError,
        );
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { gate: null },
        });
        await expect(automations.fire(fireParams(1))).rejects.toThrow(
          AutomationRevisionStaleError,
        );
        await automations.retire(SCHEDULE_ID, nextOperationId());
        await expect(automations.fire(fireParams(2))).rejects.toThrow(
          AutomationRetiredError,
        );
        expect(released).toEqual([
          [runId, 4],
          [runId, 1],
          [runId, 2],
        ]);
      },
      {
        releaseGate: async (id, revision) => {
          released.push([id, revision]);
        },
      },
    );
  });

  it('retries a fire whose stale revision’s probe Session this process owes, and only that one', async () => {
    const harness = await createHarness();
    let failing = true;
    let hanging = false;
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        // The probe's attempt could not release its Session.
        await expect(automations.fire(fireParams(1))).rejects.toThrow(
          /was not released/,
        );
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { gate: null },
        });
        await expect(automations.fire(fireParams(1))).rejects.toThrow(
          HostedAutomationGateHeld,
        );
        failing = false;
        await expect(automations.fire(fireParams(1))).rejects.toThrow(
          AutomationRevisionStaleError,
        );
        // Only then does the ungated revision claim, unprobed.
        const fired = await automations.fire(fireParams(2));
        expect(fired.run?.run.execution).toBe('dispatch_started');
        // A stale fire that owes nothing does not wait on the Broker.
        failing = true;
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { prompt: 'Run the build again.' },
        });
        await expect(
          automations.fire(fireParams(2, 'schedule:2026-03-09T07:00:00Z')),
        ).rejects.toThrow(AutomationRevisionStaleError);
        // Nor on one that hangs: the courtesy waits two seconds at most.
        hanging = true;
        const started = Date.now();
        await expect(
          automations.fire(fireParams(2, 'schedule:2026-03-10T07:00:00Z')),
        ).rejects.toThrow(AutomationRevisionStaleError);
        expect(Date.now() - started).toBeLessThan(4_000);
      },
      {
        gate: async () => {
          throw new Error(
            "The gate's Runtime Session was not released, so the fire is retried to release it: Broker unavailable",
          );
        },
        releaseGate: async () => {
          if (hanging) return new Promise<void>(() => {});
          if (failing) throw new Error('Broker unavailable');
        },
      },
    );
  });

  it('releases what an earlier attempt owes before a later answer settles the fire', async () => {
    // Attempt 1 may hold the probe's Session and fails; attempt 2 answers
    // after a refusal that came before it acquired anything, so the runner
    // released nothing. The answer would settle the occurrence and strand
    // attempt 1's Session: the release comes first, and a failed one retries.
    const harness = await createHarness();
    const released: Array<[string, number]> = [];
    let releaseFails = true;
    let attempt = 0;
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        await expect(automations.fire(fireParams())).rejects.toThrow(
          HostedAutomationGateHeld,
        );
        await expect(automations.fire(fireParams())).rejects.toThrow(
          HostedAutomationGateHeld,
        );
        expect(released).toEqual([]);
        releaseFails = false;
        const fired = await automations.fire(fireParams());
        expect(fired.gate).toEqual({ outcome: 'quiet', durationMs: 5 });
        expect(released).toEqual([[automationRunId(SCHEDULE_ID, SLOT_KEY), 1]]);
      },
      {
        gate: async () => {
          attempt++;
          if (attempt === 1) {
            throw new HostedAutomationGateHeld(
              "the occurrence's Runtime Session is held by another attempt",
            );
          }
          return { kind: 'quiet', durationMs: 5 };
        },
        releaseGate: async (id, revision) => {
          if (releaseFails) throw new Error('Broker unavailable');
          released.push([id, revision]);
        },
      },
    );
  });

  it('claims with the output, delivers it as data and replays without probing again', async () => {
    const harness = await createHarness();
    const gate = scriptedGate([
      {
        kind: 'output',
        stdout: 'event: comment\n',
        truncated: false,
        durationMs: 40,
      },
    ]);
    await withSession(
      harness,
      async (automations, authority) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const fired = await automations.fire(fireParams());
        expect(fired.gate).toEqual({ outcome: 'delivered', durationMs: 40 });
        expect(fired.run!.gateOutputRef).not.toBeNull();
        expect(fired.run!.run.execution).toBe('dispatch_started');
        const events = authority.eventsInSequenceRange(
          1,
          authority.committedSequence,
        );
        const [pending] = pendingSessionInputs(events);
        const envelope = decodeAutomationInputEnvelope(
          await harness.store.read(
            assertManagedSessionDurableRef(
              pending!.contentRef,
              'automation input contentRef',
            ),
          ),
        );
        expect(envelope.text).toContain('Run the build.\n\nGate output.');
        expect(envelope.text).toContain('(`./probe.sh --gate`, exit 0, 0.0 s)');
        expect(
          envelope.text.endsWith(
            '<gate-output>\nevent: comment\n</gate-output>',
          ),
        ).toBe(true);
        // The same occurrence again is the committed run: no second probe.
        const again = await automations.fire(fireParams());
        expect(again.replayed).toBe(true);
        expect(again.run).toEqual(fired.run);
        expect(again.gate).toEqual({ outcome: 'delivered' });
        expect(gate.calls).toHaveLength(1);
      },
      { gate: gate.runner },
    );
  });

  it("completes a gated dispatch a crash left out from the claim's output", async () => {
    const harness = await createHarness();
    const gate = scriptedGate([]);
    await withSession(
      harness,
      async (automations, authority) => {
        const opened = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const gateOutputRef = await harness.store.publish(
          AUTOMATION_RESOURCE_KINDS.gateOutput,
          encodeAutomationGateOutput({
            gate: './probe.sh --gate',
            stdout: 'recorded before the crash\n',
            truncated: false,
            durationMs: 5,
          }),
        );
        const claim = automationRunClaimBody({
          schedule: opened.schedule,
          occurrenceKey: SLOT_KEY,
          gateOutputRef,
        });
        await authority.commitExtensionRecord(
          {
            operation: 'fireRun',
            commandId: `${claim.automationRunId}:1`,
            sessionKey,
            contentDigest: 'd'.repeat(64),
          },
          { domain: 'automation_run', record: claim },
          { class: 'trusted_entry' },
        );
        const fired = await automations.fire(fireParams());
        expect(fired.replayed).toBe(true);
        expect(fired.gate).toEqual({ outcome: 'delivered' });
        expect(fired.run!.run.execution).toBe('dispatch_started');
        const [pending] = pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        );
        const envelope = decodeAutomationInputEnvelope(
          await harness.store.read(
            assertManagedSessionDurableRef(
              pending!.contentRef,
              'automation input contentRef',
            ),
          ),
        );
        expect(envelope.text).toContain('recorded before the crash');
        expect(gate.calls).toHaveLength(0);
      },
      { gate: gate.runner },
    );
  });

  it.each<[HostedAutomationGateResult, Record<string, unknown>]>([
    [
      {
        kind: 'failed',
        detail: 'exited with code 1',
        stderr: 'boom',
        durationMs: 7,
      },
      {
        outcome: 'failed',
        detail: 'exited with code 1; stderr: boom',
        durationMs: 7,
      },
    ],
    [
      {
        kind: 'failed',
        detail: 'exited with code 1',
        stderr: '',
        durationMs: 7,
      },
      { outcome: 'failed', detail: 'exited with code 1', durationMs: 7 },
    ],
    [
      { kind: 'blocked', reason: 'a permission rule denies it' },
      { outcome: 'blocked', detail: 'a permission rule denies it' },
    ],
    [
      { kind: 'unknown', reason: 'the Runtime did not settle' },
      { outcome: 'unknown', detail: 'the Runtime did not settle' },
    ],
  ])('answers %o without a run', async (result, summary) => {
    const harness = await createHarness();
    const gate = scriptedGate([result]);
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const fired = await automations.fire(fireParams());
        expect(fired.run).toBeUndefined();
        expect(fired.gate).toEqual(summary);
        expect(automations.runs()).toHaveLength(0);
      },
      { gate: gate.runner },
    );
  });

  it('publishes a printing gate’s output sanitized, so control bytes cannot push it past the resource limit', async () => {
    // Each raw C0 control byte would escape to six bytes in the published
    // JSON: 12 000 of them would outgrow the resource and drop the fire.
    const harness = await createHarness();
    const gate = scriptedGate([
      {
        kind: 'output',
        stdout: `${'\u0001'.repeat(12_000)}event: comment\n`,
        truncated: false,
        durationMs: 3,
      },
    ]);
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const fired = await automations.fire(fireParams());
        expect(fired.run).toBeDefined();
        expect(fired.gate).toMatchObject({ outcome: 'delivered' });
        // Stored as the model sees it: no control byte left to escape.
        const stored = decodeAutomationGateOutput(
          await harness.store.read(fired.run!.gateOutputRef!),
        );
        expect(stored.stdout).toBe('event: comment');
      },
      { gate: gate.runner },
    );
  });

  it('cuts the stored output back to the cap when sanitizing lengthens it', async () => {
    // An escaped `<` gains three characters: 16 KiB of tags would outgrow
    // the budget the definition was admitted under.
    const harness = await createHarness();
    const stdout = '<result>'.repeat((16 * 1024) / 8);
    const gate = scriptedGate([
      { kind: 'output', stdout, truncated: false, durationMs: 3 },
    ]);
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const fired = await automations.fire(fireParams());
        const stored = decodeAutomationGateOutput(
          await harness.store.read(fired.run!.gateOutputRef!),
        );
        expect(Buffer.byteLength(stored.stdout, 'utf8')).toBeLessThanOrEqual(
          16 * 1024,
        );
        expect(stored.truncated).toBe(true);
        expect(stored.stdout.startsWith('&lt;result>')).toBe(true);
      },
      { gate: gate.runner },
    );
  });

  it('keeps the newest stderr of a failed gate, sanitized and within what the control plane stores', async () => {
    // A failed gate runs no turn: the detail is the only place its reason
    // reaches, so a long, colored stderr must not push that reason out.
    const harness = await createHarness();
    const stderr = [
      ...Array.from({ length: 40 }, (_, i) => `noise ${i} ${'x'.repeat(60)}`),
      '\u001b[31mauthentication expired\u001b[0m',
    ].join('\n');
    const gate = scriptedGate([
      { kind: 'failed', detail: 'exited with code 1', stderr, durationMs: 7 },
    ]);
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        const detail = (await automations.fire(fireParams())).gate?.detail;
        expect(detail?.startsWith('exited with code 1; stderr: ')).toBe(true);
        expect(detail?.endsWith('authentication expired')).toBe(true);
        expect(detail).not.toContain('\u001b');
        expect(detail).not.toContain('noise 0 ');
        expect(detail!.length).toBeLessThanOrEqual(1024);
      },
      { gate: gate.runner },
    );
  });

  it('blocks a gated fire when the Session has no runner, and never probes an ungated one', async () => {
    const harness = await createHarness();
    await withSession(harness, async (automations) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: gated,
      });
      const fired = await automations.fire(fireParams());
      expect(fired.run).toBeUndefined();
      expect(fired.gate).toMatchObject({ outcome: 'blocked' });
    });
    const gate = scriptedGate([]);
    await withSession(
      harness,
      async (automations) => {
        await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { ...definition, gate: null },
        });
        const fired = await automations.fire(fireParams(2));
        // An ungated run carries the key as null.
        expect(fired.run!.gateOutputRef).toBeNull();
        expect(fired.gate).toBeUndefined();
        expect(gate.calls).toHaveLength(0);
      },
      { gate: gate.runner },
    );
  });

  it('refuses and blocks a gate on a Session whose deployment configures Hooks', async () => {
    // A probe does not run through the deployment's PreToolUse and
    // PermissionRequest Hooks, so a gate there would run around them.
    const harness = await createHarness();
    const gate = scriptedGate([]);
    await withSession(
      harness,
      async (automations) => {
        await expect(
          automations.define({
            scheduleId: SCHEDULE_ID,
            operationId: nextOperationId(),
            definition: gated,
          }),
        ).rejects.toThrow(/pins a Hook catalog for this Session/);
        expect(automations.schedules()).toHaveLength(0);
      },
      { gate: gate.runner, hooksConfigured: () => true },
    );
    // A definition committed before the Session had Hooks never probes.
    await withSession(harness, async (automations) => {
      await automations.define({
        scheduleId: SCHEDULE_ID,
        operationId: nextOperationId(),
        definition: gated,
      });
    });
    await withSession(
      harness,
      async (automations) => {
        const fired = await automations.fire(fireParams());
        expect(fired.run).toBeUndefined();
        expect(fired.gate).toMatchObject({
          outcome: 'blocked',
          detail: expect.stringContaining('pins a Hook catalog'),
        });
        expect(gate.calls).toHaveLength(0);
      },
      { gate: gate.runner, hooksConfigured: () => true, create: false },
    );
  });

  it('refuses a gate on a Session without Shell, keeps it across revisions and clears it with null', async () => {
    const harness = await createHarness();
    await withSession(
      harness,
      async (automations) => {
        await expect(
          automations.define({
            scheduleId: SCHEDULE_ID,
            operationId: nextOperationId(),
            definition: gated,
          }),
        ).rejects.toBeInstanceOf(AutomationGateUnsupportedError);
        expect(automations.schedules()).toHaveLength(0);
      },
      { shellAvailable: () => false },
    );
    await withSession(
      harness,
      async (automations) => {
        const opened = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: gated,
        });
        // A revision that names no gate keeps the committed one.
        const revised = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { prompt: 'Run the build again.' },
        });
        expect(revised.schedule.gate).toBe('./probe.sh --gate');
        expect(revised.schedule.definitionRevision).toBe(2);
        expect(revised.schedule.definitionDigest).not.toBe(
          opened.schedule.definitionDigest,
        );
        const cleared = await automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { gate: null },
        });
        expect(JSON.parse(JSON.stringify(cleared.schedule))).toHaveProperty(
          'gate',
          null,
        );
        expect(cleared.schedule.definitionRevision).toBe(3);
        await expect(
          automations.define({
            scheduleId: SCHEDULE_ID,
            operationId: nextOperationId(),
            definition: { gate: 'sleep 5 &' },
          }),
        ).rejects.toThrow(/gate must not background/);
      },
      { shellAvailable: () => true },
    );
  });
});
