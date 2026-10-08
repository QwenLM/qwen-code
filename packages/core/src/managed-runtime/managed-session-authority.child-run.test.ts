/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { managedExtensionRecordKey } from './managed-extension-projection.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

// child_run is enabled by the H3 enablement slice; this suite runs the
// commit/rebuild path ahead of it, like the monitor suite does for H0c.
const enablement = vi.hoisted(() => ({ childRun: true }));

vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (domain !== 'child_run' || !enablement.childRun) {
        actual.assertManagedSessionDomainEnabled(domain);
      }
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.childRun = true;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-child-'));
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

const BINDING_1 = { runtimeBindingId: 'binding-1', generation: '1' };

interface ShellRefs {
  readonly args: ManagedSessionDurableRef;
  readonly receipt: ManagedSessionDurableRef;
  readonly manifestA: ManagedSessionDurableRef;
  readonly manifestB: ManagedSessionDurableRef;
}

// The writer-side closure reads every reference a body names, so the test
// publishes real content and builds records from the returned refs.
async function publishRefs(harness: Harness): Promise<ShellRefs> {
  return {
    args: await harness.store.publish(
      'managed-tool-args',
      Buffer.from('{"command":"yes"}', 'utf8'),
    ),
    receipt: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"pid":1}', 'utf8'),
    ),
    manifestA: await harness.store.publish(
      'managed-tool-result-manifest',
      Buffer.from('{"pages":1}', 'utf8'),
    ),
    manifestB: await harness.store.publish(
      'managed-tool-result-manifest',
      Buffer.from('{"pages":2}', 'utf8'),
    ),
  };
}

function run(overrides: Record<string, unknown>) {
  return {
    state: 'admitted',
    reason: null,
    definition: null,
    executionCallId: 'call-shell-1',
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: 'intent',
    runtime: null,
    delivery: null,
    ...overrides,
  };
}

function shell(
  refs: ShellRefs,
  runOverrides: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: 'shell',
    shellId: 'shell-1',
    ownerScopeId: 'scope-main',
    commandRef: refs.args,
    startReceiptRef: null,
    outputRef: null,
    stopReason: null,
    stopRequested: false,
    exitCode: null,
    exitSignal: null,
    run: run(runOverrides),
    ...overrides,
  };
}

/** A Shell that starts, writes output and exits. */
function life(refs: ShellRefs) {
  return [
    shell(refs, {}),
    shell(refs, {
      state: 'running',
      execution: 'dispatch_started',
      runtime: BINDING_1,
    }),
    shell(
      refs,
      { state: 'waiting', execution: 'running_attached', runtime: BINDING_1 },
      { startReceiptRef: refs.receipt },
    ),
    shell(
      refs,
      { state: 'running', execution: 'running_attached', runtime: BINDING_1 },
      { startReceiptRef: refs.receipt, outputRef: refs.manifestA },
    ),
    shell(
      refs,
      { state: 'waiting', execution: 'running_attached', runtime: BINDING_1 },
      { startReceiptRef: refs.receipt, outputRef: refs.manifestB },
    ),
    shell(
      refs,
      { state: 'settled', execution: 'settled', runtime: BINDING_1 },
      {
        startReceiptRef: refs.receipt,
        outputRef: refs.manifestB,
        stopReason: 'exited',
        exitCode: 0,
      },
    ),
  ];
}

