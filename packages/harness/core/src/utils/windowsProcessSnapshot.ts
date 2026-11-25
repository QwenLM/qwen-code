/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnAsync } from './shell-utils.js';
import { runLogger } from './runLogger.js';

export const WINDOWS_PROCESS_CALL_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 2;

export class WindowsProcessTimeoutError extends Error {
  constructor(
    readonly phase: string,
    readonly attempts: number,
  ) {
    super(
      `Windows process ${phase} timed out after ${attempts} attempt(s); cleanup is unconfirmed`,
    );
    this.name = 'WindowsProcessTimeoutError';
  }
}

export interface WindowsProcessIdentity {
  pid: number;
  parent: number;
  created: string;
}

export function selectWindowsDescendants(
  snapshot: WindowsProcessIdentity[],
  roots: number[],
): WindowsProcessIdentity[] {
  const selected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of snapshot) {
      if (!selected.has(process.pid) && selected.has(process.parent)) {
        // A parent PID may have been reused after this child was created.
        const parent = snapshot.find((entry) => entry.pid === process.parent);
        if (parent && BigInt(parent.created) > BigInt(process.created))
          continue;
        selected.add(process.pid);
        changed = true;
      }
    }
  }
  return snapshot.filter((process) => selected.has(process.pid));
}

async function powershell(
  script: string,
  phase: 'snapshot' | 'terminate',
  deadline = performance.now() + WINDOWS_PROCESS_CALL_TIMEOUT_MS * MAX_ATTEMPTS,
) {
  const executable = path.win32.join(
    process.env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(
      `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`,
      'utf16le',
    ).toString('base64'),
  ];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = performance.now();
    const timeoutMs = Math.floor(
      Math.min(WINDOWS_PROCESS_CALL_TIMEOUT_MS, deadline - started),
    );
    if (timeoutMs <= 0)
      throw new WindowsProcessTimeoutError(phase, attempt - 1);
    const controller = new AbortController();
    // Track our own timer: exit code null alone cannot distinguish timeout
    // from external termination. Do not retry permission/script failures.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await spawnAsync(executable, args, {
        windowsHide: true,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        runLogger.debug(
          `[WindowsProcess] phase=${phase}, attempt=${attempt}, elapsedMs=${Math.round(performance.now() - started)}, result=success`,
        );
        return result;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    runLogger.warn(
      `[WindowsProcess] phase=${phase}, attempt=${attempt}/${MAX_ATTEMPTS}, timeoutMs=${timeoutMs}, elapsedMs=${Math.round(performance.now() - started)}, remainingMs=${Math.max(0, Math.floor(deadline - performance.now()))}, result=timeout`,
    );
    // Termination retries use the same PID + creation-time identities, and
    // recheck them in PowerShell. They never fall back to killing a bare PID.
    if (attempt === MAX_ATTEMPTS || performance.now() >= deadline) {
      throw new WindowsProcessTimeoutError(phase, attempt);
    }
  }
  throw new WindowsProcessTimeoutError(phase, MAX_ATTEMPTS);
}

export async function readWindowsProcessSnapshot(
  deadline?: number,
): Promise<WindowsProcessIdentity[]> {
  const { stdout } = await powershell(
    `
    $items = @(Get-CimInstance Win32_Process | ForEach-Object {
      if ($_.ProcessId -gt 1 -and $null -ne $_.CreationDate) {
        @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToFileTimeUtc().ToString()}
      }
    });
    ConvertTo-Json -InputObject $items -Compress
  `,
    'snapshot',
    deadline,
  );
  const result: unknown = JSON.parse(stdout.trim());
  if (
    !Array.isArray(result) ||
    !result.every(
      (entry) =>
        entry &&
        Number.isSafeInteger(entry.pid) &&
        entry.pid > 1 &&
        Number.isSafeInteger(entry.parent) &&
        entry.parent >= 0 &&
        typeof entry.created === 'string' &&
        /^\d+$/.test(entry.created),
    )
  )
    throw new Error('Cannot verify Windows process identities');
  return result as WindowsProcessIdentity[];
}

/** Hold process handles through cmdlet termination; the short-lived helper owns them. */
export async function terminateWindowsProcesses(
  processes: WindowsProcessIdentity[],
  deadline?: number,
): Promise<void> {
  if (!processes.length) return;
  // Only validated numeric values enter the script, never command text or paths.
  const identities = processes
    .map(({ pid, created }) => {
      if (!Number.isSafeInteger(pid) || pid <= 1 || !/^\d+$/.test(created)) {
        throw new Error('Invalid Windows termination identity');
      }
      return `@{pid=${pid};created='${created}'}`;
    })
    .join(',');
  await powershell(
    `
    try {
    $heldProcesses = @()
    foreach ($entry in @(${identities})) {
      $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
      if ($null -eq $process) { continue }
      try { $null = $process.Handle } catch {
        if ($process.HasExited) { continue }; throw
      }
      $heldProcesses += $process
      $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $entry.pid)
      if ($null -ne $current -and $current.CreationDate.ToFileTimeUtc().ToString() -eq $entry.created) {
        try {
          if (-not $process.HasExited) {
            Stop-Process -InputObject $process -Force -ErrorAction Stop
          }
        } catch { if (-not $process.HasExited) { throw } }
      }
    }
    } catch {
      Write-Error -ErrorRecord $_ -ErrorAction Continue
      exit 1
    }
    # A missing PID is success even if Get-Process left $? false.
    exit 0
  `,
    'terminate',
    deadline,
  );
}
