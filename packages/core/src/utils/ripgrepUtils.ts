/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolveBundleDir } from './bundlePaths.js';
import { fileExists } from './fileUtils.js';
import { execCommand, isCommandAvailable } from './shell-utils.js';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('RIPGREP');

const RIPGREP_COMMAND = 'rg';
const RIPGREP_BUFFER_LIMIT = 20_000_000; // Keep buffers aligned with the original bundle.
const RIPGREP_TEST_TIMEOUT_MS = 5_000;
const RIPGREP_RUN_TIMEOUT_MS = 10_000;
const RIPGREP_WSL_TIMEOUT_MS = 60_000;

export type RipgrepMode = 'builtin' | 'system';

export type RipgrepFailureKind =
  | 'eagain'
  | 'timeout'
  | 'max_buffer'
  | 'exit'
  | 'spawn';

export interface RipgrepRecoveryMetadata {
  selectionMode: RipgrepMode;
  retryTriggered: boolean;
  retrySucceeded?: boolean;
  failureKind?: RipgrepFailureKind;
}

interface RipgrepSelection {
  mode: RipgrepMode;
  command: string;
}

interface RipgrepHealth {
  working: boolean;
  lastTested: number;
  selection: RipgrepSelection;
}

export interface RipgrepRunResult {
  /**
   * The stdout output from ripgrep
   */
  stdout: string;
  /**
   * Whether ripgrep produced only partial results because execution did not
   * complete.
   */
  incomplete: boolean;
  /**
   * Any error that occurred during execution (non-fatal errors like no matches won't populate this)
   */
  error?: Error;
  recovery: RipgrepRecoveryMetadata;
}

interface RipgrepAttemptResult {
  stdout: string;
  incomplete: boolean;
  canceled: boolean;
  error?: Error;
  failureKind?: RipgrepFailureKind;
}

type RipgrepProcessError = Error & {
  code?: string | number | undefined | null;
  signal?: string | null;
};

const cachedSelections = new Map<boolean, RipgrepSelection>();
let cachedHealth: RipgrepHealth | null = null;
let macSigningAttempted = false;

export function _resetRipgrepUtilsCachesForTest(): void {
  cachedSelections.clear();
  cachedHealth = null;
  macSigningAttempted = false;
}

function wslTimeout(): number {
  return process.platform === 'linux' && process.env['WSL_INTEROP']
    ? RIPGREP_WSL_TIMEOUT_MS
    : RIPGREP_RUN_TIMEOUT_MS;
}

// Resolved at module load to the directory that should anchor sibling-asset
// lookups (here: the vendored ripgrep binary copied to `dist/vendor/`). See
// `resolveBundleDir` for the rationale behind stripping a trailing `chunks/`
// segment when this module is hoisted into a shared esbuild chunk.
//
// `__filename` is needed separately by `getBuiltinRipgrep` to decide whether
// it's running from source / transpiled / bundled output (each requires a
// different `..`-traversal count). It is NOT just `path.join(__dirname,
// basename)` because in bundled mode esbuild rewrites every bare `__filename`
// reference to `__qwen_filename` (the shim chunk's path), which would make
// the heuristic always pick `levelsUp = 0` by accident; the explicit local
// shadow keeps the lookup correct in source/transpiled/dev modes too, where
// node ESM leaves `__filename` undefined.
const __filename = fileURLToPath(import.meta.url);
const __dirname = resolveBundleDir(import.meta.url);

type Platform = 'darwin' | 'linux' | 'win32';
type Architecture = 'x64' | 'arm64';

/**
 * Maps process.platform values to vendor directory names
 */
function getPlatformString(platform: string): Platform | undefined {
  switch (platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
      return platform;
    default:
      return undefined;
  }
}

/**
 * Maps process.arch values to vendor directory names
 */
function getArchitectureString(arch: string): Architecture | undefined {
  switch (arch) {
    case 'x64':
    case 'arm64':
      return arch;
    default:
      return undefined;
  }
}

/**
 * Returns the path to the bundled ripgrep binary for the current platform
 * @returns The path to the bundled ripgrep binary, or null if not available
 */
export function getBuiltinRipgrep(): string | null {
  const platform = getPlatformString(process.platform);
  const arch = getArchitectureString(process.arch);

  if (!platform || !arch) {
    return null;
  }

  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';

  // Determine levels to traverse up to reach package root where vendor/ lives:
  // - Bundle (dist/index.js): vendor copied into dist/, 0 levels
  // - Source (src/utils/*.ts): 2 levels up
  // - Transpiled (dist/src/utils/*.js): 3 levels up
  const inSrcUtils = __filename.includes(path.join('src', 'utils'));
  const levelsUp = !inSrcUtils ? 0 : __filename.endsWith('.ts') ? 2 : 3;

  return path.join(
    __dirname,
    ...Array<string>(levelsUp).fill('..'),
    'vendor',
    'ripgrep',
    `${arch}-${platform}`,
    binaryName,
  );
}

