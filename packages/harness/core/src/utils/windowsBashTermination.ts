/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { quote } from 'shell-quote';
import { spawnAsync } from './shell-utils.js';
import { runLogger } from './runLogger.js';
import { windowsPathToPosixPath } from './windowsPaths.js';
import {
  readWindowsProcessSnapshot,
  selectWindowsDescendants,
  terminateWindowsProcesses,
  type WindowsProcessIdentity,
} from './windowsProcessSnapshot.js';

const WINDOWS_BASH_STOP_TIMEOUT_MS = 120_000;

export interface MsysProcess {
  pid: number;
  parent: number;
  group: number;
  started: string;
  windowsPid: number;
}

// comm may contain whitespace and parentheses. The fields after its final ')'
// follow proc(5); field 22 is the process start time, not a Windows PID.
export function parseMsysProcess(
  stat: string,
  windowsPid: string,
): MsysProcess {
  const match = /^(\d+) \(.*\) (.*)$/.exec(stat.trim());
  const fields = match?.[2]?.split(/\s+/);
  const result = {
    pid: Number(match?.[1]),
    parent: Number(fields?.[1]),
    group: Number(fields?.[2]),
    started: fields?.[19] ?? '',
    windowsPid: Number(windowsPid.trim()),
  };
  if (
    !fields ||
    fields.length < 20 ||
    !/^\d+$/.test(result.started) ||
    ![result.pid, result.windowsPid].every(
      (value) => Number.isSafeInteger(value) && value > 1,
    ) ||
    !Number.isSafeInteger(result.group) ||
    result.group < 0 ||
    !Number.isSafeInteger(result.parent) ||
    result.parent < 0
  )
    throw new Error('Invalid MSYS process identity');
  return result;
}

function identity(process: MsysProcess): string {
  return `${process.pid}:${process.started}:${process.windowsPid}`;
}

// Snapshot enumeration order is unrelated to ancestry. Stop producers before
// their children so a shell cannot advance to its next command after wait exits.
export function parentsFirst(processes: MsysProcess[]): MsysProcess[] {
  const pending = new Map(processes.map((process) => [process.pid, process]));
  const result: MsysProcess[] = [];
  while (pending.size) {
    const parents = [...pending.values()].filter(
      (process) => !pending.has(process.parent),
    );
    if (!parents.length) throw new Error('Invalid MSYS parent cycle');
    for (const process of parents) {
      result.push(process);
      pending.delete(process.pid);
    }
  }
  return result;
}

/** Only claim a process group when the command itself created that group. */
export function selectMsysProcesses(
  snapshot: MsysProcess[],
  root: MsysProcess,
  known: MsysProcess[],
): MsysProcess[] {
  const identities = new Set(known.map(identity));
  const selected = snapshot.filter((process) =>
    identities.has(identity(process)),
  );
  const liveRoot = snapshot.find((process) => process.pid === root.pid);
  if (liveRoot && identity(liveRoot) !== identity(root)) {
    // A recycled group leader is never a continuation of this command.
    return selected;
  }
  if (!selected.length) return [];
  const pids = new Set(selected.map((process) => process.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of snapshot) {
      if (pids.has(process.pid)) continue;
      if (
        pids.has(process.parent) ||
        (root.group === root.pid && process.group === root.group)
      ) {
        selected.push(process);
        pids.add(process.pid);
        changed = true;
      }
    }
  }
  return selected;
}

const SNAPSHOT = String.raw`
for entry in /proc/[0-9]*; do
  stat=$(< "$entry/stat") 2>/dev/null || continue
  winpid=$(< "$entry/winpid") 2>/dev/null || continue
  builtin printf '%s\t%s\n' "$winpid" "$stat"
done
`;

// Signal in the MSYS namespace after rechecking identity. Native descendants
// are captured separately before this step, so losing their parent is harmless
// for already observed children.
const TERMINATE = String.raw`
while (( $# )); do
  pid=$1; started=$2; winpid=$3; shift 3
  stat=$(< "/proc/$pid/stat") 2>/dev/null || continue
  current=$(< "/proc/$pid/winpid") 2>/dev/null || continue
  fields=\${stat##*) }; builtin read -r -a fields <<< "$fields"
  [[ \${fields[19]} == "$started" && $current == "$winpid" ]] || continue
  builtin kill -KILL -- "$pid" 2>/dev/null
done
exit 0
`.replaceAll('\\$', '$');

