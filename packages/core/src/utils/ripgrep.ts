/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ripgrep binary management and execution utilities.
 *
 * This module provides a unified interface for running ripgrep (rg) searches,
 * handling binary discovery, process spawning, timeout management, and error handling.
 *
 * Supports system rg discovery, embedded binary, timeout, and streaming.
 */

import type { ChildProcess, ExecFileException } from 'node:child_process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runLogger } from './runLogger.js';
import { getPlatform } from './platform.js';
import { isInBundledMode } from './bundledMode.js';
import {
  ENV_CLI_GLOB_TIMEOUT_SECONDS,
  BRAND_NPM_PACKAGE,
} from '../config/brand.js';
import { execFileNoThrow } from './execFileNoThrow.js';
import { getBunNativesRuntimeDir } from '../bootstrap/bunNativesBootstrap.js';



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../../'); // from dist/src/utils/ -> dist/
const requireFromBundle = createRequire(import.meta.url);

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type RipgrepConfig = {
  mode: 'system' | 'builtin' | 'embedded';
  command: string;
  args: string[];
  argv0?: string;
};

// -----------------------------------------------------------------------------
// Ripgrep binary discovery
// -----------------------------------------------------------------------------

/**
 * Find system ripgrep binary using which/where command.
 */
function findSystemRg(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['rg'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
      windowsHide: true,
    }).trim();
    return result ? result.split('\n')[0].trim() : null;
  } catch {
    return null;
  }
}

const NPM_RIPGREP_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

export function getNpmRipgrepPackageName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (!NPM_RIPGREP_TARGETS.has(`${platform}-${arch}`)) {
    return null;
  }
  return `${BRAND_NPM_PACKAGE}-ripgrep-${platform}-${arch}`;
}

export function resolveNpmRipgrepBinary(
  platform: string = process.platform,
  arch: string = process.arch,
  resolvePackage: (specifier: string) => string = (specifier) =>
    requireFromBundle.resolve(specifier),
  fileExists: (filePath: string) => boolean = existsSync,
): string | null {
  const packageName = getNpmRipgrepPackageName(platform, arch);
  if (!packageName) {
    return null;
  }

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';
  try {
    const command = resolvePackage(`${packageName}/bin/${binaryName}`);
    return fileExists(command) ? command : null;
  } catch {
    return null;
  }
}

// Memoized ripgrep config
let _ripgrepConfig: RipgrepConfig | null = null;

/**
 * Get the ripgrep configuration, memoized for performance.
 *
 * Resolution order:
 * 1. System rg (found in PATH) — unless USE_BUILTIN_RIPGREP is set
 * 2. Embedded rg (Bun bundled mode — rg compiled into the executable)
 * 3. Vendor binary at vendor/ripgrep/${arch}-${platform}/rg
 * 4. Platform-specific npm optional dependency
 * 5. Fallback to system rg if no bundled binary exists
 */
