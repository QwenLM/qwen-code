/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows-specific path conversion and shell setup utilities.
 *
 * On Windows, Git Bash (MSYS2) uses POSIX-style paths (e.g., `/c/Users/foo`)
 * while Node.js uses native Windows paths (e.g., `C:\Users\foo`). This module
 * provides bidirectional conversion between the two formats, and ensures the
 * correct shell binary is found and configured at startup.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { runWindowsExecutableProbe } from './windowsExecutableProbe.js';
import { raceWithAbortSignal } from './abort-race.js';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import path from 'node:path';
import { runLogger } from './runLogger.js';
import { sessionLogger } from './diagnosticLogger.js';
import { getPlatform } from './platform.js';
import { isWindowsShellScriptWrapper } from './windowsExecutable.js';
import { ENV_GIT_BASH_PATH, ENV_BASH_PATH } from '../config/brand.js';
import { BRAND_CLI_NAME } from '../config/brand.js';
import {
  findPreparedGitPath,
  getGitBashPreparationState,
} from './envprep/index.js';
import { WELL_KNOWN_BASH_PATHS } from './envprep/types.js';
import { _resetConversionCachesForTest } from './windowsPathConvert.js';

export const ENV_WINDOWS_SHELL_KIND = `${BRAND_FIXED_ENV_PREFIX}WINDOWS_SHELL_KIND`;
export const WINDOWS_SHELL_KIND_GIT_BASH = 'git-bash';

/** Prepend an absolute Windows executable's directory to a child PATH. */
export function prependWindowsExecutableDirectoryToPath(
  env: Record<string, string | undefined>,
  executable: string,
): void {
  if (!path.win32.isAbsolute(executable)) return;

  const pathKeys = Object.keys(env).filter(
    (key) => key.toUpperCase() === 'PATH',
  );
  // Child environments are assembled from lower-priority values first and
  // overrides last. Keep the last casing variant so a hook-level PATH wins
  // over an inherited Path, then remove aliases before spawning on Windows.
  const effectivePathKey = pathKeys.at(-1) ?? 'PATH';
  const currentPath = env[effectivePathKey];
  for (const pathKey of pathKeys) {
    if (pathKey !== effectivePathKey) delete env[pathKey];
  }
  const executableDirectory = path.win32.dirname(executable);
  env[effectivePathKey] = currentPath
    ? `${executableDirectory}${path.win32.delimiter}${currentPath}`
    : executableDirectory;
}

/** Ensure a Windows Bash shell runs a leading `.sh` command through Bash. */
export function normalizeWindowsBashCommand(command: string): string {
  const trimmed = command.trim();
  let executable = '';
  let index = 0;

  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === '"' || character === "'") {
      const closingQuote = trimmed.indexOf(character, index + 1);
      if (closingQuote === -1) {
        executable += trimmed.slice(index + 1);
        break;
      }
      executable += trimmed.slice(index + 1, closingQuote);
      index = closingQuote + 1;
    } else if (character === '\\' && index + 1 < trimmed.length) {
      executable += trimmed[index + 1];
      index += 2;
    } else if (/\s/.test(character)) {
      break;
    } else {
      executable += character;
      index++;
    }
  }

  return executable.endsWith('.sh') ? `bash ${command}` : command;
}

// ─── Path conversion utilities ──────────────────────────────────────────────

// The pure string conversions live in windowsPathConvert.ts: paths.ts needs
// the posix→windows direction without importing this module's logger/shell
// stack (which would close an import cycle). Re-exported so existing import
// sites stay unchanged.
export {
  windowsPathToPosixPath,
  posixPathToWindowsPath,
} from './windowsPathConvert.js';

// ─── Git Bash discovery and SHELL setup ─────────────────────────────────────

/** Relative paths to bash.exe under a Git root directory. */
const BASH_RELATIVE_PATHS = [
  path.win32.join('bin', 'bash.exe'),
  path.win32.join('usr', 'bin', 'bash.exe'),
];

