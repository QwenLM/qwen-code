import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalMode } from '../../config/config.js';
import { ScheduleDaemon, type FireContext } from './schedule-daemon.js';
import {
  readState,
  writeState,
  writeTask,
  type ScheduledTask,
} from './task-store.js';

/** Flush the microtask/immediate queue so an in-flight fire's cleanup runs. */
const settle = () => new Promise<void>((r) => setImmediate(r));

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'every-five',
    name: 'every-five',
    description: 'runs every five minutes',
    schedule: { cron: '*/5 * * * *', enabled: true },
    cwd: '/tmp',
    approvalMode: ApprovalMode.AUTO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'do the thing',
    ...overrides,
  };
}

const at = (h: number, m: number, s = 0) =>
  new Date(2026, 6, 1, h, m, s).getTime();

describe('schedule/ScheduleDaemon', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let fires: FireContext[];
  let clock: number;

  function makeDaemon() {
    fires = [];
    return new ScheduleDaemon({
      fire: (ctx) => {
        fires.push(ctx);
      },
      now: () => clock,
      maxConcurrent: 3,
    });
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-daemon-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('fires a recurring task at its slot, once per slot', async () => {
    await writeTask(makeTask());
    const d = makeDaemon();
    clock = at(10, 2);
    await d.load();

    d.tick(at(10, 4, 59));
    expect(fires).toHaveLength(0);

    d.tick(at(10, 5, 0));
    await settle();
    expect(fires).toHaveLength(1);

    d.tick(at(10, 5, 30));
    await settle();
    expect(fires).toHaveLength(1); // no double-fire within the same slot

    d.tick(at(10, 10, 0));
    await settle();
    expect(fires).toHaveLength(2);
    expect(fires[0].task.id).toBe('every-five');
  });

  it('does not fire retroactively for a brand-new task', async () => {
    await writeTask(makeTask());
    const d = makeDaemon();
    clock = at(10, 7); // loaded just after the 10:05 slot
    await d.load();

    d.tick(at(10, 7, 30));
    await settle();
    expect(fires).toHaveLength(0); // the passed 10:05 slot is not caught up
  });

  it('catches up a single fire for a task that was down over a slot', async () => {
    const task = makeTask({ id: 'catchup' });
    await writeTask(task);
    // Persisted evidence it last fired at 10:00, then the daemon was down.
    await writeState('catchup', {
      lastFiredAt: at(10, 0),
      nextRunAt: null,
      lastRunId: 'old',
      enabledOverride: null,
    });

    const d = makeDaemon();
    clock = at(10, 20);
    await d.load();

    d.tick(at(10, 20, 1));
    await settle();
    expect(fires).toHaveLength(1); // one catch-up, not one-per-missed-slot

    d.tick(at(10, 20, 30));
    await settle();
    expect(fires).toHaveLength(1);

    // lastFiredAt collapsed forward to the current minute.
    await d.flush();
    expect((await readState('catchup')).lastFiredAt).toBe(at(10, 20));
  });

  it('fires a one-shot once, then auto-disables it', async () => {
    const fireAt = new Date(at(10, 5)).toISOString();
    await writeTask(
      makeTask({ id: 'oneshot', schedule: { fireAt, enabled: true } }),
    );
    const d = makeDaemon();
    clock = at(10, 2);
    await d.load();

    d.tick(at(10, 4, 0));
    expect(fires).toHaveLength(0);

    d.tick(at(10, 5, 0));
    await settle();
    expect(fires).toHaveLength(1);

    d.tick(at(10, 6, 0));
    await settle();
    expect(fires).toHaveLength(1); // does not re-fire

    await d.flush();
    expect((await readState('oneshot')).enabledOverride).toBe(false);
  });

  it('never fires a disabled task', async () => {
    await writeTask(
      makeTask({
        id: 'off',
        schedule: { cron: '*/5 * * * *', enabled: false },
      }),
    );
    const d = makeDaemon();
    clock = at(10, 2);
    await d.load();
    d.tick(at(10, 5, 0));
    await settle();
    expect(fires).toHaveLength(0);
  });

  it('skips a task with an unparseable cron without crashing', async () => {
    await writeTask(
      makeTask({ id: 'bad', schedule: { cron: 'not a cron', enabled: true } }),
    );
    const d = makeDaemon();
    clock = at(10, 2);
    await d.load();
    expect(() => d.tick(at(10, 5, 0))).not.toThrow();
    expect(fires).toHaveLength(0);
  });

  it('does not re-fire a task while its previous fire is still in flight', async () => {
    await writeTask(makeTask({ id: 'slow' }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = new ScheduleDaemon({
      fire: () => gate, // stays in flight until released
      now: () => clock,
    });
    clock = at(10, 2);
    await d.load();

    d.tick(at(10, 5, 0));
    await settle();
    // Even though 10:10 is a new slot, the previous fire is still running.
    d.tick(at(10, 10, 0));
    await settle();

    release();
    await settle();
    // Only the first fire happened; the in-flight guard suppressed the second.
    // (We assert via state: lastFiredAt set to the 10:05 slot, not advanced.)
    await d.flush();
    const state = await readState('slow');
    expect(state.lastFiredAt).toBe(at(10, 5));
  });
});
