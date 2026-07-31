/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';

/**
 * Parse command-line arguments in `--key=value` format.
 * Flags without a value (e.g. `--dry-run`) are set to `true`.
 */
export function getArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const stripped = arg.substring(2);
      const eqIndex = stripped.indexOf('=');
      if (eqIndex === -1) {
        args[stripped] = true;
      } else {
        args[stripped.substring(0, eqIndex)] = stripped.substring(eqIndex + 1);
      }
    }
  });
  return args;
}

/**
 * Read and parse a JSON file.
 */
export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

/**
 * Validate that a version string matches the expected format.
 * Throws if the version is invalid.
 */
export function validateVersion(version, format, name) {
  const versionRegex = {
    'X.Y.Z': /^\d+\.\d+\.\d+$/,
    'X.Y.Z-preview.N': /^\d+\.\d+\.\d+-preview\.\d+$/,
  };

  if (!versionRegex[format] || !versionRegex[format].test(version)) {
    throw new Error(
      `Invalid ${name}: ${version}. Must be in ${format} format.`,
    );
  }
}

/**
 * Check whether an error from `gh release view` indicates the release
 * simply doesn't exist (as opposed to an unexpected failure).
 */
export function isExpectedMissingGitHubRelease(error) {
  const stderr = error.stderr?.toString() ?? '';
  const stdout = error.stdout?.toString() ?? '';
  const message = `${error.message}\n${stderr}\n${stdout}`;
  return message.includes('release not found') || message.includes('Not Found');
}
