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
function getPlatformString(platform: string): Platform {
  switch (platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
      return platform;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Maps process.arch values to vendor directory names
 */
function getArchitectureString(arch: string): Architecture {
  switch (arch) {
    case 'x64':
    case 'arm64':
      return arch;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }
}

/**
 * Returns the path to the bundled ripgrep binary for the current platform
 */
export function getRipgrepPath(): string {
  const platform = getPlatformString(process.platform);
  const arch = getArchitectureString(process.arch);

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
 * Checks if ripgrep binary is available
 * @param useBuiltin If true, tries bundled ripgrep first, then falls back to system ripgrep.
 *                   If false, only checks for system ripgrep.
 */
export async function canUseRipgrep(
  useBuiltin: boolean = true,
): Promise<boolean> {
  try {
    if (useBuiltin) {
      // Try bundled ripgrep first
      const rgPath = getRipgrepPath();
      if (await fileExists(rgPath)) {
        return true;
      }
      // Fallback to system rg if bundled binary is not available
    }

    // Check for system ripgrep by trying to spawn 'rg --version'
    const { spawn } = await import('node:child_process');
    return await new Promise<boolean>((resolve) => {
      const proc = spawn('rg', ['--version']);
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    });
  } catch (_error) {
    // Unsupported platform/arch or other error
    return false;
  }
}

/**
 * Ensures ripgrep binary exists and returns its path
 * @throws Error if ripgrep binary is not available
 */
export async function ensureRipgrepPath(): Promise<string> {
  const rgPath = getRipgrepPath();

  if (!(await fileExists(rgPath))) {
    throw new Error(
      `Ripgrep binary not found at ${rgPath}. ` +
        `Platform: ${process.platform}, Architecture: ${process.arch}`,
    );
  }

  return rgPath;
}