/**
 * The optional-runner probe follows the conservative Git for Windows lookup:
 * an explicit override, the two standard bin paths, then `where.exe git`.
 */
const OPTIONAL_RUNNER_WELL_KNOWN_BASH_PATHS = [
  WELL_KNOWN_BASH_PATHS[0],
  WELL_KNOWN_BASH_PATHS[1],
] as const;

/** Bound the asynchronous PATH lookup used by optional command runners. */
const OPTIONAL_GIT_LOOKUP_TIMEOUT_MS = 5000;

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  '.com',
  '.exe',
  '.bat',
  '.cmd',
]);

function hasWindowsExecutableExtension(candidate: string): boolean {
  const basename = candidate
    .toLowerCase()
    .replace(/.*[\\/]/, '')
    .replace(/[. ]+$/, '');
  const extensionStart = basename.lastIndexOf('.');
  return (
    extensionStart > 0 &&
    WINDOWS_EXECUTABLE_EXTENSIONS.has(basename.slice(extensionStart))
  );
}

/** Avoid resolving a PATH executable supplied by the active workspace. */
function isInsideCurrentWorkingDirectory(candidate: string): boolean {
  const currentDirectory = path.win32.resolve(process.cwd()).toLowerCase();
  const resolvedCandidate = path.win32.resolve(candidate).toLowerCase();
  if (
    path.win32.dirname(resolvedCandidate) === currentDirectory ||
    resolvedCandidate.startsWith(`${currentDirectory}${path.win32.sep}`)
  ) {
    return true;
  }

  // Keep non-Windows test hosts on the lexical path to avoid applying POSIX
  // realpath semantics to fake drive letters.
  if (process.platform !== 'win32') return false;

  let realCurrentDirectory: string;
  try {
    realCurrentDirectory = path.win32
      .normalize(realpathSync.native(process.cwd()))
      .toLowerCase();
  } catch {
    return false;
  }

  try {
    const realCandidateDirectory = path.win32
      .normalize(
        realpathSync.native(path.win32.dirname(path.win32.resolve(candidate))),
      )
      .toLowerCase();
    return (
      realCandidateDirectory === realCurrentDirectory ||
      realCandidateDirectory.startsWith(
        `${realCurrentDirectory}${path.win32.sep}`,
      )
    );
  } catch {
    // If the workspace can be resolved but the candidate directory cannot,
    // reject it conservatively.
    return true;
  }
}

/**
 * Finds all git.exe executables on Windows.
 *
 * Returns an array of paths (may be empty). Checks GIT_HOME, common
 * install locations, and `where.exe git` — returning ALL candidates
 * so callers can try each one to derive bash.exe.
 */
