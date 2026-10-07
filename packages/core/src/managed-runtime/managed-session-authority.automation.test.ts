/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
  type ManagedSessionInputRequest,
} from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  MANAGED_SESSION_ENABLED_DOMAINS,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import {
  AUTOMATION_INPUT_SOURCE,
  AUTOMATION_RESOURCE_KINDS,
  automationDefinitionDigest,
  automationInputId,
  automationRunClaimBody,
  automationRunDispatchBody,
  automationRunId,
  automationRunSettleBody,
  encodeAutomationInputEnvelope,
  scheduleOpenBody,
  scheduleRetireBody,
  scheduleRevisionBody,
  type AutomationDefinition,
} from './managed-automation-operations.js';
import type { Schedule } from './managed-automation-record.js';

// The H6b gates are real: both domains are enabled and the persistent mode
// is admitted, so this suite drives the authority with no enablement mock.
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const otherSessionId = '660e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-auto-'));
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
    now: 1_000,
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
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
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const TRUSTED = { class: 'trusted_entry' } as const;

function command(commandId: string, body: unknown) {
  return {
    operation: 'commitExtensionRecord',
    commandId,
    sessionKey,
    contentDigest: createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex'),
  };
}

const definition: AutomationDefinition = Object.freeze({
  goal: 'Nightly build',
  cron: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  prompt: 'Run the build.',
  sessionMode: 'persistent',
  overlap: 'skip',
  catchUp: 'none',
  catchUpLimit: null,
  enabled: true,
});

async function prompt(harness: Harness): Promise<ManagedSessionDurableRef> {
  return harness.store.publish(
    AUTOMATION_RESOURCE_KINDS.prompt,
    Buffer.from(definition.prompt, 'utf8'),
  );
}

function openBody(
  promptRef: ManagedSessionDurableRef,
  overrides: Partial<AutomationDefinition> = {},
  targetSessionId = sessionId,
): Schedule {
  const merged = { ...definition, ...overrides };
  return scheduleOpenBody({
    scheduleId: 'asch_1',
    ownerScopeId: sessionId,
    targetSessionId,
    definition: merged,
    promptRef,
    definitionDigest: automationDefinitionDigest(merged),
  });
}

async function commitSchedule(
  authority: LocalManagedSessionAuthority,
  body: Schedule,
) {
  return authority.commitExtensionRecord(
    command(`${body.scheduleId}:${body.definitionRevision}`, body),
    { domain: 'schedule', record: body },
    TRUSTED,
  );
}

async function input(
  harness: Harness,
  runId: string,
): Promise<ManagedSessionInputRequest> {
  const inputId = automationInputId(runId);
  return {
    inputId,
    turnId: inputId,
    source: AUTOMATION_INPUT_SOURCE,
    contentRef: await harness.store.publish(
      AUTOMATION_RESOURCE_KINDS.input,
      encodeAutomationInputEnvelope({
        automationRunId: runId,
        scheduleId: 'asch_1',
        definitionRevision: 1,
        occurrenceKey: 'schedule:2026-03-08T07:00:00Z',
        trigger: 'scheduled',
        firedAt: 1_700_000_000_000,
        text: 'Run the build.',
      }),
    ),
    deadline: null,
    admissionRef: await harness.store.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    ),
    wakeReason: 'input',
  };
}