function getRipgrepConfig(): RipgrepConfig {
  if (_ripgrepConfig) {
    return _ripgrepConfig;
  }

  const resolveSystemRipgrep = (): RipgrepConfig | null => {
    const systemPath = findSystemRg();
    if (systemPath) {
      // SECURITY: Use command name 'rg' instead of systemPath to prevent PATH hijacking
      // If we used systemPath, a malicious ./rg.exe in current directory could be executed
      // Using just 'rg' lets the OS resolve it safely with NoDefaultCurrentDirectoryInExePath protection
      return { mode: 'system', command: 'rg', args: [] };
    }
    return null;
  };

  // Check if user explicitly wants builtin ripgrep
  const useBuiltinRipgrep = process.env['USE_BUILTIN_RIPGREP'];
  const userWantsSystemRipgrep =
    useBuiltinRipgrep === undefined ||
    useBuiltinRipgrep === '' ||
    useBuiltinRipgrep === '0' ||
    useBuiltinRipgrep?.toLowerCase() === 'false';

  // Try system ripgrep first if user wants it
  if (userWantsSystemRipgrep) {
    const systemConfig = resolveSystemRipgrep();
    if (systemConfig) {
      _ripgrepConfig = systemConfig;
      return _ripgrepConfig;
    }
  }

  // In bundled (native) mode, bunNativesBootstrap extracts the vendored rg
  // binary into $TMPDIR/<cli>-natives-.../vendor/ripgrep/<arch>-<os>/rg.
  // Earlier versions here tried `spawn(process.execPath, ..., { argv0: 'rg' })`
  // assuming a bun-internal rg would trigger — it doesn't: `bun build --compile`
  // doesn't bake a multicall ripgrep into user binaries, so the spawn fell
  // through to our own entrypoint and yargs choked on `--files` / `--hidden`.
  if (isInBundledMode()) {
    const runtimeDir = getBunNativesRuntimeDir();
    if (runtimeDir) {
      const archDir = `${process.arch}-${process.platform}`;
      const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
      const extractedRg = path.resolve(
        runtimeDir,
        'vendor',
        'ripgrep',
        archDir,
        rgBinaryName,
      );
      if (existsSync(extractedRg)) {
        _ripgrepConfig = { mode: 'builtin', command: extractedRg, args: [] };
        return _ripgrepConfig;
      }
    }
    // Fall through: user may still have a system rg on PATH.
  }

  // Try vendor binary
  const rgRoot = path.resolve(packageRoot, 'vendor', 'ripgrep');
  const rgBinaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const archDir = `${process.arch}-${process.platform}`;
  const command = path.resolve(rgRoot, archDir, rgBinaryName);

  if (!existsSync(command)) {
    // In SEA binary mode, the runtime directory is flat (__dirname = runtime dir).
    // Vendor files are extracted alongside the bundle chunks.
    const seaVendorCommand = path.resolve(
      __dirname,
      'vendor',
      'ripgrep',
      archDir,
      rgBinaryName,
    );
    if (existsSync(seaVendorCommand)) {
      _ripgrepConfig = { mode: 'builtin', command: seaVendorCommand, args: [] };
      return _ripgrepConfig;
    }

    const npmRipgrepCommand = resolveNpmRipgrepBinary();
    if (npmRipgrepCommand) {
      _ripgrepConfig = {
        mode: 'builtin',
        command: npmRipgrepCommand,
        args: [],
      };
      return _ripgrepConfig;
    }

    // Vendor binary missing; fall back to system rg
    const systemConfig = resolveSystemRipgrep();
    if (systemConfig) {
      runLogger.log(
        `Bundled ripgrep missing at ${command}; falling back to system rg`,
      );
      _ripgrepConfig = systemConfig;
      return _ripgrepConfig;
    }

    // No ripgrep found anywhere — use 'rg' command name as last resort.
    // This will produce a clear ENOENT error at runtime rather than silently
    // pointing to a non-existent vendor path.
    runLogger.warn(
      `Ripgrep not found: vendor path ${command} does not exist, ` +
        `SEA path ${seaVendorCommand} does not exist, npm package ` +
        `${getNpmRipgrepPackageName() ?? 'for this platform'} is unavailable, ` +
        `and no system rg is in PATH. Glob/Grep tools will not work. ` +
        `Reinstall without omitting optional dependencies, or install ripgrep: ` +
        `https://github.com/BurntSushi/ripgrep#installation`,
    );
    _ripgrepConfig = { mode: 'system', command: 'rg', args: [] };
    return _ripgrepConfig;
  }

  _ripgrepConfig = { mode: 'builtin', command, args: [] };
  return _ripgrepConfig;
}

/**
 * Get the ripgrep command path, default arguments, and optional argv0.
 *
 * When `argv0` is present (embedded mode), callers should use `spawn()` with
 * `{ argv0 }` instead of `execFile()`.
 */
export function ripgrepCommand(): {
  rgPath: string;
  rgArgs: string[];
  argv0?: string;
} {
  const config = getRipgrepConfig();
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  };
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 20_000_000; // 20MB; large monorepos can have 200k+ files

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

/**
 * Check if an error is EAGAIN (resource temporarily unavailable).
 * This happens in resource-constrained environments (Docker, CI) when
 * ripgrep tries to spawn too many threads.
 */
function isEagainError(stderr: string): boolean {
  return (
    stderr.includes('os error 11') ||
    stderr.includes('Resource temporarily unavailable')
  );
}

/**
 * Custom error class for ripgrep timeouts.
 * This allows callers to distinguish between "no matches" and "timed out".
 */
