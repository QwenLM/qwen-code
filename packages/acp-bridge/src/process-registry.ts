/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import type { AcpChannelExitInfo } from './channel.js';

const TERM_GRACE_MS = 5_000;
const EXIT_DEADLINE_MS = 10_000;

export interface TrackedChildProcess {
  readonly exited: Promise<AcpChannelExitInfo | undefined>;
  terminate(): Promise<void>;
  killSync(): void;
}

export interface ProcessReservation {
  attach(child: ChildProcess): TrackedChildProcess;
  cancel(): void;
}

export class ProcessRegistry {
  private readonly reservations = new Set<symbol>();
  private readonly children = new Set<TrackedChild>();
  private draining = false;
  private shutdownPromise: Promise<void> | undefined;

  reserve(): ProcessReservation {
    if (this.draining) {
      throw new Error('ACP process registry is draining');
    }
    const token = Symbol('acp-child');
    this.reservations.add(token);
    let settled = false;
    return {
      attach: (child) => {
        if (settled || !this.reservations.delete(token)) {
          throw new Error('ACP process reservation is no longer active');
        }
        settled = true;
        const tracked = new TrackedChild(child, () => {
          this.children.delete(tracked);
        });
        this.children.add(tracked);
        if (this.draining) void tracked.terminate().catch(() => {});
        return tracked;
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.reservations.delete(token);
      },
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = Promise.allSettled(
      [...this.children].map((child) => child.terminate()),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'ACP child process shutdown failed');
      }
    });
    return this.shutdownPromise;
  }

  killAllSync(): void {
    this.draining = true;
    for (const child of this.children) child.killSync();
  }

  get activeProcessCount(): number {
    return this.children.size;
  }
}

class TrackedChild implements TrackedChildProcess {
  readonly exited: Promise<AcpChannelExitInfo | undefined>;
  private exitedSettled = false;
  private spawnConfirmed = false;
  private terminatePromise: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly onExit: () => void,
  ) {
    this.exited = new Promise((resolve) => {
      const finish = (info?: AcpChannelExitInfo) => {
        if (this.exitedSettled) return;
        this.exitedSettled = true;
        this.onExit();
        resolve(info);
      };
      child.once('exit', (exitCode, signalCode) => {
        finish({ exitCode, signalCode });
      });
      child.once('spawn', () => {
        this.spawnConfirmed = true;
      });
      child.once('error', () => {
        if (!this.spawnConfirmed) finish(undefined);
      });
    });
  }

  terminate(): Promise<void> {
    this.terminatePromise ??= this.terminateOnce();
    return this.terminatePromise;
  }

  killSync(): void {
    if (this.exitedSettled) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      // A concurrent exit will settle the tracked process.
    }
  }

  private async terminateOnce(): Promise<void> {
    if (this.exitedSettled) return;
    try {
      this.child.kill('SIGTERM');
    } catch {
      if (this.exitedSettled) return;
    }

    let hardKillTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      hardKillTimer = setTimeout(() => this.killSync(), TERM_GRACE_MS);
      hardKillTimer.unref();
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `ACP child pid=${this.child.pid ?? 'unknown'} did not exit within ${EXIT_DEADLINE_MS}ms`,
          ),
        );
      }, EXIT_DEADLINE_MS);
      deadlineTimer.unref();
    });
    try {
      const exitInfo = await Promise.race([this.exited, deadline]);
      if (
        exitInfo &&
        (exitInfo.exitCode !== 0 || exitInfo.signalCode !== null)
      ) {
        throw new Error(
          `ACP child pid=${this.child.pid ?? 'unknown'} exited uncleanly during shutdown ` +
            `(code=${exitInfo.exitCode ?? 'none'}, signal=${exitInfo.signalCode ?? 'none'})`,
        );
      }
    } finally {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }
}