function findKnownGitExecutables(): string[] {
  const results: string[] = [];

  // Check GIT_HOME env var first (Go: env.GetEnv("GIT_HOME"))
  const gitHome = process.env['GIT_HOME'];
  if (gitHome) {
    const gitExe = path.win32.join(gitHome, 'cmd', 'git.exe');
    if (existsSync(gitExe)) {
      results.push(gitExe);
    }
  }

  // Check common installation locations, including env-based paths
  const defaultLocations: string[] = [];

  // Use %ProgramFiles% and %ProgramFiles(x86)% env vars when available,
  // falling back to hardcoded paths (matches Go behavior)
  const programFiles = process.env['ProgramFiles'];
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  if (programFiles) {
    defaultLocations.push(
      path.win32.join(programFiles, 'Git', 'cmd', 'git.exe'),
    );
  } else {
    defaultLocations.push('C:\\Program Files\\Git\\cmd\\git.exe');
  }
  if (programFilesX86) {
    defaultLocations.push(
      path.win32.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    );
  } else {
    defaultLocations.push('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
  }

  for (const location of defaultLocations) {
    if (existsSync(location) && !results.includes(location)) {
      results.push(location);
    }
  }

  return results;
}

async function findGitExecutables(signal?: AbortSignal): Promise<string[]> {
  const results = findKnownGitExecutables();

  // Fall back to where.exe — may return multiple paths
  try {
    const result = await runWindowsExecutableProbe('git', signal);

    const paths = result.split('\r\n').filter(Boolean);
    for (const p of paths) {
      if (!results.includes(p)) {
        results.push(p);
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw error;
    }
    // git not found via where.exe
  }

  return results;
}

/** Memoized result */
let _gitBashPath: string | null = null;
/** Whether we've already completed a full system scan (avoids re-running where.exe). */
let _systemScanDone = false;
/** Positive cache whose provenance is safe for optional POSIX runners. */
let _optionalGitBashPath: string | null = null;
/** Memoized optional PATH probe, including a negative result. */
let _optionalGitBashProbe: Promise<string | null> | null = null;

/** Cache, activate as SHELL, and return a discovered bash path. */
function activateBashPath(p: string): string {
  if (isWindowsShellScriptWrapper(p)) {
    throw new Error(
      `${BRAND_CLI_NAME} cannot use the Windows shell script wrapper "${p}" as Git Bash. ` +
        'Set the Bash path to the native bash.exe executable instead.',
    );
  }
  _gitBashPath = p;
  process.env['SHELL'] = p;
  return p;
}

function activateOptionalBashPath(p: string): string {
  _optionalGitBashPath = p;
  return p;
}

/**
 * Resolve only cheap, non-fatal sources for an optional command runner.
 * Invalid overrides are ignored here: optional callers can fall back to
 * another shell and must not poison the process exit context.
 */
function resolveOptionalGitBashFromFastSources(): string | null {
  if (_optionalGitBashPath) return _optionalGitBashPath;

  const envOverride = process.env[ENV_GIT_BASH_PATH];
  if (envOverride) {
    if (
      existsSync(envOverride) &&
      !isWindowsShellScriptWrapper(envOverride)
    ) {
      return activateOptionalBashPath(envOverride);
    }
    runLogger.debug(
      `[windowsPaths] Ignoring invalid optional ${ENV_GIT_BASH_PATH} path`,
    );
  }

  for (const candidate of OPTIONAL_RUNNER_WELL_KNOWN_BASH_PATHS) {
    if (existsSync(candidate)) return activateOptionalBashPath(candidate);
  }

  const preparationState = getGitBashPreparationState();
  if (
    preparationState.status === 'succeeded' &&
    existsSync(preparationState.bashPath)
  ) {
    return activateOptionalBashPath(preparationState.bashPath);
  }

  return null;
}

/**
 * Locate Git for Windows through PATH without blocking the JavaScript thread.
 * Only paths derived from `git.exe` are accepted; a generic `where.exe bash`
 * result is never used as an optional runner.
 */
function probeGitBashViaGitExecutable(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const systemRoot =
        process.env['SYSTEMROOT'] ??
        process.env['SystemRoot'] ??
        'C:\\Windows';
      const whereExecutable = path.win32.join(
        systemRoot,
        'System32',
        'where.exe',
      );
      execFile(
        whereExecutable,
        ['git'],
        {
          encoding: 'utf8',
          timeout: OPTIONAL_GIT_LOOKUP_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            runLogger.debug(
              '[windowsPaths] Optional where.exe git lookup failed or timed out',
            );
            resolve(null);
            return;
          }

          const gitPaths = String(stdout).trim().split(/\r?\n/).filter(Boolean);
          for (const gitPath of gitPaths) {
            if (
              !existsSync(gitPath) ||
              isInsideCurrentWorkingDirectory(gitPath) ||
              !hasWindowsExecutableExtension(gitPath)
            ) {
              continue;
            }
            const gitRoot = path.win32.join(gitPath, '..', '..');
            const candidate = path.win32.join(gitRoot, 'bin', 'bash.exe');
            if (existsSync(candidate)) {
              resolve(activateOptionalBashPath(candidate));
              return;
            }

            // Match executable selection semantics: once the first safe git
            // executable is selected, do not derive Bash from later results.
            resolve(null);
            return;
          }

          resolve(null);
        },
      );
    } catch (error) {
      runLogger.debug(
        `[windowsPaths] Optional Git Bash PATH lookup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      resolve(null);
    }
  });
}

/**
 * Best-effort Git Bash discovery for optional command runners.
 *
 * The probe never exits the process, mutates diagnostic exit state, starts or
 * awaits managed preparation, performs a full synchronous installation
 * validation, or accepts a generic `bash.exe` from PATH. The only PATH lookup
 * is asynchronous, time-bounded, and memoized.
 */
export async function tryFindGitBashPathForOptionalRunner(): Promise<
  string | null
> {
  const fastPath = resolveOptionalGitBashFromFastSources();
  if (fastPath) return fastPath;

  _optionalGitBashProbe ??= probeGitBashViaGitExecutable();
  return _optionalGitBashProbe;
}

function resolveGitBashPathFromFastSources(options?: {
  includeCommonPaths?: boolean;
}): string | null {
  if (_gitBashPath) {
    runLogger.debug(`[windowsPaths] Using cached bash path: "${_gitBashPath}"`);
    return _gitBashPath;
  }

  const envOverride = process.env[ENV_GIT_BASH_PATH];
  if (envOverride) {
    if (existsSync(envOverride)) {
      if (isWindowsShellScriptWrapper(envOverride)) {
        sessionLogger.setExitContext({
          reason: 'config_error',
          exit_code: 1,
          message: `${ENV_GIT_BASH_PATH} points to a Windows shell script wrapper: "${envOverride}"`,
          source: 'windowsPaths.resolveGitBashPathFromFastSources',
        });
        throw new Error(
          `${BRAND_CLI_NAME} cannot use ${ENV_GIT_BASH_PATH} path "${envOverride}" because it is a Windows shell script wrapper.\n` +
            'Set it to the native Git Bash executable, for example:\n' +
            '  C:\\Program Files\\Git\\bin\\bash.exe',
        );
      }
      runLogger.log(
        `[windowsPaths] Found bash via ${ENV_GIT_BASH_PATH}: "${envOverride}"`,
      );
      return activateBashPath(envOverride);
    }
    sessionLogger.setExitContext({
      reason: 'config_error',
      exit_code: 1,
      message: `${ENV_GIT_BASH_PATH} is set but path does not exist: "${envOverride}"`,
      source: 'windowsPaths.resolveGitBashPathFromFastSources',
    });
    throw new Error(
      `${BRAND_CLI_NAME} was unable to find ${ENV_GIT_BASH_PATH} path "${envOverride}".\n` +
        `Set ${ENV_GIT_BASH_PATH} to a valid Git Bash executable, for example:\n` +
        '  C:\\Program Files\\Git\\bin\\bash.exe',
    );
  }

  const envCandidates: Array<[string, string | undefined]> = [
    [ENV_BASH_PATH, process.env[ENV_BASH_PATH]],
    ['GIT_BASH', process.env['GIT_BASH']],
    ['BASH_PATH', process.env['BASH_PATH']],
  ];
  for (const [name, value] of envCandidates) {
    if (value && existsSync(value)) {
      if (isWindowsShellScriptWrapper(value)) {
        runLogger.debug(
          `[windowsPaths] Ignoring ${name} Windows shell script wrapper: "${value}"`,
        );
        continue;
      }
      runLogger.log(`[windowsPaths] Found bash via ${name}: "${value}"`);
      return activateBashPath(value);
    }
  }

  if (!options?.includeCommonPaths) {
    return null;
  }

  const gitHome = process.env['GIT_HOME'];
  if (gitHome) {
    for (const rel of BASH_RELATIVE_PATHS) {
      const candidate = path.win32.join(gitHome, rel);
      if (existsSync(candidate)) {
        runLogger.log(`[windowsPaths] Found bash via GIT_HOME: "${candidate}"`);
        return activateBashPath(candidate);
      }
    }
    runLogger.debug(
      `[windowsPaths] GIT_HOME="${gitHome}" set but no bash.exe found`,
    );
  }

  for (const candidate of WELL_KNOWN_BASH_PATHS) {
    if (existsSync(candidate)) {
      runLogger.log(
        `[windowsPaths] Found bash at well-known path: "${candidate}"`,
      );
      return activateBashPath(candidate);
    }
  }

  return null;
}

/**
 * Shared logic for finding Git Bash: check cache, env override, system git.
 * Returns the bash path if found, or `null` to indicate caller should continue
 * with managed-installation / waiting logic.
 *
 * Calls `process.exit(1)` if ENV_GIT_BASH_PATH is set but the file doesn't exist.
 */
async function resolveGitBashPathFromSystem(
  signal?: AbortSignal,
): Promise<string | null> {
  const fastPath = resolveGitBashPathFromFastSources();
  if (fastPath) return fastPath;
  if (_systemScanDone) return null;

  runLogger.debug('[windowsPaths] Searching for system Git Bash...');

  // Find git.exe and derive bash.exe path — try ALL discovered git.exe
  //    locations, not just the first one. This handles the case where the
  //    first hit is a shim (scoop, chocolatey) that doesn't have bash.exe
  //    next to it, but a later one (e.g. Program Files\Git) does.
  const gitPaths = await findGitExecutables(signal);
  const fromGit = findBashNearGitExecutables(gitPaths);
  if (fromGit) return fromGit;

  const commonPath = resolveGitBashPathFromFastSources({
    includeCommonPaths: true,
  });
  if (commonPath) return commonPath;

  // Fall back to `where.exe bash` — bash.exe is in PATH but not at a
  //    well-known location (e.g. non-standard install, scoop, chocolatey).
  //    This covers the case where `where.exe bash` succeeds but all the
  //    above heuristics missed it.
  try {
    const result = await runWindowsExecutableProbe('bash', signal);

    const paths = result.split('\r\n').filter(Boolean);
    const fromPath = findBashFromPathCandidates(paths);
    if (fromPath) return fromPath;
    runLogger.debug(
      `[windowsPaths] where.exe bash returned results but none were usable: ${paths.join(', ')}`,
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw error;
    }
    runLogger.debug('[windowsPaths] where.exe bash failed or returned nothing');
  }

  runLogger.debug(
    '[windowsPaths] No system Git Bash found via env vars, well-known paths, or where.exe',
  );
  _systemScanDone = true;
  return null;
}

function findBashNearGitExecutables(gitPaths: string[]): string | null {
  for (const gitPath of gitPaths) {
    runLogger.debug(`[windowsPaths] Trying git.exe at: "${gitPath}"`);
    const gitRoot = path.win32.join(gitPath, '..', '..');
    for (const rel of BASH_RELATIVE_PATHS) {
      const candidate = path.win32.join(gitRoot, rel);
      if (existsSync(candidate)) {
        runLogger.log(`[windowsPaths] Found bash via git.exe: "${candidate}"`);
        return activateBashPath(candidate);
      }
    }
    runLogger.debug(
      `[windowsPaths] git.exe found but no bash.exe under "${path.win32.resolve(gitRoot)}"`,
    );
  }
  if (gitPaths.length === 0) {
    runLogger.debug('[windowsPaths] git.exe not found on system');
  }

  return null;
}

function findBashFromPathCandidates(paths: string[]): string | null {
  for (const candidate of paths) {
    // Only accept bash.exe that looks like Git Bash (MSYS2), not WSL bash
    // WSL bash is typically at C:\Windows\System32\bash.exe
    if (
      candidate.toLowerCase().includes('system32') ||
      candidate.toLowerCase().includes('wsl')
    ) {
      runLogger.debug(
        `[windowsPaths] Skipping WSL/System32 bash: "${candidate}"`,
      );
      continue;
    }
    if (isWindowsShellScriptWrapper(candidate)) {
      runLogger.debug(
        `[windowsPaths] Skipping Windows shell script wrapper returned by where.exe: "${candidate}"`,
      );
      continue;
    }
    if (existsSync(candidate)) {
      runLogger.log(`[windowsPaths] Found bash via where.exe: "${candidate}"`);
      return activateBashPath(candidate);
    }
  }
  return null;
}

/** Synchronous compatibility lookup without launching a blocking child. */
function findExecutablesOnPathSync(name: 'git' | 'bash'): string[] {
  // Match child_process's Windows handling of case-sensitive Worker envs.
  const envKeys = Object.keys(process.env).sort();
  const pathKey = envKeys.find((key) => key.toUpperCase() === 'PATH');
  const pathExtKey = envKeys.find((key) => key.toUpperCase() === 'PATHEXT');
  const directories = [
    process.cwd(),
    ...(process.env[pathKey ?? 'PATH'] ?? '').split(';'),
  ];
  const extensions = [
    '',
    ...(process.env[pathExtKey ?? 'PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean),
  ];
  const results: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.win32.resolve(
        directory.replace(/^"|"$/g, ''),
        `${name}${extension}`,
      );
      try {
        if (
          existsSync(candidate) &&
          statSync(candidate).isFile() &&
          !results.includes(candidate)
        ) {
          results.push(candidate);
        }
      } catch {
        // An inaccessible PATH entry must not hide later installations.
      }
    }
  }
  return results;
}

function tryResolveGitBashSync(): string | '' {
  const fastPath = resolveGitBashPathFromFastSources();
  if (fastPath) return fastPath;

  if (!_systemScanDone) {
    const fromGit = findBashNearGitExecutables([
      ...findKnownGitExecutables(),
      ...findExecutablesOnPathSync('git'),
    ]);
    if (fromGit) return fromGit;

    const commonPath = resolveGitBashPathFromFastSources({
      includeCommonPaths: true,
    });
    if (commonPath) return commonPath;

    const fromPath = findBashFromPathCandidates(
      findExecutablesOnPathSync('bash'),
    );
    if (fromPath) return fromPath;
    _systemScanDone = true;
  }

  const preparedPath = findPreparedGitPath();
  return preparedPath ? activateBashPath(preparedPath) : '';
}

/**
 * Probes for Git Bash without terminating the process when it is unavailable.
 * Capability selection uses this before deciding whether Bash or PowerShell
 * should be exposed on Windows.
 */
export function probeGitBashPathSync(): string | null {
  return tryResolveGitBashStartup() || null;
}

/**
 * Startup-only probe that intentionally avoids slow PATH scans (`where.exe`).
 * Full discovery still runs in `findGitBashPath()` the first time Bash is
 * actually needed, so shell functionality is preserved while cold startup is
 * not blocked by system executable search.
 */
function tryResolveGitBashStartup(): string | '' {
  const fastPath = resolveGitBashPathFromFastSources({
    includeCommonPaths: true,
  });
  if (fastPath) return fastPath;

  const preparedPath = findPreparedGitPath();
  if (preparedPath) return activateBashPath(preparedPath);
  return '';
}

/**
 * Finds the Git Bash binary on Windows (synchronous version).
 *
 * Searches cached/explicit/common/PATH/managed locations without spawning
 * a process. Use findGitBashPath() for cancellable asynchronous discovery.
 */
export function findGitBashPathSync(): string {
  const result = tryResolveGitBashSync();
  if (result) return result;

  const msg =
    `${BRAND_CLI_NAME} on Windows requires Git Bash to run shell commands.\n\n` +
    'Install Git for Windows: https://git-scm.com/downloads/win\n' +
    `Or set ${ENV_GIT_BASH_PATH} to your bash.exe path, for example:\n` +
    '  C:\\Program Files\\Git\\bin\\bash.exe';

  // eslint-disable-next-line no-console
  console.error('\n' + msg + '\n');
  sessionLogger.setExitContext({
    reason: 'config_error',
    exit_code: 1,
    message: 'Git Bash not found - required on Windows',
    source: 'windowsPaths.findGitBashPathSync',
  });
  process.exit(1);
}

/**
 * Finds the Git Bash binary on Windows (async version).
 *
 * Discovers installations on PATH asynchronously and can wait for a
 * background installation to complete (up to 5 minutes). This is
 * called when bash is actually needed (e.g. first shell tool execution).
 *
 * Throws an Error instead of calling process.exit() so callers
 * (e.g. hook runner) can handle the failure gracefully.
 */
export async function findGitBashPath(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const systemPath = await resolveGitBashPathFromSystem(signal);
  const result = systemPath || findPreparedGitPath();
  if (result) return activateBashPath(result);

  const state = getGitBashPreparationState();
  switch (state.status) {
    case 'running': {
      // eslint-disable-next-line no-console
      console.error(
        `\n${BRAND_CLI_NAME} is setting up Git Bash for Windows.\n` +
          'This one-time setup usually takes 1-3 minutes. The current command will wait for setup to finish.\n',
      );

      const prepResult = await raceWithAbortSignal(state.promise, signal);
      if (prepResult.ok) return activateBashPath(prepResult.bashPath);

      const msg =
        `Git Bash setup failed: ${prepResult.error}\n` +
        `${BRAND_CLI_NAME} will try automatic setup again the next time it runs. ` +
        'You can also install Git for Windows manually: https://git-scm.com/downloads/win';
      throw new Error(msg);
    }

    case 'failed': {
      throw new Error(
        `Git Bash automatic setup failed: ${state.lastError}\n` +
          `${BRAND_CLI_NAME} will try automatic setup again the next time it runs. ` +
          'You can also install Git for Windows manually: https://git-scm.com/downloads/win',
      );
    }

    case 'succeeded': {
      throw new Error(
        'The managed Git Bash installation is incomplete or corrupted.\n' +
          `${BRAND_CLI_NAME} will try to repair it the next time it runs. ` +
          'You can also install Git for Windows manually: https://git-scm.com/downloads/win',
      );
    }

    case 'idle':
    default:
      throw new Error(
        'Git Bash is not available, and automatic setup is not currently running.\n' +
          `Run ${BRAND_CLI_NAME} again to try automatic setup, or install Git for Windows manually: https://git-scm.com/downloads/win\n` +
          `If Git for Windows is already installed, set ${ENV_GIT_BASH_PATH} to your bash.exe path.`,
      );
  }
}

