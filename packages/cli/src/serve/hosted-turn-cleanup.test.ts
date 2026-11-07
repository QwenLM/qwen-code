/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { HostedChildRunSession } from './hosted-child-run-session.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
  hostedRuntimeSessionId,
} from './hosted-workspace-broker.js';
import {
  hasBlockingHostedCleanupDebt,
  hasHostedCleanupDebt,
  oweHostedTurnCleanup,
  reconcileHostedTurnCleanup,
} from './hosted-turn-cleanup.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type BackgroundKind = 'shell' | 'monitor';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-turn-cleanup-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const promptId = 'monitor:wake:cleanup';
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const options = {
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'session.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    activationLeaseDurationMs: 60_000,
  };
  let session = await openManagedSession({
    ...options,
    workerId: 'original',
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
  cleanups.push(() => session.close());
  const content = Buffer.from('[]');
  await session.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: promptId,
      sessionKey,
      contentDigest: createHash('sha256').update(content).digest('hex'),
    },
    {
      inputId: promptId,
      turnId: promptId,
      source: 'test',
      contentRef: await resources.publish('managed-input', content),
      admissionRef: await resources.publish(
        'managed-admission',
        Buffer.from('{}'),
      ),
      deadline: null,
      wakeReason: 'input',
    },
  );
  await createManagedHarnessHandle(session).ensureRunnable();
  const brokerOptions = { baseUrl: 'http://127.0.0.1:1', token: 'test' };
  const broker = new HostedWorkspaceBroker(
    brokerOptions,
    sessionKey,
    hostedRuntimeSessionId(promptId),
  );
  broker.runtime = {
    bindingId: 'binding',
    generation: '7',
    workspaceGeneration: '3',
  };
  await oweHostedTurnCleanup(session, promptId, broker);
  const shells = new HostedChildRunSession(session, sessionKey);
  const monitors = new HostedMonitorSession(session, sessionKey);
  const debt = () =>
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .findLast((event) => event.kind === 'hosted.cleanup')!;
  let nextRun = 0;
  const background = async (
    kind: BackgroundKind,
    over: {
      runtimeSessionId?: string;
      harnessSessionId?: string;
      bindingId?: string;
      generation?: string;
      inputKind?: string;
      attached?: boolean;
      intent?: boolean;
    } = {},
  ) => {
    const id = `${kind}-${++nextRun}`;
    const args = {
      command: 'sleep 60',
      runtimeSessionId: broker.runtimeSessionId,
    };
    const inputRef = await resources.publish(
      over.inputKind ?? 'managed-tool-input',
      Buffer.from(
        JSON.stringify({
          harnessSessionId: over.harnessSessionId ?? sessionKey.sessionId,
          runtimeSessionId: over.runtimeSessionId ?? broker.runtimeSessionId,
          payloadJson: JSON.stringify({
            toolName: kind === 'shell' ? 'run_shell_command' : 'watch',
            input: args,
          }),
        }),
      ),
    );
    const definitionRef = await resources.publish(
      'managed-tool-definition',
      Buffer.from(JSON.stringify({ name: kind })),
    );
    if (over.intent !== false) {
      const activation = session.activation;
      await session.authority.appendExecutionEvent(
        {
          operation: 'toolIntent',
          commandId: `intent:${id}`,
          sessionKey,
          contentDigest: inputRef.digest,
        },
        (sequence) => ({
          v: 1,
          sequence,
          eventId: `intent:${id}`,
          sessionKey,
          kind: 'tool.intent',
          occurredAt: Date.now(),
          subject: {
            type: 'activation',
            scopeId: activation.activationId,
            ...activation,
          },
          payload: {
            executionCallId: id,
            batchId: `batch:${id}`,
            ordinal: 0,
            toolDefinitionRef: definitionRef,
            argsRef: inputRef,
            outcomeSource: 'runtime',
          },
        }),
        { class: 'harness', activation },
      );
    }
    const runtime = {
      runtimeBindingId: over.bindingId ?? 'binding',
      generation: over.generation ?? '7',
    };
    if (kind === 'shell') {
      await shells.admit({
        shellId: id,
        ownerScopeId: sessionKey.sessionId,
        executionCallId: id,
        args,
      });
      await shells.dispatchStarted(id, runtime);
      if (over.attached !== false)
        await shells.attach(id, runtime, { executionCallId: id });
    } else {
      await monitors.admit({
        monitorId: id,
        ownerScopeId: sessionKey.sessionId,
        executionCallId: id,
        args,
        maxEvents: 100,
        idleTimeoutMs: 60_000,
        debounceMs: 1000,
      });
      await monitors.dispatchStarted(id, runtime);
      if (over.attached !== false)
        await monitors.attach(id, runtime, { executionCallId: id });
    }
    return id;
  };
  return {
    get session() {
      return session;
    },
    promptId,
    broker,
    brokerOptions,
    shells,
    monitors,
    background,
    debt,
    terminal: () =>
      session.sink.write({
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'turn_result',
        cwd: root,
        version: 'test',
        systemPayload: {
          promptId,
          state: 'completed',
          stopReason: 'end_turn',
          endedAt: Date.now(),
        },
      }),
    reconcile: (drain = false) =>
      reconcileHostedTurnCleanup(session, brokerOptions, undefined, drain),
    reopen: async () => {
      await session.close();
      session = await openManagedSession({
        ...options,
        workerId: 'replacement',
      });
    },
  };
}

