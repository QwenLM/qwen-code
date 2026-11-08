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

/**
 * Whether a `QWEN_HOME` value expands against the home directory: `~`, or a
 * path that starts with `~/` or `~\`. Core's `Storage` applies the same rule.
 */
export function expandsAgainstHome(dir: string): boolean {
  return dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\');
}

export function resolveConfigPathLite(dir: string, cwd?: string): string {
  let resolved = dir;
  if (expandsAgainstHome(resolved)) {
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
 * The variables Node's spawn passes on from `env` to a process, under the
 * names the process receives them by: every enumerable key, inherited ones
 * included, whose value is not `undefined`, as a string. On Windows, names
 * are case-insensitive, and of several spellings of one name only the first
 * in sorted order is passed on, and only if it has a value. Spawn may add a
 * few variables of its own, such as `NODE_V8_COVERAGE`, and on Windows the
 * ones libuv requires. Throws for an environment the process would not
 * receive as it is: a missing one, for which spawn passes on its own; a
 * variable that cannot be read, a Symbol value, or a NUL byte in a string,
 * which spawn refuses; a NUL byte in another value, which cuts the variable
 * short; and a name that contains `=`, which the process receives as another
 * name, except at the start of a Windows name such as `=C:`. An error about a
 * variable names it and leaves its value out.
 */
export function passedEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  if (!env) throw new TypeError('There is no environment to pass on.');
  const keys: string[] = [];
  for (const key in env) keys.push(key);
  const windows = os.platform() === 'win32';
  const spellings = new Set<string>();
  const passed: Record<string, string> = Object.create(null);
  for (const key of windows ? keys.sort() : keys) {
    if (windows) {
      const upperKey = key.toUpperCase();
      if (spellings.has(upperKey)) continue;
      spellings.add(upperKey);
    }
    let text: string;
    try {
      const value = env[key];
      if (value === undefined) continue;
      // A template literal throws for a Symbol, as spawn does.
      text = `${value}`;
    } catch (error) {
      throw new TypeError(
        `The environment variable ${JSON.stringify(key)} cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    // Windows names such as `=C:` start with `=`.
    if (
      key.indexOf('=', windows ? 1 : 0) !== -1 ||
      key.includes('\0') ||
      text.includes('\0')
    ) {
      throw new TypeError(
        `The environment variable ${JSON.stringify(key)} cannot be passed on as it is.`,
      );
    }
    passed[key] = text;
  }
  return passed;
}

/**
 * Reads a variable from `env` as a process spawned with it sees the variable
 * in its own `process.env`, which on Windows looks names up
 * case-insensitively. For `process.env` itself, it reads the current
 * process's own value, which differs from what a spawned process sees only for
 * a name like an array index, such as `0`. Given another environment, it
 * throws where `passedEnvironment` does, even for another variable, and so do
 * the path helpers below.
 */
export function readEnvironmentVariable(
  env: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  if (env === process.env) return env[name];
  return spawnedEnvironmentView(env)[name];
}

/**
 * The environment a process spawned with `env` sees in its own
 * `process.env`, as a record to look names up in. Its keys are the names that
 * are passed on, except names like an array index, such as `0`, for which
 * `process.env` returns nothing. On Windows, a lookup or an `in` test by any
 * spelling finds the variable. Throws where `passedEnvironment` does.
 */
export function spawnedEnvironmentView(
  env: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const passed = passedEnvironment(env);
  for (const name in passed) {
    if (/^(?:0|[1-9]\d*)$/.test(name) && Number(name) < 2 ** 32 - 1) {
      delete passed[name];
    }
  }
  if (os.platform() !== 'win32') return passed;
  const byUpperName = new Map(
    Object.entries(passed).map(([name, value]) => [name.toUpperCase(), value]),
  );
  return new Proxy(passed, {
    has: (_target, name) =>
      typeof name === 'string' && byUpperName.has(name.toUpperCase()),
    get: (_target, name) =>
      typeof name === 'string'
        ? byUpperName.get(name.toUpperCase())
        : undefined,
  });
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
