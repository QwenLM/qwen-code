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

// child_run and child_acceptance are enabled by the H4 enablement slice;
// this suite runs the commit/rebuild path ahead of it, like the H3 shell
// suite does. It covers the `child_agent` body kind and the acceptance's
// cross-record rules of docs/design/2026-10-06-managed-child-agent-runtime.md.
const enablement = vi.hoisted(() => ({ childDomains: true }));

vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (
        (domain !== 'child_run' && domain !== 'child_acceptance') ||
        !enablement.childDomains
      ) {
        actual.assertManagedSessionDomainEnabled(domain);
      }
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.childDomains = true;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-agent-'));
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

interface ChildRefs {
  readonly input: ManagedSessionDurableRef;
  readonly result: ManagedSessionDurableRef;
  readonly receipt: ManagedSessionDurableRef;
}

// The writer-side closure reads every reference a body names, so the test
// publishes real content and builds records from the returned refs. The
// result and receipt double as the acceptance's: the parent-held copies are
// the same bytes, so the digests bind.
async function publishRefs(harness: Harness): Promise<ChildRefs> {
  return {
    input: await harness.store.publish(
      'managed-input',
      Buffer.from('{"prompt":"audit the diff"}', 'utf8'),
    ),
    result: await harness.store.publish(
      'managed-child-result',
      Buffer.from('{"summary":"clean"}', 'utf8'),
    ),
    receipt: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"outcome":"settled"}', 'utf8'),
    ),
  };
}

// The dispatched definition pin the contract requires from the dispatch on.
const DEFINITION_PIN = {
  definitionId: 'agent-def-1',
  definitionRevision: 1,
  definitionDigest: 'f'.repeat(64),
};

function runBlock(overrides: Record<string, unknown>) {
  return {
    state: 'admitted',
    reason: null,
    definition: DEFINITION_PIN,
    executionCallId: 'call-agent-1',
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: 'intent',
    runtime: null,
    delivery: { target: 'session', state: 'planned' },
    ...overrides,
  };
}

function childAgent(
  refs: ChildRefs,
  runOverrides: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    kind: 'child_agent',
    childRunId: 'run-1',
    ownerScopeId: 'scope-main',
    rootSessionId: sessionId,
    depth: 1,
    completion: 'sent',
    inputRef: refs.input,
    workspaceMode: 'shared',
    workingDirectory: '.',
    childSessionId: null,
    predecessorChildRunId: null,
    resultVersion: 1,
    resultRef: null,
    terminalReceiptRef: null,
    stopReason: null,
    stopRequested: false,
    run: runBlock(runOverrides),
    ...overrides,
  };
}

/** A sent-completion child that dispatches, attaches and settles. */
function life(refs: ChildRefs) {
  return [
    childAgent(refs, {}),
    childAgent(refs, {
      state: 'running',
      execution: 'dispatch_started',
      dispatchId: 'dispatch-1',
      runtime: BINDING_1,
    }),
    childAgent(
      refs,
      {
        state: 'running',
        execution: 'running_attached',
        dispatchId: 'dispatch-1',
        runtime: BINDING_1,
      },
      { childSessionId: 'session-child' },
    ),
    childAgent(
      refs,
      {
        state: 'settled',
        execution: 'settled',
        dispatchId: 'dispatch-1',
        runtime: BINDING_1,
        delivery: { target: 'session', state: 'accepting' },
      },
      {
        childSessionId: 'session-child',
        stopReason: 'completed',
        resultRef: refs.result,
        terminalReceiptRef: refs.receipt,
      },
    ),
    childAgent(
      refs,
      {
        state: 'settled',
        execution: 'settled',
        dispatchId: 'dispatch-1',
        runtime: BINDING_1,
        delivery: { target: 'session', state: 'accepted' },
      },
      {
        childSessionId: 'session-child',
        stopReason: 'completed',
        resultRef: refs.result,
        terminalReceiptRef: refs.receipt,
      },
    ),
    childAgent(
      refs,
      {
        state: 'settled',
        execution: 'settled',
        dispatchId: 'dispatch-1',
        runtime: BINDING_1,
        delivery: { target: 'session', state: 'consumed' },
      },
      {
        childSessionId: 'session-child',
        stopReason: 'completed',
        resultRef: refs.result,
        terminalReceiptRef: refs.receipt,
      },
    ),
  ];
}

function acceptance(
  refs: ChildRefs,
  deliveryState: 'accepted' | 'consumed' = 'accepted',
  overrides: Record<string, unknown> = {},
) {
  return {
    childRunId: 'run-1',
    parentScopeId: 'scope-main',
    parentExecutionCallId: null,
    resultVersion: 1,
    contentRef: refs.result,
    contentDigest: refs.result.digest,
    terminalReceiptRef: refs.receipt,
    run: {
      state: 'settled',
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: null,
      dispatchId: null,
      deliveryId: null,
      execution: null,
      runtime: null,
      delivery: { target: 'session', state: deliveryState },
    },
    ...overrides,
  };
}