export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    readonly partialResults: string[],
  ) {
    super(message);
    this.name = 'RipgrepTimeoutError';
  }
}

// -----------------------------------------------------------------------------
// macOS codesigning
// -----------------------------------------------------------------------------

let alreadyDoneSignCheck = false;

/**
 * On macOS, vendor-shipped ripgrep binaries may only have a linker signature,
 * which triggers Gatekeeper dialogs on first run. This function:
 * 1. Checks if the vendor binary needs re-signing (linker-signed)
 * 2. Re-signs with an ad-hoc signature (`--sign -`)
 * 3. Removes the quarantine extended attribute
 *
 * Only runs once, only for `mode: 'builtin'` on macOS.
 */
async function codesignRipgrepIfNecessary(): Promise<void> {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return;
  }

  alreadyDoneSignCheck = true;

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig();
  if (config.mode !== 'builtin') {
    return;
  }
  const builtinPath = config.command;

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n');

  const needsSigned = lines.find((line) => line.includes('linker-signed'));
  if (!needsSigned) {
    return;
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ]);

    if (signResult.code !== 0) {
      runLogger.warn(
        `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
      );
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ]);

    if (quarantineResult.code !== 0) {
      runLogger.warn(
        `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
      );
    }
  } catch (e) {
    runLogger.warn('codesign error', e);
  }
}

// -----------------------------------------------------------------------------
// First-use test
// -----------------------------------------------------------------------------

// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean;
  lastTested: number;
  config: RipgrepConfig;
} | null = null;

let _firstUseTestDone = false;

/**
 * Test ripgrep availability on first use and cache the result.
 * Fire-and-forget: callers should `void testRipgrepOnFirstUse().catch(...)`.
 */
async function testRipgrepOnFirstUse(): Promise<void> {
  if (_firstUseTestDone || ripgrepStatus !== null) {
    return;
  }
  _firstUseTestDone = true;

  const config = getRipgrepConfig();

  try {
    const test = await execFileNoThrow(
      config.command,
      [...config.args, '--version'],
      { timeout: 5000 },
    );

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ');

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
    };

    runLogger.log(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    );
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
    };
    runLogger.warn('Ripgrep first use test error', error);
  }
}

/**
 * Get ripgrep status and configuration info.
 * Returns current configuration immediately, with working status if available.
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'builtin' | 'embedded';
  path: string;
  working: boolean | null; // null if not yet tested
} {
  const config = getRipgrepConfig();
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
  };
}

// -----------------------------------------------------------------------------
// Ripgrep execution — raw
// -----------------------------------------------------------------------------

/**
 * Low-level ripgrep execution.
 *
 * When `argv0` is set (embedded mode), uses `spawn()` with manual stdout/stderr
 * buffering and SIGTERM→SIGKILL timeout escalation. Otherwise uses `execFile()`.
 *
 * @param args - ripgrep arguments
 * @param target - target path to search
 * @param abortSignal - optional abort signal for cancellation
 * @param callback - callback for result handling
 * @param singleThread - force single-threaded mode (-j 1) for retry
 */
