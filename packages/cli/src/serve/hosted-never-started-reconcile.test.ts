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
import * as stdio from '../utils/stdioHelpers.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import {
  probeNeverStarted,
  reconcileNeverStartedChildRuns,
} from './hosted-never-started-reconcile.js';
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
      // The shell kind is enabled in production (#13856), so every kind the
      // production list carries goes through the real gate; a case that
      // needs the shell kind shut closes it per test. A kind production
      // has not enabled stays a fixture, admitted so the case runs what it
      // is about rather than the kind gate.
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (kind === 'shell' && !enablement.childRun) {
          throw new actual.ManagedSessionRecordError(
            'domain child_run kind shell is registered but not enabled for submission.',
          );
        }
        if (
          !(
            actual.MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS as readonly string[]
          ).includes(kind)
        )
          return;
        actual.assertManagedSessionChildRunKindEnabled(kind);
      },
    };
  },
);

const broker = vi.hoisted(() => ({
  acquire: vi.fn(async () => undefined),
  backgroundProcessStatus: vi.fn(
    (_executionCallId: string): Promise<{ state: string } | undefined> =>
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
    backgroundProcessStatus(
      executionCallId: string,
    ): Promise<{ state: string } | undefined> {
      broker.calls.push(`backgroundProcessStatus:${executionCallId}`);
      return broker.backgroundProcessStatus(executionCallId);
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
  broker.backgroundProcessStatus.mockClear().mockResolvedValue(undefined);
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

async function appendIntentWithBody(
  executionCallId: string,
  body: string,
): Promise<void> {
  const active = session!;
  const routeRef = await active.resources.publish(
    'managed-tool-input',
    Buffer.from(body),
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

async function appendIntent(
  executionCallId: string,
  runtimeSessionId: string,
  harnessSessionId = key.sessionId,
): Promise<void> {
  await appendIntentWithBody(
    executionCallId,
    JSON.stringify({ harnessSessionId, runtimeSessionId }),
  );
}

async function reopen(): Promise<void> {
  await session!.close();
  session = undefined;
  await open('reopened-worker');
}

describe('probeNeverStarted', () => {
  it.each([
    [undefined, { proven: true }],
    [
      { state: 'executing' },
      { proven: false, cause: 'ambiguous_state (executing)' },
    ],
    [
      { state: 'unknown' },
      { proven: false, cause: 'ambiguous_state (unknown)' },
    ],
  ] as const)(
    'classifies a Broker answer without widening absence',
    async (answer, expected) => {
      const backgroundProcessStatus = vi.fn(async () => answer);

      await expect(
        probeNeverStarted({ backgroundProcessStatus }, 'shell-1'),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    [
      Object.assign(new Error('secret broker URL'), {
        status: 401,
        code: 'runtime_broker_auth_rejected',
      }),
      'probe_rejected (status 401, code runtime_broker_auth_rejected)',
    ],
    [
      new Error('Runtime execution identity changed.'),
      'probe_rejected (identity_changed)',
    ],
    [
      new Error('Runtime execution outcome is unknown.'),
      'probe_rejected (outcome_unknown)',
    ],
    [new TypeError('fetch failed'), 'probe_rejected (error TypeError)'],
    [
      new DOMException('timed out', 'TimeoutError'),
      'probe_rejected (error TimeoutError)',
    ],
    ['unexpected rejection', 'probe_rejected (no status)'],
  ])(
    'classifies a rejected probe without logging its message',
    async (rejection, expectedCause) => {
      const backgroundProcessStatus = vi.fn(async () => {
        throw rejection;
      });

      const result = await probeNeverStarted(
        { backgroundProcessStatus },
        'shell-1',
      );

      expect(result).toEqual({ proven: false, cause: expectedCause });
      expect(JSON.stringify(result)).not.toContain('secret broker URL');
      expect(JSON.stringify(result)).not.toContain('fetch failed');
    },
  );
});

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
    // The definitive proof needs no acquire: status probes are the only
    // Broker interaction, so a released runtime Session cannot wedge the
    // scan behind a permanent runtime_session_not_acquirable.
    expect(broker.calls).toEqual(['backgroundProcessStatus:shell-1']);
    expect(broker.acquire).not.toHaveBeenCalled();
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

  it('settles every stranded record that shares one runtime session', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await strand('shell-2');
    await appendIntent('shell-1', 'runtime-a');
    await appendIntent('shell-2', 'runtime-a');
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result).toEqual({
      scanned: 2,
      settled: ['shell-1', 'shell-2'],
      skipped: [],
    });
    expect(broker.runtimeSessionIds).toEqual(['runtime-a']);
    expect(broker.calls).toEqual([
      'backgroundProcessStatus:shell-1',
      'backgroundProcessStatus:shell-2',
    ]);
    expect(broker.acquire).not.toHaveBeenCalled();
  });

  it('settles each stranded record under its own runtime session', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await strand('shell-2');
    await appendIntent('shell-1', 'runtime-a');
    await appendIntent('shell-2', 'runtime-b');
    broker.backgroundProcessStatus.mockImplementation(async (id) =>
      id === 'shell-1' ? undefined : { state: 'executing' as const },
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

  it('settles a stranded record whose runtime Session was released', async () => {
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

    // A freed Session permanently refuses acquire with
    // runtime_session_not_acquirable, so only a probe that never acquires
    // can carry this proof at all.
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(result.settled).toEqual(['shell-1']);
  });

  it.each([['executing'], ['unknown'], ['settled']] as const)(
    'leaves a record alone when the probe answers %s instead of proven absence',
    async (state) => {
      await open();
      await createManagedHarnessHandle(session!).ensureRunnable();
      await strand('shell-1');
      await appendIntent('shell-1', 'runtime-a');
      broker.backgroundProcessStatus.mockResolvedValue({ state });
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
    broker.backgroundProcessStatus.mockRejectedValue(new Error('broker down'));
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

  it('attributes each skip cause with the session id and never logs the rejection message', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-ambiguous');
    await strand('shell-rejected');
    await strand('shell-no-identity');
    await strand('shell-foreign');
    await appendIntent('shell-ambiguous', 'runtime-a');
    await appendIntent('shell-rejected', 'runtime-a');
    await appendIntent('shell-foreign', 'runtime-a', 'another-session');
    // shell-no-identity intentionally has no tool.intent at all.
    const rejection = Object.assign(
      new Error(
        'fetch failed: GET https://broker.test/internal/runtime-broker/v1/executions/shell-rejected:process?runtimeSessionId=runtime-a',
      ),
      { status: 401, code: 'runtime_broker_auth_rejected' },
    );
    broker.backgroundProcessStatus.mockImplementation(async (id) => {
      if (id === 'shell-rejected') throw rejection;
      if (id === 'shell-ambiguous') return { state: 'executing' as const };
      return undefined;
    });
    await reopen();
    const stderr = vi
      .spyOn(stdio, 'writeStderrLineSafe')
      .mockImplementation(() => {});
    try {
      const result = await reconcileNeverStartedChildRuns({
        authority: session!.authority,
        resources: session!.resources,
        childRuns: orchestratorOf(session!),
        brokerOptions: BROKER_OPTIONS,
      });

      expect(result.settled).toEqual([]);
      expect(result.skipped.toSorted()).toEqual([
        'shell-ambiguous',
        'shell-foreign',
        'shell-no-identity',
        'shell-rejected',
      ]);
      // One diagnostic line attributes every skip to its own cause; a bare
      // `skipped.join(', ')` here goes red.
      expect(stderr).toHaveBeenCalledTimes(1);
      const line = stderr.mock.calls.at(0)?.[0] as string;
      expect(line).toContain(`session ${key.sessionId}`);
      expect(line).toContain('shell-ambiguous (ambiguous_state (executing))');
      expect(line).toContain(
        'shell-rejected (probe_rejected (status 401, code runtime_broker_auth_rejected))',
      );
      expect(line).toContain('shell-no-identity (no_identity)');
      expect(line).toContain('shell-foreign (route_foreign)');
      expect(line).not.toContain('https://');
      expect(line).not.toContain('fetch failed');
    } finally {
      stderr.mockRestore();
    }
    expect(committed('shell-ambiguous').run.execution).toBe('dispatch_started');
  });

  it.each([
    ['a route body that is not JSON', (): string => 'NOT-JSON{{{'],
    [
      'a runtimeSessionId with a control character',
      (): string =>
        JSON.stringify({
          harnessSessionId: key.sessionId,
          runtimeSessionId: 'runtime-\u0001a',
        }),
    ],
  ] as const)(
    'leaves a record alone when its route is unreadable (%s)',
    async (_label, routeBody) => {
      await open();
      await createManagedHarnessHandle(session!).ensureRunnable();
      await strand('shell-1');
      await appendIntentWithBody('shell-1', routeBody());
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
      expect(broker.calls).toEqual([]);
      expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
      expect(committed('shell-1').run.execution).toBe('dispatch_started');
    },
  );

  it('propagates a settle commit failure instead of downgrading it to a skip', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    await strand('shell-1');
    await appendIntent('shell-1', 'runtime-a');
    await reopen();
    const settle = vi
      .spyOn(HostedChildRunSession.prototype, 'settleFailed')
      .mockRejectedValue(new Error('writer plane down'));
    try {
      await expect(
        reconcileNeverStartedChildRuns({
          authority: session!.authority,
          resources: session!.resources,
          childRuns: orchestratorOf(session!),
          brokerOptions: BROKER_OPTIONS,
        }),
      ).rejects.toThrow('writer plane down');
    } finally {
      settle.mockRestore();
    }
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
    expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
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
    expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
  });

  it('admits a shell through the enabled production kind gate', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();

    await expect(
      orchestratorOf(session!).admit({
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        executionCallId: 'shell-1',
        args: { command: 'printf hi', is_background: true },
      }),
    ).resolves.toMatchObject({ kind: 'managed-tool-args' });
    expect(committed('shell-1')).toMatchObject({
      kind: 'shell',
      run: { state: 'admitted', execution: 'intent' },
    });
  });

  it('never scans a child_agent record, the one kind production can commit today', async () => {
    await open();
    await createManagedHarnessHandle(session!).ensureRunnable();
    const agents = new HostedChildAgentSession(
      {
        authority: session!.authority,
        resources: session!.resources,
      },
      session!.authority.sessionHeader.sessionKey,
    );
    await agents.admit({
      childRunId: 'run-1',
      ownerScopeId: 'scope-main',
      rootSessionId: key.sessionId,
      completion: 'sent',
      description: 'audit the diff',
      prompt: 'review the change',
      definition: {
        definitionId: 'agent-main',
        definitionRevision: 3,
        definitionDigest: 'f'.repeat(64),
      },
      workspaceMode: 'shared',
      workingDirectory: '.',
      executionCallId: 'call-1',
    });
    await agents.dispatchStarted('run-1', {
      dispatchId: 'dispatch-1',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await reopen();

    const result = await reconcileNeverStartedChildRuns({
      authority: session!.authority,
      resources: session!.resources,
      childRuns: orchestratorOf(session!),
      brokerOptions: BROKER_OPTIONS,
    });

    expect(result).toEqual({ scanned: 0, settled: [], skipped: [] });
    expect(broker.calls).toEqual([]);
    expect(broker.runtimeSessionIds).toEqual([]);
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
    expect(broker.backgroundProcessStatus).not.toHaveBeenCalled();
  });
});
