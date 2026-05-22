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
      return;
    }

    try {
      const child = this.spawn(command.command, command.args, {
        stdio: 'ignore',
        detached: false,
        windowsHide: true,
      });
      this.child = child;

      child.once('error', (error) => {
        this.logger.debug(`Failed to start sleep inhibitor: ${error.message}`);
        this.spawnFailedForCurrentRun = true;
        if (this.child === child) {
          this.child = undefined;
        }
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

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) {
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
        return { command: 'caffeinate', args: ['-i'] };
      case 'linux':
        return {
          command: 'systemd-inhibit',
          args: [
            '--what=sleep',
            '--who=Qwen Code',
            `--why=${reason}`,
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

export function acquireSleepInhibitor(
  config: Pick<Config, 'getPreventSystemSleepEnabled'>,
  reason?: string,
): SleepInhibitorHandle {
  if (config.getPreventSystemSleepEnabled?.() !== true) {
    return NOOP_HANDLE;
  }
  return sleepInhibitor.acquire(reason);
}
