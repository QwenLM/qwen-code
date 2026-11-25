/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';

const CONTAINER_MARKER_FILES = ['/.dockerenv', '/run/.containerenv'];
const CGROUP_PATH = '/proc/1/cgroup';
const CONTAINER_RUNTIME_NAMES = ['docker', 'containerd', 'kubepods'];

/**
 * Whether this process runs inside a container.
 *
 * Total by construction — callers evaluate this outside their
 * try/catch, so it must never throw.
 */
export function detectContainer(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    if (CONTAINER_MARKER_FILES.some((marker) => existsSync(marker))) {
      return true;
    }
    if (existsSync(CGROUP_PATH)) {
      // Marker files miss containerd and Kubernetes; PID 1's cgroup names them.
      const cgroup = readFileSync(CGROUP_PATH, 'utf-8').toLowerCase();
      if (CONTAINER_RUNTIME_NAMES.some((name) => cgroup.includes(name))) {
        return true;
      }
    }
  } catch {
    // Unreadable marker or cgroup.
  }
  return !!process.env['DOCKER_CONTAINER'];
}

/**
 * Whether an x64 build runs under Rosetta 2 on Apple silicon.
 *
 * x86 cannot execute natively on ARM, so an x64 process seeing an Apple chip
 * must be translated. Substring checks, not regexes: this runs once per
 * process, where a regex compile costs as much as the whole probe.
 *
 * Total by construction — callers evaluate this outside their
 * try/catch, so it must never throw.
 */
export function detectRosetta(): boolean {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return false;

  try {
    const model = (cpus()[0]?.model ?? '').toLowerCase();
    if (model.includes('apple')) return true;
    if (model.includes('intel')) return false;

    // Unrecognised vendor, e.g. virtualised hardware.
    const output = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
    return output === '1';
  } catch {
    return false;
  }
}
