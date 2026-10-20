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

// monitor_run is enabled by the H3 enablement slice (#13856): this suite
// drives the hosted loop through the real gate, with no lift.
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

const temporaryDirectories = new Set<string>();
const activeRigs = new Set<Rig>();

async function cleanupFixtures(): Promise<void> {
  for (const rig of activeRigs) await closeLoop(rig);
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}

afterEach(cleanupFixtures);

class ManualClock implements MonitorLoopClock {
  time = 0;
  readonly executions: Array<Promise<unknown>> = [];
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

  advance(ms: number): Promise<void> {
    return this.track(this.advanceOnce(ms));
  }

  track<T>(execution: Promise<T>): Promise<T> {
    this.executions.push(execution);
    void execution.catch(() => undefined);
    return execution;
  }

  /** Runs every handler due by then, in due order, awaiting each. */
  private async advanceOnce(ms: number): Promise<void> {
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

  /** Starts every handler due by then at once, as real timers can race. */
  fireTogether(ms: number): Promise<unknown> {
    this.time += ms;
    const due = [...this.pending.entries()]
      .filter(([, entry]) => entry.at <= this.time)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [handle] of due) this.pending.delete(handle);
    return this.track(Promise.all(due.map(([, entry]) => entry.handler())));
  }
}

class FakeExecutor {
  onLine: ((line: string) => void) | undefined;
  private onExit:
    | ((failed: boolean, stopRequested?: boolean) => Promise<void> | void)
    | undefined;
  terminateCalls = 0;
  /** Whether terminate answers with the worker's exit evidence. */
  provesStop = true;
  /** Holds each terminate open until the case answers it. */
  holdStop = false;
  private readonly heldStops: Array<(proven: boolean) => void> = [];
  commands: Array<Readonly<Record<string, unknown>>> = [];
  failStart: Error | undefined;

  start(
    command: Readonly<Record<string, unknown>>,
    onLine: (line: string) => void,
    onExit: (failed: boolean, stopRequested?: boolean) => Promise<void> | void,
  ): Promise<MonitorWatchHandle> {
    this.commands.push(command);
    if (this.failStart !== undefined) return Promise.reject(this.failStart);
    this.onLine = onLine;
    this.onExit = onExit;
    return Promise.resolve({
      receipt: { watch: 'started' },
      terminate: async () => {
        this.terminateCalls += 1;
        if (this.holdStop)
          return new Promise<boolean>((resolve) =>
            this.heldStops.push(resolve),
          );
        // The worker answers a proven stop only after the finalize that
        // carries the stopped watch's exit returned (#13896).
        if (this.provesStop) await this.exitStopped();
        return this.provesStop;
      },
    });
  }

  answerStop(proven: boolean): void {
    this.heldStops.shift()?.(proven);
  }

  releaseStops(): void {
    this.holdStop = false;
    while (this.heldStops.length > 0) this.answerStop(false);
  }

  exitNaturally(): Promise<void> {
    return (
      (this.onExit?.(false) as Promise<void> | undefined) ?? Promise.resolve()
    );
  }

