/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { readLocalBootId } from '../utils/process-liveness.js';

interface MemberIdentity {
  pid: number;
  pgid: number;
  sid: number;
  start: string;
  running: boolean;
}

const POLL_MS = 25;
const CONFIRM_MS = 200;

class InvalidProcIdentitySourceError extends Error {}

function requireSupportedProcView(): void {
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' - ').map((part) => part.split(/\s+/)))
    .filter(([mount]) => mount[4] === '/proc');
  const [mount, filesystem] = mounts[0] ?? [];
  if (mounts.some(([, source]) => source?.[0] && source[0] !== 'proc'))
    throw new InvalidProcIdentitySourceError(
      'Refusing non-proc identity source for process-group cleanup',
    );
  if (
    mounts.length !== 1 ||
    mount?.[3] !== '/' ||
    !mount?.[5] ||
    filesystem?.[0] !== 'proc' ||
    !filesystem?.[2] ||
    `${mount[5]},${filesystem[2]}`
      .split(',')
      .some(
        (option) =>
          option.startsWith('hidepid=') && !/^hidepid=(0|off)$/.test(option),
      )
  )
    throw new Error('Unsupported /proc visibility for process-group cleanup');
}

function readMember(pid: number): MemberIdentity | null {
  const boot = readLocalBootId();
  if (!boot) throw new Error('Linux process-start identity is unavailable');
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces and ')', so fields begin after its last closing parenthesis.
    const fields = raw
      .slice(raw.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const pgid = Number(fields[2]);
    const sid = Number(fields[3]);
    const start = fields[19];
    if (
      Number(raw.slice(0, raw.indexOf(' '))) !== pid ||
      raw.lastIndexOf(')') === -1 ||
      !Number.isSafeInteger(pgid) ||
      pgid < 0 ||
      !Number.isSafeInteger(sid) ||
      sid < 0 ||
      !start ||
      !/^\d+$/.test(start) ||
      !fields[0] ||
      !/^[A-Za-z]$/.test(fields[0])
    )
      throw new Error(`Invalid Linux process identity for ${pid}`);
    return {
      pid,
      pgid,
      sid,
      start: `${boot}:${start}`,
      running: !/^[ZXx]$/.test(fields[0]),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameMember(
  left: MemberIdentity,
  right: MemberIdentity | null,
): boolean {
  return (
    right !== null &&
    left.start === right.start &&
    left.pgid === right.pgid &&
    left.sid === right.sid
  );
}

/** Cancellation ownership lasts until the authenticated group has stopped. */
export class OwnedPosixProcessGroup {
  private readonly members = new Map<number, MemberIdentity>();
  private readonly initialError: Error | null;
  private done = false;
  private released = false;
  private initialized = false;
  private killAttempted = false;
  private timer: NodeJS.Timeout | undefined;
  private promise: Promise<Error | null> | undefined;
  private resolve: ((error: Error | null) => void) | undefined;
  private signalError: Error | undefined;
  private inspectionError: Error | undefined;

  constructor(private readonly pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      this.initialError = new Error(`Refusing unsafe process group ${pid}`);
    } else if (process.platform !== 'linux') {
      this.initialError = new Error(
        `Authenticated process-group cleanup is unavailable on ${process.platform}`,
      );
    } else {
      try {
        const member = readMember(pid);
        if (member) {
          this.members.set(pid, member);
          this.initialError = null;
        } else {
          this.initialError = new Error(
            `Could not capture original process-group identity for ${pid}`,
          );
        }
      } catch (error) {
        this.initialError = new Error(
          `Could not capture original process-group identity for ${pid}`,
          { cause: error },
        );
      }
    }
  }

  get completion(): Promise<Error | null> | undefined {
    return this.promise;
  }
  get cancelling(): boolean {
    return this.promise !== undefined && !this.released;
  }

  cancel(graceMs = 200): Promise<Error | null> {
    if (this.promise) return this.promise;
    const completion = this.begin();
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      this.finish(new Error(`Invalid process-group grace period ${graceMs}`));
      return completion;
    }
    if (!this.prepare()) return completion;
    this.signal('SIGTERM');
    if (!this.done && !this.killAttempted) {
      this.wait(performance.now() + graceMs, () => this.force());
    }
    return completion;
  }

  force(): void {
    if (this.done || this.released || this.killAttempted) return;
    this.begin();
    if (!this.prepare()) return;
    this.killAttempted = true;
    this.clearTimer();
    this.signal('SIGKILL');
    if (!this.done) {
      this.wait(
        performance.now() + CONFIRM_MS,
        () =>
          this.finish(
            new Error(
              this.inspectionError?.message ??
                `Process group ${this.pid} did not stop after SIGKILL`,
              { cause: this.signalError ?? this.inspectionError },
            ),
          ),
        true,
      );
    }
  }

  release(): void {
    this.released = true;
    this.clearTimer();
    if (this.promise && !this.done) {
      this.finish(
        new Error(
          `Cleanup ownership for process group ${this.pid} was released before termination was confirmed`,
        ),
      );
    }
  }

  private begin(): Promise<Error | null> {
    this.promise ??= new Promise((resolve) => {
      this.resolve = resolve;
    });
    return this.promise;
  }

  private prepare(): boolean {
    if (this.released || this.initialError) {
      this.finish(
        this.initialError ??
          new Error(
            `Cleanup ownership for process group ${this.pid} was released`,
          ),
      );
      return false;
    }
    if (!this.initialized) {
      try {
        const original = this.members.get(this.pid);
        const current = readMember(this.pid);
        if (
          !original ||
          !current ||
          current.start !== original.start ||
          current.pgid !== this.pid ||
          current.sid !== this.pid
        ) {
          this.finish(
            new Error(
              `Refusing process group ${this.pid}: original leader identity or isolation changed`,
            ),
          );
          return false;
        }
        this.members.set(this.pid, current);
        this.initialized = true;
      } catch (error) {
        this.finish(
          new Error(
            `Could not authenticate original process group ${this.pid}`,
            { cause: error },
          ),
        );
        return false;
      }
    }
    return true;
  }

  private inspect(): boolean {
    try {
      this.inspectionError = undefined;
      try {
        process.kill(-this.pid, 0);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          this.finish(null);
          return false;
        }
        if (code !== 'EPERM') throw error;
      }
      const witnesses = this.readWitnesses(this.members.values());
      if (!witnesses.length) {
        throw new Error(
          `Refusing process group ${this.pid}: original member identities are gone or changed`,
        );
      }
      // Visibility limits prevent confirmation, not signals authorized by a matching identity.
      try {
        requireSupportedProcView();
      } catch (error) {
        if (error instanceof InvalidProcIdentitySourceError) throw error;
        this.noteInspectionError(error);
      }
      let snapshot: MemberIdentity[] = [];
      try {
        snapshot = readdirSync('/proc')
          .filter((name) => /^\d+$/.test(name))
          .map((name) => this.readObservedMember(Number(name)))
          .filter(
            (member): member is MemberIdentity =>
              member !== null &&
              member.pgid === this.pid &&
              member.sid === witnesses[0].sid,
          );
      } catch (error) {
        this.noteInspectionError(error);
      }
      // Newly observed members are trusted only while an old identity still anchors the group.
      const currentWitnesses = this.readWitnesses(witnesses);
      if (!currentWitnesses.length) {
        throw new Error(
          `Refusing process group ${this.pid}: ownership changed during inspection`,
        );
      }
      for (const member of snapshot) this.members.set(member.pid, member);
      if (
        !this.inspectionError &&
        !snapshot.some((member) => member.running) &&
        !currentWitnesses.some((member) => member.running)
      ) {
        this.finish(null);
        return false;
      }
      return true;
    } catch (error) {
      this.finish(
        new Error(
          `Could not inspect process group ${this.pid}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
      return false;
    }
  }

  private noteInspectionError(error: unknown): void {
    this.inspectionError ??= new Error(
      `Cleanup unconfirmed for process group ${this.pid}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  private readObservedMember(pid: number): MemberIdentity | null {
    try {
      return readMember(pid);
    } catch (error) {
      this.noteInspectionError(error);
      return null;
    }
  }

  private readWitnesses(members: Iterable<MemberIdentity>): MemberIdentity[] {
    return [...members].flatMap((member) => {
      const current = this.readObservedMember(member.pid);
      return current && sameMember(member, current) ? [current] : [];
    });
  }

  private signal(signal: NodeJS.Signals): void {
    if (!this.inspect() || this.done || this.released) return;
    if (!this.readWitnesses(this.members.values()).length) {
      this.finish(
        new Error(
          `Refusing ${signal} for process group ${this.pid}: no authenticated member`,
          { cause: this.inspectionError },
        ),
      );
      return;
    }
    if (
      this.done ||
      this.released ||
      (signal === 'SIGTERM' && this.killAttempted)
    )
      return;
    try {
      process.kill(-this.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        this.finish(null);
      } else {
        this.signalError = new Error(
          `Could not send ${signal} to process group ${this.pid}`,
          { cause: error },
        );
      }
    }
  }

  private wait(deadline: number, expired: () => void, afterKill = false): void {
    if (this.done || this.released || !this.inspect()) return;
    if (this.done || this.released || this.killAttempted !== afterKill) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      expired();
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wait(deadline, expired, afterKill);
      },
      Math.min(POLL_MS, remaining),
    );
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private finish(error: Error | null): void {
    if (this.done) return;
    this.done = true;
    this.clearTimer();
    this.resolve?.(error);
  }
}
