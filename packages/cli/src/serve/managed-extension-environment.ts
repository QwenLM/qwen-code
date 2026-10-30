/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function managedExtensionEnvironment(
  inherited: NodeJS.ProcessEnv,
  directory: string,
  extension: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    HOME: directory,
    USERPROFILE: directory,
    ...extension,
  };
}