/**
 * Checks if ripgrep binary exists and returns its path
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 * @returns The path to ripgrep binary ('rg' or 'rg.exe' for system ripgrep, or full path for bundled), or null if not available
 * @throws {Error} If an error occurs while resolving the ripgrep binary.
 */
export async function resolveRipgrep(
  useBuiltin: boolean = true,
): Promise<RipgrepSelection | null> {
  const cachedSelection = cachedSelections.get(useBuiltin);
  if (cachedSelection) return cachedSelection;

  if (useBuiltin) {
    // Try bundled ripgrep first
    const rgPath = getBuiltinRipgrep();
    if (rgPath && (await fileExists(rgPath))) {
      const selection = { mode: 'builtin' as const, command: rgPath };
      cachedSelections.set(useBuiltin, selection);
      return selection;
    }
    // Fallback to system rg if bundled binary is not available
  }

  const { available, error } = isCommandAvailable(RIPGREP_COMMAND);
  if (available) {
    const selection = { mode: 'system' as const, command: RIPGREP_COMMAND };
    cachedSelections.set(useBuiltin, selection);
    return selection;
  }

  if (error) {
    throw error;
  }

  return null;
}

/**
 * Ensures that ripgrep is healthy by checking its version.
 * @param selection The ripgrep selection to check.
 * @throws {Error} If ripgrep is not found or is not healthy.
 */
export async function ensureRipgrepHealthy(
  selection: RipgrepSelection,
): Promise<void> {
  if (
    cachedHealth &&
    cachedHealth.selection.command === selection.command &&
    cachedHealth.working
  )
    return;

  let working = false;
  let probeOutput = '';
  let probeCode = -1;
  try {
    const { stdout, code } = await execCommand(
      selection.command,
      ['--version'],
      {
        timeout: RIPGREP_TEST_TIMEOUT_MS,
      },
    );
    probeOutput = stdout;
    probeCode = code;
    working = code === 0 && stdout.startsWith('ripgrep');
    cachedHealth = { working, lastTested: Date.now(), selection };
  } catch (error) {
    cachedHealth = { working: false, lastTested: Date.now(), selection };
    throw error;
  }

  // Callers only tell healthy from unhealthy by the throw, so a probe that
  // returns without identifying itself as ripgrep must not read as success.
  // Carry what it printed, so a wrapper or wrong tool is identifiable.
  if (!working) {
    throw new Error(
      `${selection.command} is not a working ripgrep binary (exit ${probeCode}): ${probeOutput.trim() || '(no output)'}`,
    );
  }
}

export async function ensureMacBinarySigned(
  selection: RipgrepSelection,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (macSigningAttempted) return;
  macSigningAttempted = true;

  if (selection.mode !== 'builtin') return;
  const binaryPath = selection.command;

  const inspect = await execCommand('codesign', ['-vv', '-d', binaryPath], {
    preserveOutputOnError: false,
  });
  const alreadySigned =
    inspect.stdout
      ?.split('\n')
      .some((line) => line.includes('linker-signed')) ?? false;
  if (!alreadySigned) return;

  await execCommand('codesign', [
    '--sign',
    '-',
    '--force',
    '--preserve-metadata=entitlements,requirements,flags,runtime',
    binaryPath,
  ]);
  await execCommand('xattr', ['-d', 'com.apple.quarantine', binaryPath]);
}

/**
 * Resolves ripgrep and verifies it actually runs.
 *
 * The bundled binary is selected by file existence alone, so a binary that
 * exists but cannot execute — e.g. arm64 kernels with 64K pages (#2676) —
 * would otherwise fail the whole session instead of using system rg.
 */
async function resolveHealthyRipgrep(
  useBuiltin: boolean,
): Promise<RipgrepSelection | null> {
  const selection = await resolveRipgrep(useBuiltin);
  if (!selection) {
    return null;
  }

  try {
    await ensureRipgrepHealthy(selection);
    return selection;
  } catch (error) {
    if (selection.mode !== 'builtin') {
      throw error;
    }
    debugLogger.warn(
      `Bundled ripgrep at ${selection.command} is unusable (${error}); trying system rg.`,
    );

    let fallback: RipgrepSelection | null = null;
    try {
      fallback = await resolveRipgrep(false);
      if (fallback) {
        await ensureRipgrepHealthy(fallback);
      }
    } catch (fallbackError) {
      // System rg is unusable too. The bundled failure is the root cause, but
      // keep the system reason visible or it is lost entirely.
      debugLogger.warn(`System rg is unusable as well: ${fallbackError}`);
      throw error;
    }
    if (!fallback) {
      throw error;
    }

    cachedSelections.set(true, fallback);
    return fallback;
  }
}

