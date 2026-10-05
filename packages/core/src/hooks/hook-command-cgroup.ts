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
const { writeFileSync, writeSync } = require('node:fs');
const { spawn } = require('node:child_process');
const [group, executable, args] = process.argv.slice(1);
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
// No deployment command or environment is evaluated before membership.
const child = spawn(executable, JSON.parse(args), {
  env: JSON.parse(process.env.QWEN_HOOK_COMMAND_ENV),
  stdio: ['inherit', 'inherit', 'inherit'],
});
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
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

  launch(executable: string, args: string[], env: NodeJS.ProcessEnv) {
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
}