function heldRelease() {
  return vi
    .spyOn(HostedWorkspaceBroker.prototype, 'release')
    .mockRejectedValue(
      new HostedWorkspaceBrokerRejection(409, 'runtime_session_held'),
    );
}

it('does not release or classify background holds before the owning turn settles', async () => {
  const f = await fixture();
  await f.background('shell');
  const release = heldRelease();
  expect(await f.reconcile()).toEqual({
    states: new Map([[f.promptId, 'owed']]),
    held: new Map(),
  });
  expect(release).not.toHaveBeenCalled();
  expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
});

it.each<BackgroundKind>(['shell', 'monitor'])(
  'retains a proved %s hold without confirming release',
  async (kind) => {
    const f = await fixture();
    await f.background(kind);
    await f.terminal();
    const release = heldRelease();
    const result = await f.reconcile();
    expect(release).toHaveBeenCalledExactlyOnceWith({
      bindingId: 'binding',
      generation: '7',
    });
    expect(result.states).toEqual(new Map([[f.promptId, 'owed']]));
    expect(result.held.get(f.promptId)).toEqual({
      cleanupId: f.debt().payload['cleanupId'],
      descriptorRef: f.debt().payload['descriptorRef'],
      runtimeSessionId: f.broker.runtimeSessionId,
    });
    expect(hasHostedCleanupDebt(f.session)).toBe(true);
    const sequence = f.session.authority.committedSequence;
    expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
      false,
    );
    expect(f.session.authority.committedSequence).toBe(sequence);
    expect(release).toHaveBeenCalledTimes(1);
    expect(f.debt().payload['state']).toBe('owed');
  },
);

it('does not use a hold classification to exempt a different cleanup debt', async () => {
  const f = await fixture();
  await f.background('shell');
  await f.terminal();
  heldRelease();
  const result = await f.reconcile();
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
    false,
  );
  const other = new HostedWorkspaceBroker(
    f.brokerOptions,
    f.session.authority.sessionHeader.sessionKey,
    'other-prompt',
  );
  other.runtime = f.broker.runtime;
  await oweHostedTurnCleanup(f.session, 'other-prompt', other);
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(true);
});

it.each([
  { runtimeSessionId: 'other-runtime' },
  { harnessSessionId: 'other-harness' },
  { bindingId: 'other-binding' },
  { generation: '8' },
  { inputKind: 'managed-tool-args' },
  { attached: false },
  { intent: false },
])(
  'does not classify incomplete or foreign background evidence (%j)',
  async (over) => {
    const f = await fixture();
    await f.background('shell', over);
    await f.terminal();
    heldRelease();
    await expect(f.reconcile()).rejects.toMatchObject({
      status: 409,
      code: 'runtime_session_held',
    });
    expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
    expect(f.debt().payload['state']).toBe('owed');
  },
);

it.each(['none', 'exited', 'unknown'] as const)(
  'does not treat historical or unproven runs as held (%s)',
  async (state) => {
    const f = await fixture();
    if (state === 'exited') {
      const id = await f.background('shell');
      await f.shells.settleExited(id, { exitCode: 0, exitSignal: null });
    } else if (state === 'unknown') {
      const id = await f.background('monitor');
      await f.monitors.blockedRuntimeLost(id);
    }
    await f.terminal();
    heldRelease();
    await expect(f.reconcile()).rejects.toMatchObject({
      code: 'runtime_session_held',
    });
    expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
  },
);

it('does not let a healthy run mask another unknown hold under the same owner', async () => {
  const f = await fixture();
  await f.background('shell');
  const monitorId = await f.background('monitor');
  await f.monitors.blockedRuntimeLost(monitorId);
  await f.terminal();
  heldRelease();
  await expect(f.reconcile()).rejects.toMatchObject({
    code: 'runtime_session_held',
  });
});

it.each([{ bindingId: 'other-binding' }, { generation: '8' }])(
  'does not let a healthy run mask conflicting same-owner binding evidence (%j)',
  async (runtime) => {
    const f = await fixture();
    await f.background('shell');
    await f.background('monitor', runtime);
    await f.terminal();
    heldRelease();
    await expect(f.reconcile()).rejects.toMatchObject({
      code: 'runtime_session_held',
    });
    expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
  },
);