/**
 * Checks if ripgrep binary is available
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 * @returns True if ripgrep is available, false otherwise.
 * @throws {Error} If an error occurs while resolving the ripgrep binary.
 */
export async function canUseRipgrep(
  useBuiltin: boolean = true,
): Promise<boolean> {
  const selection = await resolveHealthyRipgrep(useBuiltin);
  return selection !== null;
}

function errorCodeOf(
  error: RipgrepProcessError,
): string | number | undefined | null {
  return error.code;
}

function isCanceledRipgrepExecution(
  error: RipgrepProcessError,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted === true ||
    error.name === 'AbortError' ||
    errorCodeOf(error) === 'ABORT_ERR'
  );
}

function isRipgrepThreadEagain(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  // `os error 11` is the stable errno marker from ripgrep's worker creation
  // path; generic resource-unavailable text still needs thread context.
  if (lower.includes('os error 11')) {
    return true;
  }

  const mentionsThread = lower.includes('thread') || lower.includes('worker');
  const mentionsEagain =
    lower.includes('resource temporarily unavailable') ||
    lower.includes('eagain');
  return mentionsThread && mentionsEagain;
}

function withSingleRipgrepThread(args: string[]): string[] | null {
  // Only rewrite the exact pair generated by RipGrepTool so retry stays local
  // to this narrow recovery path and never mutates the caller's argument list.
  const threadsIndex = args.findIndex(
    (arg, index) => arg === '--threads' && args[index + 1] === '4',
  );
  if (threadsIndex === -1) {
    return null;
  }

  const retryArgs = [...args];
  retryArgs[threadsIndex + 1] = '1';
  return retryArgs;
}

function dropPossiblyIncompleteLastLine(stdout: string): string {
  // Timeout and maxBuffer termination can leave the final buffered line
  // incomplete; keep only lines ripgrep had fully written.
  if (stdout.length === 0) return stdout;
  const lines = stdout.split('\n');
  lines.pop();
  return lines.join('\n');
}

function classifyRipgrepError(
  error: RipgrepProcessError,
  stderr: string,
  signal?: AbortSignal,
): { failureKind?: RipgrepFailureKind; canceled: boolean } {
  const canceled = isCanceledRipgrepExecution(error, signal);
  if (canceled) {
    return { canceled };
  }

  const errorCode = errorCodeOf(error);
  // Stderr-confirmed worker failures are recoverable; plain numeric exits are
  // not, even if ripgrep uses the same non-zero exit code.
  if (isRipgrepThreadEagain(stderr)) {
    return { failureKind: 'eagain', canceled: false };
  }
  if (errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { failureKind: 'max_buffer', canceled: false };
  }
  if (error.signal === 'SIGTERM') {
    return { failureKind: 'timeout', canceled: false };
  }
  if (typeof errorCode === 'string') {
    return { failureKind: 'spawn', canceled: false };
  }

  return { failureKind: 'exit', canceled: false };
}

function shouldDropLastLine(
  failureKind: RipgrepFailureKind | undefined,
  canceled: boolean,
): boolean {
  return canceled || failureKind === 'timeout' || failureKind === 'max_buffer';
}

function createRecoveryMetadata(
  selection: RipgrepSelection,
  options: {
    retryTriggered: boolean;
    retrySucceeded?: boolean;
    failureKind?: RipgrepFailureKind;
  },
): RipgrepRecoveryMetadata {
  const recovery: RipgrepRecoveryMetadata = {
    selectionMode: selection.mode,
    retryTriggered: options.retryTriggered,
  };
  if (options.retrySucceeded !== undefined) {
    recovery.retrySucceeded = options.retrySucceeded;
  }
  if (options.failureKind !== undefined) {
    recovery.failureKind = options.failureKind;
  }
  return recovery;
}

function toRunResult(
  attempt: RipgrepAttemptResult,
  recovery: RipgrepRecoveryMetadata,
): RipgrepRunResult {
  const result: RipgrepRunResult = {
    stdout: attempt.stdout,
    incomplete: attempt.incomplete,
    recovery,
  };
  if (attempt.error !== undefined) {
    result.error = attempt.error;
  }
  return result;
}

