/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { parseChildShellRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { reconcileNeverStartedChildRuns } from './hosted-never-started-reconcile.js';
import type { HostedWorkspaceBrokerOptions } from './hosted-workspace-broker.js';

const enablement = vi.hoisted(() => ({ childRun: true }));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (!enablement.childRun) {
          actual.assertManagedSessionChildRunKindEnabled(kind);
        }
      },
    };
  },
);

const broker = vi.hoisted(() => ({
  acquire: vi.fn(async () => undefined),
  status: vi.fn(
    (_id: string): Promise<{ state: string } | undefined> =>
      Promise.resolve(undefined),
  ),
  calls: [] as string[],
  runtimeSessionIds: [] as string[],
}));
vi.mock('./hosted-workspace-broker.js', () => {
  class FakeBroker {
    constructor(
      _options: unknown,
      _key: unknown,
      readonly runtimeSessionId: string,
    ) {
      broker.runtimeSessionIds.push(runtimeSessionId);
    }
    acquire(): Promise<void> {
      broker.calls.push('acquire');
      return broker.acquire();
    }
    status(id: string): Promise<{ state: string } | undefined> {
      broker.calls.push(`status:${id}`);
      return broker.status(id);
    }
  }
  return { HostedWorkspaceBroker: FakeBroker };
});

const BROKER_OPTIONS: HostedWorkspaceBrokerOptions = {
  baseUrl: 'http://broker.test',
  token: 'test',
};

let root: string | undefined;
let session: ManagedSession | undefined;
let key: {
  tenantId: string;
  workspaceId: string;
  sessionId: string;
};

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  enablement.childRun = true;
});

beforeEach(() => {
  broker.calls.length = 0;
  broker.runtimeSessionIds.length = 0;
  broker.acquire.mockClear().mockResolvedValue(undefined);
  broker.status.mockClear().mockResolvedValue(undefined);
});

async function open(workerId = 'worker'): Promise<ManagedSession> {
  root ??= await mkdtemp(path.join(tmpdir(), 'qwen-never-started-'));
  key ??= {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey: key,
  });
  if (workerId === 'worker') {
    session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: key.sessionId,
      sessionKey: key,
      version: 'test',
      workerId,
      activationLeaseDurationMs: 60_000,
      create: {
        definitionRef: await resources.publish(
          'managed-definition',
          Buffer.from('{}'),
        ),
        rootSnapshotRef: await resources.publish(
          'managed-root',
          Buffer.from('{}'),
        ),
        createdBy: 'test',
      },
    });
  } else {
    session = await openManagedSession({
      runtimeBaseDir: root,
      cwd: root,
      transcriptPath: path.join(root, 'transcript.jsonl'),
      sessionId: key.sessionId,
      sessionKey: key,
      version: 'test',
      workerId,
      activationLeaseDurationMs: 60_000,
    });
  }
  return session;
}

function orchestratorOf(active: ManagedSession): HostedChildRunSession {
  return new HostedChildRunSession(
    {
      authority: active.authority,
      resources: active.resources,
    },
    active.authority.sessionHeader.sessionKey,
  );
}

function committed(shellId: string) {
  const existing = session!.authority.extensionRecord('child_run', shellId);
  if (existing === undefined)
    throw new Error(`No child_run record for ${shellId}.`);
  return parseChildShellRun(existing.record);
}

async function strand(shellId: string): Promise<HostedChildRunSession> {
  const orchestrator = orchestratorOf(session!);
  await orchestrator.admit({
    shellId,
    ownerScopeId: 'scope-main',
    executionCallId: shellId,
    args: { command: 'printf hi', is_background: true },
  });
  await orchestrator.dispatchStarted(shellId, {
    runtimeBindingId: 'binding-1',
    generation: '1',
  });
  return orchestrator;
}

async function appendIntent(
  executionCallId: string,
  runtimeSessionId: string,
  harnessSessionId = key.sessionId,
): Promise<void> {
  const active = session!;
  const routeRef = await active.resources.publish(
    'managed-tool-input',
    Buffer.from(JSON.stringify({ harnessSessionId, runtimeSessionId })),
  );
  const definitionRef = await active.resources.publish(
    'managed-tool-definition',
    Buffer.from('{}'),
  );
  await active.authority.appendExecutionEvent(
    {
      operation: 'toolIntent',
      commandId: `tool-intent:${executionCallId}`,
      sessionKey: key,
      contentDigest: routeRef.digest,
    },
    (sequence) => ({
      v: 1,
      sequence,
      eventId: `tool-intent:${executionCallId}`,
      sessionKey: key,
      kind: 'tool.intent',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: active.activation.activationId,
        ...active.activation,
      },
      payload: {
        executionCallId,
        batchId: 'batch-a',
        ordinal: 0,
        toolDefinitionRef: definitionRef,
        argsRef: routeRef,
        outcomeSource: 'runtime',
      },
    }),
    { class: 'harness', activation: active.activation },
  );
}

