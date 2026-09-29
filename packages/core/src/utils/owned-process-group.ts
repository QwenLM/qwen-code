/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawnSync } from 'node:child_process';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('OWNED_PROCESS_GROUP');
const SIGKILL_TIMEOUT_MS = 200;

export interface OwnedProcessGroup {
  exited: Promise<void>;
  killSync(): void;
}

interface ProcessGroupMember {
  pid: number;
  pgid: number;
  identity: string;
  zombie: boolean;
}

const GROUP_PS_ARGS = [
  '-A',
  '-o',
  'pid=',
  '-o',
  'pgid=',
  '-o',
  'lstart=',
  '-o',
  'stat=',
];
const GROUP_PS_OPTIONS = {
  encoding: 'utf8' as const,
  timeout: 1000,
  maxBuffer: 4 * 1024 * 1024,
};

function parseProcessGroup(output: string): ProcessGroupMember[] {
  const members: ProcessGroupMember[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error('Cannot parse owned process group snapshot.');
    members.push({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      identity: `${match[1]}:${match[3]}`,
      zombie: match[4].startsWith('Z'),
    });
  }
  if (members.length === 0)
    throw new Error('Owned process snapshot was unexpectedly empty.');
  return members;
}

function readProcessGroupSync(): ProcessGroupMember[] {
  const result = spawnSync('/bin/ps', GROUP_PS_ARGS, {
    ...GROUP_PS_OPTIONS,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error('Cannot inspect owned process group.');
  return parseProcessGroup(result.stdout);
}

function readProcessGroup(): Promise<ProcessGroupMember[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      GROUP_PS_ARGS,
      { ...GROUP_PS_OPTIONS, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseProcessGroup(stdout));
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

export function ownProcessGroup(
  pgid: number,
  signal: AbortSignal,
  onCancel?: (reason: unknown) => void,
): OwnedProcessGroup {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let closed = false;
  let anchored = false;
  let uncertain = false;
  let known = new Set<string>();
  let cancelRequested = signal.aborted;
  if (signal.aborted) onCancel?.(signal.reason);
  let termSentAt: number | undefined;
  let killSent = false;
  let warning: string | undefined;
  const onAbort = () => {
    cancelRequested = true;
    onCancel?.(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const close = () => {
    closed = true;
    signal.removeEventListener('abort', onAbort);
    resolveExit();
  };
  const observe = (snapshot: ProcessGroupMember[]): boolean => {
    if (closed) return false;
    const initialLeader =
      !anchored && !uncertain
        ? snapshot.find((member) => member.pid === pgid)
        : undefined;
    if (initialLeader) known.add(initialLeader.identity);
    // Unobserved setsid/detached children are outside this group contract.
    // An observed member moving groups is not proof that our work stopped.
    if (
      snapshot.some(
        (member) =>
          known.has(member.identity) && member.pgid !== pgid && !member.zombie,
      )
    ) {
      uncertain = true;
      throw new Error('An owned process moved outside its process group.');
    }
    const members = snapshot.filter((member) => member.pgid === pgid);
    if (!members.some((member) => !member.zombie)) {
      close();
      return false;
    }
    // A continuous member identity prevents a reused PGID from acquiring the
    // previous command's kill authority. Lost continuity remains uncontained.
    if (
      uncertain ||
      !(anchored
        ? members.some((member) => known.has(member.identity))
        : members.some((member) => member.pid === pgid))
    ) {
      uncertain = true;
      throw new Error('Owned process group ownership continuity was lost.');
    }
    anchored = true;
    known = new Set(members.map((member) => member.identity));
    return true;
  };
  const send = (kind: NodeJS.Signals) => {
    try {
      process.kill(-pgid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Never signal this PGID again after observing its disappearance.
        // A fresh snapshot must still exclude an observed member escaping.
        uncertain = true;
        return;
      }
      throw error;
    }
  };
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== warning)
      debugLogger.warn(
        `Owned process group ${pgid} remains uncontained: ${message}`,
      );
    warning = message;
  };
  // Capture before yielding to leader-exit callbacks, while its PID is still
  // ours. Later probes must retain an identity from this process group.
  try {
    observe(readProcessGroupSync());
  } catch (error) {
    uncertain = true;
    report(error);
  }
  void (async () => {
    while (!closed) {
      try {
        if (observe(await readProcessGroup()) && cancelRequested) {
          if (termSentAt === undefined) {
            send('SIGTERM');
            termSentAt = Date.now();
          } else if (
            !killSent &&
            Date.now() - termSentAt >= SIGKILL_TIMEOUT_MS
          ) {
            send('SIGKILL');
            killSent = true;
          }
        }
      } catch (error) {
        report(error);
      }
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return {
    exited,
    killSync() {
      if (closed) return;
      try {
        if (observe(readProcessGroupSync())) send('SIGKILL');
      } catch (error) {
        report(error);
      }
    },
  };
}