describe('managed session authority automation enablement', () => {
  it('enables both domains explicitly and gates the target mode', async () => {
    expect(MANAGED_SESSION_ENABLED_DOMAINS).toContain('schedule');
    expect(MANAGED_SESSION_ENABLED_DOMAINS).toContain('automation_run');
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const promptRef = await prompt(harness);
      const perRun = openBody(promptRef, { sessionMode: 'per_run' }, sessionId);
      await expect(commitSchedule(authority, perRun)).rejects.toThrow(
        /schedule session mode per_run is not enabled/,
      );
      const receipt = await commitSchedule(authority, openBody(promptRef));
      expect(receipt.revision).toBe(1);
      expect(authority.extensionRecord('schedule', 'asch_1')?.record).toEqual(
        openBody(promptRef),
      );
      expect(authority.taskViews()).toHaveLength(0);
    });
  });

  it('keeps a persistent definition in its target Session', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const promptRef = await prompt(harness);
      await expect(
        commitSchedule(authority, openBody(promptRef, {}, otherSessionId)),
      ).rejects.toThrow(ManagedSessionConflictError);
      await expect(
        commitSchedule(authority, openBody(promptRef, {}, otherSessionId)),
      ).rejects.toThrow(/must be this Session/);
      expect(authority.extensionRecord('schedule', 'asch_1')).toBeUndefined();
    });
  });

  it('gates the target mode on every revision, not only the first', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const promptRef = await prompt(harness);
      const opened = openBody(promptRef);
      await commitSchedule(authority, opened);
      // The revision builder refuses a mode change itself; a body that
      // bypasses it still meets the gate at the authority.
      const moved: Schedule = {
        ...opened,
        definitionRevision: 2,
        sessionMode: 'per_run',
        targetSessionId: null,
        definitionDigest: automationDefinitionDigest({
          ...definition,
          sessionMode: 'per_run',
        }),
      };
      await expect(commitSchedule(authority, moved)).rejects.toThrow(
        /schedule session mode per_run is not enabled/,
      );
      expect(authority.extensionRecord('schedule', 'asch_1')?.revision).toBe(1);
    });
  });

  it('closes a definition over its prompt resource', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const dangling: ManagedSessionDurableRef = {
        resourceId: 'prompt-x',
        kind: AUTOMATION_RESOURCE_KINDS.prompt,
        schemaVersion: 1,
        byteLength: 14,
        digest: 'a'.repeat(64),
      };
      await expect(
        commitSchedule(authority, openBody(dangling)),
      ).rejects.toThrow(/resource prompt-x is not present/);
      const held = await prompt(harness);
      const receipt = await commitSchedule(authority, openBody(held));
      expect(receipt.revision).toBe(1);
    });
  });
});

