/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_TRAVERSAL_DEPTH = 32;

/**
 * Fetches the parent process ID, name, and command for a given process ID.
 *
 * @param pid The process ID to inspect.
 * @returns A promise that resolves to the parent's PID, name, and command.
 */
async function getProcessInfo(pid: number): Promise<{
  parentPid: number;
  name: string;
  command: string;
}> {
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      const powershellCommand = [
        '$p = Get-CimInstance Win32_Process',
        `-Filter 'ProcessId=${pid}'`,
        '-ErrorAction SilentlyContinue;',
        'if ($p) {',
        '@{Name=$p.Name;ParentProcessId=$p.ParentProcessId;CommandLine=$p.CommandLine}',
        '| ConvertTo-Json',
        '}',
      ].join(' ');

      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        powershellCommand,
      ]);
      const output = stdout.trim();
      if (!output) return { parentPid: 0, name: '', command: '' };
      const {
        Name = '',
        ParentProcessId = 0,
        CommandLine = '',
      } = JSON.parse(output);
      return {
        parentPid: ParentProcessId,
        name: Name,
        command: CommandLine ?? '',
      };
    } else {
      const command = `ps -o ppid=,command= -p ${pid}`;
      const { stdout } = await execAsync(command);
      const trimmedStdout = stdout.trim();
      if (!trimmedStdout) {
        return { parentPid: 0, name: '', command: '' };
      }
      const ppidString = trimmedStdout.split(/\s+/)[0];
      const parentPid = parseInt(ppidString, 10);
      const fullCommand = trimmedStdout.substring(ppidString.length).trim();
      const processName = path.basename(fullCommand.split(' ')[0]);
      return {
        parentPid: isNaN(parentPid) ? 1 : parentPid,
        name: processName,
        command: fullCommand,
      };
    }
  } catch (_e) {
    console.debug(`Failed to get process info for pid ${pid}:`, _e);
    return { parentPid: 0, name: '', command: '' };
  }
}

/**
 * Finds the IDE process info on Unix-like systems.
 *
 * The strategy is to find the shell process that spawned the CLI, and then
 * find that shell's parent process (the IDE). To get the true IDE process,
 * we traverse one level higher to get the grandparent.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
async function getIdeProcessInfoForUnix(): Promise<{
  pid: number;
  command: string;
}> {
  const shells = ['zsh', 'bash', 'sh', 'tcsh', 'csh', 'ksh', 'fish', 'dash'];
  let currentPid = process.pid;

  for (let i = 0; i < MAX_TRAVERSAL_DEPTH; i++) {
    try {
      const { parentPid, name } = await getProcessInfo(currentPid);

      const isShell = shells.some((shell) => name === shell);
      if (isShell) {
        // The direct parent of the shell is often a utility process (e.g. VS
        // Code's `ptyhost` process). To get the true IDE process, we need to
        // traverse one level higher to get the grandparent.
        let idePid = parentPid;
        try {
          const { parentPid: grandParentPid } = await getProcessInfo(parentPid);
          if (grandParentPid > 1) {
            idePid = grandParentPid;
          }
        } catch {
          // Ignore if getting grandparent fails, we'll just use the parent pid.
        }
        const { command } = await getProcessInfo(idePid);
        return { pid: idePid, command };
      }

      if (parentPid <= 1) {
        break; // Reached the root
      }
      currentPid = parentPid;
    } catch {
      // Process in chain died
      break;
    }
  }

  const { command } = await getProcessInfo(currentPid);
  return { pid: currentPid, command };
}

async function getProcessTreeForWindows(): Promise<
  Map<number, { parentPid: number; name: string; command: string }>
> {
  try {
    const powershellCommand =
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Depth 1';
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', powershellCommand],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const processes = JSON.parse(stdout);
    const map = new Map();

    const list = Array.isArray(processes) ? processes : [processes];

    for (const p of list) {
      map.set(p.ProcessId, {
        parentPid: p.ParentProcessId,
        name: p.Name,
        command: p.CommandLine || '',
      });
    }
    return map;
  } catch (e) {
    console.error('Failed to get process tree:', e);
    return new Map();
  }
}

/**
 * Finds the IDE process info on Windows.
 *
 * The strategy is to find the great-grandchild of the root process.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
async function getIdeProcessInfoForWindows(): Promise<{
  pid: number;
  command: string;
}> {
  const processMap = await getProcessTreeForWindows();
  let currentPid = process.pid;
  let previousPid = process.pid;

  for (let i = 0; i < MAX_TRAVERSAL_DEPTH; i++) {
    const proc = processMap.get(currentPid);
    if (!proc) break;

    const parentPid = proc.parentPid;

    if (parentPid > 0) {
      const parentProc = processMap.get(parentPid);
      if (parentProc && parentProc.parentPid === 0) {
        // We've found the grandchild of the root (`currentPid`). The IDE
        // process is its child, which we've stored in `previousPid`.
        const ideProc = processMap.get(previousPid);
        return { pid: previousPid, command: ideProc?.command || '' };
      }
    }

    if (parentPid <= 0) break;
    previousPid = currentPid;
    currentPid = parentPid;
  }

  const currentProc = processMap.get(currentPid);
  return { pid: currentPid, command: currentProc?.command || '' };
}

/**
 * Traverses up the process tree to find the process ID and command of the IDE.
 *
 * This function uses different strategies depending on the operating system
 * to identify the main application process (e.g., the main VS Code window
 * process).
 *
 * If the IDE process cannot be reliably identified, it will return the
 * top-level ancestor process ID and command as a fallback.
 *
 * @returns A promise that resolves to the PID and command of the IDE process.
 */
export async function getIdeProcessInfo(): Promise<{
  pid: number;
  command: string;
}> {
  const platform = os.platform();

  if (platform === 'win32') {
    return getIdeProcessInfoForWindows();
  }

  return getIdeProcessInfoForUnix();
}
