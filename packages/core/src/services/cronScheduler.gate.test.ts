/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The scheduler's gate path: a job with a gate runs it before onFire, and
 * the gate's result decides whether, and with what text, the fire is
 * delivered. See docs/design/2026-10-21-scheduled-task-gate.md.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import type {
  CronGateResult,
  CronGateRunOptions,
  CronGateRunner,
} from './cron-gate.js';
import { CronScheduler, type CronJob } from './cronScheduler.js';
import {
  readCronTasks,
  taskHasLegacyCondition,
  updateCronTasks,
  withTaskGate,
  writeCronTasks,
  type DurableCronTask,
} from './cronTasksFile.js';

const at = (h: number, m: number, sec = 0) => new Date(2025, 0, 15, h, m, sec);

/** Hands each gate run the next scripted result; unscripted runs stay
 * pending until `release` settles them. */
function scriptedRunner(results: CronGateResult[] = []) {
  const calls: Array<{ gate: string; options: CronGateRunOptions }> = [];
  const pending: Array<(result: CronGateResult) => void> = [];
  const runner: CronGateRunner = (gate, options) => {
    calls.push({ gate, options });
    const next = results.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => pending.push(resolve));
  };
  const release = async (result: CronGateResult) => {
    pending.shift()!(result);
    await settled();
  };
  return { runner, calls, release };
}

/** Drains the microtask hops between a resolved gate run and its settle. */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const output = (stdout: string): CronGateResult => ({
  kind: 'output',
  stdout,
  truncated: false,
  durationMs: 50,
});
const quiet: CronGateResult = { kind: 'quiet', durationMs: 20 };
const failed: CronGateResult = {
  kind: 'failed',
  detail: 'exited with code 1',
  stderr: 'boom',
  durationMs: 30,
};

