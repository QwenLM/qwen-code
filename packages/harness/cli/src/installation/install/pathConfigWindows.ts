/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PATH configuration for Windows systems.
 *
 * Reads the user-level PATH from the Windows Registry, appends the install
 * directory if not already present, writes back preserving the original
 * registry value type, and broadcasts WM_SETTINGCHANGE so new shells pick
 * up the change immediately.
 *
 * Safety guarantees:
 * - Never overwrites an existing PATH with a shorter value
 * - Preserves REG_EXPAND_SZ / REG_SZ type
 * - Refuses to write if PATH exceeds Windows limit (2047 chars)
 * - Refuses to write if existing PATH cannot be read reliably
 */

import { execFileSync } from 'node:child_process';
import { normalize } from 'node:path';
import { isInBundledMode, runLogger } from '@qwen-code/core';
import { notifyWindowsPathChange } from './windowsPathNotification.js';

import type { PathConfigResult } from './installTypes.js';
import { readWindowsRegistryPath } from './windowsRegistryPath.js';
export type { RegistryPathEntry } from './windowsRegistryPath.js';

const TAG = '[PathConfigWindows]';

export const MAX_USER_PATH_LENGTH = 2047;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure PATH on Windows by modifying the HKCU Registry.
 *
 * @param installDir - The directory to add to PATH (e.g. C:\Users\xxx\.qwen\bin\qwen)
 * @returns Result indicating what was done
 */
export async function configurePATHWindows(
  installDir: string,
  { rebroadcast = false }: { rebroadcast?: boolean } = {},
): Promise<PathConfigResult> {
  const detectedShell = 'powershell';

  try {
    // 1. Read current user PATH from registry
    const registryResult = readRegistryPath();

    // 2. Handle the "key does not exist" case — safe to create fresh
    if (registryResult === null) {
      runLogger.debug(
        `${TAG} HKCU\\Environment\\Path does not exist, creating with ${installDir}`,
      );
      writeRegistryPath(installDir, 'REG_EXPAND_SZ');
      broadcastSettingChange();
      return {
        modified: true,
        detectedShell,
        method: 'registry',
      };
    }

    // 3. Refuse to operate on empty PATH value (abnormal state — avoid overwriting)
    if (registryResult.value.trim() === '') {
      runLogger.debug(
        `${TAG} Registry PATH exists but is empty — refusing to modify (safety guard)`,
      );
      return {
        modified: false,
        skipReason: 'error',
        detectedShell,
        errorMessage:
          'Registry PATH value is empty. Add the install directory to your PATH manually to avoid data loss.',
      };
    }

    // 4. Check if already present (case-insensitive, normalized)
    const normalizedInstallDir = normalize(installDir).toLowerCase();
    const pathEntries = registryResult.value
      .split(';')
      .map((p) => normalize(p.trim()).toLowerCase())
      .filter((p) => p.length > 0);

    if (pathEntries.includes(normalizedInstallDir)) {
      runLogger.debug(`${TAG} ${installDir} already on user PATH`);
      if (rebroadcast) broadcastSettingChange();
      return {
        modified: false,
        skipReason: 'runtime_path_exists',
        detectedShell,
      };
    }

    // 5. Append install dir to the end
    const newPath = registryResult.value + ';' + installDir;

    // 6. Check length limit
    if (newPath.length > MAX_USER_PATH_LENGTH) {
      const errMsg = `PATH too long after adding ${installDir} (${newPath.length} chars, max ${MAX_USER_PATH_LENGTH}). Please manually clean up your PATH.`;
      runLogger.debug(`${TAG} ${errMsg}`);
      return {
        modified: false,
        skipReason: 'error',
        detectedShell,
        errorMessage: errMsg,
      };
    }

    // 7. Write to registry, preserving original type
    writeRegistryPath(newPath, registryResult.type);

    // 8. Broadcast WM_SETTINGCHANGE
    broadcastSettingChange();

    runLogger.debug(`${TAG} PATH updated in registry`);

    return {
      modified: true,
      detectedShell,
      method: 'registry',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    runLogger.debug(`${TAG} Failed to configure PATH: ${errMsg}`);
    return {
      modified: false,
      skipReason: 'error',
      detectedShell,
      errorMessage: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

// reg.exe can exceed the timeout on the very first install: the machine is
// busy (AV/EDR scanning the freshly written .exe, installer disk IO) and the
// registry hive may be cold. It succeeds on a quiet retry — so retry a couple
// of times with backoff before giving up rather than bumping a single timeout.
const REG_RETRY_BACKOFF_MS = [500, 1500];
const REG_MAX_ATTEMPTS = REG_RETRY_BACKOFF_MS.length + 1;

function isTransientExecError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ETIMEDOUT' || err.message.includes('ETIMEDOUT');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run reg.exe directly (never via cmd.exe), retrying on transient timeouts.
 * Non-timeout failures (e.g. exit code 1 for a missing key) throw immediately
 * so callers can handle them without incurring retry latency.
 */
function execReg(args: string[], timeout: number): void {
  for (let attempt = 0; attempt < REG_MAX_ATTEMPTS; attempt++) {
    try {
      execFileSync('reg.exe', args, {
        timeout,
        // Registry data is read only from the Unicode export file. Native text
        // stdout is code-page dependent and must never become PATH input.
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch (err) {
      const backoff = REG_RETRY_BACKOFF_MS[attempt];
      // No backoff entry left means this was the final attempt.
      if (!isTransientExecError(err) || backoff === undefined) {
        throw err;
      }
      runLogger.debug(
        `${TAG} reg.exe timed out (attempt ${attempt + 1}/${REG_MAX_ATTEMPTS}), retrying in ${backoff}ms`,
      );
      sleepSync(backoff);
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error('reg.exe exhausted retries');
}

/**
 * Read the user-level PATH from HKCU\Environment.
 *
 * Returns:
 * - { value, type } on success
 * - null if the Path key does not exist (not an error — can be created)
 * - throws on unexpected read failures (caller should refuse to modify)
 */
export function readRegistryPath() {
  return readWindowsRegistryPath((args) => execReg(args, 10_000));
}

/**
 * Write the user-level PATH to HKCU\Environment.
 * Preserves the specified registry value type (REG_EXPAND_SZ or REG_SZ).
 */
export function writeRegistryPath(
  newPath: string,
  regType: string = 'REG_EXPAND_SZ',
): void {
  // Use REG_EXPAND_SZ as default — PATH typically needs %variable% expansion
  const safeType =
    regType === 'REG_SZ' || regType === 'REG_EXPAND_SZ'
      ? regType
      : 'REG_EXPAND_SZ';

  execReg(
    [
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      safeType,
      '/d',
      newPath,
      '/f',
    ],
    10_000,
  );
}

/**
 * Notify Windows that user environment settings changed.
 *
 * Avoid PowerShell Add-Type/PInvoke here: locked-down enterprise machines can
 * run PowerShell in Constrained Language Mode, where Add-Type is blocked and
 * emits CLIXML error records into installer output.
 */
export function broadcastSettingChange(): void {
  if (isInBundledMode()) {
    try {
      notifyWindowsPathChange();
      return;
    } catch (err) {
      runLogger.debug(
        `${TAG} Native environment broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Keep the existing notification path for Node/SEA and as a Bun fallback.
  try {
    execFileSync(
      'rundll32.exe',
      ['user32.dll,UpdatePerUserSystemParameters', '1,', 'True'],
      {
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
  } catch (err) {
    // Non-fatal — the PATH change is persisted, just won't apply to
    // already-running shells until next login.
    runLogger.debug(
      `${TAG} WM_SETTINGCHANGE broadcast failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
