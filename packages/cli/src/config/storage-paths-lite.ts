/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';

// Keep this literal in sync with core's QWEN_DIR. This lite module must not
// import @qwen-code/qwen-code-core because it runs before serve listener ready.
export const SETTINGS_DIRECTORY_NAME = '.qwen';

export function resolveConfigPathLite(dir: string, cwd?: string): string {
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
    resolved = path.resolve(cwd || process.cwd(), resolved);
  }
  return resolved;
}

/**
 * Reads a variable from `env` as a process spawned with that environment
 * sees it, for an environment of string values. On Windows, names are
 * case-insensitive, and of several spellings of one name only the first in
 * sorted order is passed on, as Node's spawn does.
 */
export function readEnvironmentVariable(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  if (env === process.env || os.platform() !== 'win32') {
    return env[name];
  }
  const upperName = name.toUpperCase();
  const keys: string[] = [];
  for (const key in env) keys.push(key);
  const passed = keys
    .sort()
    .find((candidate) => candidate.toUpperCase() === upperName);
  return passed === undefined ? undefined : env[passed];
}

/**
 * Whether a path names one place for every process. On Windows, `\x` and
 * `/x` take the drive of the working directory and `C:x` its directory on
 * that drive; only a drive root or a UNC path with a server and a share does.
 */
export function isFullyQualifiedPath(location: string): boolean {
  return os.platform() === 'win32'
    ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(location)
    : path.isAbsolute(location);
}

export function getGlobalQwenDirLite(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const envDir = readEnvironmentVariable(env, 'QWEN_HOME');
  if (envDir) {
    return resolveConfigPathLite(envDir);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), SETTINGS_DIRECTORY_NAME);
  }
  return path.join(homeDir, SETTINGS_DIRECTORY_NAME);
}

export function getSystemSettingsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const configured = readEnvironmentVariable(
    env,
    'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  );
  if (configured) {
    return configured;
  }
  if (os.platform() === 'darwin') {
    return '/Library/Application Support/QwenCode/settings.json';
  }
  if (os.platform() === 'win32') {
    return 'C:\\ProgramData\\qwen-code\\settings.json';
  }
  return '/etc/qwen-code/settings.json';
}

export function getSystemDefaultsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const configured = readEnvironmentVariable(
    env,
    'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
  );
  if (configured) {
    return configured;
  }
  return path.join(
    path.dirname(getSystemSettingsPath(env)),
    'system-defaults.json',
  );
}
