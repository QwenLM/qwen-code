/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

/**
 * Expands tilde and resolves relative paths to absolute.
 * Mirrors Storage.resolvePath() in packages/core.
 */
function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(resolved);
  }
  return resolved;
}

// Written into the XDG directory while it is the default global dir in use;
// see Storage.getGlobalQwenDir() in packages/core.
const GLOBAL_DIR_MARKER = '.qwen-global-dir';

/**
 * The global Qwen directory when QWEN_HOME is unset. Mirrors
 * Storage.getGlobalQwenDir() in packages/core.
 */
function getDefaultQwenDir(homeDir: string): string {
  const legacyDir = path.join(homeDir, '.qwen');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return legacyDir;
  }
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  const xdgDir = path.join(
    xdgConfigHome && path.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : path.join(homeDir, '.config'),
    'qwen',
  );
  return !fs.existsSync(legacyDir) ||
    fs.existsSync(path.join(xdgDir, GLOBAL_DIR_MARKER))
    ? xdgDir
    : legacyDir;
}

let envBootstrapped = false;

/**
 * Pre-resolves QWEN_HOME / QWEN_RUNTIME_DIR from the default global Qwen
 * dir's `.env` and `<homedir>/.env`. Mirrors the CLI's
 * `preResolveHomeEnvOverrides` so the companion's lock-file location agrees
 * with the CLI even when these vars are only configured via `.env`.
 * Idempotent.
 */
function bootstrapHomeEnvOverrides(): void {
  if (envBootstrapped) {
    return;
  }
  envBootstrapped = true;

  if (process.env['QWEN_HOME'] && process.env['QWEN_RUNTIME_DIR']) {
    return;
  }

  const homeDir = os.homedir();
  if (!homeDir) {
    return;
  }

  const initialQwenHome = process.env['QWEN_HOME'];
  const currentQwenDir = initialQwenHome
    ? resolvePath(initialQwenHome)
    : getDefaultQwenDir(homeDir);

  const KEYS = ['QWEN_HOME', 'QWEN_RUNTIME_DIR'] as const;
  const readInto = (file: string) => {
    try {
      const parsed = dotenv.parse(fs.readFileSync(file, 'utf-8'));
      for (const key of KEYS) {
        if (parsed[key] && !Object.hasOwn(process.env, key)) {
          process.env[key] = parsed[key];
        }
      }
    } catch {
      // Match the dotenv quiet-mode behavior used by the CLI.
    }
  };

  readInto(path.join(currentQwenDir, '.env'));
  if (!initialQwenHome) {
    readInto(path.join(homeDir, '.env'));
  }

  // If QWEN_HOME was just discovered, also read <new QWEN_HOME>/.env so
  // QWEN_RUNTIME_DIR can be sourced from there — otherwise the companion
  // would write lock files into a different runtime dir than the CLI reads.
  const discoveredQwenHome = process.env['QWEN_HOME'];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = resolvePath(discoveredQwenHome);
    if (discoveredDir !== currentQwenDir) {
      readInto(path.join(discoveredDir, '.env'));
    }
  }
}

/** Test-only: reset the bootstrap latch. */
export function resetEnvBootstrapForTesting(): void {
  envBootstrapped = false;
}

/**
 * Returns the global Qwen home directory (config, credentials, etc.).
 *
 * Priority: QWEN_HOME env var > the platform default (~/.qwen, or the XDG
 * config directory on Linux)
 */
export function getGlobalQwenDir(): string {
  bootstrapHomeEnvOverrides();
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return resolvePath(envDir);
  }
  const homeDir = os.homedir();
  return homeDir ? getDefaultQwenDir(homeDir) : path.join(os.tmpdir(), '.qwen');
}

/**
 * Returns the runtime base directory for ephemeral data (tmp, debug, IDE
 * lock files, sessions, etc.).
 *
 * Priority: QWEN_RUNTIME_DIR env var > QWEN_HOME env var > ~/.qwen
 *
 * This mirrors the fallback chain in packages/core Storage.getRuntimeBaseDir()
 * without importing from core to avoid cross-package dependencies.
 */
export function getRuntimeBaseDir(): string {
  bootstrapHomeEnvOverrides();
  const runtimeDir = process.env['QWEN_RUNTIME_DIR'];
  if (runtimeDir) {
    return resolvePath(runtimeDir);
  }
  return getGlobalQwenDir();
}
