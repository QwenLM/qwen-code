/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { HostedMonitorSession } from './hosted-monitor-session.js';
import {
  HostedMonitorLoop,
  type MonitorLoopClock,
  type MonitorWatchHandle,
} from './hosted-monitor-loop.js';

// monitor_run is enabled by the H3 enablement slice; this suite drives the
// hosted orchestrator ahead of it, like the core authority suite does.
const enablement = vi.hoisted(() => ({ monitorRun: true }));

vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
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
  },
);

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.monitorRun = true;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

class ManualClock implements MonitorLoopClock {
  time = 0;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { handler: () => void; at: number }
  >();

  now(): number {
    return this.time;
  }

  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
    this.seq += 1;
    this.pending.set(this.seq, { handler, at: this.time + ms });
    return this.seq as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.pending.delete(handle as unknown as number);
  }

  /** Runs every handler due by then, in due order, awaiting each. */
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const next = [...this.pending.entries()]
        .filter(([, entry]) => entry.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.pending.delete(next[0]);
      this.time = next[1].at;
      await (next[1].handler() as unknown as Promise<void> | undefined);
    }
    this.time = until;
  }
}

class FakeExecutor {
  onLine: ((line: string) => void) | undefined;
  private onExit: ((failed: boolean) => Promise<void> | void) | undefined;
  terminateCalls = 0;
  commands: Array<Readonly<Record<string, unknown>>> = [];
  failStart: Error | undefined;

  start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean) => Promise<void> | void,
  ): Promise<MonitorWatchHandle> {
    this.commands.push(command);
    if (this.failStart !== undefined) return Promise.reject(this.failStart);
    this.onLine = onLine;
    this.onExit = onExit;
    return Promise.resolve({
      receipt: { watch: 'started' },
      terminate: () => {
        this.terminateCalls += 1;
        return Promise.resolve();
      },
    });
  }

  exitNaturally(): Promise<void> {
    return (
      (this.onExit?.(false) as Promise<void> | undefined) ?? Promise.resolve()
    );
  }

  fail(): Promise<void> {
    return (
      (this.onExit?.(true) as Promise<void> | undefined) ?? Promise.resolve()
    );
  }
}

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-monitor-loop-'));
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

interface Rig {
  readonly authority: LocalManagedSessionAuthority;
  readonly session: HostedMonitorSession;
  readonly executor: FakeExecutor;
  readonly clock: ManualClock;
  readonly loop: HostedMonitorLoop;
  readonly lease: SessionWriterLease;
}

async function openLoop(harness: Harness): Promise<Rig> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  const authority = await LocalManagedSessionAuthority.open({
    lease,
    sessionKey,
    cwd: '/workspace',
    version: 'test',
    resources: harness.store,
    now: () => harness.now,
    create: {
      definitionRef: await harness.store.publish(
        'managed-definition',
        Buffer.from('{}', 'utf8'),
      ),
      rootSnapshotRef: await harness.store.publish(
        'managed-root',
        Buffer.from('{}', 'utf8'),
      ),
      createdBy: 'daemon',
    },
  });
  const session = new HostedMonitorSession(
    { authority, resources: harness.store },
    sessionKey,
  );
  const executor = new FakeExecutor();
  const clock = new ManualClock();
  const loop = new HostedMonitorLoop(session, 'monitor-1', executor, clock);
  return { authority, session, executor, clock, loop, lease };
}

async function closeLoop(rig: Rig): Promise<void> {
  await rig.lease.release().catch(() => undefined);
}

function params(overrides: Record<string, unknown> = {}) {
  return {
    ownerScopeId: 'scope-main',
    executionCallId: 'call-monitor-1',
    args: { command: 'tail -f build.log' },
    maxEvents: 100,
    idleTimeoutMs: 60_000,
    debounceMs: 1000,
    runtime: BINDING,
    ...overrides,
  };
}

function committed(
  authority: LocalManagedSessionAuthority,
): ReturnType<typeof parseMonitorRun> {
  const existing = authority.extensionRecord('monitor_run', 'monitor-1');
  if (!existing) throw new Error('No monitor_run record.');
  return parseMonitorRun(existing.record);
}

