/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';

export interface ChannelProcessSample {
  /** `utime + stime` from `/proc/<pid>/stat`, in clock ticks. */
  cpuTicks: number;
  /** Field 3 of `/proc/<pid>/stat` (`R`, `S`, `D`, `T`, `Z`, …). */
  state: string;
  /** Kernel wait channel; `'0'` when the kernel reports no symbolic wait, `''` when unreadable. */
  wchan: string;
  /** `VmRSS` from `/proc/<pid>/status`, in bytes; `0` when unreadable. */
  rssBytes: number;
}

/**
 * Pure parser for the fields the liveness monitor needs. `comm` (field 2)
 * is parenthesized and may itself contain spaces and ')' — a process named
 * "my ) proc" is legal — so anchor on the LAST ')' and count from there,
 * the same technique as `core/src/utils/process-liveness.ts`. After
 * "<pid> (<comm>) " the state (field 3) is index 0, `utime` (field 14) is
 * index 11, and `stime` (field 15) is index 12.
 */
export function parseProcStat(
  raw: string,
): { state: string; cpuTicks: number } | undefined {
  const commEnd = raw.lastIndexOf(')');
  if (commEnd === -1) return undefined;
  const fields = raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 13) return undefined;
  const state = fields[0];
  const utime = fields[11];
  const stime = fields[12];
  if (!state || !/^\d+$/.test(utime) || !/^\d+$/.test(stime)) {
    return undefined;
  }
  return { state, cpuTicks: Number(utime) + Number(stime) };
}

/**
 * One best-effort snapshot of the agent child for the liveness monitor's
 * busy-grace decision and failure evidence. Returns `undefined` wherever
 * the snapshot cannot be trusted (non-Linux, invalid pid, unreadable or
 * malformed `/proc`); callers must then fall back to the unmodified
 * timeout accounting rather than guess.
 */
export function sampleChannelProcess(
  pid: number | undefined,
): ChannelProcessSample | undefined {
  if (process.platform !== 'linux') return undefined;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  let stat: { state: string; cpuTicks: number } | undefined;
  try {
    stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
  if (!stat) return undefined;
  let wchan = '';
  try {
    wchan = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim();
  } catch {
    // Running processes report '0'; unreadable degrades to ''.
  }
  let rssBytes = 0;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (match) rssBytes = Number(match[1]) * 1024;
  } catch {
    // Evidence-only field; a missing RSS must not void the sample.
  }
  return { cpuTicks: stat.cpuTicks, state: stat.state, wchan, rssBytes };
}
