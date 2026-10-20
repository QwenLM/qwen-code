/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The recorded-refusal cause discriminator. The recorded refusal is the
 * only place this lands: the design keeps the transport surface free of
 * new public error codes.
 */
export type HookCommandIsolationUnavailableReason =
  | 'platform'
  | 'root_missing'
  | 'root_shape'
  | 'root_unreadable'
  | 'unit_name_invalid'
  | 'unit_name_taken'
  | 'unit_not_empty'
  | 'membership_unproven';

export class HookCommandIsolationUnavailableError extends Error {
  constructor(readonly reason?: HookCommandIsolationUnavailableReason) {
    super(
      'Managed command hooks require a delegated Linux cgroup v2 directory.',
    );
    this.name = 'HookCommandIsolationUnavailableError';
  }
}

const LAUNCHER = String.raw`
const { mkdirSync, readFileSync, writeFileSync, writeSync } = require('node:fs');
const { spawn } = require('node:child_process');
const [group, executable, args] = process.argv.slice(1);
// Cancellation SIGTERMs the unit before escalating to cgroup.kill. An
// opted-in launcher must survive that sweep: if the worker dies before the
// escalation, this process is the only reaper left. exitLikeChild removes
// this handler before re-raising a SIGTERM that ended the command.
if (process.env.QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT === '1') {
  process.on('SIGTERM', () => {});
}
try {
  writeFileSync(group + '/cgroup.procs', String(process.pid));
} catch {
  writeSync(3, 'unavailable\n');
  process.exit(1);
}
// The joined proof rides fd 3 when the parent pipes it; without that pipe
// the pid listing in cgroup.procs must carry the proof alone.
try {
  writeSync(3, 'joined\n');
} catch {}
// A Hook command belongs to the worker that launched it. If that worker
// dies without running its handlers, this launcher is reparented and the
// unit would otherwise stay populated forever. Hook commands opt in; a
// background Shell does not, because H3 keeps it across worker restarts.
if (process.env.QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT === '1') {
  const parentPid = process.ppid;
  if (parentPid === 1) {
    // The worker died before this launcher started; there is no parent
    // transition left to observe.
    try {
      writeFileSync(group + '/cgroup.kill', '1');
    } catch {
      // The unit is gone or the kernel refused the write.
    }
    process.exit(0);
  }
  setInterval(() => {
    if (process.ppid === parentPid) return;
    try {
      writeFileSync(group + '/cgroup.kill', '1');
    } catch {
      // The unit is gone or the kernel refused the write.
    }
    process.exit(0);
  }, 100).unref();
}
// No deployment command or environment is evaluated before membership.
const child = spawn(executable, JSON.parse(args), {
  env: JSON.parse(process.env.QWEN_HOOK_COMMAND_ENV),
  stdio: ['inherit', 'inherit', 'inherit'],
});
child.on('error', () => process.exit(1));
// A command a signal ended must end this launcher by the same signal: the
// launcher's exit is its supervisor's only evidence, and the nonzero status a
// plain exit substitutes is one the command never returned. A core-dumping
// signal would dump this launcher too, and Node.js owns SIGUSR1 and ignores
// SIGPIPE, so those keep the nonzero fallback. Delivery to self is
// synchronous on POSIX; the timer only covers a signal that somehow left the
// process running. Only names Node.js reports on Linux are listed: it calls
// signal 6 SIGABRT, never SIGIOT, and Linux has no SIGEMT.
const KEPT = ['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGQUIT', 'SIGSEGV',
  'SIGSYS', 'SIGTRAP', 'SIGXCPU', 'SIGXFSZ', 'SIGUSR1', 'SIGPIPE'];
let exitCode = 0;
let exitSignal = null;
function exitLikeChild() {
  if (exitSignal !== null && !KEPT.includes(exitSignal)) {
    // The SIGTERM handler above must not swallow the command's own signal.
    if (exitSignal === 'SIGTERM') process.removeAllListeners('SIGTERM');
    process.kill(process.pid, exitSignal);
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  process.exit(exitCode ?? 1);
}
child.on('exit', (code, signal) => {
  exitCode = code;
  exitSignal = signal;
  if (process.env.QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT === '1') {
    // A foreground exit is not the end of the Hook tree. Move this launcher
    // out of the unit so its population is only the remaining members, then
    // keep the reaper alive until the unit is empty. A worker that dies in
    // that drain window still reaches cgroup.kill through the interval.
    let moved = false;
    try {
      // A temporary sibling unit keeps this launcher out of the original
      // unit without moving into the root, which may forbid internal
      // processes while it has children.
      const reaperUnit = group + '-reaper-' + process.pid;
      mkdirSync(reaperUnit, { mode: 0o700 });
      writeFileSync(reaperUnit + '/cgroup.procs', String(process.pid));
      moved = true;
    } catch {
      // The delegated root may refuse the unit; fall back to the old exit.
    }
    if (moved) {
      const drained = () => {
        try {
          return /^populated 0$/m.test(
            readFileSync(group + '/cgroup.events', 'utf8'),
          );
        } catch {
          // A removed unit has no members left.
          return true;
        }
      };
      // The foreground may have been the last member: do not tax every
      // successful command with the poll interval's first tick.
      if (drained()) {
        exitLikeChild();
        return;
      }
      const wait = setInterval(() => {
        if (!drained()) return;
        clearInterval(wait);
        exitLikeChild();
      }, 100);
      // The wait itself keeps this launcher alive; do not unref it.
      return;
    }
  }
  exitLikeChild();
});
`;

export class HookCommandCgroup {
  private constructor(readonly directory: string) {}