it('does not let a different owner block a matching healthy hold', async () => {
  const f = await fixture();
  await f.background('shell');
  await f.background('monitor', {
    runtimeSessionId: 'other-runtime',
    bindingId: 'other-binding',
    generation: '8',
  });
  await f.terminal();
  heldRelease();
  const result = await f.reconcile();
  expect(result.held.size).toBe(1);
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
    false,
  );
});

it.each([
  new HostedWorkspaceBrokerRejection(409, 'runtime_session_busy'),
  new HostedWorkspaceBrokerRejection(503, 'runtime_session_held'),
  new Error('network disconnected'),
  { status: 409, code: 'runtime_session_held' },
])(
  'preserves release failures instead of classifying them as held (%s)',
  async (failure) => {
    const f = await fixture();
    await f.background('shell');
    await f.terminal();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockRejectedValue(
      failure,
    );
    await expect(f.reconcile()).rejects.toBe(failure);
    expect(f.debt().payload['state']).toBe('owed');
    expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
  },
);

it('requires actual release on drain and confirms only its successful retry', async () => {
  const f = await fixture();
  await f.background('shell');
  await f.terminal();
  const release = heldRelease();
  await expect(f.reconcile(true)).rejects.toMatchObject({
    code: 'runtime_session_held',
  });
  expect(release).toHaveBeenLastCalledWith({
    bindingId: 'binding',
    generation: '7',
    drain: true,
  });
  expect(f.debt().payload['state']).toBe('owed');
  release.mockResolvedValue();
  expect(await f.reconcile(true)).toEqual({
    states: new Map([[f.promptId, 'confirmed']]),
    held: new Map(),
  });
  expect(hasHostedCleanupDebt(f.session)).toBe(false);
});

it('rebuilds hold classification after a cold read instead of trusting durable history alone', async () => {
  const f = await fixture();
  await f.background('shell');
  await f.terminal();
  heldRelease();
  expect((await f.reconcile()).held.size).toBe(1);
  await f.reopen();
  expect(await hasBlockingHostedCleanupDebt(f.session)).toBe(true);
  expect(await hasBlockingHostedCleanupDebt(f.session, new Map())).toBe(true);
  const result = await f.reconcile();
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
    false,
  );
  expect(f.debt().payload['state']).toBe('owed');
});

it.each(['terminal', 'unknown'] as const)(
  'invalidates classification after its durable run becomes %s',
  async (state) => {
    const f = await fixture();
    const id = await f.background('monitor');
    await f.terminal();
    heldRelease();
    const result = await f.reconcile();
    expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
      false,
    );
    if (state === 'unknown') await f.monitors.blockedRuntimeLost(id);
    else await f.monitors.settleQuiet(id, 'exited');
    expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(
      true,
    );
  },
);

it('invalidates classification when the latest cleanup descriptor changes', async () => {
  const f = await fixture();
  await f.background('shell');
  await f.terminal();
  heldRelease();
  const result = await f.reconcile();
  const event = f.debt();
  const ref = assertManagedSessionDurableRef(
    event.payload['descriptorRef'],
    'descriptor',
  );
  const descriptor = JSON.parse(
    (await f.session.resources.read(ref)).toString('utf8'),
  );
  const descriptorRef = await f.session.resources.publish(
    'hosted-turn-cleanup',
    Buffer.from(
      JSON.stringify({ ...descriptor, bindingId: 'replacement-binding' }),
    ),
  );
  const activation = f.session.activation;
  const eventId = randomUUID();
  await f.session.authority.appendExecutionEvent(
    {
      operation: 'changedCleanup',
      commandId: eventId,
      sessionKey: event.sessionKey,
      contentDigest: descriptorRef.digest,
    },
    (sequence) => ({
      ...event,
      sequence,
      eventId,
      payload: { ...event.payload, descriptorRef },
    }),
    { class: 'harness', activation },
  );
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(true);
});

it('rejects a moving evidence view without releasing or admitting through it', async () => {
  const f = await fixture();
  const id = await f.background('shell');
  await f.terminal();
  const release = heldRelease();
  const result = await f.reconcile();
  const read = f.session.resources.read.bind(f.session.resources);
  let changed = false;
  vi.spyOn(f.session.resources, 'read').mockImplementation(async (ref) => {
    const bytes = await read(ref);
    if (!changed && ref.kind === 'managed-tool-input') {
      changed = true;
      await f.shells.settleExited(id, { exitCode: 0, exitSignal: null });
    }
    return bytes;
  });
  expect(await hasBlockingHostedCleanupDebt(f.session, result.held)).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
});