async function reopen(): Promise<void> {
  await session!.close();
  session = undefined;
  await open('reopened-worker');
}

describe('reconcileNeverStartedChildRuns', () => {
  it('settles a stranded dispatch-claimed record whose process provably does not exist', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await appendIntent('shell-1', 'runtime-a');
    await reopen();
    const orchestrator = orchestratorOf(session!);

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestrator,
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result).toEqual({
      scanned: 1,
      settled: ['shell-1'],
      skipped: [],
    });
    expect(committed('shell-1')).toMatchObject({
      stopReason: 'start_failed',
      run: { state: 'failed', execution: 'not_started_proven' },
    });
    // The cold-Broker contract: idempotent adopt acquire precedes any probe.
    expect(broker.calls).toEqual(['acquire', 'status:shell-1:process']);
    expect(broker.runtimeSessionIds).toEqual(['runtime-a']);
    const taskId = `task_${managedExtensionRecordKey(key.sessionId, 'child_run', 'shell-1')}`;
    expect(session!.authority.taskViews()).toEqual([
      expect.objectContaining({
        taskId,
        state: 'failed',
        runtimeState: null,
        settledAt: expect.any(Number),
      }),
    ]);
    // Reads as never-started on yet another reload: the settle is durable.
    await reopen();
    expect(committed('shell-1')).toMatchObject({
      stopReason: 'start_failed',
      run: { state: 'failed', execution: 'not_started_proven' },
    });
  });

  it('settles each stranded record under its own runtime session', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await strand('shell-2');
    await appendIntent('shell-1', 'runtime-a');
    await appendIntent('shell-2', 'runtime-b');
    broker.status.mockImplementation(async (id) =>
      id === 'shell-1:process' ? undefined : { state: 'executing' as const },
    );
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result.settled).toEqual(['shell-1']);
    expect(result.skipped).toEqual(['shell-2']);
    expect(broker.runtimeSessionIds.toSorted()).toEqual([
      'runtime-a',
      'runtime-b',
    ]);
    expect(committed('shell-2').run.execution).toBe('dispatch_started');
  });

  it.each([['executing'], ['unknown'], ['settled']] as const)(
    'leaves a record alone when the probe answers %s instead of proven absence',
    async (state) => {
      await open();
      await createManagedHarnessHandle(session!).ensureRunnable();
      await strand('shell-1');
      await appendIntent('shell-1', 'runtime-a');
      broker.status.mockResolvedValue({ state });
      await reopen();

      const result = await reconcileNeverStartedChildRuns({
        authority: session!.authority,
        resources: session!.resources,
        childRuns: orchestratorOf(session!),
        brokerOptions: BROKER_OPTIONS,
      });

      expect(result.settled).toEqual([]);
      expect(result.skipped).toEqual(['shell-1']);
      expect(committed('shell-1').run.execution).toBe('dispatch_started');
      expect(committed('shell-1').stopReason).toBeNull();
    },
  );

  it('leaves a record alone when the probe itself fails', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await appendIntent('shell-1', 'runtime-a');
    broker.status.mockRejectedValue(new Error('broker down'));
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result.settled).toEqual([]);
    expect(result.skipped).toEqual(['shell-1']);
    expect(committed('shell-1').run.execution).toBe('dispatch_started');
  });

  it('leaves a record alone when its runtime session cannot be rebuilt', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result).toEqual({
      scanned: 1,
      settled: [],
      skipped: ['shell-1'],
    });
    expect(broker.status).not.toHaveBeenCalled();
    expect(broker.runtimeSessionIds).toEqual([]);
    expect(committed('shell-1').run.execution).toBe('dispatch_started');
  });

  it('leaves a record alone when the route belongs to another Session', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await appendIntent('shell-1', 'runtime-a', 'another-session');
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result.settled).toEqual([]);
    expect(result.skipped).toEqual(['shell-1']);
    expect(broker.status).not.toHaveBeenCalled();
  });

  it('leaves the Broker untouched when nothing is stranded', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    const orchestrator = await strand('shell-1');
    await orchestrator.attach(
      'shell-1',
      { runtimeBindingId: 'binding-1', generation: '1' },
      { pid: 4242 },
    );
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result).toEqual({ scanned: 0, settled: [], skipped: [] });
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.status).not.toHaveBeenCalled();
  });
});
