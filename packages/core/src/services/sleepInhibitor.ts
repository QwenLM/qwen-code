/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  spawn as defaultSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { platform as defaultPlatform } from 'node:os';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SLEEP_INHIBITOR');

export interface SleepInhibitorHandle {
  release(): void;
}

export interface SleepInhibitorConfig {
  platform?: NodeJS.Platform;
  spawn?: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => ChildProcess;
  logger?: Pick<ReturnType<typeof createDebugLogger>, 'debug' | 'warn'>;
}

const NOOP_HANDLE: SleepInhibitorHandle = {
  release() {},
};

const MAX_INHIBITOR_REASON_LENGTH = 120;

/**
 * Sanitize the inhibitor reason before it is passed to `systemd-inhibit
 * --why=`. The string is visible in process listings (`ps`,
 * `systemd-inhibit --list`) on shared systems, so strip control characters
 * and cap the length to avoid leaking large/multiline context.
 */
function sanitizeInhibitorReason(reason: string): string {
  // Strip C0 control characters and DEL.
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\x00-\x1f\x7f]/g;
  return reason
    .replace(controlChars, ' ')
    .slice(0, MAX_INHIBITOR_REASON_LENGTH)
    .trim();
}

export class SleepInhibitor {
  private activeCount = 0;
  private child: ChildProcess | undefined;
  private spawnFailedForCurrentRun = false;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: NonNullable<SleepInhibitorConfig['spawn']>;
  private readonly logger: NonNullable<SleepInhibitorConfig['logger']>;

  constructor(config: SleepInhibitorConfig = {}) {
    this.platform = config.platform ?? defaultPlatform();
    this.spawn =
      config.spawn ??
      ((command, args, options) => defaultSpawn(command, args, options ?? {}));
    this.logger = config.logger ?? debugLogger;
  }

  acquire(reason = 'Qwen Code is processing a request'): SleepInhibitorHandle {
    this.activeCount += 1;

    if (this.activeCount === 1) {
      this.spawnFailedForCurrentRun = false;
      this.start(reason);
    } else if (!this.child && !this.spawnFailedForCurrentRun) {
      this.start(reason);
    }

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.release();
      },
    };
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  isRunning(): boolean {
    return this.child !== undefined;
  }

  private release(): void {
    if (this.activeCount === 0) {
      return;
    }

    this.activeCount -= 1;
    if (this.activeCount === 0) {
      this.stop();
      this.spawnFailedForCurrentRun = false;
    }
  }

  private start(reason: string): void {
    if (this.child || this.spawnFailedForCurrentRun) {
      return;
    }

    const command = this.getCommand(reason);
    if (!command) {
      this.logger.debug(
        `Sleep inhibition is unsupported on platform ${this.platform}.`,
      );
      // Latch so we don't re-check and re-log the unsupported platform on
      // every subsequent acquire() within the same run.
      this.spawnFailedForCurrentRun = true;
      return;
    }

    try {
      const child = this.spawn(command.command, command.args, {
        stdio: 'ignore',
        detached: false,
        windowsHide: true,
        env: this.getSpawnEnv(),
      });
      this.child = child;

      child.once('error', (error) => {
        // Guard the whole handler: a stale child (already replaced by a
        // newer spawn) must not flip spawnFailedForCurrentRun and poison the
        // current run's respawn logic.
        if (this.child !== child) {
          return;
        }
        this.logger.debug(`Failed to start sleep inhibitor: ${error.message}`);
        this.spawnFailedForCurrentRun = true;
        this.child = undefined;
      });

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
        }
        if (this.activeCount > 0 && !this.spawnFailedForCurrentRun) {
          this.logger.debug(
            `Sleep inhibitor exited while active: code=${String(code)} signal=${String(signal)}`,
          );
        }
      });
    } catch (error) {
      this.spawnFailedForCurrentRun = true;
      this.logger.debug(
        `Failed to spawn sleep inhibitor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Kill any active inhibitor subprocess and reset state. Safe to call
   * multiple times; used by the process-exit handler to avoid orphaning the
   * subprocess.
   */
  dispose(): void {
    this.activeCount = 0;
    this.spawnFailedForCurrentRun = false;
    this.stop();
  }

  /**
   * Build a minimal environment for the inhibitor subprocess instead of
   * passing an empty env. An empty env strips PATH (so the command cannot be
   * resolved) and DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR (which
   * systemd-inhibit needs to reach the user's systemd over D-Bus on Linux).
   * On Windows, PowerShell needs SYSTEMROOT/WINDIR.
   */
  private getSpawnEnv(): NodeJS.ProcessEnv {
    const allowList = [
      'PATH',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'SYSTEMROOT',
      'WINDIR',
      'TEMP',
      'TMP',
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowList) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return env;
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    // `child.pid` is undefined when the spawn failed (e.g. `systemd-inhibit`
    // is absent, as in the container sandbox, which rejects with ENOENT on the
    // next tick). Calling `kill()` on such a pidless child does not kill the
    // intended process — it signals the caller's own process group, which
    // inside a container delivers SIGTERM to this process and aborts the run.
    // Only kill a child that actually started.
    if (!child || child.killed || child.pid == null) {
      return;
    }

    try {
      child.kill();
    } catch (error) {
      this.logger.warn(
        `Failed to stop sleep inhibitor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private getCommand(
    reason: string,
  ): { command: string; args: string[] } | undefined {
    switch (this.platform) {
      case 'darwin':
        // -i prevents idle sleep; -s prevents system sleep but, per the
        // caffeinate(8) man page, only while on AC power. On battery -s is
        // ignored and lid-close sleep still occurs — macOS does not expose a
        // way to block that, so this does not fully match the Linux
        // systemd-inhibit semantics on battery.
        return { command: 'caffeinate', args: ['-is'] };
      case 'linux':
        return {
          command: 'systemd-inhibit',
          args: [
            '--what=sleep',
            '--who=Qwen Code',
            `--why=${sanitizeInhibitorReason(reason)}`,
            '--mode=block',
            'sleep',
            'infinity',
          ],
        };
      case 'win32':
        return {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            WINDOWS_INHIBIT_SCRIPT,
          ],
        };
      default:
        return undefined;
    }
  }
}

const WINDOWS_INHIBIT_SCRIPT = `
Add-Type -Namespace QwenCode -Name SleepUtil -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);';
[QwenCode.SleepUtil]::SetThreadExecutionState(0x80000001) | Out-Null;
try {
  while ($true) { Start-Sleep -Seconds 3600 }
} finally {
  [QwenCode.SleepUtil]::SetThreadExecutionState(0x80000000) | Out-Null;
}
`.trim();

export const sleepInhibitor = new SleepInhibitor();

// Kill the inhibitor subprocess if the parent process exits; otherwise an
// orphaned `caffeinate`/`systemd-inhibit`/PowerShell process would keep
// blocking system sleep indefinitely. Mirrors the exit handling in
// shellExecutionService.
process.on('exit', () => {
  sleepInhibitor.dispose();
});

export function acquireSleepInhibitor(
  config: Pick<Config, 'getPreventSystemSleepEnabled'>,
  reason?: string,
): SleepInhibitorHandle {
  if (config.getPreventSystemSleepEnabled?.() !== true) {
    return NOOP_HANDLE;
  }
  return sleepInhibitor.acquire(reason);
}