function ripGrepRaw(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
  singleThread = false,
  cwd?: string,
): ChildProcess {
  const { rgPath, rgArgs, argv0 } = ripgrepCommand();

  // Use single-threaded mode only if explicitly requested for this call's retry
  const threadArgs = singleThread ? ['-j', '1'] : [];
  const fullArgs = [...rgArgs, ...threadArgs, ...args, target];

  // Allow timeout to be configured via env var (in seconds), otherwise use platform defaults.
  // WSL has severe performance penalty for file reads (3-5x slower on WSL2).
  const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000;
  const parsedSeconds = parseInt(
    process.env[ENV_CLI_GLOB_TIMEOUT_SECONDS] || '',
    10,
  );
  const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout;
  // For embedded ripgrep, use spawn with argv0 (execFile doesn't support argv0 properly)
  if (argv0) {
    const child = spawn(rgPath, fullArgs, {
      argv0,
      cwd,
      signal: abortSignal,
      // Prevent visible console window on Windows (no-op on other platforms)
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString();
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE);
          stdoutTruncated = true;
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString();
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE);
          stderrTruncated = true;
        }
      }
    });

    // Set up timeout with SIGKILL escalation.
    // SIGTERM alone may not kill ripgrep if it's blocked in uninterruptible I/O
    // (e.g., deep filesystem traversal). If SIGTERM doesn't work within 5 seconds,
    // escalate to SIGKILL which cannot be caught or ignored.
    // On Windows, child.kill('SIGTERM') throws; use default signal.
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill();
      } else {
        child.kill('SIGTERM');
        killTimeoutId = setTimeout((c) => c.kill('SIGKILL'), 5_000, child);
      }
    }, timeout);

    // On Windows, both 'close' and 'error' can fire for the same process
    // (e.g. when AbortSignal kills the child). Guard against double-callback.
    let settled = false;
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(killTimeoutId);
      if (code === 0 || code === 1) {
        // 0 = matches found, 1 = no matches (both are success)
        callback(null, stdout, stderr);
      } else {
        const error: ExecFileException = new Error(
          `ripgrep exited with code ${code}`,
        );
        error.code = code ?? undefined;
        error.signal = signal ?? undefined;
        callback(error, stdout, stderr);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(killTimeoutId);
      const error: ExecFileException = err;
      callback(error, stdout, stderr);
    });

    return child;
  }

  // For non-embedded ripgrep, use execFile
  // Use SIGKILL as killSignal because SIGTERM may not terminate ripgrep
  // when it's blocked in uninterruptible filesystem I/O.
  // On Windows, SIGKILL throws; use default (undefined) which sends SIGTERM.
  const child = execFile(
    rgPath,
    fullArgs,
    {
      cwd,
      maxBuffer: MAX_BUFFER_SIZE,
      signal: abortSignal,
      timeout,
      killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
      encoding: 'utf8',
    },
    callback,
  );
  return child;
}

// -----------------------------------------------------------------------------
// Ripgrep execution — public API
// -----------------------------------------------------------------------------

/**
 * Execute a ripgrep search and return the results.
 *
 * This is the main public API for ripgrep execution.
 *
 * @param args - ripgrep arguments
 * @param target - target path to search
 * @param abortSignal - optional abort signal for cancellation
 * @returns Promise resolving to array of result lines
 * @throws RipgrepTimeoutError if the search times out with no results
 * @throws Error for critical errors (ENOENT, EACCES, EPERM)
 */