async function runRipgrepOnce(
  selection: RipgrepSelection,
  args: string[],
  signal?: AbortSignal,
): Promise<RipgrepAttemptResult> {
  return new Promise<RipgrepAttemptResult>((resolve) => {
    let settled = false;
    // execFile can report the same failure through both the callback and the
    // child "error" event; recovery decisions must see exactly one result.
    const settle = (result: RipgrepAttemptResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = execFile(
        selection.command,
        args,
        {
          maxBuffer: RIPGREP_BUFFER_LIMIT,
          timeout: wslTimeout(),
          signal,
        },
        (error, stdout = '', stderr = '') => {
          const stdoutText = stdout.toString();
          const stderrText = stderr.toString();
          if (!error) {
            settle({
              stdout: stdoutText,
              incomplete: false,
              canceled: false,
            });
            return;
          }

          const errorCode = errorCodeOf(error);
          // ripgrep's contract: exit 1 means "no matches AND no error". It
          // never carries matches, but under --json it still emits a trailing
          // summary event on stdout, so stdout emptiness cannot gate this.
          if (errorCode === 1 && stderrText.trim() === '') {
            settle({
              stdout: stdoutText,
              incomplete: false,
              canceled: false,
            });
            return;
          }

          const { failureKind, canceled } = classifyRipgrepError(
            error,
            stderrText,
            signal,
          );
          const incomplete =
            (shouldDropLastLine(failureKind, canceled) ||
              failureKind === 'eagain' ||
              failureKind === 'exit') &&
            stdoutText.trim().length > 0;
          const partialOutput = shouldDropLastLine(failureKind, canceled)
            ? dropPossiblyIncompleteLastLine(stdoutText)
            : stdoutText;

          if (failureKind === 'timeout' || failureKind === 'max_buffer') {
            debugLogger.warn(
              `ripgrep exited abnormally (signal=${error.signal} code=${error.code}) with stderr:\n${stderrText.trim() || '(empty)'}`,
            );
          }

          settle({
            stdout: partialOutput,
            incomplete,
            canceled,
            error,
            ...(failureKind !== undefined ? { failureKind } : {}),
          });
        },
      );
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      settle({
        stdout: '',
        incomplete: false,
        canceled: false,
        error: normalizedError,
        failureKind: 'spawn',
      });
      return;
    }

    child.on('error', (error) => {
      const canceled = isCanceledRipgrepExecution(error, signal);
      const result: RipgrepAttemptResult = {
        stdout: '',
        incomplete: false,
        canceled,
        error,
      };
      if (!canceled) {
        result.failureKind = 'spawn';
      }
      settle(result);
    });
  });
}

/**
 * Runs ripgrep with the provided arguments
 * @param args The arguments to pass to ripgrep
 * @param signal The signal to abort the ripgrep process
 * @param useBuiltin Whether to try the bundled ripgrep before falling back to system ripgrep
 * @returns The result of running ripgrep
 * @throws {Error} If an error occurs while running ripgrep.
 */
export async function runRipgrep(
  args: string[],
  signal?: AbortSignal,
  useBuiltin: boolean = true,
): Promise<RipgrepRunResult> {
  const selection = await resolveHealthyRipgrep(useBuiltin);
  if (!selection) {
    throw new Error('ripgrep not found.');
  }

  const firstAttempt = await runRipgrepOnce(selection, args, signal);
  if (
    firstAttempt.failureKind === 'eagain' &&
    !firstAttempt.canceled &&
    signal?.aborted !== true
  ) {
    const retryArgs = withSingleRipgrepThread(args);
    if (retryArgs !== null) {
      // A thread creation failure is scoped to this invocation, so retry once
      // without lowering concurrency for later searches.
      const retryAttempt = await runRipgrepOnce(selection, retryArgs, signal);
      const retryRecoveryOptions: {
        retryTriggered: boolean;
        retrySucceeded: boolean;
        failureKind?: RipgrepFailureKind;
      } = {
        retryTriggered: true,
        retrySucceeded: retryAttempt.error === undefined,
      };
      const retryFailureKind =
        retryAttempt.error === undefined ? 'eagain' : retryAttempt.failureKind;
      if (retryFailureKind !== undefined) {
        retryRecoveryOptions.failureKind = retryFailureKind;
      }
      return toRunResult(
        retryAttempt,
        createRecoveryMetadata(selection, retryRecoveryOptions),
      );
    }
  }

  const recoveryOptions: {
    retryTriggered: boolean;
    failureKind?: RipgrepFailureKind;
  } = {
    retryTriggered: false,
  };
  if (firstAttempt.failureKind !== undefined) {
    recoveryOptions.failureKind = firstAttempt.failureKind;
  }
  return toRunResult(
    firstAttempt,
    createRecoveryMetadata(selection, recoveryOptions),
  );
}
