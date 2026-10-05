/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HookCommandCgroup,
  HookCommandIsolationUnavailableError,
} from '../hooks/hook-command-cgroup.js';

// H3 of #12827: the per-process supervisor for a managed background Shell.
// Each process lives in its own delegated cgroup v2 unit whose name derives
// from the execution identity, so a replacement worker re-attaches by name
// across its own restarts. Exit is claimed only with evidence; a unit that
// cannot be proven empty keeps the hold instead. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export { HookCommandIsolationUnavailableError };
export type { HookCommandIsolationUnavailableReason } from '../hooks/hook-command-cgroup.js';

export interface ChildRunExitEvidence {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

export interface ChildRunSpawnSpec {
  /** The unit's stable name, derived from the execution identity. */
  readonly unitName: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** The caller's bounded capture sink, one call per pipe chunk. */
  readonly onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
}

export class ManagedChildRunProcess {
  private exitEvidence: ChildRunExitEvidence | null = null;
  private settled = false;

  constructor(
    readonly unitName: string,
    private readonly unit: HookCommandCgroup,
    readonly child: ChildProcess,
  ) {
    child.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.exitEvidence = {
        exitCode: code,
        exitSignal: typeof signal === 'string' ? signal : null,
      };
    });
  }

  get exited(): boolean {
    return this.evidence !== null;
  }

  get evidence(): ChildRunExitEvidence | null {
    if (this.exitEvidence !== null) return this.exitEvidence;
    // An exit inside the membership proof window precedes the constructor's
    // listener; Node assigns these in the same callback that emits 'exit',
    // so the evidence survives a missed event.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return {
        exitCode: this.child.exitCode,
        exitSignal: this.child.signalCode,
      };
    }
    return null;
  }

  /**
   * Drains output, then TERM, then `cgroup.kill` after the grace window, and
   * settles only once the unit is proven empty via `cgroup.events` — never on
   * the root process's exit alone. Answers the exit evidence on success and
   * `null` while nothing is proven, in which case the caller keeps the hold.
   */
  async terminate(graceMs: number): Promise<ChildRunExitEvidence | null> {
    if (this.settled) return this.evidence;
    if (this.exited && this.unit.empty()) {
      this.unit.remove();
      this.settled = true;
      return this.evidence;
    }
    try {
      await this.unit.terminate(graceMs);
    } catch (error) {
      // The natural-end settle raced this stop: it removed the unit first,
      // so a stale read or the `cgroup.kill` write fails with ENOENT. The
      // process is proven ended by its settle, so the stop answers that
      // evidence instead of an "unavailable" after the fact.
      if (!this.settled) throw error;
    }
    if (this.settled) return this.evidence;
    if (!this.unit.empty()) return null;
    this.unit.remove();
    this.settled = true;
    return this.evidence;
  }

  /**
   * The natural-end twin of `terminate`: the root's exit is evidence only
   * once the unit proves empty — a `setsid` daemon that outlives its
   * launcher is still running, never an exit. Waits for membership to drain
   * (a stop from another owner wins the same wait), then removes the unit
   * and answers the exit evidence; `null` means nothing proved and the
   * caller keeps the hold rather than settling over live members.
   */
  async settleOnEmpty(): Promise<ChildRunExitEvidence | null> {
    if (this.settled) return this.evidence;
    if (!this.exited) return null;
    await this.unit.waitForEmpty(
      Number.MAX_SAFE_INTEGER / 2,
      () => this.settled,
    );
    if (this.settled) return this.evidence;
    if (!this.unit.empty()) return null;
    this.unit.remove();
    this.settled = true;
    return this.evidence;
  }
}

export class ManagedChildRunSupervisor {
  private readonly processes = new Map<string, ManagedChildRunProcess>();

  private constructor(private readonly cgroupRoot: string) {}

  static create(options: { cgroupRoot: string | undefined }) {
    if (options.cgroupRoot === undefined)
      throw new HookCommandIsolationUnavailableError('root_missing');
    return new ManagedChildRunSupervisor(options.cgroupRoot);
  }

  get size(): number {
    return this.processes.size;
  }

  process(unitName: string): ManagedChildRunProcess | undefined {
    return this.processes.get(unitName);
  }

  /**
   * Starts a new process under a fresh unit named after the execution, and
   * resolves only once the launcher's cgroup membership is proven — the
   * launcher's own `joined` marker on fd 3, or its pid in `cgroup.procs`;
   * a quiet fd 3 is never success, and neither is a launcher that joined
   * and already exited by the first listing. A membership that cannot be
   * proven is an isolation failure: the child goes, the unit goes, and the
   * caller records a start that never happened.
   */
  async start(
    spec: ChildRunSpawnSpec,
    membership?: {
      readonly prove?: (
        child: ChildProcess,
        unit: HookCommandCgroup,
      ) => Promise<boolean>;
    },
  ): Promise<ManagedChildRunProcess> {
    const unit = HookCommandCgroup.create(this.cgroupRoot, spec.unitName);
    // The launcher joins the unit before the command exists, so no
    // deployment-provided executable or environment is read outside it.
    const launch = unit.launch(spec.executable, [...spec.args], spec.env);
    const child = spawn(launch.executable, launch.args, {
      cwd: spec.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    // A spawn failure before the proof settles must never escape as an
    // unhandled 'error'; the settle path answers it.
    child.on('error', () => undefined);
    child.stdout?.on('data', (chunk: Buffer) => spec.onOutput('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => spec.onOutput('stderr', chunk));
    let status = '';
    child.stdio[3]?.on('data', (data: Buffer) => {
      status += data.toString();
    });
    const prove =
      membership?.prove ??
      (async (launched: ChildProcess, inUnit: HookCommandCgroup) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          // The launcher's marker proves membership the kernel already
          // accepted; it also covers a fast exit that empties the unit
          // before the first listing could run.
          if (status.includes('joined\n')) return true;
          if (status.includes('unavailable\n')) return false;
          try {
            const members = readFileSync(
              join(inUnit.directory, 'cgroup.procs'),
              'utf8',
            );
            if (
              launched.pid !== undefined &&
              members.split('\n').includes(String(launched.pid))
            ) {
              return true;
            }
          } catch {
            // The unit's membership file is not readable yet.
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      });
    if (!(await prove(child, unit))) {
      child.kill('SIGKILL');
      unit.remove();
      throw new HookCommandIsolationUnavailableError('membership_unproven');
    }
    const process_ = new ManagedChildRunProcess(spec.unitName, unit, child);
    this.processes.set(spec.unitName, process_);
    return process_;
  }

  /**
   * Re-attaches a unit that a previous incarnation of this worker started:
   * nothing spawns, and the caller verifies the membership evidence itself.
   */
  attach(unitName: string): HookCommandCgroup | undefined {
    return HookCommandCgroup.attach(this.cgroupRoot, unitName);
  }

  forget(unitName: string): void {
    this.processes.delete(unitName);
  }
}