export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  options: {
    /** Preserve raw output, using this record boundary to discard partial tails. */
    outputDelimiter?: '\n' | '\0';
    rejectOnInputError?: boolean;
    cwd?: string;
    onPartialResults?: () => void;
  } = {},
): Promise<string[]> {
  await codesignRipgrepIfNecessary();

  // Test ripgrep on first use and cache the result (fire and forget)
  void testRipgrepOnFirstUse().catch((error) => {
    runLogger.warn('Ripgrep first use test failed', error);
  });

  const splitOutput = (stdout: string, truncated = false): string[] => {
    if (options.outputDelimiter !== undefined) {
      const complete = truncated
        ? stdout.slice(0, stdout.lastIndexOf(options.outputDelimiter) + 1)
        : stdout;
      return complete === '' ? [] : complete.split('\n');
    }
    const lines = stdout
      .trim()
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean);
    return truncated ? lines.slice(0, -1) : lines;
  };

  return new Promise((resolve, reject) => {
    const handleResult = (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
      isRetry: boolean,
    ): void => {
      // Success case
      if (!error) {
        resolve(splitOutput(stdout));
        return;
      }

      // Exit code 1 is normal "no matches"
      if (error.code === 1) {
        resolve([]);
        return;
      }

      // Critical errors that indicate ripgrep is broken, not "no matches"
      // These should be surfaced to the user rather than silently returning empty results
      const CRITICAL_ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM'];
      if (
        typeof error.code === 'string' &&
        CRITICAL_ERROR_CODES.includes(error.code)
      ) {
        reject(error);
        return;
      }

      // If we hit EAGAIN and haven't retried yet, retry with single-threaded mode
      // Note: We only use -j 1 for this specific retry, not for future calls.
      // Persisting single-threaded mode globally caused timeouts on large repos
      // where EAGAIN was just a transient startup error.
      if (!isRetry && isEagainError(stderr)) {
        runLogger.log(
          'rg EAGAIN error detected, retrying with single-threaded mode (-j 1)',
        );
        ripGrepRaw(
          args,
          target,
          abortSignal,
          (retryError, retryStdout, retryStderr) => {
            handleResult(retryError, retryStdout, retryStderr, true);
          },
          true, // Force single-threaded mode for this retry only
          options.cwd,
        );
        return;
      }

      // For all other errors, try to return partial results if available
      const hasOutput = stdout && stdout.trim().length > 0;
      const isTimeout =
        error.signal === 'SIGTERM' ||
        error.signal === 'SIGKILL' ||
        error.code === 'ABORT_ERR';
      const isBufferOverflow =
        error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

      const lines = hasOutput
        ? splitOutput(stdout, isTimeout || isBufferOverflow)
        : [];

      if (options.rejectOnInputError && error.code === 2 && !hasOutput) {
        reject(
          new Error(
            `Search failed: ripgrep rejected the search input.\n${stderr.trim().slice(0, 2000)}`,
          ),
        );
        return;
      }

      runLogger.log(
        `rg error (signal=${error.signal}, code=${error.code}, stderr: ${stderr}), ${lines.length} results`,
      );

      // code 2 = ripgrep usage error; ABORT_ERR = caller explicitly aborted
      // (not an error, just a cancellation — interactive callers may abort on
      // every keystroke-after-debounce). Don't log these.
      if (error.code !== 2 && error.code !== 'ABORT_ERR') {
        runLogger.warn('ripgrep error', error);
      }

      // If we timed out with no results, throw an error so caller knows the search
      // didn't complete rather than thinking there were no matches
      if (isTimeout && lines.length === 0) {
        reject(
          new RipgrepTimeoutError(
            `Ripgrep search timed out after ${getPlatform() === 'wsl' ? 60 : 20} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
            lines,
          ),
        );
        return;
      }

      options.onPartialResults?.();
      resolve(lines);
    };

    ripGrepRaw(
      args,
      target,
      abortSignal,
      (error, stdout, stderr) => {
        handleResult(error, stdout, stderr, false);
      },
      false,
      options.cwd,
    );
  });
}

// -----------------------------------------------------------------------------
// Streaming APIs
// -----------------------------------------------------------------------------

/**
 * Stream lines from ripgrep as they arrive, calling `onLines` per stdout chunk.
 *
 * Unlike `ripGrep()` which buffers the entire stdout, this flushes complete
 * lines as soon as each chunk arrives — first results paint while rg is still
 * walking the tree (the fzf `change:reload` pattern). Partial trailing lines
 * are carried across chunk boundaries.
 *
 * Callers that want to stop early (e.g. after N matches) should abort the
 * signal — spawn's signal option kills rg. No EAGAIN retry, no internal
 * timeout. Exit code 2 preserves usable output from partially readable trees;
 * other failures and cancellation still reject.
 */
export async function ripGrepStream(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
  onLines: (lines: string[]) => void,
): Promise<void> {
  await codesignRipgrepIfNecessary();
  const { rgPath, rgArgs, argv0 } = ripgrepCommand();

  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, [...rgArgs, ...args, target], {
      argv0,
      signal: abortSignal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
    let remainder = '';
    let lineCount = 0;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 2000);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const data = remainder + chunk.toString();
      const lines = data.split('\n');
      remainder = lines.pop() ?? '';
      lineCount += lines.length;
      if (lines.length) onLines(lines.map(stripCR));
    });

    // On Windows, both 'close' and 'error' can fire for the same process.
    let settled = false;
    child.on('close', (code) => {
      if (settled) return;
      // Abort races close — don't flush a torn tail from a killed process.
      // Promise still settles: spawn's signal option fires 'error' with
      // AbortError → reject below.
      if (abortSignal.aborted) return;
      settled = true;
      if (code === 0 || code === 1 || code === 2) {
        if (remainder) {
          onLines([stripCR(remainder)]);
          lineCount++;
        }
      }
      if (code === 2 && lineCount > 0) {
        runLogger.warn(
          `[ripGrepStream] Partial scan of ${target}: exit code 2, keeping partial results (${lineCount} lines). ${stderr.trim()}`,
        );
        resolve();
      } else if (code === 0 || code === 1) {
        resolve();
      } else {
        reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`));
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
