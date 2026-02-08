/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * doctor-utils.ts
 *
 * Utility functions for the doctor diagnostic script.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMMAND_NAME } from './constant';
import { DoctorCheckResult, DoctorStatus } from './doctor-types';
import { colorText } from './utils';

/**
 * Constants for doctor checks
 */
export const EXPECTED_PORT = 12306;
export const SCHEMA_VERSION = 1;
export const MIN_NODE_MAJOR_VERSION = 20;

/**
 * Read package.json from the project root.
 */
export function readPackageJson(): Record<string, unknown> {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const content = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Get command information from package.json bin field.
 */
export function getCommandInfo(pkg: Record<string, unknown>): {
  canonical: string;
  aliases: string[];
} {
  const bin = pkg.bin as Record<string, string> | undefined;
  if (!bin || typeof bin !== 'object') {
    return { canonical: COMMAND_NAME, aliases: [] };
  }

  const canonical = COMMAND_NAME;
  const canonicalTarget = bin[canonical];

  const aliases = canonicalTarget
    ? Object.keys(bin).filter(
        (name) => name !== canonical && bin[name] === canonicalTarget,
      )
    : [];

  return { canonical, aliases };
}

/**
 * Resolve the distribution directory containing native host files.
 */
export function resolveDistDir(): string {
  // __dirname is dist/scripts when running from compiled code
  const candidateFromDistScripts = path.resolve(__dirname, '..');
  const candidateFromSrcScripts = path.resolve(__dirname, '..', '..', 'dist');

  const looksLikeDist = (dir: string): boolean => {
    return (
      fs.existsSync(path.join(dir, 'mcp', 'stdio-config.json')) ||
      fs.existsSync(path.join(dir, 'run_host.sh')) ||
      fs.existsSync(path.join(dir, 'run_host.bat'))
    );
  };

  if (looksLikeDist(candidateFromDistScripts)) return candidateFromDistScripts;
  if (looksLikeDist(candidateFromSrcScripts)) return candidateFromSrcScripts;
  return candidateFromDistScripts;
}

/**
 * Convert an error to a string representation.
 */
export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Check if a file path is executable.
 */
export function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a path for comparison purposes.
 */
export function normalizeComparablePath(filePath: string): string {
  if (process.platform === 'win32') {
    return path.normalize(filePath).toLowerCase();
  }
  return path.normalize(filePath);
}

/**
 * Remove outer quotes from a string.
 */
export function stripOuterQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Expand tilde (~) to home directory.
 */
export function expandTilde(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Expand Windows environment variables (e.g., %APPDATA%).
 */
export function expandWindowsEnvVars(input: string): string {
  if (process.platform !== 'win32') return input;
  return input.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = String(name);
    return (
      process.env[key] ??
      process.env[key.toUpperCase()] ??
      process.env[key.toLowerCase()] ??
      _match
    );
  });
}

/**
 * Parse version numbers from a directory name.
 * @returns Array of version numbers (e.g., ["20", "10", "0"] from "v20.10.0") or null if invalid.
 */
export function parseVersionFromDirName(dirName: string): number[] | null {
  const cleaned = dirName.trim().replace(/^v/, '');
  if (!/^\d+(\.\d+){0,3}$/.test(cleaned)) return null;
  return cleaned.split('.').map((part) => Number(part));
}

/**
 * Parse Node.js version string from `node -v` output.
 * Handles versions like: v20.10.0, v22.0.0-nightly.2024..., v21.0.0-rc.1
 * Returns major version number or null if parsing fails.
 */
export function parseNodeMajorVersion(versionString: string): number | null {
  if (!versionString) return null;
  // Match pattern: v?MAJOR.MINOR.PATCH[-anything]
  const match = versionString.trim().match(/^v?(\d+)(?:\.\d+)*(?:[-+].*)?$/i);
  if (match?.[1]) {
    const major = Number(match[1]);
    return Number.isNaN(major) ? null : major;
  }
  return null;
}

/**
 * Compare two version arrays.
 * @returns Negative if a < b, positive if a > b, 0 if equal.
 */
export function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Find the latest version directory within a parent directory.
 * @returns Full path to the latest version directory, or null if none found.
 */
export function pickLatestVersionDir(parentDir: string): string | null {
  if (!fs.existsSync(parentDir)) return null;
  const dirents = fs.readdirSync(parentDir, { withFileTypes: true });
  let best: { name: string; version: number[] } | null = null;

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const parsed = parseVersionFromDirName(dirent.name);
    if (!parsed) continue;
    if (!best || compareVersions(parsed, best.version) > 0) {
      best = { name: dirent.name, version: parsed };
    }
  }

  return best ? path.join(parentDir, best.name) : null;
}

/**
 * Read a JSON file and return parsed content or error.
 */
export function readJsonFile(
  filePath: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: stringifyError(e) };
  }
}

/**
 * Compute summary statistics from check results.
 */
export function computeSummary(checks: DoctorCheckResult[]): {
  ok: number;
  warn: number;
  error: number;
} {
  let ok = 0;
  let warn = 0;
  let error = 0;
  for (const check of checks) {
    if (check.status === 'ok') ok++;
    else if (check.status === 'warn') warn++;
    else error++;
  }
  return { ok, warn, error };
}

/**
 * Generate a status badge with appropriate color.
 */
export function statusBadge(status: DoctorStatus): string {
  if (status === 'ok') return colorText('[OK]', 'green');
  if (status === 'warn') return colorText('[WARN]', 'yellow');
  return colorText('[ERROR]', 'red');
}
