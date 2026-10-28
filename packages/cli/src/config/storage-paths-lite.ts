/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
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

/**
 * Where a system file named `fileName` lives when no override applies.
 */
function getPlatformSystemFilePath(fileName: string): string {
  if (os.platform() === 'darwin') {
    return `/Library/Application Support/QwenCode/${fileName}`;
  }
  if (os.platform() === 'win32') {
    return `C:\\ProgramData\\qwen-code\\${fileName}`;
  }
  return `/etc/qwen-code/${fileName}`;
}

// The system-wide settings directory on Windows, where the platform default
// lives and an environment override may point.
const WINDOWS_SYSTEM_SETTINGS_DIR = 'C:\\ProgramData\\qwen-code';

/**
 * Whether a Windows path stays inside the system-wide settings directory
 * once normalized: the path is case-folded and its forward slashes turned
 * into backslashes, then each `..` segment is resolved against the segments
 * that precede it, so a path such as `C:\ProgramData\qwen-code\..\..` cannot
 * be written to point outside the directory.
 */
export function isInsideWindowsSystemSettingsDir(configured: string): boolean {
  const segments: string[] = [];
  for (const segment of String(configured)
    .toLowerCase()
    .replace(/\//g, '\\')
    .split('\\')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // A `..` with no segment left to resolve against stays outside.
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments
    .join('\\')
    .startsWith(`${WINDOWS_SYSTEM_SETTINGS_DIR.toLowerCase()}\\`);
}

/**
 * Whether a path supplied by `QWEN_CODE_SYSTEM_SETTINGS_PATH` or
 * `QWEN_CODE_SYSTEM_DEFAULTS_PATH` is trusted to carry system-wide settings.
 *
 * The platform defaults sit in locations only the OS administrator can
 * write, and that boundary is what keeps system settings under administrator
 * control; an override honored unconditionally would let a process's
 * environment point the system layer at a file its user controls. So an
 * override is honored only while it names a location the operating system
 * keeps out of reach of ordinary users, and fails closed to the platform
 * default otherwise: on Unix, a regular file owned by root, checked with
 * `lstatSync` so a link to a root-owned file does not qualify; on Windows, a
 * path that stays inside the system-wide settings directory once normalized.
 */
export function isSystemSettingsPathTrusted(configured: string): boolean {
  if (os.platform() === 'win32') {
    return isInsideWindowsSystemSettingsDir(configured);
  }
  try {
    const stats = fs.lstatSync(configured);
    return stats.isFile() && stats.uid === 0;
  } catch {
    return false;
  }
}

/**
 * Whether the entry at `candidate` is an administrator-installed system
 * file, proven rather than assumed: the entry must be a root-owned
 * (`uid === 0`) file or directory, judged as itself by `lstatSync` so a
 * planted link does not qualify, and its parent directory must be a
 * root-owned directory, so the current user cannot create, replace, or
 * remove the entry. An entry whose ownership cannot be read proves nothing
 * and does not qualify.
 */
function isInstalledAdministratorFile(candidate: string): boolean {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(candidate);
  } catch {
    return false;
  }
  if (entry.uid !== 0 || (!entry.isFile() && !entry.isDirectory())) {
    return false;
  }
  try {
    const parent = fs.statSync(path.dirname(candidate));
    return parent.isDirectory() && parent.uid === 0;
  } catch {
    return false;
  }
}

/**
 * The administrator file installed at a platform default location: the
 * system settings file or, failing that, the system defaults file beside it.
 * An entry at the platform path counts only while its root ownership can be
 * proven (see `isInstalledAdministratorFile`); it is then the proof that the
 * system layers are managed and a path override must not move them
 * elsewhere. On Windows no entry counts: `C:\ProgramData` lets ordinary
 * users create subdirectories they own, and Node exposes no ACL to tell a
 * planted entry from an installed one, so an override keeps being honored
 * there.
 */
function findInstalledAdministratorFile(): string | undefined {
  if (os.platform() === 'win32') return undefined;
  const candidates = [
    getPlatformSystemFilePath('settings.json'),
    getPlatformSystemFilePath('system-defaults.json'),
  ];
  for (const candidate of candidates) {
    if (isInstalledAdministratorFile(candidate)) return candidate;
  }
  return undefined;
}

const warnedIgnoredOverrides = new Set<string>();

/**
 * The one-shot, per-variable breadcrumb for an override this resolver
 * ignored: the variable, the path it was set to, and the reason. The
 * resolver runs on every settings load, so one warning per variable per
 * process, and it runs before the debug log file is available, so
 * `console.warn` is the only channel left.
 */
function warnIgnoredOverride(name: string, message: string): void {
  if (warnedIgnoredOverrides.has(name)) return;
  warnedIgnoredOverrides.add(name);
  // eslint-disable-next-line no-console -- one-shot warning; the debug log file is not available where this resolver runs
  console.warn(message);
}

/**
 * Whether the override `name` may replace a system layer: only while no
 * administrator file is installed and the file it names is trusted (see
 * `isSystemSettingsPathTrusted`).
 */
function isSystemPathOverrideHonored(
  name: string,
  configured: string,
): boolean {
  const administratorFile = findInstalledAdministratorFile();
  if (administratorFile !== undefined) {
    warnIgnoredOverride(
      name,
      `${name} is set to ${JSON.stringify(configured)}, but administrator settings are installed at ${JSON.stringify(administratorFile)}, so the override is ignored.`,
    );
    return false;
  }
  if (!isSystemSettingsPathTrusted(configured)) {
    const reason =
      os.platform() === 'win32'
        ? `does not point inside ${WINDOWS_SYSTEM_SETTINGS_DIR}\\`
        : 'is not a regular root-owned file';
    warnIgnoredOverride(
      name,
      `${name} is set to ${JSON.stringify(configured)}, which ${reason}, so the platform default is used instead.`,
    );
    return false;
  }
  return true;
}

/**
 * The system settings file. `QWEN_CODE_SYSTEM_SETTINGS_PATH` replaces the
 * platform default only while no administrator file is installed and the
 * file it names is a root-owned regular file (Unix) or stays inside the
 * system-wide settings directory (Windows); otherwise the platform default
 * is used and a one-shot warning names the variable and the reason.
 */
export function getSystemSettingsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const configured = readEnvironmentVariable(
    env,
    'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  );
  if (
    configured &&
    isSystemPathOverrideHonored('QWEN_CODE_SYSTEM_SETTINGS_PATH', configured)
  ) {
    return configured;
  }
  return getPlatformSystemFilePath('settings.json');
}

/**
 * The system defaults file. `QWEN_CODE_SYSTEM_DEFAULTS_PATH` replaces it
 * only while no administrator file is installed and the file it names is
 * trusted. A rejected override falls back to the platform default beside the
 * platform settings file, never beside the (possibly relocated) settings
 * override, so the rejected path cannot be re-derived as the layer; with no
 * defaults override at all, the layer sits beside wherever the settings
 * layer resolved.
 */
export function getSystemDefaultsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const configured = readEnvironmentVariable(
    env,
    'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
  );
  if (
    configured &&
    isSystemPathOverrideHonored('QWEN_CODE_SYSTEM_DEFAULTS_PATH', configured)
  ) {
    return configured;
  }
  if (configured) {
    return getPlatformSystemFilePath('system-defaults.json');
  }
  return path.join(
    path.dirname(getSystemSettingsPath(env)),
    'system-defaults.json',
  );
}
