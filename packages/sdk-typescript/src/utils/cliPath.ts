/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI path resolution and subprocess spawning utilities
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Executable types supported by the SDK
 */
export type ExecutableType = 'node' | 'bun' | 'tsx' | 'native';

/**
 * Spawn information for CLI process
 */
export type SpawnInfo = {
  /** Command to execute (e.g., 'node', 'bun', 'tsx', or native binary path) */
  command: string;
  /** Arguments to pass to command */
  args: string[];
  /** Type of executable detected */
  type: ExecutableType;
  /** Original input that was resolved */
  originalInput: string;
};

/**
 * Get the directory containing the current module (ESM or CJS)
 */
function getCurrentModuleDir(): string {
  let moduleDir: string | null = null;

  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      moduleDir = path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // Fall through to CJS
  }

  if (!moduleDir) {
    try {
      if (typeof __dirname !== 'undefined') {
        moduleDir = __dirname;
      }
    } catch {
      // Fall through
    }
  }

  if (moduleDir) {
    return path.normalize(moduleDir);
  }
  throw new Error('Cannot find module directory.');
}

/**
 * Find the SDK package root directory
 */
function findSdkPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('@qwen-code/sdk/package.json');
    const packageRoot = path.dirname(packageJsonPath);
    const cliPath = path.join(packageRoot, 'dist', 'cli', 'cli.js');
    if (fs.existsSync(cliPath)) {
      return packageRoot;
    }
  } catch {
    // Continue to fallback strategy
  }

  const currentDir = getCurrentModuleDir();
  let dir = currentDir;
  const root = path.parse(dir).root;
  let bestMatch: string | null = null;

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const cliPath = path.join(dir, 'dist', 'cli', 'cli.js');
      if (fs.existsSync(cliPath)) {
        try {
          const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf-8'),
          );
          if (packageJson.name === '@qwen-code/sdk') {
            return dir;
          }
          if (!bestMatch) {
            bestMatch = dir;
          }
        } catch {
          if (!bestMatch) {
            bestMatch = dir;
          }
        }
      }
    }
    dir = path.dirname(dir);
  }

  return bestMatch;
}

/**
 * Normalize path separators for regex matching
 */
function normalizeForRegex(dirPath: string): string {
  return dirPath.replace(/\\/g, '/');
}

/**
 * Resolve bundled CLI using import.meta.url relative path
 */
