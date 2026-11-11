/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import path from 'node:path';

// Keep this key in sync with packages/core/src/utils/paths.ts.
// This file intentionally avoids importing core because it runs before core
// modules can safely read the config directory.
const CONFIG_HOME_DIR_OVERRIDE_KEY = Symbol.for('cli.configHomeDirOverride');
const CONFIG_ENV_PREFIX =
  // @ts-expect-error Bun replaces this exact dot-access expression per brand.
  process.env.BRAND_ENV_PREFIX || 'QWEN_';

// Keep this validation in sync with packages/core/src/config/configDirectory.ts.
// Importing core here is unsafe because this module runs before core startup.
const MAX_CONFIG_DIRECTORY_NAME_LENGTH = 64;
const CONFIG_DIRECTORY_NAME_PATTERN = /^[\p{L}\p{N}\p{M}._ -]+$/u;
const RESERVED_CONFIG_DIRECTORY_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const CONFIG_DIRECTORY_NAME_REQUIREMENTS =
  'must be a valid directory name after NFC normalization: 1-64 Unicode characters using letters, numbers, combining marks, ".", "_", "-", or internal spaces; it must not start or end with a space, end with ".", or use a reserved name';
const PROTECTED_CONFIG_DIRECTORY_NAMES = [
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.idea',
  '.husky',
  '.github',
  'node_modules',
  'bower_components',
] as const;
const PROTECTED_CONFIG_DIRECTORY_NAMES_LOWER = new Set(
  PROTECTED_CONFIG_DIRECTORY_NAMES.map((name) => name.toLowerCase()),
);
const PROTECTED_CONFIG_DIRECTORY_NAME_REQUIREMENTS =
  `must not use protected directory name; protected names are ${PROTECTED_CONFIG_DIRECTORY_NAMES.join(', ')}`;

function isValidConfigDirectoryName(value: string): boolean {
  const codePointLength = Array.from(value).length;
  return (
    codePointLength >= 1 &&
    codePointLength <= MAX_CONFIG_DIRECTORY_NAME_LENGTH &&
    !value.startsWith(' ') &&
    !value.endsWith(' ') &&
    !value.endsWith('.') &&
    value !== '.' &&
    value !== '..' &&
    CONFIG_DIRECTORY_NAME_PATTERN.test(value) &&
    !RESERVED_CONFIG_DIRECTORY_NAME_PATTERN.test(value)
  );
}

export type ConfigDirFlagParseResult =
  | { value: string; error?: undefined }
  | { value?: undefined; error: string }
  | { value?: undefined; error?: undefined };

export function getConfigDirNameEnvError(
  env: NodeJS.ProcessEnv = process.env,
  envPrefix: string = CONFIG_ENV_PREFIX,
): string | undefined {
  const name = `${envPrefix}CONFIG_DIR_NAME`;
  const value = env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  const normalizedValue = value.normalize('NFC');
  if (!isValidConfigDirectoryName(normalizedValue)) {
    return `${name} ${CONFIG_DIRECTORY_NAME_REQUIREMENTS}; received ${JSON.stringify(value)}`;
  }
  if (
    PROTECTED_CONFIG_DIRECTORY_NAMES_LOWER.has(normalizedValue.toLowerCase())
  ) {
    return `${name} ${PROTECTED_CONFIG_DIRECTORY_NAME_REQUIREMENTS}; received ${JSON.stringify(value)}`;
  }
  return undefined;
}

export function parseConfigDirFlag(
  argv: readonly string[] = process.argv,
): ConfigDirFlagParseResult {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      break;
    }
    if (arg === '--config-dir') {
      const value = argv[i + 1];
      if (!value || value === '--' || value.startsWith('--')) {
        return { error: '--config-dir requires a directory path' };
      }
      return { value };
    }
    if (arg.startsWith('--config-dir=')) {
      const value = arg.slice('--config-dir='.length);
      if (!value) {
        return { error: '--config-dir requires a directory path' };
      }
      return { value };
    }
  }
  return {};
}

export function applyConfigDirFlagFromArgv(
  argv: readonly string[] = process.argv,
): string | undefined {
  const configDirNameError = getConfigDirNameEnvError();
  if (configDirNameError) {
    process.stderr.write(`Error: ${configDirNameError}\n`);
    process.exit(1);
  }

  const parsed = parseConfigDirFlag(argv);
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    process.exit(1);
  }
  if (!parsed.value) {
    return undefined;
  }

  const resolvedPath = path.resolve(parsed.value).normalize('NFC');
  try {
    const existing =
      fs.statSync(resolvedPath, { throwIfNoEntry: false }) ??
      fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) {
      throw new Error('path exists but is not a directory');
    }
  } catch (error) {
    process.stderr.write(
      `Error: Failed to initialize --config-dir ${JSON.stringify(resolvedPath)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
  const global = globalThis as Record<symbol, string | undefined>;
  global[CONFIG_HOME_DIR_OVERRIDE_KEY] = resolvedPath;
  return resolvedPath;
}

export function clearConfigDirFlagOverrideForTest(): void {
  const global = globalThis as Record<symbol, string | undefined>;
  delete global[CONFIG_HOME_DIR_OVERRIDE_KEY];
}