  exitStopped(): Promise<void> {
    return (
      (this.onExit?.(false, true) as Promise<void> | undefined) ??
      Promise.resolve()
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
  const stop = loop.stop.bind(loop);
  vi.spyOn(loop, 'stop').mockImplementation((...args) =>
    clock.track(stop(...args)),
  );
  const rig = { authority, session, executor, clock, loop, lease };
  activeRigs.add(rig);
  return rig;
}

async function closeLoop(rig: Rig): Promise<void> {
  rig.loop.prepareLifecycle();
  rig.executor.releaseStops();
  await Promise.allSettled(rig.clock.executions);
  await rig.loop.done.catch(() => undefined);
  if (rig.session.record('monitor-1')?.stopReason === null) {
    await rig.loop.stop();
  }
  await rig.lease.release().catch(() => undefined);
  activeRigs.delete(rig);
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
  it('drains an abandoned quota stop before removing its transcript', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.holdStop = true;
    await rig.loop.start(params({ maxEvents: 1 }));
    rig.executor.onLine?.('one');
    const fired = rig.clock.advance(1_000);
    await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(1));

    await cleanupFixtures();
    rig.executor.answerStop(false);
    await expect(fired).resolves.toBeUndefined();
    await expect(fs.stat(harness.transcriptPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps observations but suppresses wakes and premature stop during lifecycle drain', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({ maxEvents: 1, idleTimeoutMs: 2_000 }));
    rig.loop.prepareLifecycle();
    rig.executor.onLine?.('output during stop');
    await rig.clock.advance(3_000);
    expect(rig.executor.terminateCalls).toBe(0);
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 1,
      notifiedThrough: 0,
      stopReason: null,
      run: { state: 'running' },
    });
    expect(
      rig.authority
        .eventsInSequenceRange(1, rig.authority.committedSequence)
        .filter((event) => event.kind === 'input.accepted'),
    ).toHaveLength(0);
    await rig.executor.exitStopped();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

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

  it.each(['stop_requested', 'runtime_lost'] as const)(
    'close stop after a resume that found the record settled (%s)',
    async (settle) => {
      const harness = await createHarness();
      const rig = await openLoop(harness);
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
      await rig.session.settleQuiet('monitor-1', 'exited'); // the publisher's no-observer settle
      await rig.loop.resumeAttached(params()); // returns early, as designed
      await rig.loop.stop(settle); // what the Session close does next
      await closeLoop(rig);
    },
  );

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

  it('parks an auto-stop it cannot prove instead of settling the quota (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    // The worker could not prove the stop (#13896): the quota may not
    // claim a settled watch that may still run and still hold its Runtime.
    rig.executor.provesStop = false;
    await rig.loop.start(params({ maxEvents: 1 }));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 1,
      stopReason: null,
      run: {
        state: 'recovery_blocked',
        reason: 'runtime_lost',
        execution: 'outcome_unknown',
      },
    });
    expect(rig.executor.terminateCalls).toBe(1);

    // The loop stopped observing, so a later line neither flushes nor
    // re-settles the parked record.
    rig.executor.onLine?.('late');
    await rig.clock.advance(5_000);
    expect(committed(rig.authority).observationSequence).toBe(1);
    await closeLoop(rig);
  });

  it('settles a parked quota at the watch exit that follows it (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.provesStop = false;
    await rig.loop.start(params({ maxEvents: 1 }));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    await rig.loop.done;
    expect(committed(rig.authority).run.state).toBe('recovery_blocked');

    // The park left the record open: the watch kept running, so its own
    // physical end is still the evidence that settles it.
    await rig.executor.exitNaturally();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('projects a platform stop that follows a parked idle window (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.provesStop = false;
    await rig.loop.start(params({ idleTimeoutMs: 60_000 }));

    rig.executor.onLine?.('kept-alive');
    await rig.clock.advance(1_000);
    await rig.clock.advance(60_000);
    await rig.loop.done;
    expect(committed(rig.authority).run.state).toBe('recovery_blocked');

    // A8 still holds after a park: a requested stop projects as
    // stop_requested, never as a bare exit.
    await rig.executor.exitStopped();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('upgrades a parked record when the close drain proves the stop (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.provesStop = false;
    await rig.loop.start(params({ maxEvents: 1 }));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    await rig.loop.done;
    expect(committed(rig.authority).run.state).toBe('recovery_blocked');

    // The Session close drained, so its stop call is proven and must not be
    // skipped over the park.
    await rig.loop.stop('stop_requested');
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('settles a failed close park at the watch exit that follows it (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    // The held-Runtime drain could not prove its stop, so the close parks
    // this loop and fails: the Session and its publisher stay alive.
    rig.executor.provesStop = false;
    await rig.loop.stop('runtime_lost');
    expect(committed(rig.authority).run).toMatchObject({
      state: 'recovery_blocked',
      execution: 'outcome_unknown',
    });

    // Nothing proved the watch stopped, and it ends here: that evidence
    // still settles the record the park left open.
    await rig.executor.exitNaturally();
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('upgrades a failed close park when the retry drain proves the stop (#13856)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.onLine?.('one');
    await rig.clock.advance(1_000);
    rig.executor.provesStop = false;
    await rig.loop.stop('runtime_lost');
    expect(committed(rig.authority).run.state).toBe('recovery_blocked');

    // The retried close drained, so its stop call is proven and must not be
    // skipped over the earlier park.
    rig.executor.provesStop = true;
    await rig.loop.stop('stop_requested');
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it('settles an exit that crosses the quota as exited, without a false park (#13856 R1-30)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    // The production remote watch cannot prove a terminate, which is exactly
    // where the quota park would have minted a false runtime_lost revision.
    rig.executor.provesStop = false;
    const parked = vi.spyOn(rig.session, 'blockedRuntimeLost');
    await rig.loop.start(params({ maxEvents: 1 }));

    rig.executor.onLine?.('one');
    // The physical end arrives with the quota just reached, ahead of any
    // debounce window: the exit evidence wins over the quota.
    await rig.executor.exitNaturally();
    await rig.loop.done;

    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'exited',
      run: { state: 'settled', execution: 'settled' },
    });
    expect(parked).not.toHaveBeenCalled();
    await closeLoop(rig);
  });

  it.each([
    ['max_events', { maxEvents: 1 }, 1_000, true],
    ['idle_timeout', { idleTimeoutMs: 60_000 }, 60_000, false],
  ] as const)(
    'settles %s at the exit that lands while its stop waits on the worker (#13896)',
    async (reason, bounds, firing, proven) => {
      const harness = await createHarness();
      const rig = await openLoop(harness);
      rig.executor.holdStop = true;
      await rig.loop.start(params(bounds));

      if (reason === 'max_events') rig.executor.onLine?.('one');
      const fired = rig.clock.advance(firing);
      await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(1));
      // The worker finalizes before it answers, so the exit is this stop's
      // own evidence: its stop marker does not override the loop's reason.
      await rig.executor.exitStopped();
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state: 'settled', execution: 'settled' },
      });

      // The answer that follows, proven or lost, finds the record settled.
      rig.executor.answerStop(proven);
      await fired;
      await rig.loop.done;
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state: 'settled', execution: 'settled' },
      });
      await closeLoop(rig);
    },
  );

  it.each([
    [true, 'max_events', 1],
    [false, 'stop_requested', 2],
  ] as const)(
    'lets a close stop wait out the auto-stop in flight (proven: %s) (#13896)',
    async (proven, reason, calls) => {
      const harness = await createHarness();
      const rig = await openLoop(harness);
      rig.executor.holdStop = true;
      await rig.loop.start(params({ maxEvents: 1 }));

      rig.executor.onLine?.('one');
      const fired = rig.clock.advance(1_000);
      await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(1));
      const stopped = rig.loop.stop('stop_requested');
      // The close's stop issues nothing while the auto-stop still waits.
      expect(rig.executor.terminateCalls).toBe(1);

      // A proven answer with no exit before it: the final output never
      // landed, so the close settles at the auto-stop's reason itself.
      rig.executor.answerStop(proven);
      await fired;
      if (!proven) {
        // Only the auto-stop's park leaves the record to the close's own
        // proven stop.
        await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(2));
        rig.executor.answerStop(true);
      }
      await stopped;
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state: proven ? 'settled' : 'cancelled', execution: 'settled' },
      });
      expect(rig.executor.terminateCalls).toBe(calls);
      await closeLoop(rig);
    },
  );

  it.each([
    ['max_events', { maxEvents: 1 }, 1_000],
    ['idle_timeout', { idleTimeoutMs: 60_000 }, 60_000],
  ] as const)(
    'keeps a proven %s stop open until its refused finalize lands (#13896)',
    async (reason, bounds, firing) => {
      const harness = await createHarness();
      const rig = await openLoop(harness);
      rig.executor.holdStop = true;
      const parked = vi.spyOn(rig.session, 'blockedRuntimeLost');
      await rig.loop.start(params(bounds));

      if (reason === 'max_events') rig.executor.onLine?.('one');
      const fired = rig.clock.advance(firing);
      await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(1));
      // The worker proved the end, but the publisher refused the finalize
      // that carries it: the sealed output has not reached the record, and
      // a terminal record would refuse it.
      rig.executor.answerStop(true);
      await fired;
      await rig.loop.done;
      expect(committed(rig.authority)).toMatchObject({
        stopReason: null,
        run: { state: 'running' },
      });
      expect(parked).not.toHaveBeenCalled();

      // The finalize's redrive delivers the exit, which settles at the
      // stop's reason, not at its stop marker.
      await rig.executor.exitStopped();
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state: 'settled', execution: 'settled' },
      });
      expect(rig.executor.terminateCalls).toBe(1);
      await closeLoop(rig);
    },
  );

  it('settles watch_failed for an end without evidence while its stop waits (#13896)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.holdStop = true;
    await rig.loop.start(params({ maxEvents: 1 }));

    rig.executor.onLine?.('one');
    const fired = rig.clock.advance(1_000);
    await vi.waitFor(() => expect(rig.executor.terminateCalls).toBe(1));
    // An end without evidence proves no stop: it reports the failed watch,
    // never the stop's reason, and the answer that follows changes nothing.
    await rig.executor.fail();
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'watch_failed',
      run: { state: 'failed', execution: 'settled' },
    });

    rig.executor.answerStop(true);
    await fired;
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'watch_failed',
      run: { state: 'failed', execution: 'settled' },
    });
    await closeLoop(rig);
  });

  it.each([
    ['runtime_lost', 'exitNaturally', 'exited', 'settled'],
    ['stop_requested', 'exitStopped', 'stop_requested', 'cancelled'],
  ] as const)(
    'keeps the settlement an exit made while a %s close stop waited (#13896)',
    async (settle, exit, reason, state) => {
      const harness = await createHarness();
      const rig = await openLoop(harness);
      rig.executor.holdStop = true;
      await rig.loop.start(params({}));

      rig.executor.onLine?.('one');
      await rig.clock.advance(1_000);
      const stopped = rig.loop.stop(settle);
      await rig.executor[exit]();
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state, execution: 'settled' },
      });

      // The stop's own answer arrives after the exit settled the record.
      rig.executor.answerStop(false);
      await stopped;
      expect(committed(rig.authority)).toMatchObject({
        stopReason: reason,
        run: { state, execution: 'settled' },
      });
      await closeLoop(rig);
    },
  );

  it('issues one auto-stop when the idle window fires inside the quota flush (#13896)', async () => {
    const harness = await createHarness();
    const rig = await openLoop(harness);
    rig.executor.holdStop = true;
    await rig.loop.start(params({ maxEvents: 1, idleTimeoutMs: 1_000 }));

    // The window's flush is still committing when the idle timer fires: the
    // idle stop is the one under way, and the quota the flush then reaches
    // has nothing left to stop.
    rig.executor.onLine?.('one');
    const fired = rig.clock.fireTogether(1_000);
    await vi.waitFor(() =>
      expect(committed(rig.authority).observationSequence).toBe(1),
    );
    expect(rig.executor.terminateCalls).toBe(1);

    await rig.executor.exitStopped();
    rig.executor.answerStop(true);
    await fired;
    await rig.loop.done;
    expect(committed(rig.authority)).toMatchObject({
      stopReason: 'idle_timeout',
      run: { state: 'settled', execution: 'settled' },
    });
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

  it('settles stop_requested when a platform stop ends the watch', async () => {
    // #13856 A8: the drain's stop arrives marked; the loop flushes the
    // buffered lines, then settles the requested stop — never a bare exit.
    const harness = await createHarness();
    const rig = await openLoop(harness);
    await rig.loop.start(params({}));

    rig.executor.onLine?.('tail line');
    await rig.executor.exitStopped();
    expect(committed(rig.authority)).toMatchObject({
      observationSequence: 1,
      stopReason: 'stop_requested',
      run: { state: 'cancelled', execution: 'settled' },
    });
    // The physical stop already happened; the loop terminates nothing more.
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