describe('managed session authority automation runs', () => {
  const occurrenceKey = 'schedule:2026-03-08T07:00:00Z';

  async function openSchedule(
    harness: Harness,
    authority: LocalManagedSessionAuthority,
  ): Promise<Schedule> {
    const body = openBody(await prompt(harness));
    await commitSchedule(authority, body);
    return body;
  }

  async function commitRun(
    authority: LocalManagedSessionAuthority,
    record: unknown,
    revision: number,
    extra: { input?: ManagedSessionInputRequest; commandId?: string } = {},
  ) {
    const runId = (record as { automationRunId: string }).automationRunId;
    return authority.commitExtensionRecord(
      command(extra.commandId ?? `${runId}:${revision}`, record),
      {
        domain: 'automation_run',
        record,
        ...(extra.input === undefined ? {} : { input: extra.input }),
      },
      TRUSTED,
    );
  }

  it('binds a run to its live definition at the current revision', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const claim = automationRunClaimBody({ schedule, occurrenceKey });
      // No definition at all.
      await expect(
        commitRun(authority, { ...claim, scheduleId: 'asch_9' }, 1),
      ).rejects.toThrow(/live definition at the current revision/);
      // A stale revision.
      await expect(
        commitRun(authority, { ...claim, definitionRevision: 2 }, 1),
      ).rejects.toThrow(/live definition at the current revision/);
      // Another target.
      await expect(
        commitRun(authority, { ...claim, targetSessionId: otherSessionId }, 1),
      ).rejects.toThrow(/live definition at the current revision/);
      // The current revision binds.
      const receipt = await commitRun(authority, claim, 1);
      expect(receipt.revision).toBe(1);
      expect(authority.taskViews().map((view) => view.kind)).toEqual([
        'automation_run',
      ]);
    });
  });

  it('refuses a run whose id is not the derivation of its occurrence', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const claim = automationRunClaimBody({ schedule, occurrenceKey });
      await expect(
        commitRun(authority, { ...claim, automationRunId: 'run-1' }, 1),
      ).rejects.toThrow(/derived from its definition and occurrence/);
      await commitRun(authority, claim, 1);
      // The same occurrence under another id is the same refusal, and the
      // same claim under its own command id is the committed run again.
      await expect(
        commitRun(authority, { ...claim, automationRunId: 'run-2' }, 1),
      ).rejects.toThrow(/derived from its definition and occurrence/);
      const again = await commitRun(authority, claim, 1);
      expect(again.receipt.replayed).toBe(true);
      expect(again.revision).toBe(1);
      expect(authority.extensionRecordsInDomain('automation_run')).toHaveLength(
        1,
      );
    });
  });

  it('refuses a run against a retired or revised definition', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const revised = scheduleRevisionBody(schedule, {
        definition: { ...definition, cron: '30 2 * * *' },
        promptRef: schedule.promptRef,
        definitionDigest: automationDefinitionDigest({
          ...definition,
          cron: '30 2 * * *',
        }),
      });
      await commitSchedule(authority, revised);
      await expect(
        commitRun(
          authority,
          automationRunClaimBody({ schedule, occurrenceKey }),
          1,
        ),
      ).rejects.toThrow(/live definition at the current revision/);
      await commitRun(
        authority,
        automationRunClaimBody({ schedule: revised, occurrenceKey }),
        1,
      );
      const retired = scheduleRetireBody(revised);
      await commitSchedule(authority, retired);
      await expect(
        commitRun(
          authority,
          automationRunClaimBody({
            schedule: retired,
            occurrenceKey: 'manual:key-1',
          }),
          1,
        ),
      ).rejects.toThrow(/live definition at the current revision/);
      // The frozen chain takes no revision at all.
      await expect(
        commitSchedule(authority, {
          ...retired,
          definitionRevision: retired.definitionRevision + 1,
          enabled: true,
        }),
      ).rejects.toThrow(/cannot follow/);
    });
  });

  it('dispatches with the input and its wake in one transaction', async () => {
    const harness = await createHarness();
    const runId = automationRunId('asch_1', occurrenceKey);
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const claim = automationRunClaimBody({ schedule, occurrenceKey });
      await commitRun(authority, claim, 1);
      const before = authority.committedSequence;
      const request = await input(harness, runId);
      const receipt = await commitRun(
        authority,
        automationRunDispatchBody(claim),
        2,
        { input: request },
      );
      expect(receipt.revision).toBe(2);
      const events = authority.eventsInSequenceRange(
        before + 1,
        authority.committedSequence,
      );
      expect(events.map((event) => event.kind)).toEqual([
        'domain.committed',
        'input.accepted',
        'wake.requested',
      ]);
      expect(events[1]!.payload['source']).toBe(AUTOMATION_INPUT_SOURCE);
      expect(events[1]!.payload['inputId']).toBe(automationInputId(runId));
      // A retry of the dispatch answers the committed transaction.
      const again = await commitRun(
        authority,
        automationRunDispatchBody(claim),
        2,
        { input: request },
      );
      expect(again.receipt.replayed).toBe(true);
      expect(authority.committedSequence).toBe(before + 3);
    });
  });

  it('rebuilds the chains and the task view when it reopens', async () => {
    const harness = await createHarness();
    const runId = automationRunId('asch_1', occurrenceKey);
    let dispatched: ReturnType<typeof automationRunDispatchBody> | undefined;
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const claim = automationRunClaimBody({ schedule, occurrenceKey });
      await commitRun(authority, claim, 1);
      dispatched = automationRunDispatchBody(claim);
      await commitRun(authority, dispatched, 2, {
        input: await input(harness, runId),
      });
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.extensionRecord('schedule', 'asch_1')?.revision).toBe(
          1,
        );
        const run = authority.extensionRecord('automation_run', runId);
        expect(run?.revision).toBe(2);
        expect(run?.record).toEqual(dispatched);
        const [view] = authority.taskViews();
        expect(view?.kind).toBe('automation_run');
        expect(view?.state).toBe('running');
        const settled = automationRunSettleBody(dispatched!, 'settled', true);
        const receipt = await commitRun(authority, settled, 3);
        expect(receipt.revision).toBe(3);
        expect(authority.taskViews()[0]?.state).toBe('completed');
        // A settled run takes no further revision.
        await expect(
          commitRun(authority, automationRunDispatchBody(dispatched!), 4),
        ).rejects.toThrow(/cannot follow/);
      },
      { create: false },
    );
  });

  it('refuses a malformed body before publishing anything', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const schedule = await openSchedule(harness, authority);
      const claim = automationRunClaimBody({ schedule, occurrenceKey });
      const before = authority.committedSequence;
      await expect(
        commitRun(authority, { ...claim, occurrenceKey: 'webhook:e-1' }, 1),
      ).rejects.toThrow(ManagedSessionRecordError);
      expect(authority.committedSequence).toBe(before);
    });
  });
});
