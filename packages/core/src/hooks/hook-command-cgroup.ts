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

export class HookCommandIsolationUnavailableError extends Error {
  constructor() {
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

  static create(root: string | undefined): HookCommandCgroup {
    let directory: string | undefined;
    try {
      if (process.platform !== 'linux' || !root || !isAbsolute(root))
        throw new HookCommandIsolationUnavailableError();
      const resolved = realpathSync(root);
      if (statfsSync(resolved).type !== 0x63677270)
        throw new HookCommandIsolationUnavailableError();
      if (
        readFileSync(join(resolved, 'cgroup.type'), 'utf8').trim() !== 'domain'
      )
        throw new HookCommandIsolationUnavailableError();
      directory = join(resolved, `qwen-hook-${randomUUID()}`);
      mkdirSync(directory, { mode: 0o700 });
      const unit = new HookCommandCgroup(directory);
      if (!unit.empty()) throw new HookCommandIsolationUnavailableError();
      for (const file of ['cgroup.procs', 'cgroup.kill']) {
        const fd = openSync(join(directory, file), 'w');
        closeSync(fd);
      }
      return unit;
    } catch {
      if (directory) {
        try {
          rmdirSync(directory);
        } catch {
          // A nonempty unit must remain available to the deployment owner.
        }
      }
      throw new HookCommandIsolationUnavailableError();
    }
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