/**
 * On Windows, finds Git Bash and sets `process.env.SHELL` to point to it.
 * This must be called early during startup, before any shell operations.
 *
 * On non-Windows platforms, this is a no-op.
 *
 * If Git Bash is found through cheap sources (env vars, GIT_HOME, well-known
 * paths, or the managed install), SHELL is set immediately. Slower PATH scans
 * and waiting for background preparation are deferred until `findGitBashPath()`
 * is called at the point Bash is actually needed.
 * This avoids blocking TUI/headless/SDK startup on Windows process scans or a
 * multi-minute download.
 */
export async function setShellIfWindows(): Promise<void> {
  if (getPlatform() !== 'windows') return;

  runLogger.debug('[windowsPaths] Windows detected, probing Git Bash');

  const result = tryResolveGitBashStartup();
  if (result) {
    runLogger.log(`[windowsPaths] Using bash path: "${result}"`);
    return;
  }

  // No bash available yet. Do not write a bare "bash.exe" to SHELL: callers
  // may treat SHELL as an executable path. Keep only an internal hint until a
  // real path is resolved lazily by findGitBashPath().
  process.env[ENV_WINDOWS_SHELL_KIND] = WINDOWS_SHELL_KIND_GIT_BASH;
  runLogger.log(
    '[windowsPaths] Git Bash not found during startup',
  );
}

/** Reset all module-level caches. Test-only. */
export function _resetWindowsPathsForTest(): void {
  _resetConversionCachesForTest();
  _gitBashPath = null;
  _systemScanDone = false;
  _optionalGitBashPath = null;
  _optionalGitBashProbe = null;
}