function tryResolveCliFromImportMeta(): string | null {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      const currentFilePath = fileURLToPath(import.meta.url);
      const currentDir = path.dirname(currentFilePath);
      const cliPath = path.join(currentDir, 'cli', 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Get all candidate paths for the bundled CLI
 */
function getBundledCliCandidatePaths(): string[] {
  const candidates: string[] = [];

  const importMetaResolved = tryResolveCliFromImportMeta();
  if (importMetaResolved) {
    candidates.push(importMetaResolved);
  }

  try {
    const currentDir = getCurrentModuleDir();
    const normalizedDir = normalizeForRegex(currentDir);

    candidates.push(path.join(currentDir, 'cli', 'cli.js'));

    if (/\/src\/utils$/.test(normalizedDir)) {
      const packageRoot = path.dirname(path.dirname(currentDir));
      candidates.push(path.join(packageRoot, 'dist', 'cli', 'cli.js'));
    }

    const packageRoot = findSdkPackageRoot();
    if (packageRoot) {
      candidates.push(path.join(packageRoot, 'dist', 'cli', 'cli.js'));
    }

    const monorepoMatch = normalizedDir.match(
      /^(.+?)\/packages\/sdk-typescript/,
    );
    if (monorepoMatch && monorepoMatch[1]) {
      const monorepoRoot =
        process.platform === 'win32'
          ? monorepoMatch[1].replace(/\//g, '\\')
          : monorepoMatch[1];
      candidates.push(path.join(monorepoRoot, 'dist', 'cli.js'));
    }
  } catch {
    const packageRoot = findSdkPackageRoot();
    if (packageRoot) {
      candidates.push(path.join(packageRoot, 'dist', 'cli', 'cli.js'));
    }
  }

  return candidates;
}

/**
 * Find the bundled CLI path
 */
function getBundledCliPath(): string | null {
  const candidates = getBundledCliCandidatePaths();

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Find the bundled CLI path or throw error
 */
export function findBundledCliPath(): string {
  const bundledCli = getBundledCliPath();
  if (bundledCli) {
    return bundledCli;
  }

  const candidates = getBundledCliCandidatePaths();
  throw new Error(
    'Bundled qwen CLI not found. The CLI should be included in the SDK package.\n' +
      'Searched locations:\n' +
      candidates.map((c) => `  - ${c}`).join('\n') +
      '\n\nIf you need to use a custom CLI, provide explicit path:\n' +
      '  • query({ pathToQwenExecutable: "/path/to/cli.js" })',
  );
}

/**
 * Validate file exists and is a file
 */
function validateFilePath(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Executable file not found at '${filePath}'. ` +
        'Please check the file path and ensure the file exists.',
    );
  }

  const stats = fs.statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(
      `Path '${filePath}' exists but is not a file. ` +
        'Please provide a path to an executable file.',
    );
  }
}

/**
 * Check if path contains separators (file path vs command name)
 */
function isFilePath(spec: string): boolean {
  return spec.includes('/') || spec.includes('\\');
}

/**
 * Check if file is JavaScript
 */
function isJavaScriptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.js', '.mjs', '.cjs'].includes(ext);
}

/**
 * Check if file is TypeScript
 */
function isTypeScriptFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.ts', '.tsx'].includes(ext);
}

/**
 * Check if command is available in PATH
 */
function isCommandAvailable(command: string): boolean {
  try {
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCommand} ${command}`, {
      stdio: 'ignore',
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if tsx is available
 */
function isTsxAvailable(): boolean {
  return isCommandAvailable('tsx');
}

/**
 * Get JavaScript runtime type (bun if running under bun, otherwise node)
 */
function getJsRuntimeType(): 'bun' | 'node' {
  if (
    typeof process !== 'undefined' &&
    'versions' in process &&
    'bun' in process.versions
  ) {
    return 'bun';
  }
  return 'node';
}

/**
 * Prepare spawn information for CLI process
 */
export function prepareSpawnInfo(executableSpec?: string): SpawnInfo {
  if (executableSpec !== undefined && executableSpec.trim() === '') {
    throw new Error('Executable path cannot be empty');
  }

  if (executableSpec === undefined) {
    const bundledCliPath = findBundledCliPath();
    return {
      command: process.execPath,
      args: [bundledCliPath],
      type: getJsRuntimeType(),
      originalInput: '',
    };
  }

  if (!isFilePath(executableSpec)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(executableSpec)) {
      throw new Error(
        `Invalid command name '${executableSpec}'. ` +
          'Command names should only contain letters, numbers, dots, hyphens, and underscores.',
      );
    }
    return {
      command: executableSpec,
      args: [],
      type: 'native',
      originalInput: executableSpec,
    };
  }

  const resolvedPath = path.resolve(executableSpec);
  validateFilePath(resolvedPath);

  if (isJavaScriptFile(resolvedPath)) {
    return {
      command: process.execPath,
      args: [resolvedPath],
      type: getJsRuntimeType(),
      originalInput: executableSpec,
    };
  }

  if (isTypeScriptFile(resolvedPath)) {
    if (isTsxAvailable()) {
      return {
        command: 'tsx',
        args: [resolvedPath],
        type: 'tsx',
        originalInput: executableSpec,
      };
    }
  }

  return {
    command: resolvedPath,
    args: [],
    type: 'native',
    originalInput: executableSpec,
  };
}