function command(commandId: string) {
  return {
    operation: 'commitChildRun',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

const TRUSTED = { class: 'trusted_entry' } as const;

const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'child_run', 'shell-1')}`;

async function publishedBodies(harness: Harness): Promise<number> {
  try {
    return (
      await fs.readdir(
        path.join(
          harness.runtimeBaseDir,
          'resources',
          sessionId,
          'managed-child_run',
        ),
      )
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

describe('managed session authority child_run records', () => {
  it('chains shell revisions and projects the task', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitExtensionRecord(
        command('shell-1:1'),
        { domain: 'child_run', record: chain[0] },
        TRUSTED,
      );
      expect(first).toMatchObject({
        domain: 'child_run',
        recordId: 'shell-1',
        taskId: TASK_ID,
        revision: 1,
        receipt: { replayed: false },
      });
      expect(first.recordRef.kind).toBe('managed-child_run');
      // The resource holds exactly the closed body, with no envelope.
      expect(
        JSON.parse((await harness.store.read(first.recordRef)).toString()),
      ).toEqual(chain[0]);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);

      harness.now = 2_000;
      await authority.commitExtensionRecord(
        command('shell-1:2'),
        { domain: 'child_run', record: chain[1] },
        TRUSTED,
      );
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'running',
          runtimeState: 'provisioning',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: null,
        },
      ]);

      harness.now = 3_000;
      await authority.commitExtensionRecord(
        command('shell-1:3'),
        { domain: 'child_run', record: chain[2] },
        TRUSTED,
      );
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'waiting',
          runtimeState: 'ready',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: null,
        },
      ]);

      harness.now = 4_000;
      await authority.commitExtensionRecord(
        command('shell-1:4'),
        { domain: 'child_run', record: chain[3] },
        TRUSTED,
      );
      harness.now = 5_000;
      await authority.commitExtensionRecord(
        command('shell-1:5'),
        { domain: 'child_run', record: chain[4] },
        TRUSTED,
      );
      expect(await publishedBodies(harness)).toBe(5);

      harness.now = 6_000;
      const last = await authority.commitExtensionRecord(
        command('shell-1:6'),
        { domain: 'child_run', record: chain[5] },
        TRUSTED,
      );
      expect(last.revision).toBe(6);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'completed',
          runtimeState: null,
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: 6_000,
        },
      ]);
    });
  });

  it('rebuilds the chain and the task view on reopen', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of chain.slice(0, 4).entries()) {
        harness.now = 1_000 * (index + 1);
        await authority.commitExtensionRecord(
          command(`shell-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.taskViews()).toEqual([
          {
            taskId: TASK_ID,
            sessionId,
            kind: 'background_shell',
            state: 'running',
            runtimeState: 'ready',
            definitionRevision: null,
            createdAt: 1_000,
            startedAt: 2_000,
            settledAt: null,
          },
        ]);
        expect(authority.extensionRecord('child_run', 'shell-1')).toMatchObject(
          {
            revision: 4,
            operationId: 'shell-1:1',
            record: chain[3],
          },
        );
      },
      { create: false },
    );
  });

  it('projects draining once a stop is requested', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of chain.slice(0, 3).entries()) {
        harness.now = 1_000 * (index + 1);
        await authority.commitExtensionRecord(
          command(`shell-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      harness.now = 4_000;
      await authority.commitExtensionRecord(
        command('shell-1:4'),
        {
          domain: 'child_run',
          record: shell(
            refs,
            {
              state: 'running',
              execution: 'running_attached',
              runtime: BINDING_1,
            },
            { startReceiptRef: refs.receipt, stopRequested: true },
          ),
        },
        TRUSTED,
      );
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'background_shell',
          state: 'running',
          runtimeState: 'draining',
          definitionRevision: null,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: null,
        },
      ]);
    });
  });

  it('refuses a revision that skips a step and commits nothing', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('shell-1:1'),
        { domain: 'child_run', record: chain[0] },
        TRUSTED,
      );
      const before = authority.committedSequence;
      // admitted/intent straight to settled skips every line step.
      await expect(
        authority.commitExtensionRecord(
          command('shell-1:2'),
          {
            domain: 'child_run',
            record: shell(
              refs,
              { state: 'settled', execution: 'settled', runtime: BINDING_1 },
              {
                startReceiptRef: refs.receipt,
                stopReason: 'exited',
                exitCode: 0,
              },
            ),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/successor|must follow|revision/im);
      expect(authority.committedSequence).toBe(before);
      expect(await publishedBodies(harness)).toBe(1);
    });
  });

  it('refuses a record whose reference was never published', async () => {
    const harness = await createHarness();
    const unpublished: ManagedSessionDurableRef = {
      resourceId: 'never-published',
      kind: 'managed-tool-args',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'f'.repeat(64),
    };
    const fake: ShellRefs = {
      args: unpublished,
      receipt: unpublished,
      manifestA: unpublished,
      manifestB: unpublished,
    };
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('shell-1:1'),
          { domain: 'child_run', record: shell(fake, {}) },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /never-published|managed-tool-args|resource|reference/im,
      );
      expect(await publishedBodies(harness)).toBe(0);
    });
  });

  it('refuses the domain while it stays disabled', async () => {
    enablement.childRun = false;
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('shell-1:1'),
          { domain: 'child_run', record: chain[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      expect(await publishedBodies(harness)).toBe(0);
    });
  });

  it('replays a repeated command with the original receipt', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('shell-1:1'),
        { domain: 'child_run', record: chain[0] },
        TRUSTED,
      );
      const replay = await authority.commitExtensionRecord(
        command('shell-1:1'),
        { domain: 'child_run', record: chain[0] },
        TRUSTED,
      );
      expect(replay.revision).toBe(1);
      expect(replay.receipt.replayed).toBe(true);
      expect(await publishedBodies(harness)).toBe(1);
      expect(authority.taskViews()).toHaveLength(1);
    });
  });
});