describe('CronScheduler gate', () => {
  let scheduler: CronScheduler;
  let fired: CronJob[];
  const script = scriptedRunner();

  beforeEach(() => {
    // Only Date is faked: the gate settles on real microtasks, and the
    // creation minute must sit before the slots the tests tick.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(10, 29));
    script.calls.length = 0;
    scheduler = new CronScheduler(null, undefined, { runGate: script.runner });
    fired = [];
    scheduler.start((job) => fired.push(job));
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  const createGated = (gate = './probe.sh') =>
    scheduler.create('* * * * *', 'Handle the events below.', true, gate);

  it('skips the fire and records a quiet run when the gate prints nothing', async () => {
    const job = createGated();
    script.calls.length = 0;
    scheduler.tick(at(10, 30, 59));
    expect(script.calls).toHaveLength(1);
    await script.release(quiet);
    expect(fired).toHaveLength(0);
    expect(job.gateStatus).toMatchObject({
      lastOutcome: 'quiet',
      quietSinceDelivery: 1,
      consecutiveFailures: 0,
    });
    expect(job.gateStatus?.lastAt).toBe(at(10, 30).getTime());
  });

  it('delivers the prompt with the output attached when the gate prints', async () => {
    const job = createGated();
    scheduler.tick(at(10, 30, 59));
    await script.release(output('event: comment\n'));
    expect(fired).toHaveLength(1);
    const text = fired[0]!.prompt;
    expect(text.startsWith('Handle the events below.\n\n')).toBe(true);
    expect(text).toContain('(`./probe.sh`, exit 0, 0.1 s)');
    expect(text.endsWith('<gate-output>\nevent: comment\n</gate-output>')).toBe(
      true,
    );
    expect(fired[0]!.id).toBe(job.id);
    // The stored job keeps its own prompt; only the delivered copy carries
    // the output.
    expect(job.prompt).toBe('Handle the events below.');
    // The task's own prompt rides along, to title a fresh per-run session.
    expect(fired[0]!.taskPrompt).toBe('Handle the events below.');
    expect(job.gateStatus).toMatchObject({
      lastOutcome: 'delivered',
      quietSinceDelivery: 0,
      lastDeliveredAt: at(10, 30).getTime(),
    });
  });

  it('passes the in-process approval to the runner', async () => {
    const job = createGated();
    scheduler.tick(at(10, 30, 59));
    expect(script.calls[0]!.options.approvedInProcess).toBe(false);
    await script.release(quiet);
    job.gateApproved = true;
    scheduler.tick(at(10, 31, 59));
    expect(script.calls[1]!.options.approvedInProcess).toBe(true);
    await script.release(quiet);
  });

  it('reports a failure once per streak and counts the rest', async () => {
    const job = createGated();
    scheduler.tick(at(10, 30, 59));
    await script.release(failed);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.prompt).toContain(
      'its gate command failed, so the task prompt did not run',
    );
    expect(fired[0]!.prompt).toContain('`./probe.sh` exited with code 1');
    expect(fired[0]!.prompt).toContain('<gate-stderr>\nboom\n</gate-stderr>');

    scheduler.tick(at(10, 31, 59));
    await script.release(failed);
    expect(fired).toHaveLength(1);
    expect(job.gateStatus).toMatchObject({
      lastOutcome: 'failed',
      consecutiveFailures: 2,
      lastError: 'exited with code 1',
    });

    // A success ends the streak; the next failure is reported again.
    scheduler.tick(at(10, 32, 59));
    await script.release(quiet);
    expect(job.gateStatus?.consecutiveFailures).toBe(0);
    expect(job.gateStatus?.lastError).toBeUndefined();
    scheduler.tick(at(10, 33, 59));
    await script.release(failed);
    expect(fired).toHaveLength(2);
  });

  it('reports a blocked gate with the rule to add', async () => {
    createGated();
    scheduler.tick(at(10, 30, 59));
    await script.release({
      kind: 'blocked',
      reason: 'it has not been approved to run unattended in this session',
      rule: 'Monitor(./probe.sh)',
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.prompt).toContain('was not run because it has not been');
    expect(fired[0]!.prompt).toContain('`Monitor(./probe.sh)`');
  });

  it('reports again when a blocked streak turns into failures, and back', async () => {
    const job = createGated();
    const blocked: CronGateResult = {
      kind: 'blocked',
      reason: 'it has not been approved to run unattended in this session',
      rule: 'Monitor(./probe.sh)',
    };
    scheduler.tick(at(10, 30, 59));
    await script.release(blocked);
    expect(fired).toHaveLength(1);
    // The rule is added, the gate runs and fails: the blocked notice promised
    // silence only until then.
    scheduler.tick(at(10, 31, 59));
    await script.release(failed);
    expect(fired).toHaveLength(2);
    expect(fired[1]!.prompt).toContain('its gate command failed');
    scheduler.tick(at(10, 32, 59));
    await script.release(failed);
    expect(fired).toHaveLength(2);
    scheduler.tick(at(10, 33, 59));
    await script.release(blocked);
    expect(fired).toHaveLength(3);
    expect(fired[2]!.prompt).toContain('was not run because');
    expect(job.gateStatus).toMatchObject({
      lastOutcome: 'blocked',
      consecutiveFailures: 4,
    });
  });

  it('reports a gate blocked for another reason, so the rule to add reaches the session', async () => {
    // A deny rule is removed: the gate is now only unapproved, and that
    // notice is the one that names the rule.
    createGated();
    scheduler.tick(at(10, 30, 59));
    await script.release({
      kind: 'blocked',
      reason: 'a permission rule denies it',
    });
    const unapproved: CronGateResult = {
      kind: 'blocked',
      reason: 'it has not been approved to run unattended in this session',
      rule: 'Monitor(./probe.sh)',
    };
    scheduler.tick(at(10, 31, 59));
    await script.release(unapproved);
    expect(fired).toHaveLength(2);
    expect(fired[1]!.prompt).toContain('`Monitor(./probe.sh)`');
    scheduler.tick(at(10, 32, 59));
    await script.release(unapproved);
    expect(fired).toHaveLength(2);
  });

  it('blocks every gated fire when the scheduler has no runner', async () => {
    const bare = new CronScheduler();
    const bareFired: CronJob[] = [];
    bare.start((job) => bareFired.push(job));
    try {
      const job = bare.create('* * * * *', 'watch', true, './probe.sh');
      bare.tick(at(10, 30, 59));
      await settled();
      expect(bareFired).toHaveLength(1);
      expect(bareFired[0]!.prompt).toContain(
        'this session cannot run shell commands',
      );
      expect(job.gateStatus?.lastOutcome).toBe('blocked');
    } finally {
      bare.destroy();
    }
  });

  it('runs one gate at a time per job and consumes the slots in between', async () => {
    createGated();
    scheduler.tick(at(10, 30, 59));
    expect(script.calls).toHaveLength(1);
    scheduler.tick(at(10, 31, 59));
    expect(script.calls).toHaveLength(1);
    await script.release(output('late\n'));
    expect(fired).toHaveLength(1);
    // The consumed slot does not fire once the gate returns; the next one does.
    scheduler.tick(at(10, 31, 59));
    expect(script.calls).toHaveLength(1);
    scheduler.tick(at(10, 32, 59));
    expect(script.calls).toHaveLength(2);
    await script.release(quiet);
  });

  it('delivers nothing when the job is deleted while its gate runs', async () => {
    // The cancelled settlement still reaches the listener: the deleted job's
    // gate may have been the last work a headless run was waiting on.
    const skipped = vi.fn();
    scheduler.setGateSkippedListener(skipped);
    const job = createGated();
    scheduler.tick(at(10, 30, 59));
    expect(script.calls[0]!.options.signal.aborted).toBe(false);
    await scheduler.delete(job.id);
    expect(script.calls[0]!.options.signal.aborted).toBe(true);
    expect(scheduler.hasGatesInFlight()).toBe(false);
    await script.release(output('too late\n'));
    expect(fired).toHaveLength(0);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing when the scheduler stops while a gate runs', async () => {
    const skipped = vi.fn();
    scheduler.setGateSkippedListener(skipped);
    createGated();
    scheduler.tick(at(10, 30, 59));
    scheduler.stop();
    expect(script.calls[0]!.options.signal.aborted).toBe(true);
    await script.release(output('too late\n'));
    expect(fired).toHaveLength(0);
    // stop() is the end of the run, not a settlement to re-check after.
    expect(skipped).not.toHaveBeenCalled();
  });

  it('delivers to the consumer a later start() installed while the gate ran', async () => {
    // ACP installs a fresh callback through start() after every turn while
    // the timer keeps running; a gate mid-run must not lose its output to it.
    createGated();
    scheduler.tick(at(10, 30, 59));
    const later: CronJob[] = [];
    scheduler.start((job) => later.push(job));
    await script.release(output('event: push\n'));
    expect(fired).toHaveLength(0);
    expect(later).toHaveLength(1);
    expect(later[0]!.prompt).toContain(
      '<gate-output>\nevent: push\n</gate-output>',
    );
  });

  it('counts a final fire whose gate still runs and reports a quiet settlement', async () => {
    // An expiring recurring job (like a one-shot) leaves the map before its
    // gate runs. Until the gate settles it is still this session's work, and
    // a quiet settlement reaches no consumer, so the listener is what lets a
    // headless run notice it is done.
    scheduler.destroy();
    scheduler = new CronScheduler(null, 60_000, { runGate: script.runner });
    scheduler.start((job) => fired.push(job));
    const skipped = vi.fn();
    scheduler.setGateSkippedListener(skipped);
    createGated();
    expect(scheduler.sessionSize).toBe(1);
    scheduler.tick(at(10, 30, 59)); // past expiresAt (10:29 + 60 s): final fire
    expect(scheduler.list()).toHaveLength(0);
    expect(scheduler.sessionSize).toBe(1);
    expect(skipped).not.toHaveBeenCalled();
    await script.release(quiet);
    expect(fired).toHaveLength(0);
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(scheduler.sessionSize).toBe(0);
  });

  it('tells the listener about a counted failure but not a delivered fire', async () => {
    const skipped = vi.fn();
    scheduler.setGateSkippedListener(skipped);
    createGated();
    scheduler.tick(at(10, 30, 59));
    await script.release(failed); // first of the streak: a notice is delivered
    expect(fired).toHaveLength(1);
    expect(skipped).not.toHaveBeenCalled();
    scheduler.tick(at(10, 31, 59));
    await script.release(failed); // counted only
    expect(fired).toHaveLength(1);
    expect(skipped).toHaveBeenCalledTimes(1);
    scheduler.tick(at(10, 32, 59));
    await script.release(output('back\n'));
    expect(fired).toHaveLength(2);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('gates a forced fire too', async () => {
    const job = createGated();
    expect(scheduler.forceFireJob(job.id)).toBe(true);
    expect(script.calls).toHaveLength(1);
    await script.release(output('forced\n'));
    expect(fired).toHaveLength(1);
    expect(fired[0]!.prompt).toContain('<gate-output>\nforced\n</gate-output>');
  });

  it('leaves jobs without a gate alone', () => {
    scheduler.create('* * * * *', 'plain', true);
    scheduler.tick(at(10, 30, 59));
    expect(script.calls).toHaveLength(0);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.prompt).toBe('plain');
  });

  describe('durable tasks', () => {
    let tmpDir: string;

    // The chain every background write is appended to. Dereferenced per call:
    // the field is reassigned on each tracked write, so a value captured once
    // would await a chain that has already resolved.
    const persisted = (): Promise<unknown> =>
      (scheduler as unknown as { pendingPersist: Promise<unknown> })
        .pendingPersist;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-gate-test-'));
      Storage.setRuntimeBaseDir(tmpDir);
      scheduler.destroy();
      scheduler = new CronScheduler(tmpDir, undefined, {
        runGate: script.runner,
      });
      fired = [];
    });

    afterEach(async () => {
      scheduler.destroy();
      await persisted();
      Storage.setRuntimeBaseDir(null);
      await fs.rm(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    });

    const reload = () =>
      (
        scheduler as unknown as {
          loadFileTasks(handleMissed: boolean): Promise<void>;
        }
      ).loadFileTasks(false);

    it.each<[string, (tasks: DurableCronTask[]) => DurableCronTask[]]>([
      ['disabled', (tasks) => tasks.map((t) => ({ ...t, enabled: false }))],
      ['removed', () => []],
      [
        'given another gate',
        (tasks) => tasks.map((t) => withTaskGate(t, './other.sh')),
      ],
    ])(
      'aborts a running gate when the task is %s on disk',
      async (_what, edit) => {
        // The paths another session or the daemon's task controls take:
        // cancelling through the file must stop the command like delete()
        // does, not let it finish and drop the result.
        await scheduler.createDurable('* * * * *', 'p', true, './probe.sh');
        await scheduler.enableDurable('session-1');
        scheduler.start((j) => fired.push(j));
        const skipped = vi.fn();
        scheduler.setGateSkippedListener(skipped);
        scheduler.tick(at(10, 30, 59));
        const { signal } = script.calls[0]!.options;
        expect(signal.aborted).toBe(false);
        await updateCronTasks(tmpDir, edit);
        await reload();
        expect(signal.aborted).toBe(true);
        expect(scheduler.hasGatesInFlight()).toBe(false);
        await script.release(output('too late\n'));
        expect(fired).toHaveLength(0);
        // Nothing reaches a consumer, so a headless run waiting on this gate
        // re-checks from the listener.
        expect(skipped).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['quiet', quiet, 0],
      ['delivering', output('event: comment\n'), 1],
    ] as const)(
      'stamps a gated catch-up at once and books its run only at settlement (%s)',
      async (_what, result, runs) => {
        const createdAt = at(7, 0).getTime();
        await writeCronTasks(tmpDir, [
          withTaskGate(
            {
              id: 'cu1',
              cron: '0 * * * *',
              prompt: 'overdue',
              recurring: true,
              createdAt,
              lastFiredAt: createdAt,
            },
            './probe.sh',
          ),
        ]);
        await scheduler.enableDurable('session-1');
        scheduler.start((j) => fired.push(j));
        expect(script.calls).toHaveLength(1);
        // The stamp lands before the gate decides, so a restart cannot
        // replay the catch-up; the run does not.
        let task: DurableCronTask | undefined;
        await persisted();
        [task] = await readCronTasks(tmpDir);
        expect(task?.lastFiredAt).toBe(at(10, 29).getTime());
        expect(task?.runs ?? []).toHaveLength(0);
        await script.release(result);
        expect(fired).toHaveLength(runs);
        await persisted();
        [task] = await readCronTasks(tmpDir);
        expect(task?.runs ?? []).toHaveLength(runs);
        if (runs > 0) {
          expect(task?.runs?.[0]).toMatchObject({
            at: at(10, 29).getTime(),
            kind: 'catch-up',
            gate: 'delivered',
            sessionId: 'session-1',
          });
        }
      },
    );

    it('persists the gate with its downgrade fuse, the status and delivered runs', async () => {
      const job = await scheduler.createDurable(
        '* * * * *',
        'Handle the events below.',
        true,
        './probe.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));

      let [task] = await readCronTasks(tmpDir);
      expect(task).toMatchObject({
        gate: './probe.sh',
        condition: './probe.sh',
      });
      expect(taskHasLegacyCondition(task!)).toBe(false);

      // A quiet fire books no run; its status rides along with the next slot.
      scheduler.tick(at(10, 30, 59));
      await script.release(quiet);
      scheduler.tick(at(10, 31, 59));
      await (scheduler as unknown as { pendingPersist: Promise<unknown> })
        .pendingPersist;
      [task] = await readCronTasks(tmpDir);
      expect(task?.lastFiredAt).toBe(at(10, 31).getTime());
      expect(task?.runs ?? []).toHaveLength(0);
      expect(task?.gateStatus).toMatchObject({
        lastOutcome: 'quiet',
        quietSinceDelivery: 1,
      });

      await script.release(output('event: comment\n'));
      expect(fired).toHaveLength(1);
      await (scheduler as unknown as { pendingPersist: Promise<unknown> })
        .pendingPersist;
      [task] = await readCronTasks(tmpDir);
      expect(task?.runs).toHaveLength(1);
      expect(task?.runs?.[0]).toMatchObject({
        at: at(10, 31).getTime(),
        kind: 'scheduled',
        gate: 'delivered',
        sessionId: 'session-1',
      });
      expect(task?.gateStatus).toMatchObject({
        lastOutcome: 'delivered',
        quietSinceDelivery: 0,
      });
      // The reload keeps the in-process approval for an unchanged gate.
      expect(scheduler.list().find((j) => j.id === job.id)?.gateApproved).toBe(
        true,
      );
    });

    it('carries a confirmation to a task another component writes, once it loads', async () => {
      // The daemon's current-session creator writes the task file; this
      // scheduler only meets the task on its next reload.
      const task = (id: string, gate: string) =>
        withTaskGate(
          {
            id,
            cron: '* * * * *',
            prompt: 'p',
            recurring: true,
            createdAt: at(10, 29).getTime(),
            // Stamped at creation: no catch-up runs, only the tick below.
            lastFiredAt: at(10, 29).getTime(),
          },
          gate,
        );
      scheduler.approveGate('confirmed', './probe.sh');
      scheduler.approveGate('swapped', './probe.sh');
      // A turn cancelled before the reload stops and re-enables the
      // scheduler: the confirmations must survive that.
      scheduler.stop();
      await writeCronTasks(tmpDir, [
        task('confirmed', './probe.sh'),
        task('swapped', './other.sh'),
      ]);
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      const approved = (id: string) =>
        scheduler.list().find((j) => j.id === id)?.gateApproved === true;
      expect(approved('confirmed')).toBe(true);
      // Confirmed for another command than the one on disk.
      expect(approved('swapped')).toBe(false);

      scheduler.tick(at(10, 30, 59));
      expect(script.calls).toHaveLength(2);
      const byGate = Object.fromEntries(
        script.calls.map((c) => [c.gate, c.options.approvedInProcess]),
      );
      // Settle both runs before asserting, so a failure here cannot leave
      // pending runs for the next test's releases.
      await script.release(quiet);
      await script.release(quiet);
      expect(byGate).toEqual({ './probe.sh': true, './other.sh': false });

      // A loaded job takes a confirmation at once, but only for its own
      // command: one for a command another client has since swapped out
      // must not approve the new one.
      scheduler.approveGate('swapped', './probe.sh');
      expect(approved('swapped')).toBe(false);
      scheduler.approveGate('swapped', './other.sh');
      expect(approved('swapped')).toBe(true);
    });

    it('stores a quiet fire that ends a failure streak at once, so a restart cannot revive the streak', async () => {
      const job = await scheduler.createDurable(
        '* * * * *',
        'p',
        true,
        './probe.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      scheduler.tick(at(10, 30, 59));
      await script.release(failed);
      scheduler.tick(at(10, 31, 59));
      await script.release(quiet);
      // Before the next slot's tick persist: the file already has the
      // streak ended, so a scheduler that reloads it reports its next
      // failure.
      await persisted();
      const [task] = await readCronTasks(tmpDir);
      expect(task?.gateStatus).toMatchObject({
        lastOutcome: 'quiet',
        consecutiveFailures: 0,
      });
      expect(task?.runs).toEqual([expect.objectContaining({ gate: 'failed' })]);
    });

    it('books a gated fire at its own slot when the job was stamped again while the gate ran', async () => {
      // A manual run (or the next slot) stamps the job while the gate runs:
      // the run record and the delivered fire keep the slot the gate ran for.
      const job = await scheduler.createDurable(
        '* * * * *',
        'p',
        true,
        './probe.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      scheduler.tick(at(10, 30, 59));
      const live = scheduler.list().find((j) => j.id === job.id)!;
      expect(live.lastFiredAt).toBe(at(10, 30).getTime());
      live.lastFiredAt = at(10, 45).getTime();
      await script.release(output('event: comment\n'));
      expect(fired[0]!.lastFiredAt).toBe(at(10, 30).getTime());
      await persisted();
      const [task] = await readCronTasks(tmpDir);
      expect(task?.runs).toEqual([
        expect.objectContaining({
          at: at(10, 30).getTime(),
          gate: 'delivered',
        }),
      ]);
      expect(task?.gateStatus?.lastAt).toBe(at(10, 30).getTime());
    });

    it('keeps a late result of the replaced command off the new gate', async () => {
      // The old command settles after the PATCH rewrote the file and before
      // the watcher reloads the task: its status must not land on the new
      // gate, or the new command's first failure is counted silently.
      const job = await scheduler.createDurable(
        '* * * * *',
        'p',
        true,
        './old.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      scheduler.tick(at(10, 30, 59)); // ./old.sh starts and stays running
      await updateCronTasks(tmpDir, (tasks) =>
        tasks.map(({ gateStatus: _dropped, ...t }) =>
          withTaskGate(t, './new.sh'),
        ),
      );
      await script.release(failed); // the old command's late failure
      expect(fired).toHaveLength(1);
      await persisted();
      let [task] = await readCronTasks(tmpDir);
      expect(task?.gate).toBe('./new.sh');
      expect(task?.gateStatus).toBeUndefined();
      // The fire still happened and keeps its run record.
      expect(task?.runs).toEqual([expect.objectContaining({ gate: 'failed' })]);

      await reload();
      scheduler.tick(at(10, 31, 59));
      await script.release(failed); // the new command's first failure
      expect(fired).toHaveLength(2);
      expect(fired[1]!.prompt).toContain('./new.sh');
      await persisted();
      [task] = await readCronTasks(tmpDir);
      expect(task?.gateStatus?.consecutiveFailures).toBe(1);
    });

    it('keeps the tick from writing the old command’s streak onto a replaced gate', async () => {
      // The old command already failed once; the PATCH swaps the command and
      // drops the status; a tick lands before the watcher reloads the task.
      // Its persist must not put the old streak back on the new gate.
      const job = await scheduler.createDurable(
        '* * * * *',
        'p',
        true,
        './old.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      scheduler.tick(at(10, 30, 59));
      await script.release(failed); // the old command's first failure
      expect(fired).toHaveLength(1);
      await persisted();
      let [task] = await readCronTasks(tmpDir);
      expect(task?.gateStatus?.consecutiveFailures).toBe(1);

      await updateCronTasks(tmpDir, (tasks) =>
        tasks.map(({ gateStatus: _dropped, ...t }) =>
          withTaskGate(t, './new.sh'),
        ),
      );
      scheduler.tick(at(10, 31, 59)); // the old job is still loaded
      await persisted();
      await reload(); // cancels the old command's run
      await script.release(quiet); // its late answer is superseded
      // Read after the old run settled, so a failure here leaves nothing
      // pending for the next test; the reload itself writes nothing.
      [task] = await readCronTasks(tmpDir);
      expect(task?.gate).toBe('./new.sh');
      expect(task?.gateStatus).toBeUndefined();

      scheduler.tick(at(10, 32, 59));
      await script.release(failed); // the new command's first failure
      expect(fired).toHaveLength(2);
      expect(fired[1]!.prompt).toContain('./new.sh');
      await persisted();
      [task] = await readCronTasks(tmpDir);
      expect(task?.gateStatus?.consecutiveFailures).toBe(1);
    });

    it('starts a fresh failure streak when the gate is replaced on disk', async () => {
      // The daemon's PATCH swaps the command and drops the file's status; the
      // running session must not carry the old command's streak over, or the
      // new command's first failure would be counted silently.
      const job = await scheduler.createDurable(
        '* * * * *',
        'p',
        true,
        './probe.sh',
      );
      job.gateApproved = true;
      await scheduler.enableDurable('session-1');
      scheduler.start((j) => fired.push(j));
      scheduler.tick(at(10, 30, 59));
      await script.release(failed); // reported
      scheduler.tick(at(10, 31, 59));
      await script.release(failed); // counted only
      expect(fired).toHaveLength(1);
      const current = () => scheduler.list().find((j) => j.id === job.id);
      expect(current()?.gateStatus?.consecutiveFailures).toBe(2);
      await persisted();

      await updateCronTasks(tmpDir, (tasks) =>
        tasks.map(({ gateStatus: _dropped, ...t }) =>
          withTaskGate(t, './other.sh'),
        ),
      );
      await reload();
      expect(current()?.gate).toBe('./other.sh');
      expect(current()?.gateStatus).toBeUndefined();
      scheduler.tick(at(10, 32, 59));
      await script.release(failed);
      expect(fired).toHaveLength(2);
      expect(fired[1]!.prompt).toContain('./other.sh');
      expect(current()?.gateStatus?.consecutiveFailures).toBe(1);
    });
  });
});
