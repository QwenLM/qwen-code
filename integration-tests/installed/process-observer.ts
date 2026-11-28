/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

export function inspect(pid: number) {
  try {
    const output = execFileSync(
      'ps',
      [
        '-p',
        String(pid),
        '-o',
        'pid=,ppid=,pgid=,tpgid=,state=,tty=,lstart=,comm=,args=',
      ],
      {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C' },
      },
    )
      .trim()
      .split(/\s+/);
    return {
      pid: Number(output[0]),
      ppid: Number(output[1]),
      pgid: Number(output[2]),
      state: output[4],
      started: output.slice(6, 11).join(' '),
      command: output.slice(11).join(' '),
      birth:
        process.platform === 'linux'
          ? fs
              .readFileSync(`/proc/${pid}/stat`, 'utf8')
              .split(') ')
              .at(-1)!
              .split(' ')[19]
          : output.slice(6, 11).join(' '),
    };
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    }
    throw error;
  }
}
type Captured = NonNullable<ReturnType<typeof inspect>>;
export function sameProcess(row: Captured) {
  const current = inspect(row.pid);
  return current?.birth === row.birth && !current.state.startsWith('Z');
}
export function descendants(
  root: number,
  window?: { cap: number; offset: number },
) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: 5_000,
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([root]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, ppid] of rows)
      if (ids.has(ppid) && !ids.has(pid)) {
        ids.add(pid);
        changed = true;
      }
  }
  const targets = [...ids];
  const collect = (pids: number[]) =>
    pids.map(inspect).filter((entry): entry is Captured => entry !== undefined);
  // Without a window every member is inspected, which is what the standalone
  // callers want. With one, the cap is applied BEFORE `inspect`: the cost this
  // bounds is one `ps -p` fork per probed process, so slicing after the forks
  // would bound nothing. The window rotates so later sweeps cover the tail
  // rather than re-reading the same head forever.
  if (!window) return collect(targets);
  const count = Math.min(window.cap, targets.length);
  const start = targets.length === 0 ? 0 : window.offset % targets.length;
  const picked: number[] = [];
  for (let index = 0; index < count; index++)
    picked.push(targets[(start + index) % targets.length]);
  return collect(picked);
}
export function descriptors(row: Captured) {
  if (!sameProcess(row)) return '';
  try {
    if (process.platform === 'linux') {
      const executable = fs.readlinkSync(`/proc/${row.pid}/exe`);
      const maps = fs.readFileSync(`/proc/${row.pid}/maps`, 'utf8');
      const paths = maps.split('\n').flatMap((line) => {
        const match = line.match(/^(?:\S+\s+){5}(\/.*)$/);
        return match
          ? [
              match[1].replace(/\\([0-7]{3})/g, (_, octal: string) =>
                String.fromCharCode(parseInt(octal, 8)),
              ),
            ]
          : [];
      });
      return [
        `n${executable}`,
        ...new Set(paths.map((file) => `n${file}`)),
      ].join('\n');
    }
    return execFileSync(
      'lsof',
      ['-a', '-p', String(row.pid), '-d', 'txt,0', '-Ffn'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (error) {
    if (!sameProcess(row)) return '';
    throw error;
  }
}
// Freshness bound for discovery. A child is found by walking the table only
// while it is still parented to a captured process (the launcher's product
// outlives its sh parent, npm exec wraps the product under a new process
// group), so an unbounded sweep would have to catch that instant. Both models
// re-walk every second or two anyway, so a 500ms stale snapshot never decides
// what a test sees.
const SWEEP_MS = 500;
// Each probed process costs one fork, and every fork blocks the loop that
// serves the PTY (and the runner adapter's flush) for its duration. The
// launcher tree is 21 processes at its widest; the cap keeps the first sweep
// over a wide npm install short and re-walks the rest on the next interval.
const SWEEP_PROBES = 32;

export function observe(pidFile: string) {
  const captured = new Map<number, Captured>();
  let error: string | undefined;
  // `polls` counts every walk, a throttled tick included; `sweeps` counts the
  // walks that actually read the process table. The interval bounds sweeps, so
  // a test that asserts on `polls` is measuring the tick, not the sweep.
  const timing = { polls: 0, sweeps: 0, totalMs: 0, maxMs: 0 };
  // The timer skips a tick whose predecessor has not returned, so a slow
  // read never stacks forks behind itself.
  let polling = false;
  let lastSweep = -Infinity;
  let sweepOffset = 0;
  const tick = (): boolean => {
    // The gate runs before anything that forks — the liveness probe included:
    // it costs a `ps -p`, and paying it on every 100ms tick is exactly the
    // cost the throttle exists to avoid on a runner where a fork is slow.
    if (performance.now() - lastSweep < SWEEP_MS) return false;
    if (!fs.existsSync(pidFile)) return false;
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid < 2) return false;
    const root = captured.get(pid);
    // A dead root cannot gain descendants; walking the table for it only
    // costs forks on the sweep that discovers the exit.
    if (root && !sameProcess(root)) return false;
    try {
      const rows = descendants(pid, { cap: SWEEP_PROBES, offset: sweepOffset });
      for (const row of rows) captured.set(row.pid, row);
      sweepOffset += SWEEP_PROBES;
      return true;
    } finally {
      // Stamp on completion, never on entry: the throttle must bound the gap
      // between sweeps, not start counting while the previous sweep is still
      // forking its way through the table.
      lastSweep = performance.now();
    }
  };
  const walk = (): void => {
    const started = performance.now();
    try {
      if (tick()) timing.sweeps++;
    } catch (caught) {
      error = String(caught);
    } finally {
      const elapsed = performance.now() - started;
      timing.polls++;
      timing.totalMs += elapsed;
      timing.maxMs = Math.max(timing.maxMs, elapsed);
    }
  };
  const poll = () => {
    // A tick still forking would otherwise stack another walk behind itself.
    if (polling) return;
    polling = true;
    try {
      walk();
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, 100);
  timer.unref();
  return {
    poll: walk,
    timing: () => ({ ...timing }),
    snapshot: () => {
      walk();
      return [...captured.values()];
    },
    stop: () => {
      clearInterval(timer);
      walk();
      return error;
    },
    cleanup: async () => {
      clearInterval(timer);
      for (const row of [...captured.values()].reverse())
        if (sameProcess(row)) process.kill(row.pid, 'SIGTERM');
      const end = Date.now() + 5000;
      while (Date.now() < end && [...captured.values()].some(sameProcess))
        await new Promise((resolve) => setTimeout(resolve, 100));
      for (const row of [...captured.values()].reverse())
        if (sameProcess(row)) process.kill(row.pid, 'SIGKILL');
      const killEnd = Date.now() + 5000;
      while (Date.now() < killEnd && [...captured.values()].some(sameProcess))
        await new Promise((resolve) => setTimeout(resolve, 100));
      if ([...captured.values()].some(sameProcess))
        throw new Error('owned process survived TERM5/KILL5');
    },
  };
}