function command(commandId: string) {
  return {
    operation: 'acceptChildResult',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

const TRUSTED = { class: 'trusted_entry' } as const;

const TASK_ID = `task_${managedExtensionRecordKey(sessionId, 'child_run', 'run-1')}`;

async function publishedBodies(
  harness: Harness,
  domain: string,
): Promise<number> {
  try {
    return (
      await fs.readdir(
        path.join(
          harness.runtimeBaseDir,
          'resources',
          sessionId,
          `managed-${domain}`,
        ),
      )
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Commits the first four revisions (through the settled result). */
async function settleChild(
  harness: Harness,
  authority: LocalManagedSessionAuthority,
  chain: readonly unknown[],
): Promise<void> {
  for (const [index, record] of chain.slice(0, 4).entries()) {
    harness.now = 1_000 * (index + 1);
    await authority.commitExtensionRecord(
      command(`run-1:${index + 1}`),
      { domain: 'child_run', record },
      TRUSTED,
    );
  }
}

describe('managed session authority child_agent records', () => {
  it('chains a child agent lifecycle and projects the child_agent task', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitExtensionRecord(
        command('run-1:1'),
        { domain: 'child_run', record: chain[0] },
        TRUSTED,
      );
      expect(first).toMatchObject({
        domain: 'child_run',
        recordId: 'run-1',
        taskId: TASK_ID,
        revision: 1,
        receipt: { replayed: false },
      });
      expect(first.recordRef.kind).toBe('managed-child_run');
      expect(
        JSON.parse((await harness.store.read(first.recordRef)).toString()),
      ).toEqual(chain[0]);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'child_agent',
          state: 'pending',
          runtimeState: 'unbound',
          definitionRevision: 1,
          createdAt: 1_000,
          startedAt: null,
          settledAt: null,
        },
      ]);

      harness.now = 2_000;
      await authority.commitExtensionRecord(
        command('run-1:2'),
        { domain: 'child_run', record: chain[1] },
        TRUSTED,
      );
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'child_agent',
          state: 'running',
          runtimeState: 'provisioning',
          definitionRevision: 1,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: null,
        },
      ]);

      harness.now = 3_000;
      await authority.commitExtensionRecord(
        command('run-1:3'),
        { domain: 'child_run', record: chain[2] },
        TRUSTED,
      );
      expect(authority.taskViews()[0]).toMatchObject({
        state: 'running',
        runtimeState: 'ready',
      });

      harness.now = 4_000;
      const settled = await authority.commitExtensionRecord(
        command('run-1:4'),
        { domain: 'child_run', record: chain[3] },
        TRUSTED,
      );
      expect(settled.revision).toBe(4);
      expect(authority.taskViews()).toEqual([
        {
          taskId: TASK_ID,
          sessionId,
          kind: 'child_agent',
          state: 'completed',
          runtimeState: null,
          definitionRevision: 1,
          createdAt: 1_000,
          startedAt: 2_000,
          settledAt: 4_000,
        },
      ]);

      // The relay advances the delivery independently of the acceptance.
      harness.now = 5_000;
      await authority.commitExtensionRecord(
        command('run-1:5'),
        { domain: 'child_run', record: chain[4] },
        TRUSTED,
      );
      harness.now = 6_000;
      const consumed = await authority.commitExtensionRecord(
        command('run-1:6'),
        { domain: 'child_run', record: chain[5] },
        TRUSTED,
      );
      expect(consumed.revision).toBe(6);
      expect(await publishedBodies(harness, 'child_run')).toBe(6);
      expect(authority.taskViews()[0]).toMatchObject({
        kind: 'child_agent',
        state: 'completed',
      });
    });
  });

  it('projects draining once a stop is requested of an unsettled child', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of chain.slice(0, 3).entries()) {
        harness.now = 1_000 * (index + 1);
        await authority.commitExtensionRecord(
          command(`run-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      harness.now = 4_000;
      await authority.commitExtensionRecord(
        command('run-1:4'),
        {
          domain: 'child_run',
          record: childAgent(
            refs,
            {
              state: 'running',
              execution: 'running_attached',
              dispatchId: 'dispatch-1',
              runtime: BINDING_1,
            },
            { childSessionId: 'session-child', stopRequested: true },
          ),
        },
        TRUSTED,
      );
      expect(authority.taskViews()[0]).toMatchObject({
        kind: 'child_agent',
        state: 'running',
        runtimeState: 'draining',
      });
    });
  });

  it('binds an acceptance to the child run it names, not its sibling', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, chain);
      await authority.commitExtensionRecord(
        command('run-2:1'),
        {
          domain: 'child_run',
          record: childAgent(refs, {}, { childRunId: 'run-2' }),
        },
        TRUSTED,
      );
      // The sibling child run exists as a child_agent but has not ended:
      // an acceptance for the settled run-1 may not claim its chain.
      await expect(
        authority.commitExtensionRecord(
          command('accept-2:1'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', { childRunId: 'run-2' }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must name a run that ended with its result committed');
    });
  });

  it('commits and consumes an acceptance without projecting a task', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, chain);
      harness.now = 5_000;
      const accepted = await authority.commitExtensionRecord(
        command('accept-1:1'),
        { domain: 'child_acceptance', record: acceptance(refs) },
        TRUSTED,
      );
      expect(accepted).toMatchObject({
        domain: 'child_acceptance',
        recordId: 'run-1',
        taskId: null,
        revision: 1,
        receipt: { replayed: false },
      });
      // The acceptance is a receipt, not a task: the child task alone shows.
      expect(authority.taskViews()).toHaveLength(1);

      harness.now = 6_000;
      const consumed = await authority.commitExtensionRecord(
        command('accept-1:2'),
        { domain: 'child_acceptance', record: acceptance(refs, 'consumed') },
        TRUSTED,
      );
      expect(consumed.revision).toBe(2);
      expect(
        authority.extensionRecord('child_acceptance', 'run-1'),
      ).toMatchObject({
        revision: 2,
        operationId: 'accept-1:1',
        record: acceptance(refs, 'consumed'),
      });
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(2);
    });
  });

  it('rebuilds the chains and the task view on reopen', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, chain);
      harness.now = 5_000;
      await authority.commitExtensionRecord(
        command('accept-1:1'),
        { domain: 'child_acceptance', record: acceptance(refs) },
        TRUSTED,
      );
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.taskViews()).toEqual([
          {
            taskId: TASK_ID,
            sessionId,
            kind: 'child_agent',
            state: 'completed',
            runtimeState: null,
            definitionRevision: 1,
            createdAt: 1_000,
            startedAt: 2_000,
            settledAt: 4_000,
          },
        ]);
        expect(authority.extensionRecord('child_run', 'run-1')).toMatchObject({
          revision: 4,
          operationId: 'run-1:1',
        });
        expect(
          authority.extensionRecord('child_acceptance', 'run-1'),
        ).toMatchObject({
          revision: 1,
          operationId: 'accept-1:1',
          record: acceptance(refs),
        });
      },
      { create: false },
    );
  });

  it('refuses a first-level child agent rooted at another Session', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('run-1:1'),
          {
            domain: 'child_run',
            record: childAgent(refs, {}, { rootSessionId: 'session-other' }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        'rootSessionId must be this Session for a first-level child',
      );
      expect(await publishedBodies(harness, 'child_run')).toBe(0);
    });
  });

  it('refuses an acceptance without its child run', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          { domain: 'child_acceptance', record: acceptance(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow('must name a child agent run of this Session');
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(0);
    });
  });

  it('refuses an acceptance that names a shell run', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const shell = {
      kind: 'shell',
      shellId: 'run-1',
      ownerScopeId: 'scope-main',
      commandRef: refs.input,
      startReceiptRef: null,
      outputRef: null,
      stopReason: null,
      stopRequested: false,
      exitCode: null,
      exitSignal: null,
      run: {
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
      },
    };
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('shell-1:1'),
        { domain: 'child_run', record: shell },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          { domain: 'child_acceptance', record: acceptance(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow('must name a child agent run of this Session');
    });
  });

  it('refuses an acceptance before the child run ends with its result', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of chain.slice(0, 3).entries()) {
        await authority.commitExtensionRecord(
          command(`run-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          { domain: 'child_acceptance', record: acceptance(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow('must name a run that ended with its result committed');
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(0);
    });
  });

  it('refuses an acceptance with a foreign scope', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', {
              parentScopeId: 'scope-other',
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must match its child run scope and result version');
    });
  });

  it('refuses a sent-completion acceptance that names a call', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', {
              parentExecutionCallId: 'call-agent-1',
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must attach the completion call its child run names');
    });
  });

  it('accepts a tool-completion acceptance with the original call only', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs).map((record) => ({
      ...(record as Record<string, unknown>),
      completion: 'tool',
    }));
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, chain);
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', {
              parentExecutionCallId: 'call-wrong',
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must attach the completion call its child run names');
      const accepted = await authority.commitExtensionRecord(
        command('accept-1:2'),
        {
          domain: 'child_acceptance',
          record: acceptance(refs, 'accepted', {
            parentExecutionCallId: 'call-agent-1',
          }),
        },
        TRUSTED,
      );
      expect(accepted.revision).toBe(1);
    });
  });

  it('refuses a redelivery with conflicting content', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const other = await harness.store.publish(
      'managed-child-result',
      Buffer.from('{"summary":"changed"}', 'utf8'),
    );
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      await authority.commitExtensionRecord(
        command('accept-1:1'),
        { domain: 'child_acceptance', record: acceptance(refs) },
        TRUSTED,
      );
      // The restated delivery with different bytes is not a second
      // acceptance: it conflicts with the receipt already committed.
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:2'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', {
              contentRef: other,
              contentDigest: other.digest,
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must bind the result and receipt');
    });
  });

  it('binds the terminal receipt on its own', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const otherReceipt = await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"outcome":"other"}', 'utf8'),
    );
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      // Same content, another receipt: the receipt binds independently.
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          {
            domain: 'child_acceptance',
            record: acceptance(refs, 'accepted', {
              terminalReceiptRef: otherReceipt,
            }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('must bind the result and receipt');
    });
  });

  it('closes a child agent launch over the Session resources', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const unheld = {
      ...refs.input,
      resourceId: 'input-never-published',
    };
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('run-1:1'),
          {
            domain: 'child_run',
            record: childAgent({ ...refs, input: unheld }, {}),
          },
          TRUSTED,
        ),
      ).rejects.toThrow('resource input-never-published is not present');
      expect(await publishedBodies(harness, 'child_run')).toBe(0);
    });
  });

  it('closes a settling revision over its result and receipt', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const unheld = { ...refs.result, resourceId: 'result-never-published' };
    await withAuthority(harness, async (authority) => {
      const chain = life({ ...refs, result: unheld });
      for (const [index, record] of chain.slice(0, 3).entries()) {
        await authority.commitExtensionRecord(
          command(`run-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      await expect(
        authority.commitExtensionRecord(
          command('run-1:4'),
          { domain: 'child_run', record: chain[3] },
          TRUSTED,
        ),
      ).rejects.toThrow('resource result-never-published is not present');
      expect(await publishedBodies(harness, 'child_run')).toBe(3);
    });
  });

  it('closes a settling revision over its terminal receipt', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const unheld = { ...refs.receipt, resourceId: 'receipt-never-published' };
    await withAuthority(harness, async (authority) => {
      const chain = life({ ...refs, receipt: unheld });
      for (const [index, record] of chain.slice(0, 3).entries()) {
        await authority.commitExtensionRecord(
          command(`run-1:${index + 1}`),
          { domain: 'child_run', record },
          TRUSTED,
        );
      }
      await expect(
        authority.commitExtensionRecord(
          command('run-1:4'),
          { domain: 'child_run', record: chain[3] },
          TRUSTED,
        ),
      ).rejects.toThrow('resource receipt-never-published is not present');
      expect(await publishedBodies(harness, 'child_run')).toBe(3);
    });
  });

  it('replays a repeated acceptance command with the original receipt', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      await authority.commitExtensionRecord(
        command('accept-1:1'),
        { domain: 'child_acceptance', record: acceptance(refs) },
        TRUSTED,
      );
      const replay = await authority.commitExtensionRecord(
        command('accept-1:1'),
        { domain: 'child_acceptance', record: acceptance(refs) },
        TRUSTED,
      );
      expect(replay.revision).toBe(1);
      expect(replay.receipt.replayed).toBe(true);
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(1);
    });
  });

  it('refuses an acceptance whose content was never published', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const unpublished: ManagedSessionDurableRef = {
      resourceId: 'never-published',
      kind: 'managed-child-result',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'f'.repeat(64),
    };
    await withAuthority(harness, async (authority) => {
      await settleChild(harness, authority, life(refs));
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          {
            domain: 'child_acceptance',
            record: {
              ...acceptance(refs),
              contentRef: unpublished,
              contentDigest: unpublished.digest,
            },
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /never-published|managed-child-result|resource|reference/im,
      );
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(0);
    });
  });

  it('refuses both domains while they stay disabled', async () => {
    enablement.childDomains = false;
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const chain = life(refs);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('run-1:1'),
          { domain: 'child_run', record: chain[0] },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      await expect(
        authority.commitExtensionRecord(
          command('accept-1:1'),
          { domain: 'child_acceptance', record: acceptance(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      expect(await publishedBodies(harness, 'child_run')).toBe(0);
      expect(await publishedBodies(harness, 'child_acceptance')).toBe(0);
    });
  });
});
