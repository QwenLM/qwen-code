/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileExists } from './fileUtils.js';

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
 * Checks if system ripgrep is available and returns the command to use
 * @returns The ripgrep command ('rg' or 'rg.exe') if available, or null if not found
 */
export async function getSystemRipgrep(): Promise<string | null> {
  try {
    const { spawn } = await import('node:child_process');
    const rgCommand = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const isAvailable = await new Promise<boolean>((resolve) => {
      const proc = spawn(rgCommand, ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    });
    return isAvailable ? rgCommand : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Checks if ripgrep binary exists and returns its path
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 * @returns The path to ripgrep binary ('rg' or 'rg.exe' for system ripgrep, or full path for bundled), or null if not available
 */
export async function getRipgrepCommand(
  useBuiltin: boolean = true,
): Promise<string | null> {
  try {
    if (useBuiltin) {
      // Try bundled ripgrep first
      const rgPath = getBuiltinRipgrep();
      if (rgPath && (await fileExists(rgPath))) {
        return rgPath;
      }
      // Fallback to system rg if bundled binary is not available
    }

    // Check for system ripgrep
    return await getSystemRipgrep();
  } catch (_error) {
    return null;
  }
}

/**
 * Checks if ripgrep binary is available
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 */
export async function canUseRipgrep(
  useBuiltin: boolean = true,
): Promise<boolean> {
  const rgPath = await getRipgrepCommand(useBuiltin);
  return rgPath !== null;
}
