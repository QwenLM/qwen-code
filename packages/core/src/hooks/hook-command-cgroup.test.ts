/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookCommandCgroup,
  HookCommandIsolationUnavailableError,
} from './hook-command-cgroup.js';

// A real cgroup directory accepts rmdir while its virtual files stay; a
// regular directory with a `cgroup.events` file cannot model that, so the
// removal decision is observed on the call instead.
const rmdirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  rmdirSync.mockImplementation(actual.rmdirSync);
  return { ...actual, rmdirSync };
});

let root: string;
let directory: string;
beforeEach(async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  rmdirSync.mockImplementation(actualFs.rmdirSync);
  root = await mkdtemp(join(tmpdir(), 'hook-launcher-'));
  directory = join(root, 'unit');
  await mkdir(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition did not settle');
}

describe('unit creation and attachment', () => {
  it('refuses to create or attach without a delegated Linux root', () => {
    expect(() => HookCommandCgroup.create(undefined)).toThrow(
      HookCommandIsolationUnavailableError,
    );
    expect(() =>
      HookCommandCgroup.create(join(directory, 'not-a-cgroup')),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() =>
      HookCommandCgroup.create(join(directory, 'not-a-cgroup'), 'qwen-bg-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() =>
      HookCommandCgroup.attach(join(directory, 'not-a-cgroup'), 'qwen-bg-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
  });

  it('refuses a caller-supplied unit name that escapes its root', async () => {
    expect(() =>
      HookCommandCgroup.create(directory, 'qwen-bg/../other'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(() => HookCommandCgroup.create(directory, 'qwen-bg\0tail')).toThrow(
      HookCommandIsolationUnavailableError,
    );
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(directory)).toEqual([]);
  });

  it('admits a caller-supplied name that stays one unit', () => {
    // The creation below still fails closed on a non-cgroup root, but the
    // name guard must not be the thrower: it runs before resolveRoot, so
    // reaching resolveRoot is the proof the name passed.
    const resolveRoot = vi
      .spyOn(
        HookCommandCgroup as unknown as {
          resolveRoot: (root: string | undefined) => string;
        },
        'resolveRoot',
      )
      .mockReturnValue(directory);
    expect(() =>
      HookCommandCgroup.create('/unused-root', 'qwen-bg-shell-1'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(resolveRoot).toHaveBeenCalledWith('/unused-root');
  });

  it('removes only the unit it created on a failed create, never a pre-existing one', async () => {
    vi.spyOn(
      HookCommandCgroup as unknown as {
        resolveRoot: (root: string | undefined) => string;
      },
      'resolveRoot',
    ).mockReturnValue(directory);
    // A named unit that already exists belongs to its owner — the very
    // process-holding cgroup the H3 recovery path re-attaches by name — so
    // a refused create must leave it exactly where it found it.
    const owned = join(directory, 'qwen-bg-owner');
    await mkdir(owned);
    try {
      HookCommandCgroup.create('/unused-root', 'qwen-bg-owner');
      expect.unreachable('a taken unit name must be refused');
    } catch (cause) {
      expect(cause).toBeInstanceOf(HookCommandIsolationUnavailableError);
      expect((cause as HookCommandIsolationUnavailableError).reason).toBe(
        'unit_name_taken',
      );
    }
    expect(await readdir(directory)).toEqual(['qwen-bg-owner']);
    // A unit create itself made dies with the failed start: no half-empty
    // unit stays behind for the next caller to trip over.
    expect(() =>
      HookCommandCgroup.create('/unused-root', 'qwen-bg-fresh'),
    ).toThrow(HookCommandIsolationUnavailableError);
    expect(await readdir(directory)).toEqual(['qwen-bg-owner']);
  });

  it('covers a launcher that moved into its reaper sibling unit', async () => {
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    await writeFile(join(directory, 'cgroup.procs'), '1\n');
    const sibling = `${directory}-reaper-4321`;
    await mkdir(sibling);
    await writeFile(join(sibling, 'cgroup.procs'), '4321\n');

    expect(unit.covers(1)).toBe(true);
    expect(unit.covers(4321)).toBe(true);
    expect(unit.covers(9999)).toBe(false);
  });

  it('removes an empty reaper sibling and keeps a populated one', async () => {
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const emptySibling = `${directory}-reaper-4321`;
    await mkdir(emptySibling);
    await writeFile(join(emptySibling, 'cgroup.events'), 'populated 0\n');
    rmdirSync.mockClear();
    unit.removeReaper(4321);
    expect(rmdirSync).toHaveBeenCalledWith(emptySibling);

    const busySibling = `${directory}-reaper-5678`;
    await mkdir(busySibling);
    await writeFile(join(busySibling, 'cgroup.events'), 'populated 1\n');
    rmdirSync.mockClear();
    unit.removeReaper(5678);
    expect(rmdirSync).not.toHaveBeenCalled();
  });
});

describe('managed command launcher environment', () => {
  it('keeps environment values out of argv and applies them only after membership', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'preloaded');
    await writeFile(
      preload,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, fs.readFileSync(${JSON.stringify(join(directory, 'cgroup.procs'))}, 'utf8') + '\\n');`,
    );
    // This exercises the real launcher with a membership-file stand-in,
    // without claiming that the temporary directory is a cgroup.
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const env = {
      SERVICE_TOKEN: 'fake-secret-"quoted"\n非真实凭据',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      PATH: '/deployment-command-path',
    };
    const launch = unit.launch(
      process.execPath,
      [
        '--eval',
        'process.stdout.write(JSON.stringify({ token: process.env.SERVICE_TOKEN, path: process.env.PATH }));',
      ],
      env,
    );
    expect(launch.args.join('\n')).not.toContain('fake-secret');
    expect(launch.env).not.toHaveProperty('NODE_OPTIONS');
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output[3]).toBe('joined\n');
    expect(JSON.parse(result.stdout)).toEqual({
      token: env.SERVICE_TOKEN,
      path: env.PATH,
    });
    expect(await readFile(marker, 'utf8')).toBe(`${result.pid}\n`);
  });

  it('does not apply command environment when membership fails', async () => {
    const preload = join(directory, 'preload.cjs');
    const marker = join(directory, 'forbidden');
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      join(directory, 'missing'),
    ]);
    const launch = unit.launch(process.execPath, ['--eval', ''], {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    });
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.output[3]).toBe('unavailable\n');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('announces its membership on fd 3 once the kernel accepts it', () => {
    // The marker is the membership proof a parent may rely on even after
    // the unit's process list can no longer name the launcher (the command
    // already ran and everything exited).
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(process.execPath, ['--eval', ''], {});
    const result = spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output[3]).toBe('joined\n');
  });

  it('enables parent-death reaping only when the caller opts in', () => {
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const plain = unit.launch(process.execPath, ['--eval', ''], {});
    expect(plain.env).not.toHaveProperty(
      'QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT',
    );
    const supervised = unit.launch(
      process.execPath,
      ['--eval', ''],
      {},
      {
        reapOnParentExit: true,
      },
    );
    expect(supervised.env.QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT).toBe('1');
  });
});

describe('exit evidence', () => {
  const run = (script: string, options?: { reapOnParentExit?: boolean }) => {
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(
      process.execPath,
      ['--eval', script],
      {},
      options,
    );
    return spawnSync(launch.executable, launch.args, {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
  };

  it('keeps the exit status of a command that exited', () => {
    const result = run('process.exit(3)');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.signal).toBeNull();
  });

  // The launcher's own end is the background supervisor's exit evidence: a
  // command a signal killed must not read as one that exited nonzero.
  it
    .skipIf(process.platform === 'win32')
    .each(['SIGKILL', 'SIGTERM', 'SIGUSR2'])(
    'ends by the %s that ended its command',
    (signal) => {
      const result = run(`process.kill(process.pid, '${signal}')`);
      expect(result.error).toBeUndefined();
      expect(result.status).toBeNull();
      expect(result.signal).toBe(signal);
    },
  );

  // The opted-in launcher handles SIGTERM to survive the cancellation sweep.
  // That handler must not swallow the SIGTERM that ended the command itself.
  it.skipIf(process.platform === 'win32')(
    'ends by the SIGTERM that ended its command while opted into reaping',
    () => {
      const result = run(`process.kill(process.pid, 'SIGTERM')`, {
        reapOnParentExit: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGTERM');
    },
  );
});

describe.skipIf(process.platform === 'win32')('parent death', () => {
  it('reaps the unit when the launcher parent dies', async () => {
    const launcherPidFile = join(directory, 'launcher.pid');
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(
      process.execPath,
      ['--eval', 'setTimeout(() => process.exit(0), 1000)'],
      {},
      { reapOnParentExit: true },
    );
    const worker = spawn(
      process.execPath,
      [
        '--eval',
        `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.SPEC);
const child = spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(process.env.LAUNCHER_PID, String(child.pid));
setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          SPEC: JSON.stringify(launch),
          LAUNCHER_PID: launcherPidFile,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    try {
      await waitFor(async () => {
        try {
          return (await readFile(launcherPidFile, 'utf8')).length > 0;
        } catch {
          return false;
        }
      });
      const launcherPid = Number(await readFile(launcherPidFile, 'utf8'));

      // The launcher captures its parent after it joins the unit. Wait for
      // that membership write before killing the worker, or the launcher
      // starts with ppid 1 and has no change to observe.
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.procs'), 'utf8')) ===
            String(launcherPid)
          );
        } catch {
          return false;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The worker dies without running any handler; the launcher is
      // reparented and must reap its own unit.
      worker.kill('SIGKILL');

      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.kill'), 'utf8')) === '1'
          );
        } catch {
          return false;
        }
      });
      await waitFor(() => !alive(launcherPid));
    } finally {
      worker.kill('SIGKILL');
    }
  });

  it('reaps when it starts already reparented to PID 1', async () => {
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(
      process.execPath,
      ['--eval', 'setTimeout(() => process.exit(0), 1000)'],
      {},
      { reapOnParentExit: true },
    );
    const worker = spawn(
      process.execPath,
      [
        '--eval',
        `const { spawn } = require('node:child_process');
const spec = JSON.parse(process.env.SPEC);
spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['ignore', 'ignore', 'ignore'],
});
process.exit(0);`,
      ],
      {
        env: { PATH: process.env['PATH'] ?? '', SPEC: JSON.stringify(launch) },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    try {
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.kill'), 'utf8')) === '1'
          );
        } catch {
          return false;
        }
      });
    } finally {
      worker.kill('SIGKILL');
    }
  });

  it('keeps the reaper for a foreground that exits before its descendants', async () => {
    await writeFile(join(directory, 'cgroup.events'), 'populated 1\n');
    const descendantPidFile = join(directory, 'descendant.pid');
    const launcherPidFile = join(directory, 'launcher.pid');
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(
      process.execPath,
      [
        '--eval',
        `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
descendant.unref();
writeFileSync(process.env.DESCENDANT_PID, String(descendant.pid));
process.exit(0);`,
      ],
      { DESCENDANT_PID: descendantPidFile },
      { reapOnParentExit: true },
    );
    const worker = spawn(
      process.execPath,
      [
        '--eval',
        `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.SPEC);
const child = spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(process.env.LAUNCHER_PID, String(child.pid));
setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          SPEC: JSON.stringify(launch),
          LAUNCHER_PID: launcherPidFile,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    try {
      await waitFor(async () => {
        try {
          return (await readFile(launcherPidFile, 'utf8')).length > 0;
        } catch {
          return false;
        }
      });
      const launcherPid = Number(await readFile(launcherPidFile, 'utf8'));

      // The foreground exits immediately; the launcher moves itself to a
      // temporary sibling reaper unit and stays for the remaining members.
      await waitFor(async () => {
        try {
          return (
            (await readFile(
              join(root, `unit-reaper-${launcherPid}`, 'cgroup.procs'),
              'utf8',
            )) === String(launcherPid)
          );
        } catch {
          return false;
        }
      });
      worker.kill('SIGKILL');
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.kill'), 'utf8')) === '1'
          );
        } catch {
          return false;
        }
      });
    } finally {
      worker.kill('SIGKILL');
    }
    try {
      const descendantPid = Number(await readFile(descendantPidFile, 'utf8'));
      process.kill(descendantPid, 'SIGKILL');
    } catch {
      // The descendant already exited.
    }
  });

  it('survives the cancellation SIGTERM sweep until the worker dies', async () => {
    const launcherPidFile = join(directory, 'launcher.pid');
    const foregroundPidFile = join(directory, 'foreground.pid');
    const unit: HookCommandCgroup = Reflect.construct(HookCommandCgroup, [
      directory,
    ]);
    const launch = unit.launch(
      process.execPath,
      [
        '--eval',
        `const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
writeFileSync(process.env.FOREGROUND_PID, String(process.pid));
setInterval(() => {}, 1000);`,
      ],
      { FOREGROUND_PID: foregroundPidFile },
      { reapOnParentExit: true },
    );
    const worker = spawn(
      process.execPath,
      [
        '--eval',
        `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.SPEC);
const child = spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['ignore', 'ignore', 'ignore'],
});
writeFileSync(process.env.LAUNCHER_PID, String(child.pid));
setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          SPEC: JSON.stringify(launch),
          LAUNCHER_PID: launcherPidFile,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    let foregroundPid: number | undefined;
    try {
      await waitFor(async () => {
        try {
          return (await readFile(launcherPidFile, 'utf8')).length > 0;
        } catch {
          return false;
        }
      });
      const launcherPid = Number(await readFile(launcherPidFile, 'utf8'));

      // Cancellation SIGTERMs every unit member before escalating.
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.procs'), 'utf8')) ===
            String(launcherPid)
          );
        } catch {
          return false;
        }
      });
      foregroundPid = Number(
        await waitFor(async () => {
          try {
            return (await readFile(foregroundPidFile, 'utf8')).length > 0;
          } catch {
            return false;
          }
        }).then(() => readFile(foregroundPidFile, 'utf8')),
      );
      process.kill(launcherPid, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The launcher is the reaper: the SIGTERM must not end it, and the
      // kill escalation still belongs to the worker.
      expect(alive(launcherPid)).toBe(true);
      await expect(
        readFile(join(directory, 'cgroup.kill'), 'utf8'),
      ).rejects.toThrow();

      // The worker dies inside the grace period; the launcher must escalate.
      worker.kill('SIGKILL');
      await waitFor(async () => {
        try {
          return (
            (await readFile(join(directory, 'cgroup.kill'), 'utf8')) === '1'
          );
        } catch {
          return false;
        }
      });
      await waitFor(() => !alive(launcherPid));
    } finally {
      worker.kill('SIGKILL');
      if (foregroundPid) {
        try {
          process.kill(foregroundPid, 'SIGKILL');
        } catch {
          // The foreground already exited.
        }
      }
    }
  });
});
