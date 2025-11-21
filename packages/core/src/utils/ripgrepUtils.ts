/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { fileExists } from './fileUtils.js';
import { execCommand, isCommandAvailable } from './shell-utils.js';

const RIPGREP_COMMAND = 'rg';
const RIPGREP_BUFFER_LIMIT = 20_000_000; // Keep buffers aligned with the original bundle.
const RIPGREP_TEST_TIMEOUT_MS = 5_000;
const RIPGREP_RUN_TIMEOUT_MS = 10_000;
const RIPGREP_WSL_TIMEOUT_MS = 60_000;

type RipgrepMode = 'builtin' | 'system';

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
   * Whether the results were truncated due to buffer overflow or signal termination
   */
  truncated: boolean;
  /**
   * Any error that occurred during execution (non-fatal errors like no matches won't populate this)
   */
  error?: Error;
}

let cachedSelection: RipgrepSelection | null = null;
let cachedHealth: RipgrepHealth | null = null;
let macSigningAttempted = false;

function wslTimeout(): number {
  return process.platform === 'linux' && process.env['WSL_INTEROP']
    ? RIPGREP_WSL_TIMEOUT_MS
    : RIPGREP_RUN_TIMEOUT_MS;
}

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  // Binary name includes .exe on Windows
  const binaryName = platform === 'win32' ? 'rg.exe' : 'rg';

  // Path resolution:
  // When running from transpiled code: dist/src/utils/ripgrepUtils.js -> ../../../vendor/ripgrep/
  // When running from bundle: dist/index.js -> vendor/ripgrep/

  // Detect if we're running from a bundle (single file)
  // In bundle, __filename will be something like /path/to/dist/index.js
  // In transpiled code, __filename will be /path/to/dist/src/utils/ripgrepUtils.js
  const isBundled = !__filename.includes(path.join('src', 'utils'));

  const vendorPath = isBundled
    ? path.join(
        __dirname,
        'vendor',
        'ripgrep',
        `${arch}-${platform}`,
        binaryName,
      )
    : path.join(
        __dirname,
        '..',
        '..',
        '..',
        'vendor',
        'ripgrep',
        `${arch}-${platform}`,
        binaryName,
      );

  return vendorPath;
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
  if (cachedSelection) return cachedSelection;

  if (useBuiltin) {
    // Try bundled ripgrep first
    const rgPath = getBuiltinRipgrep();
    if (rgPath && (await fileExists(rgPath))) {
      cachedSelection = { mode: 'builtin', command: rgPath };
      return cachedSelection;
    }
    // Fallback to system rg if bundled binary is not available
  }

  const { available, error } = isCommandAvailable(RIPGREP_COMMAND);
  if (available) {
    cachedSelection = { mode: 'system', command: RIPGREP_COMMAND };
    return cachedSelection;
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

  try {
    const { stdout, code } = await execCommand(
      selection.command,
      ['--version'],
      {
        timeout: RIPGREP_TEST_TIMEOUT_MS,
      },
    );
    const working = code === 0 && stdout.startsWith('ripgrep');
    cachedHealth = { working, lastTested: Date.now(), selection };
  } catch (error) {
    cachedHealth = { working: false, lastTested: Date.now(), selection };
    throw error;
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
 * Checks if ripgrep binary is available
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 * @returns True if ripgrep is available, false otherwise.
 * @throws {Error} If an error occurs while resolving the ripgrep binary.
 */
export async function canUseRipgrep(
  useBuiltin: boolean = true,
): Promise<boolean> {
  const selection = await resolveRipgrep(useBuiltin);
  if (!selection) {
    return false;
  }
  await ensureRipgrepHealthy(selection);
  return true;
}

/**
 * Runs ripgrep with the provided arguments
 * @param args The arguments to pass to ripgrep
 * @param signal The signal to abort the ripgrep process
 * @returns The result of running ripgrep
 * @throws {Error} If an error occurs while running ripgrep.
 */
export async function runRipgrep(
  args: string[],
  signal?: AbortSignal,
): Promise<RipgrepRunResult> {
  const selection = await resolveRipgrep();
  if (!selection) {
    throw new Error('ripgrep not found.');
  }
  await ensureRipgrepHealthy(selection);

  return new Promise<RipgrepRunResult>((resolve) => {
    const child = execFile(
      selection.command,
      args,
      {
        maxBuffer: RIPGREP_BUFFER_LIMIT,
        timeout: wslTimeout(),
        signal,
      },
      (error, stdout = '', stderr = '') => {
        if (!error) {
          // Success case
          resolve({
            stdout,
            truncated: false,
          });
          return;
        }

        // Exit code 1 = no matches found (not an error)
        // The error.code from execFile can be string | number | undefined | null
        const errorCode = (
          error as Error & { code?: string | number | undefined | null }
        ).code;
        if (errorCode === 1) {
          resolve({ stdout: '', truncated: false });
          return;
        }

        // Detect various error conditions
        const wasKilled =
          error.signal === 'SIGTERM' || error.name === 'AbortError';
        const overflow = errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const syntaxError = errorCode === 2;

        const truncated = wasKilled || overflow;
        let partialOutput = stdout;

        // If killed or overflow with partial output, remove the last potentially incomplete line
        if (truncated && partialOutput.length > 0) {
          const lines = partialOutput.split('\n');
          if (lines.length > 0) {
            lines.pop();
            partialOutput = lines.join('\n');
          }
        }

        // Log warnings for abnormal exits (except syntax errors)
        if (!syntaxError && truncated) {
          console.warn(
            `ripgrep exited abnormally (signal=${error.signal} code=${error.code}) with stderr:\n${stderr.trim() || '(empty)'}`,
          );
        }

        resolve({
          stdout: partialOutput,
          truncated,
          error: error instanceof Error ? error : undefined,
        });
      },
    );

    // Handle spawn errors
    child.on('error', (err) =>
      resolve({ stdout: '', truncated: false, error: err }),
    );
  });
}