  private static resolveRoot(root: string | undefined): string {
    if (process.platform !== 'linux')
      throw new HookCommandIsolationUnavailableError('platform');
    if (!root || !isAbsolute(root))
      throw new HookCommandIsolationUnavailableError('root_shape');
    try {
      const resolved = realpathSync(root);
      if (statfsSync(resolved).type !== 0x63677270)
        throw new HookCommandIsolationUnavailableError('root_shape');
      if (
        readFileSync(join(resolved, 'cgroup.type'), 'utf8').trim() !== 'domain'
      )
        throw new HookCommandIsolationUnavailableError('root_shape');
      return resolved;
    } catch (cause) {
      if (cause instanceof HookCommandIsolationUnavailableError) throw cause;
      throw new HookCommandIsolationUnavailableError('root_unreadable');
    }
  }

  static create(
    root: string | undefined,
    unitName?: string,
  ): HookCommandCgroup {
    let directory: string | undefined;
    let created = false;
    try {
      // A caller-supplied name must stay one unit: the same containment
      // rule attach() applies before it joins the name into the root.
      if (
        unitName !== undefined &&
        (unitName.includes('/') || unitName.includes('\0'))
      ) {
        throw new HookCommandIsolationUnavailableError('unit_name_invalid');
      }
      const resolved = HookCommandCgroup.resolveRoot(root);
      directory = join(resolved, unitName ?? `qwen-hook-${randomUUID()}`);
      try {
        mkdirSync(directory, { mode: 0o700 });
        created = true;
      } catch (cause) {
        throw new HookCommandIsolationUnavailableError(
          (cause as NodeJS.ErrnoException)?.code === 'EEXIST'
            ? 'unit_name_taken'
            : 'unit_name_invalid',
        );
      }
      const unit = new HookCommandCgroup(directory);
      if (!unit.empty())
        throw new HookCommandIsolationUnavailableError('unit_not_empty');
      for (const file of ['cgroup.procs', 'cgroup.kill']) {
        const fd = openSync(join(directory, file), 'w');
        closeSync(fd);
      }
      return unit;
    } catch (cause) {
      // Only a unit this call created may be removed: a named unit that
      // already exists belongs to whoever made it, never to us.
      if (created && directory) {
        try {
          rmdirSync(directory);
        } catch {
          // A nonempty unit must remain available to the deployment owner.
        }
      }
      if (cause instanceof HookCommandIsolationUnavailableError) throw cause;
      throw new HookCommandIsolationUnavailableError('root_unreadable');
    }
  }

  /**
   * Opens a unit somebody else created, for a worker that (re)attaches a
   * supervised process after a replacement. A missing unit answers
   * `undefined`; an unusable root answers the isolation error, never a guess.
   */
  static attach(
    root: string | undefined,
    unitName: string,
  ): HookCommandCgroup | undefined {
    const resolved = HookCommandCgroup.resolveRoot(root);
    if (unitName.includes('/') || unitName.includes('\0')) return undefined;
    let directory: string;
    try {
      directory = realpathSync(join(resolved, unitName));
      if (!directory.startsWith(resolved + '/')) return undefined;
      if (statfsSync(directory).type !== 0x63677270) return undefined;
      readFileSync(join(directory, 'cgroup.events'), 'utf8');
    } catch {
      return undefined;
    }
    return Reflect.construct(HookCommandCgroup, [directory]);
  }

  launch(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: { reapOnParentExit?: boolean },
  ) {
    return {
      executable: process.execPath,
      args: [
        '--input-type=commonjs',
        '--eval',
        LAUNCHER,
        this.directory,
        executable,
        JSON.stringify(args),
      ],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        QWEN_HOOK_COMMAND_ENV: JSON.stringify(env),
        ...(options?.reapOnParentExit
          ? { QWEN_HOOK_COMMAND_REAP_ON_PARENT_EXIT: '1' }
          : {}),
      },
    };
  }

  empty(): boolean {
    try {
      return /^populated 0$/m.test(
        readFileSync(join(this.directory, 'cgroup.events'), 'utf8'),
      );
    } catch {
      return false;
    }
  }

  covers(pid: number): boolean {
    // A launcher that outlived its foreground waits in the reaper sibling
    // unit, so the original listing alone would misread it as unjoined.
    for (const file of [
      join(this.directory, 'cgroup.procs'),
      join(`${this.directory}-reaper-${pid}`, 'cgroup.procs'),
    ]) {
      try {
        if (
          readFileSync(file, 'utf8')
            .split('\n')
            .some((line) => Number(line) === pid)
        ) {
          return true;
        }
      } catch {
        // A missing unit holds no members.
      }
    }
    return false;
  }

  async waitForEmpty(
    timeoutMs: number,
    stopped?: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.empty()) {
      if (stopped?.()) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  kill(): void {
    writeFileSync(join(this.directory, 'cgroup.kill'), '1');
  }

  async terminate(graceMs: number): Promise<void> {
    // Membership survives setsid and double-fork. cgroup.kill closes the fork
    // race left by the graceful per-process signal pass.
    for (const line of readFileSync(
      join(this.directory, 'cgroup.procs'),
      'utf8',
    ).split('\n')) {
      const pid = Number(line);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The member may already have exited.
      }
    }
    if (!(await this.waitForEmpty(graceMs))) this.kill();
  }

  remove(): void {
    if (this.empty()) rmdirSync(this.directory);
  }

  removeReaper(pid: number): void {
    const reaper = `${this.directory}-reaper-${pid}`;
    try {
      if (
        /^populated 0$/m.test(
          readFileSync(join(reaper, 'cgroup.events'), 'utf8'),
        )
      ) {
        rmdirSync(reaper);
      }
    } catch {
      // Missing or still populated: the worker-start sweep owns it.
    }
  }
}
