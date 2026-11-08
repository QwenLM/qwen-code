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
export function descendants(root: number) {
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
  return [...ids]
    .map(inspect)
    .filter((entry): entry is Captured => entry !== undefined);
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
export function observe(pidFile: string) {
  const captured = new Map<number, Captured>();
  let error: string | undefined;
  const timing = { polls: 0, totalMs: 0, maxMs: 0 };
  const poll = () => {
    const started = performance.now();
    try {
      if (!fs.existsSync(pidFile)) return;
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid < 2) return;
      const root = captured.get(pid);
      if (root && !sameProcess(root)) return;
      for (const row of descendants(pid)) captured.set(row.pid, row);
    } catch (caught) {
      error = String(caught);
    } finally {
      const elapsed = performance.now() - started;
      timing.polls++;
      timing.totalMs += elapsed;
      timing.maxMs = Math.max(timing.maxMs, elapsed);
    }
  };
  const timer = setInterval(poll, 100);
  timer.unref();
  return {
    poll,
    timing: () => ({ ...timing }),
    snapshot: () => {
      poll();
      return [...captured.values()];
    },
    stop: () => {
      clearInterval(timer);
      poll();
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
