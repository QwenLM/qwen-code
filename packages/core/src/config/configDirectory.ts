/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ConfigDirectoryNameInput {
  rawValue: string | undefined;
  envName: string;
  userDefault: string;
  projectDefault: string;
}

export interface ConfigDirectoryNames {
  userConfigDirName: string;
  projectConfigDirName: string;
}

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

export function resolveConfigDirectoryNames(
  input: ConfigDirectoryNameInput,
): ConfigDirectoryNames {
  if (input.rawValue === undefined || input.rawValue === '') {
    return {
      userConfigDirName: input.userDefault,
      projectConfigDirName: input.projectDefault,
    };
  }
  const value = input.rawValue.normalize('NFC');
  if (!isValidConfigDirectoryName(value)) {
    throw new Error(
      `${input.envName} ${CONFIG_DIRECTORY_NAME_REQUIREMENTS}; received ${JSON.stringify(input.rawValue)}`,
    );
  }
  if (PROTECTED_CONFIG_DIRECTORY_NAMES_LOWER.has(value.toLowerCase())) {
    throw new Error(
      `${input.envName} ${PROTECTED_CONFIG_DIRECTORY_NAME_REQUIREMENTS}; received ${JSON.stringify(input.rawValue)}`,
    );
  }

  return {
    userConfigDirName: value,
    projectConfigDirName: value,
  };
}
