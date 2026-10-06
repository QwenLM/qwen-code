/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
  type ManagedSessionInputRequest,
} from './managed-session-authority.js';
import {
  MANAGED_EXTENSION_RECORD_BODIES,
  managedExtensionRecordKey,
  type ManagedTaskProjection,
} from './managed-extension-projection.js';
import { ManagedOperationGrantGate } from './managed-operation-grant-gate.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

const enablement = vi.hoisted(() => ({ monitorRun: true }));
const chainRules = vi.hoisted(() => ({ lenient: false }));

// Lets a test write revisions that do not chain, as a log written under
// looser rules would hold them.
vi.mock('./managed-extension-projection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-extension-projection.js')>();
  const monitor = actual.MANAGED_EXTENSION_RECORD_BODIES.monitor_run!;
  return {
    ...actual,
    MANAGED_EXTENSION_RECORD_BODIES: {
      monitor_run: {
        ...monitor,
        isSuccessor: (previous: unknown, next: unknown) =>
          chainRules.lenient || monitor.isSuccessor(previous, next),
      },
    },
  };
});

// monitor_run is enabled by H3; this suite runs the H0c path ahead of it.
vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (domain !== 'monitor_run' || !enablement.monitorRun) {
        actual.assertManagedSessionDomainEnabled(domain);
      }
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.monitorRun = true;
  chainRules.lenient = false;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-ext-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const harness: Harness = {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    now: 1_000,
  };
  await publishLifeRefs(harness);
  return harness;
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

const BINDING_1 = { runtimeBindingId: 'binding-1', generation: '1' };
const BINDING_2 = { runtimeBindingId: 'binding-2', generation: '2' };

function run(overrides: Record<string, unknown>) {
  return {
    state: 'admitted',
    reason: null,
    definition: null,
    executionCallId: 'call-monitor-1',
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: 'intent',
    runtime: null,
    delivery: null,
    ...overrides,
  };
}

function monitor(
  runOverrides: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    monitorId: 'monitor-1',
    ownerScopeId: 'scope-main',
    commandRef: ref('args-monitor-1', 'managed-tool-args'),
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1000,
    startReceiptRef: null,
    observationSequence: 0,
    lastObservationRef: null,
    notifiedThrough: 0,
    stopReason: null,
    outputRef: null,
    run: run(runOverrides),
    ...overrides,
  };
}

/** Content the constant LIFE refs describe, exactly as read() verifies. */
const REF_BYTES = Buffer.alloc(64, 0);
const REF_DIGEST = createHash('sha256').update(REF_BYTES).digest('hex');

function ref(resourceId: string, kind: string): ManagedSessionDurableRef {
  return {
    resourceId,
    kind,
    schemaVersion: 1,
    byteLength: REF_BYTES.byteLength,
    digest: REF_DIGEST,
  };
}

const RECEIPT_1 = ref('receipt-1', 'managed-runtime-receipt');
const RECEIPT_2 = ref('receipt-2', 'managed-runtime-receipt');
const OBSERVATION_1 = ref('observation-1', 'managed-monitor-observation');

/**
 * A watch that starts, observes once, loses its Runtime and is rebuilt —
 * the static chain main's suite composes from; the bytes each ref names
 * live in the store, seeded per harness, so commit-time closure reads
 * them back exactly as the closure rule demands.
 */
const LIFE = [
  monitor({}),
  monitor({ execution: 'dispatch_started', runtime: BINDING_1 }),
  monitor(
    { state: 'running', execution: 'running_attached', runtime: BINDING_1 },
    { startReceiptRef: RECEIPT_1 },
  ),
  monitor(
    { state: 'running', execution: 'running_attached', runtime: BINDING_1 },
    {
      startReceiptRef: RECEIPT_1,
      observationSequence: 1,
      lastObservationRef: OBSERVATION_1,
    },
  ),
  monitor(
    {
      state: 'recovery_blocked',
      reason: 'runtime_lost',
      execution: 'outcome_unknown',
      runtime: BINDING_1,
    },
    {
      startReceiptRef: RECEIPT_1,
      observationSequence: 1,
      lastObservationRef: OBSERVATION_1,
    },
  ),
  monitor(
    {
      state: 'running',
      reason: 'runtime_lost',
      execution: 'running_attached',
      runtime: BINDING_2,
    },
    {
      startReceiptRef: RECEIPT_2,
      observationSequence: 1,
      lastObservationRef: OBSERVATION_1,
    },
  ),
  monitor(
    { state: 'cancelled', execution: 'settled', runtime: BINDING_2 },
    {
      startReceiptRef: RECEIPT_2,
      observationSequence: 1,
      lastObservationRef: OBSERVATION_1,
      notifiedThrough: 1,
      stopReason: 'stop_requested',
    },
  ),
];