describe('HostedMonitorLoop', () => {
  it('does not resume a record the publisher already settled', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    // The watch ended before its observation arm could register; the
    // publisher's fallback settled the record. A later resume must
    // recognize the terminal record instead of driving a watch nobody
    // watches and settling it twice.
    await rig.session.admit({
      monitorId: 'monitor-1',
      ownerScopeId: 'scope-main',
      executionCallId: 'call-monitor-1',
      args: { command: 'tail -f build.log' },
      maxEvents: 100,
      idleTimeoutMs: 60_000,
      debounceMs: 1_000,
    });
    await rig.session.dispatchStarted('monitor-1', BINDING);
    await rig.session.attach('monitor-1', BINDING, { watch: 'started' });
    await rig.session.settleQuiet('monitor-1', 'exited');
    await rig.loop.resumeAttached(params());
    expect(rig.executor.commands).toEqual([]);
    await closeLoop(rig);
  });

  it('aggregates lines into one observation per floored debounce window', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({ debounceMs: 0 }));
    expect(committed(rig.authority).run).toMatchObject({
      state: 'running',
      execution: 'running_attached',
    });

    rig.executor.onLine?.('built');
    rig.executor.onLine?.('tested');
    await rig.clock.advance(999);
    expect(committed(rig.authority).observationSequence).toBe(0);
    await rig.clock.advance(1);
    expect(committed(rig.authority).observationSequence).toBe(1);

    await rig.clock.advance(1_000);
    expect(committed(rig.authority).observationSequence).toBe(1);
    const body = committed(rig.authority);
    expect(body.notifiedThrough).toBe(1);
    expect(
      JSON.parse(
        (await harness.store.read(body.lastObservationRef!)).toString(),
      ),
    ).toEqual({ lines: ['built', 'tested'] });

    // The observation, its notification input and its wake landed in one
    // transaction: the turn the wake raises reads exactly these lines.
    const events = rig.authority.readEvents().slice(-3);
    expect(events.map((event) => event.kind)).toEqual([
      'domain.committed',
      'input.accepted',
      'wake.requested',
    ]);
    expect(events[2].payload).toMatchObject({
      sourceEventId: 'monitor-1:notify:1:accepted',
      requiredSequence: events[1].sequence,
    });
    expect(
      JSON.parse(
        (
          await harness.store.read(events[1].payload['contentRef'] as never)
        ).toString(),
      ),
    ).toEqual({
      text: [
        '<task-notification>',
        '<task-id>monitor-1</task-id>',
        '<tool-use-id>call-monitor-1</tool-use-id>',
        '<kind>monitor</kind>',
        '<status>running</status>',
        '<event-count>1</event-count>',
        '<summary>Monitor "tail -f build.log" emitted event #1.</summary>',
        '<result>built\ntested</result>',
        '</task-notification>',
      ].join('\n'),
    });
    await closeLoop(rig);
  });

  it('settles max_events at the quota and terminates the watch', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({ maxEvents: 2 }));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    rig.executor.onLine?.('two');
    await rig.clock.advance(1_000);
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 2,
      notifiedThrough: 2,
      stopReason: 'max_events',
      run: { state: 'settled', execution: 'settled' },
    });
    expect(rig.executor.terminateCalls).toBe(1);

    rig.executor.onLine?.('late');
    await rig.clock.advance(5_000);
    expect(committed(rig.authority).observationSequence).toBe(2);
    await closeLoop(rig);
  });

  it('settles idle_timeout after its last accepted observation', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({ idleTimeoutMs: 60_000 }));

    rig.executor.onLine?.('kept-alive');
    await rig.clock.advance(1_000);
    expect(committed(rig.authority).observationSequence).toBe(1);
    await rig.clock.advance(59_000);
    expect(committed(rig.authority).stopReason).toBeNull();
    await rig.clock.advance(1_000);
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'idle_timeout',
      run: { state: 'settled', execution: 'settled' },
    });
    expect(rig.executor.terminateCalls).toBe(1);
    await closeLoop(rig);
  });

  it('flushes the buffer and settles exited when the watch ends', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.onLine?.('tail line');
    rig.executor.exitNaturally();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 1,
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
    expect(rig.executor.terminateCalls).toBe(0);
    await closeLoop(rig);
  });

  it('prints the successor refusal on its exit chain when an owner settles first', async () => {
    // Why the publisher now awaits this chain: an owner that settles ahead
    // of it loses the last window — the successor rule rightly refuses the
    // observe, and that refusal must surface, never die in the void.
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.onLine?.('lost tail');
    await rig.session.settleQuiet('monitor-1', 'exited');
    await expect(rig.executor.exitNaturally()).rejects.toThrow();
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 0,
      notifiedThrough: 0,
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('settles start_failed on not_started_proven when the watch cannot start', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.failStart = new Error('no cgroup');
    await expect(rig.loop.start(params({}))).rejects.toThrow('no cgroup');
    expect(committed(rig.authority)).toMatchObject({
      startReceiptRef: null,
      stopReason: 'start_failed',
      run: { state: 'failed', execution: 'not_started_proven' },
    });
    await closeLoop(rig);
  });

  it('settles watch_failed when the watch dies mid-run', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.fail();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'watch_failed',
      run: { state: 'failed', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('stops on request, terminates, and stays settled', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    await rig.loop.stop();
    expect(rig.executor.terminateCalls).toBe(1);
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });

    rig.executor.onLine?.('too late');
    await rig.clock.advance(5_000);
    expect(committed(rig.authority).observationSequence).toBe(0);
    await closeLoop(rig);
  });
});
