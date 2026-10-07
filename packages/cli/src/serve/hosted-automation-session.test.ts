/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  AUTOMATION_INPUT_SOURCE,
  AUTOMATION_RUN_INSTRUCTION,
  automationInputId,
  automationRunClaimBody,
  automationRunId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import { settlePendingMonitorInputs } from './hosted-monitor-wake.js';
import {
  AutomationNotFoundError,
  AutomationOperationConflictError,
  AutomationQuotaError,
  AutomationRetiredError,
  AutomationRevisionStaleError,
  HostedAutomationSession,
} from './hosted-automation-session.js';

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
  options: { create?: boolean } = {},
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
      lease,
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
  } as unknown as ChatRecord;
}

function turnResult(
  turnId: string,
  state: 'completed' | 'error' | 'cancelled',
): ChatRecord {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    type: 'system',
    cwd: '/workspace',
    version: 'hosted-harness/1',
    subtype: 'turn_result',
    systemPayload: {
      promptId: turnId,
      state,
      stopReason: state === 'completed' ? 'end_turn' : state,
      endedAt: Date.now(),
    },
  } as unknown as ChatRecord;
}

describe('hosted automation definitions', () => {
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
      await expect(
        automations.define({
          scheduleId: SCHEDULE_ID,
          operationId: nextOperationId(),
          definition: { ...definition, sessionMode: 'per_run' },
        }),
      ).rejects.toThrow(/schedule session mode per_run is not enabled/);
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
      expect(fired.run.run.execution).toBe('dispatch_started');
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
      expect(fired.run.automationRunId).toBe(runId);
      expect(fired.run.run.state).toBe('running');
      expect(fired.run.run.execution).toBe('dispatch_started');
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
      const envelope = JSON.parse(
        (
          await harness.store.read(
            assertManagedSessionDurableRef(
              pending!.contentRef,
              'automation input contentRef',
            ),
          )
        ).toString('utf8'),
      ) as { text: string; occurrenceKey: string; trigger: string };
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
      expect(manual.run.automationRunId).toBe(
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
      expect(fired.run.run.execution).toBe('dispatch_started');
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
      expect(ended.run.run.state).toBe('cancelled');
      expect(ended.run.run.execution).toBe('not_started_proven');
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