/** The bytes LIFE's constant refs name, landed once per store root. */
async function publishLifeRefs(harness: Harness): Promise<void> {
  await Promise.all(
    [
      ['args-monitor-1', 'managed-tool-args'],
      ['receipt-1', 'managed-runtime-receipt'],
      ['receipt-2', 'managed-runtime-receipt'],
      ['observation-1', 'managed-monitor-observation'],
    ].map(async ([resourceId, kind]) => {
      const directory = path.join(harness.store.sessionRoot, kind!);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, resourceId!), REF_BYTES);
    }),
  );
}
interface MonitorRefs {
  readonly args: ManagedSessionDurableRef;
  readonly receipt1: ManagedSessionDurableRef;
  readonly receipt2: ManagedSessionDurableRef;
  readonly observation: ManagedSessionDurableRef;
}

const monitorRefsCache = new WeakMap<Harness, Promise<MonitorRefs>>();

/** Every revision of a chain cites the same refs, so publish them once per harness. */
function publishMonitorRefs(harness: Harness): Promise<MonitorRefs> {
  const cached = monitorRefsCache.get(harness);
  if (cached) return cached;
  const pending = (async (): Promise<MonitorRefs> => ({
    args: await harness.store.publish(
      'managed-tool-args',
      Buffer.from('{"command":"du -sh ."}', 'utf8'),
    ),
    receipt1: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"pid":7}', 'utf8'),
    ),
    receipt2: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"pid":8}', 'utf8'),
    ),
    observation: await harness.store.publish(
      'managed-monitor-observation',
      Buffer.from('{"size":1024}', 'utf8'),
    ),
  }))();
  monitorRefsCache.set(harness, pending);
  return pending;
}

/** A watch that starts, observes once, loses its Runtime and is rebuilt. */

/** A watch's chain, identical bodies to the static LIFE every test cites. */
async function monitorLife(harness: Harness) {
  await publishLifeRefs(harness);
  return LIFE;
}

function command(commandId: string, digest = 'd') {
  return {
    operation: 'commitMonitorRun',
    commandId,
    sessionKey,
    contentDigest: digest.repeat(64),
  };
}

const TRUSTED = { class: 'trusted_entry' } as const;

async function commitLife(
  harness: Harness,
  authority: LocalManagedSessionAuthority,
  count?: number,
) {
  const life = await monitorLife(harness);
  count ??= life.length;
  for (let index = 0; index < count; index++) {
    harness.now = 1_000 * (index + 1);
    await authority.commitExtensionRecord(
      command(`monitor-1:${index + 1}`),
      { domain: 'monitor_run', record: life[index] },
      TRUSTED,
    );
  }
}

