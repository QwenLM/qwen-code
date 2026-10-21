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
import { readCronTasks, taskHasLegacyCondition } from './cronTasksFile.js';

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
    const job = createGated();
    scheduler.tick(at(10, 30, 59));
    expect(script.calls[0]!.options.signal.aborted).toBe(false);
    await scheduler.delete(job.id);
    expect(script.calls[0]!.options.signal.aborted).toBe(true);
    await script.release(output('too late\n'));
    expect(fired).toHaveLength(0);
  });

  it('delivers nothing when the scheduler stops while a gate runs', async () => {
    createGated();
    scheduler.tick(at(10, 30, 59));
    scheduler.stop();
    expect(script.calls[0]!.options.signal.aborted).toBe(true);
    await script.release(output('too late\n'));
    expect(fired).toHaveLength(0);
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
      await (scheduler as unknown as { pendingPersist: Promise<unknown> })
        .pendingPersist;
      Storage.setRuntimeBaseDir(null);
      await fs.rm(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    });

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
      await vi.waitFor(async () => {
        [task] = await readCronTasks(tmpDir);
        expect(task?.lastFiredAt).toBe(at(10, 31).getTime());
      });
      expect(task?.runs ?? []).toHaveLength(0);
      expect(task?.gateStatus).toMatchObject({
        lastOutcome: 'quiet',
        quietSinceDelivery: 1,
      });

      await script.release(output('event: comment\n'));
      expect(fired).toHaveLength(1);
      await vi.waitFor(async () => {
        [task] = await readCronTasks(tmpDir);
        expect(task?.runs).toHaveLength(1);
      });
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
  });
});