/** No bundled helper or native addon: use the same MSYS runtime as the command. */
export function prepareWindowsBashTermination(shellPath: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'qoder-bash-owner-'));
  const file = path.join(directory, 'identity');
  const shellFile = quote([windowsPathToPosixPath(file)]);
  const env = { ...process.env };
  // A cleanup probe must not execute user shell initialization.
  delete env['BASH_ENV'];
  delete env['ENV'];
  delete env['SHELLOPTS'];
  delete env['BASHOPTS'];
  const run = (script: string, args: string[], deadline: number) => {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0)
      throw new Error(
        'Windows Bash stop deadline exceeded; cleanup is unconfirmed',
      );
    return spawnAsync(
      shellPath,
      ['--noprofile', '--norc', '-c', script, 'qoder-stop', ...args],
      { env, windowsHide: true, timeout: Math.min(5000, remainingMs) },
    );
  };
  const snapshot = async (deadline: number) => {
    const { stdout } = await run(SNAPSHOT, [], deadline);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('\t');
        return parseMsysProcess(
          line.slice(separator + 1),
          line.slice(0, separator),
        );
      });
  };
  const signal = (
    processes: MsysProcess[],
    name: 'STOP' | 'CONT' | 'KILL',
    deadline: number,
  ) =>
    run(
      TERMINATE.replace(
        'builtin kill -KILL -- "$pid" 2>/dev/null',
        `builtin kill -${name} -- "$pid" 2>/dev/null${name === 'STOP' ? ' || exit 1' : ''}`,
      ),
      processes.flatMap((process) => [
        String(process.pid),
        process.started,
        String(process.windowsPid),
      ]),
      deadline,
    );
  return {
    // Keep the owner alive even when user code replaces its own shell with exec.
    // Pass the provider's original argv through so only the user shell runs profiles.
    wrapArgs: (args: string[]) => [
      '--noprofile',
      '--norc',
      '-p',
      '-c',
      `stat=$(< /proc/$$/stat) && winpid=$(< /proc/$$/winpid) && builtin printf '%s\\n%s\\n' "$stat" "$winpid" >| ${shellFile} || { builtin echo 'Could not record Windows Bash process identity' >&2; exit 1; }
"$BASH" "$@"
exit $?`,
      'qoder-bash-owner',
      ...args,
    ],
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    async kill(): Promise<void> {
      const deadline = performance.now() + WINDOWS_BASH_STOP_TIMEOUT_MS;
      let root: MsysProcess | undefined;
      const readyDeadline = performance.now() + 2000;
      do {
        try {
          const [stat, winpid] = readFileSync(file, 'utf8').trim().split('\n');
          root = parseMsysProcess(stat ?? '', winpid ?? '');
        } catch {
          if (performance.now() >= readyDeadline) {
            throw new Error(
              'Cannot confirm Windows Bash process identity; stop was not confirmed',
            );
          }
          await delay(25);
        }
      } while (!root);

      let known = [root];
      let nativeKnown: WindowsProcessIdentity[] = [];
      let first = true;
      let ownerStopped = false;
      try {
        while (true) {
          const current = await snapshot(deadline);
          if (
            first &&
            !current.some((process) => identity(process) === identity(root))
          ) {
            throw new Error(
              'Windows Bash leader exited before ownership could be confirmed',
            );
          }
          if (first) {
            // Keep the ownership anchor alive while descendants are being killed.
            // Otherwise the supervisor exits as soon as its user shell exits.
            ownerStopped = true;
            await signal([root], 'STOP', deadline);
          }
          first = false;
          known = selectMsysProcesses(current, root, known);
          if (
            !known.length &&
            root.group === root.pid &&
            current.some((process) => process.group === root.group)
          ) {
            throw new Error(
              'Windows Bash group ownership changed; stop was not confirmed',
            );
          }
          const nativeSnapshot = await readWindowsProcessSnapshot(deadline);
          // CIM can be slow. Validate the MSYS identities again before treating
          // Windows PIDs from the earlier snapshot as roots of native trees.
          const confirmed = new Set((await snapshot(deadline)).map(identity));
          const nativeRoots = known
            .filter((process) => confirmed.has(identity(process)))
            .map((process) => process.windowsPid);
          nativeKnown = nativeSnapshot.filter((process) =>
            nativeKnown.some(
              (entry) =>
                entry.pid === process.pid && entry.created === process.created,
            ),
          );
          nativeKnown = selectWindowsDescendants(nativeSnapshot, [
            ...nativeRoots,
            ...nativeKnown.map((process) => process.pid),
          ]);
          if (!known.length && !nativeKnown.length) return;
          if (performance.now() >= deadline)
            throw new Error('Windows Bash descendants remain after stop');
          const descendants = known.filter(
            (process) => identity(process) !== identity(root),
          );
          const nativeDescendants = nativeKnown.filter(
            (process) => process.pid !== root.windowsPid,
          );
          const releaseOwner = !descendants.length && !nativeDescendants.length;
          await signal(
            parentsFirst(releaseOwner ? known : descendants),
            'KILL',
            deadline,
          );
          await terminateWindowsProcesses(
            releaseOwner ? nativeKnown : nativeDescendants,
            deadline,
          );
          await delay(50);
        }
      } finally {
        // A failed query must not leave a suspended supervisor behind.
        if (ownerStopped) {
          await signal([root], 'CONT', performance.now() + 5000).catch(
            (error) => {
              runLogger.warn(
                `[WindowsStop] Could not resume supervisor: ${String(error)}`,
              );
            },
          );
        }
      }
    },
  };
}