const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'monitor_run', 'monitor-1')}`;

async function publishedBodies(
  harness: Harness,
  kind = 'managed-monitor_run',
): Promise<number> {
  try {
    return (
      await fs.readdir(
        path.join(harness.runtimeBaseDir, 'resources', sessionId, kind),
      )
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

// The same chains ManagedExtensionRecordStoreTest commits through the Java
// Session store, so both sides must project and refuse them alike.
const chains = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'contracts',
      'managed-extension-projection-v1.fixtures.json',
    ),
    'utf8',
  ),
) as {
  readonly monitorChainCases: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly revisions: ReadonlyArray<{
      readonly occurredAt: number;
      readonly monitorRun: { readonly monitorId: string };
      readonly view: ManagedTaskProjection;
    }>;
  }>;
  readonly monitorChainRejectCases: ReadonlyArray<{
    readonly id: string;
    readonly accepted: readonly unknown[];
    readonly next: unknown;
    readonly reuseCommandOf?: number;
  }>;
};

// Same as the Java side: fixtures cite resources by fictional identity, so
// every chain first mirrors them as real, same-kind placeholder resources —
// identity stays fixed across the chain, only lookup becomes real.
const fixtureResourcesCache = new WeakMap<
  Harness,
  Map<string, Promise<ManagedSessionDurableRef>>
>();

async function materializeFixtureMonitorRun(
  harness: Harness,
  body: unknown,
): Promise<unknown> {
  const monitor = body as Record<string, unknown>;
  const cache =
    fixtureResourcesCache.get(harness) ??
    fixtureResourcesCache.set(harness, new Map()).get(harness)!;
  const next = { ...monitor };
  for (const field of [
    'commandRef',
    'startReceiptRef',
    'outputRef',
    'lastObservationRef',
  ] as const) {
    const ref = next[field];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const typed = ref as Record<string, unknown>;
    const key = `${typed['resourceId']}${typed['kind']}${typed['digest']}`;
    const pending =
      cache.get(key) ??
      cache
        .set(
          key,
          (async () =>
            await harness.store.publish(
              typed['kind'] as string,
              Buffer.alloc(Number(typed['byteLength'])),
            ))(),
        )
        .get(key)!;
    next[field] = await pending;
  }
  return next;
}

describe('managed-extension-projection/1 monitor chains', () => {
  it.each(chains.monitorChainCases)(
    'commits and projects: $id',
    async (each) => {
      expect(each.sessionId).toBe(sessionId);
      const harness = await createHarness();
      await withAuthority(harness, async (authority) => {
        for (const [index, revision] of each.revisions.entries()) {
          harness.now = revision.occurredAt;
          await authority.commitExtensionRecord(
            command(`chain:${index}`),
            {
              domain: 'monitor_run',
              record: await materializeFixtureMonitorRun(
                harness,
                revision.monitorRun,
              ),
            },
            TRUSTED,
          );
          const [view] = authority.taskViews();
          expect(view).toEqual({
            taskId: `task_${managedExtensionRecordKey(sessionId, 'monitor_run', revision.monitorRun.monitorId)}`,
            sessionId,
            kind: 'monitor',
            ...revision.view,
          });
        }
      });
    },
  );

  it.each(chains.monitorChainRejectCases)('refuses: $id', async (each) => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of each.accepted.entries()) {
        await authority.commitExtensionRecord(
          command(`chain:${index}`),
          {
            domain: 'monitor_run',
            record: await materializeFixtureMonitorRun(harness, record),
          },
          TRUSTED,
        );
      }
      const before = authority.committedSequence;
      const next =
        each.reuseCommandOf === undefined
          ? command('chain:next')
          : {
              ...command(`chain:${each.reuseCommandOf}`),
              operation: 'reopenMonitorRun',
            };
      await expect(
        authority.commitExtensionRecord(
          next,
          {
            domain: 'monitor_run',
            record: await materializeFixtureMonitorRun(harness, each.next),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      expect(authority.committedSequence).toBe(before);
    });
  });
});

describe('managed session authority Stage H records', () => {
  it('chains monitor revisions and projects the task', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      expect(first).toMatchObject({
        domain: 'monitor_run',
        recordId: 'monitor-1',
        taskId: TASK_ID,
        revision: 1,
        receipt: { replayed: false },
      });
      expect(first.recordRef.kind).toBe('managed-monitor_run');
      // The resource holds exactly the closed body, with no envelope.
      expect(
        JSON.parse((await harness.store.read(first.recordRef)).toString()),
      ).toEqual(life[0]);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'monitor',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);

      for (let index = 1; index < life.length; index++) {
        harness.now = 1_000 * (index + 1);
        await authority.commitExtensionRecord(
          command(`monitor-1:${index + 1}`),
          { domain: 'monitor_run', record: life[index] },
          TRUSTED,
        );
        if (index === 4) {
          expect(authority.taskViews()[0]).toMatchObject({
            state: 'recovery_blocked',
            runtimeState: 'lost',
          });
        }
        if (index === 5) {
          expect(authority.taskViews()[0]).toMatchObject({
            state: 'degraded',
            runtimeState: 'ready',
          });
        }
      }
      expect(
        authority.extensionRecord('monitor_run', 'monitor-1'),
      ).toMatchObject({
        revision: life.length,
        operationId: 'monitor-1:1',
        record: life.at(-1),
      });
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'monitor',
          state: 'cancelled',
          runtimeState: null,
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 3_000,
          settledAt: 7_000,
        },
      ]);
    });
  });

  it('keeps one chain per monitor and lists the newest first', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      harness.now = 2_000;
      const second = await authority.commitExtensionRecord(
        command('monitor-2:1'),
        {
          domain: 'monitor_run',
          record: { ...life[0], monitorId: 'monitor-2' },
        },
        TRUSTED,
      );
      expect(second.revision).toBe(1);
      const third = await authority.commitExtensionRecord(
        command('monitor-3:1'),
        {
          domain: 'monitor_run',
          record: { ...life[0], monitorId: 'monitor-3' },
        },
        TRUSTED,
      );
      // Created at the same time, the two newest order by task ID.
      const tied = [second.taskId, third.taskId].sort().reverse();
      expect(authority.taskViews().map((view) => view.taskId)).toEqual([
        ...tied,
        TASK_ID,
      ]);
    });
  });

  it('refuses a first revision that does not open its run', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const before = authority.committedSequence;
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          { domain: 'monitor_run', record: life[2] },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionConflictError);
      expect(authority.committedSequence).toBe(before);
      expect(authority.taskViews()).toEqual([]);
    });
  });

  it('refuses a revision that is not a successor', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 4);
      // A lost watch observes nothing, so the count cannot grow while blocked.
      const skipped = monitor(
        {
          state: 'recovery_blocked',
          reason: 'runtime_lost',
          execution: 'outcome_unknown',
          runtime: BINDING_1,
        },
        {
          commandRef: (await publishMonitorRefs(harness)).args,
          startReceiptRef: (await publishMonitorRefs(harness)).receipt1,
          observationSequence: 0,
          lastObservationRef: null,
        },
      );
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:5'),
          { domain: 'monitor_run', record: skipped },
          TRUSTED,
        ),
      ).rejects.toThrow(/cannot follow its revision 4/);
      expect(
        authority.extensionRecord('monitor_run', 'monitor-1')?.revision,
      ).toBe(4);
    });
  });

  it('refuses a malformed body before publishing it', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          {
            domain: 'monitor_run',
            record: { ...life[0], operationId: 'envelope-field' },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      expect(await publishedBodies(harness)).toBe(0);
    });
  });

  it('refuses a stale or foreign command before publishing it', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          { ...command('monitor-1:1'), expectedSequence: 99 },
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/re-read before retrying/);
      await expect(
        authority.commitExtensionRecord(
          {
            ...command('monitor-1:1'),
            sessionKey: { ...sessionKey, sessionId: 'another-session' },
          },
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/does not match this session/);
      expect(await publishedBodies(harness)).toBe(0);
    });
  });

  it('refuses a record that cites a resource the store does not hold', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          {
            domain: 'monitor_run',
            record: {
              ...life[0],
              commandRef: {
                resourceId: 'args-nobody-committed',
                kind: 'managed-tool-args',
                schemaVersion: 1,
                byteLength: 22,
                digest: 'b'.repeat(64),
              },
            },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/is not present/);
    });
  });
  it('refuses a malformed command identity before publishing it', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      // The commit marker refuses these identities too, but only after the
      // body is published, so each retry would orphan one more body.
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:\u0001note'),
          { domain: 'monitor_run', record: LIFE[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /command\.commandId must not contain control characters/,
      );
      await expect(
        authority.commitExtensionRecord(
          command('a'.repeat(513)),
          { domain: 'monitor_run', record: LIFE[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/command\.commandId exceeds 512 UTF-8 bytes/);
      await expect(
        authority.commitExtensionRecord(
          { ...command('monitor-1:op'), operation: 'x'.repeat(4097) },
          { domain: 'monitor_run', record: LIFE[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/command\.operation exceeds 4096 UTF-8 bytes/);
      await expect(
        authority.commitExtensionRecord(
          { ...command('monitor-1:digest'), contentDigest: 'not-a-digest' },
          { domain: 'monitor_run', record: LIFE[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /command\.contentDigest must be a lowercase SHA-256 hex digest/,
      );
      await expect(
        authority.commitDomainRecord(
          command('rename:goal\u0001'),
          {
            domain: 'goal_state',
            content: { goalId: 'goal-1', title: 'goal' },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /command\.commandId must not contain control characters/,
      );
      expect(await publishedBodies(harness)).toBe(0);
      expect(await publishedBodies(harness, 'managed-goal_state')).toBe(0);
    });
  });
  it('refuses the actor or the input before publishing it', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:actor'),
          { domain: 'monitor_run', record: LIFE[0] },
          { class: 'authority' },
        ),
      ).rejects.toThrow(/must not be requested by authority/);
      await expect(
        authority.commitDomainRecord(
          command('rename:actor'),
          {
            domain: 'goal_state',
            content: { goalId: 'goal-1', title: 'goal' },
          },
          { class: 'authority' },
        ),
      ).rejects.toThrow(/must not be requested by authority/);
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:input'),
          {
            domain: 'monitor_run',
            record: LIFE[0],
            input: {
              inputId: '',
              turnId: 'monitor-1:input',
              source: 'monitor',
              contentRef: await harness.store.publish(
                'managed-input',
                Buffer.from('{"text":"changed"}', 'utf8'),
              ),
              deadline: null,
              admissionRef: await harness.store.publish(
                'managed-admission',
                Buffer.from('{}', 'utf8'),
              ),
              wakeReason: 'input',
            },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/inputId/);
      await expect(
        authority.commitDomainRecord(
          { ...command('rename:stale-sequence'), expectedSequence: 99 },
          {
            domain: 'goal_state',
            content: { goalId: 'goal-1', title: 'stale' },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/expectedSequence 99 does not match/);
      // Refused before publishing: no monitor or goal-state body landed.
      expect(await publishedBodies(harness)).toBe(0);
      expect(await publishedBodies(harness, 'managed-goal_state')).toBe(0);
      // Positive control: produced commits publish exactly one body each.
      await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: LIFE[0] },
        TRUSTED,
      );
      expect(await publishedBodies(harness)).toBe(1);
      await authority.commitDomainRecord(
        command('rename:goal'),
        {
          domain: 'goal_state',
          content: { goalId: 'goal-1', title: 'grown' },
        },
        TRUSTED,
      );
      expect(await publishedBodies(harness, 'managed-goal_state')).toBe(1);
      // An accepted input commits its events once; the same input under a
      // fresh command is refused by the preflight, before the body lands.
      const input: ManagedSessionInputRequest = {
        inputId: 'monitor-1:notify:1',
        turnId: 'monitor-1:notify:1',
        source: 'monitor',
        contentRef: await harness.store.publish(
          'managed-input',
          Buffer.from('{"text":"changed"}', 'utf8'),
        ),
        deadline: null,
        admissionRef: await harness.store.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      };
      await authority.commitExtensionRecord(
        command('monitor-1:2'),
        { domain: 'monitor_run', record: LIFE[1], input },
        TRUSTED,
      );
      const bodiesAfterInput = await publishedBodies(harness);
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:dup'),
          { domain: 'monitor_run', record: LIFE[2], input },
          TRUSTED,
        ),
      ).rejects.toThrow(/is already committed/);
      expect(await publishedBodies(harness)).toBe(bodiesAfterInput);
    });
  });
  it('reopens over a record committed before its domain had a body', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      // commitDomainRecord serves the envelope domains already enabled: its
      // body is the envelope, which no closed Stage H body can parse.
      await authority.commitDomainRecord(
        command('rename:goal'),
        {
          domain: 'goal_state',
          content: { goalId: 'goal-1', title: 'pre-body' },
        },
        TRUSTED,
      );
    });
    const bodies = MANAGED_EXTENSION_RECORD_BODIES as unknown as Record<
      string,
      unknown
    >;
    bodies['goal_state'] = MANAGED_EXTENSION_RECORD_BODIES['monitor_run'];
    // The registry is mutable here only because this file's vi.mock of
    // './managed-extension-projection.js' returns a plain object literal.
    const reads = vi.spyOn(harness.store, 'read');
    try {
      await withAuthority(
        harness,
        async (authority) => {
          // The envelope is skipped as a pre-registration record; nothing
          // materializes from it.
          expect(authority.taskViews()).toEqual([]);
          expect(reads).toHaveBeenCalledTimes(1);
        },
        { create: false },
      );
    } finally {
      delete bodies['goal_state'];
    }
  });
  it('reads each committed body once for the same views across a restart', async () => {
    const harness = await createHarness();
    const before = await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 3);
      return {
        views: authority.taskViews(),
        extensionRecord: authority.extensionRecord('monitor_run', 'monitor-1'),
      };
    });
    const reads = vi.spyOn(harness.store, 'read');
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.taskViews()).toEqual(before.views);
        expect(
          authority.extensionRecord('monitor_run', 'monitor-1'),
        ).toMatchObject({
          recordId: before.extensionRecord!.recordId,
          revision: before.extensionRecord!.revision,
          recordRef: before.extensionRecord!.recordRef,
        });
      },
      { create: false },
    );
    // One serialized body read per committed revision — and one per
    // distinct resource the closures name, verified on the same pass.
    expect(reads).toHaveBeenCalledTimes(5);
  });

  it('keeps the Stage H event IDs for Stage H records', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.appendExecution(
          command('squatter'),
          [
            {
              v: 1,
              sequence: authority.committedSequence + 1,
              eventId: 'monitor_run:1',
              sessionKey,
              kind: 'cancel.requested',
              occurredAt: harness.now,
              payload: {
                requestId: 'cancel-1',
                target: null,
                reason: 'user',
                requestedBy: 'user',
              },
            },
          ],
          TRUSTED,
        ),
      ).rejects.toThrow(/reserved for Stage H records/);
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });

  it('commits a notification input and its wake with the record', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 4);
      const input: ManagedSessionInputRequest = {
        inputId: 'monitor-1:notify:1',
        turnId: 'monitor-1:notify:1',
        source: 'monitor',
        contentRef: await harness.store.publish(
          'managed-input',
          Buffer.from('{"text":"changed"}', 'utf8'),
        ),
        deadline: null,
        admissionRef: await harness.store.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      };
      const notified = { ...life[3], notifiedThrough: 1 };
      const committed = await authority.commitExtensionRecord(
        command('monitor-1:notify:1'),
        { domain: 'monitor_run', record: notified, input },
        TRUSTED,
      );
      const { firstSequence, lastSequence } = committed.receipt;
      expect(lastSequence - firstSequence).toBe(2);
      const events = authority.eventsInSequenceRange(
        firstSequence,
        lastSequence,
      );
      expect(events.map((event) => event.kind)).toEqual([
        'domain.committed',
        'input.accepted',
        'wake.requested',
      ]);
      expect(events[2].payload).toMatchObject({
        sourceEventId: 'monitor-1:notify:1:accepted',
        requiredSequence: events[1].sequence,
      });
    });
  });

  it('replays a retried command without publishing again', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 2);
      const sequence = authority.committedSequence;
      const bodies = path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        'managed-monitor_run',
      );
      const published = (await fs.readdir(bodies)).length;
      const replay = await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      expect(replay).toMatchObject({
        revision: 1,
        receipt: { replayed: true },
      });
      expect(replay.recordRef).toEqual(
        authority
          .eventsInSequenceRange(1, sequence)
          .find((event) => event.kind === 'domain.committed')?.payload[
          'recordRef'
        ],
      );
      expect(authority.committedSequence).toBe(sequence);
      expect((await fs.readdir(bodies)).length).toBe(published);
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1', 'e'),
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/different content/);
    });
  });

  it('refuses a monitor record committed around its chain', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const recordRef = await harness.store.publish(
        'managed-monitor_run',
        Buffer.from(JSON.stringify(life[0]), 'utf8'),
      );
      await expect(
        authority.appendExecution(
          command('raw-monitor'),
          [
            {
              v: 1,
              sequence: authority.committedSequence + 1,
              eventId: 'monitor_run:1',
              sessionKey,
              kind: 'domain.committed',
              occurredAt: harness.now,
              payload: {
                domain: 'monitor_run',
                version: 1,
                operationId: 'raw-monitor',
                recordRef,
              },
            },
          ],
          TRUSTED,
        ),
      ).rejects.toThrow(/only through commitExtensionRecord/);
    });
  });

  it('refuses a record of a disabled domain on the generic paths', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const recordRef = await harness.store.publish(
        'managed-schedule',
        Buffer.from('{}', 'utf8'),
      );
      const sequence = authority.committedSequence;
      await expect(
        authority.appendExecution(
          command('raw-schedule'),
          [
            {
              v: 1,
              sequence: sequence + 1,
              eventId: 'schedule-1',
              sessionKey,
              kind: 'domain.committed',
              occurredAt: harness.now,
              payload: {
                domain: 'schedule',
                version: 1,
                operationId: 'raw-schedule',
                recordRef,
              },
            },
          ],
          TRUSTED,
        ),
      ).rejects.toThrow(/not enabled for submission/);
      expect(authority.committedSequence).toBe(sequence);
    });
  });

  it('refuses domains without a body and disabled domains', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('schedule-1'),
          { domain: 'schedule', record: {} },
          TRUSTED,
        ),
      ).rejects.toThrow(/has no Stage H record body/);
      enablement.monitorRun = false;
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/not enabled for submission/);
    });
  });

  it('rebuilds the chains and the task list after a restart', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    const before = await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 5);
      return authority.taskViews();
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.taskViews()).toEqual(before);
        expect(
          authority.extensionRecord('monitor_run', 'monitor-1'),
        ).toMatchObject({ revision: 5, operationId: 'monitor-1:1' });
        await expect(
          authority.commitExtensionRecord(
            command('monitor-1:bad'),
            { domain: 'monitor_run', record: life[0] },
            TRUSTED,
          ),
        ).rejects.toThrow(ManagedSessionConflictError);
        harness.now = 6_000;
        const next = await authority.commitExtensionRecord(
          command('monitor-1:6'),
          { domain: 'monitor_run', record: life[5] },
          TRUSTED,
        );
        expect(next.revision).toBe(6);
        expect(authority.taskViews()[0]).toMatchObject({
          state: 'degraded',
          startedAt: 3_000,
        });
      },
      { create: false },
    );
  });

  it('fails to reopen when a committed body is missing', async () => {
    const harness = await createHarness();
    const recordRef = await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 1);
      return authority.extensionRecord('monitor_run', 'monitor-1')!.recordRef;
    });
    await fs.rm(
      path.join(
        harness.runtimeBaseDir,
        'resources',
        sessionId,
        recordRef.kind,
        recordRef.resourceId,
      ),
    );
    await expect(
      withAuthority(harness, async () => undefined, { create: false }),
    ).rejects.toThrow(ManagedSessionRecordError);
  });

  it('fails to reopen when committed revisions no longer chain', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      chainRules.lenient = true;
      await commitLife(harness, authority, 1);
      await authority.commitExtensionRecord(
        command('monitor-1:skip'),
        { domain: 'monitor_run', record: life[3] },
        TRUSTED,
      );
    });
    chainRules.lenient = false;
    await expect(
      withAuthority(harness, async () => undefined, { create: false }),
    ).rejects.toThrow(
      /session log is corrupt: monitor_run record monitor-1 cannot follow its revision 1/,
    );
  });

  it('issues grants the Runtime gate installs, renews and replaces', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await commitLife(harness, authority, 5);
      const request = {
        domain: 'monitor_run' as const,
        recordId: 'monitor-1',
        ownerId: 'runtime-monitor-owner',
        workspaceGeneration: '3',
        phases: ['rebuild_watch'],
        leaseDurationMs: 30_000,
      };
      const grant = authority.issueOperationGrant(request);
      expect(grant).toMatchObject({
        sessionKey,
        operationId: 'monitor-1:1',
        domain: 'monitor_run',
        operationRevision: 5,
        resourceScope: {
          recordRef: authority.extensionRecord('monitor_run', 'monitor-1')
            ?.recordRef,
          phases: ['rebuild_watch'],
        },
        expiresAt: harness.now + 30_000,
      });
      const gate = new ManagedOperationGrantGate();
      expect(gate.install(grant)).toBe('installed');
      expect(gate.install(grant)).toBe('unchanged');
      expect(
        gate.admits(sessionKey, 'monitor-1:1', 'rebuild_watch', harness.now),
      ).toBe(true);

      harness.now += 1_000;
      expect(gate.install(authority.issueOperationGrant(request))).toBe(
        'installed',
      );
      // The authority issues another owner's grant under the same revision,
      // and the gate refuses it until the record has a new revision.
      const otherOwner = authority.issueOperationGrant({
        ...request,
        ownerId: 'other-owner',
      });
      expect(otherOwner.operationRevision).toBe(5);
      expect(() => gate.install(otherOwner)).toThrow(
        /cannot replace revision 5/,
      );

      harness.now = 6_000;
      await authority.commitExtensionRecord(
        command('monitor-1:6'),
        { domain: 'monitor_run', record: life[5] },
        TRUSTED,
      );
      expect(
        gate.install(
          authority.issueOperationGrant({ ...request, ownerId: 'other-owner' }),
        ),
      ).toBe('installed');
    });
  });

  it('refuses a grant for a record that was never committed', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      expect(() =>
        authority.issueOperationGrant({
          domain: 'monitor_run',
          recordId: 'monitor-1',
          ownerId: 'owner',
          workspaceGeneration: '1',
          phases: ['rebuild_watch'],
          leaseDurationMs: 30_000,
        }),
      ).toThrow(/is committed/);
    });
  });

  it('lets a command open one record, whatever its operation name', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        { ...command('open-1'), operation: 'startMonitor' },
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('open-1'),
          {
            domain: 'monitor_run',
            record: { ...life[0], monitorId: 'monitor-2' },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/already opened monitor_run record monitor-1/);
      expect(authority.taskViews()).toHaveLength(1);
    });
  });

  it('refuses a Stage H retry of a command committed without a record', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const shared = command('shared-1');
      await authority.submitInput(shared, {
        inputId: 'shared-1',
        turnId: 'shared-1',
        source: 'user',
        contentRef: await harness.store.publish(
          'managed-input',
          Buffer.from('{"text":"hello"}', 'utf8'),
        ),
        deadline: null,
        admissionRef: await harness.store.publish(
          'managed-admission',
          Buffer.from('{}', 'utf8'),
        ),
        wakeReason: 'input',
      });
      const sequence = authority.committedSequence;
      await expect(
        authority.commitExtensionRecord(
          shared,
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(/committed without a Stage H record/);
      expect(await publishedBodies(harness)).toBe(0);
      expect(authority.committedSequence).toBe(sequence);
      expect(authority.taskViews()).toEqual([]);
      expect(authority.extensionRecord('monitor_run', 'monitor-1')).toBe(
        undefined,
      );
    });
  });

  it('shows the record as soon as its transaction commits', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const journal = (
        authority as unknown as {
          journal: { appendTransaction(records: unknown[]): Promise<void> };
        }
      ).journal;
      const append = journal.appendTransaction.bind(journal);
      const seen: Array<[number, number]> = [];
      // Readers woken by the append keep reading for a few turns of the
      // microtask queue, across the point where the commit lands.
      vi.spyOn(journal, 'appendTransaction').mockImplementation(
        async (records) => {
          await append(records);
          const observe = (turns: number): void => {
            seen.push([
              authority.committedSequence,
              authority.taskViews().length,
            ]);
            if (turns > 0) queueMicrotask(() => observe(turns - 1));
          };
          queueMicrotask(() => observe(10));
        },
      );
      await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      expect(seen.map(([committed]) => committed)).toContain(1);
      for (const [committed, tasks] of seen) {
        expect(tasks).toBe(committed);
      }
    });
  });

  it('fails to reopen when two records share their opening command', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        { ...command('open-1'), operation: 'startMonitor' },
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      // A writer without the one-record rule, as a log written under looser
      // rules would hold it.
      const rules = vi
        .spyOn(
          LocalManagedSessionAuthority.prototype as unknown as {
            assertExtensionRevision(): void;
          },
          'assertExtensionRevision',
        )
        .mockImplementation(() => undefined);
      await authority.commitExtensionRecord(
        command('open-1'),
        {
          domain: 'monitor_run',
          record: { ...life[0], monitorId: 'monitor-2' },
        },
        TRUSTED,
      );
      rules.mockRestore();
    });
    await expect(
      withAuthority(harness, async () => undefined, { create: false }),
    ).rejects.toThrow(
      /session log is corrupt: command open-1 already opened monitor_run record monitor-1/,
    );
  });

  it('replays a committed command after its domain was disabled', async () => {
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      enablement.monitorRun = false;
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:1'),
          { domain: 'monitor_run', record: life[0] },
          TRUSTED,
        ),
      ).resolves.toMatchObject({
        recordRef: first.recordRef,
        receipt: { replayed: true },
      });
      await expect(
        authority.commitExtensionRecord(
          command('monitor-1:2'),
          { domain: 'monitor_run', record: life[1] },
          TRUSTED,
        ),
      ).rejects.toThrow(/not enabled for submission/);
    });
  });
});

describe('reader compatibility for the H3 domains', () => {
  it('stamps a new Session with a reader every deployed version carries', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      expect(authority.sessionHeader.minimumReader).toBe('managed-session/1');
    });
  });

  it('admits monitor_run into the same v1 Session, enabled or not at all', async () => {
    // Every deployed reader parses monitor_run since #12837; the only gate
    // a domain ever needs is the enablement list, not a header version.
    const harness = await createHarness();
    const life = await monitorLife(harness);
    await withAuthority(harness, async (authority) => {
      expect(authority.sessionHeader.minimumReader).toBe('managed-session/1');
      await authority.commitExtensionRecord(
        command('monitor-1:1'),
        { domain: 'monitor_run', record: life[0] },
        TRUSTED,
      );
      expect(
        authority.extensionRecord('monitor_run', 'monitor-1')?.revision,
      ).toBe(1);
    });
  });
});
