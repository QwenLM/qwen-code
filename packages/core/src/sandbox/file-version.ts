/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';

const VERSION_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;
export type SandboxFileVersion = Readonly<
  Record<(typeof VERSION_FIELDS)[number], string>
>;

export function isSandboxFileVersion(
  value: unknown,
): value is SandboxFileVersion {
  return (
    value !== null &&
    typeof value === 'object' &&
    VERSION_FIELDS.every((key) => {
      const field = (value as Record<string, unknown>)[key];
      return typeof field === 'string' && /^-?\d{1,40}$/.test(field);
    })
  );
}

export function getSandboxFileVersion(
  filePath: string,
): SandboxFileVersion | null {
  try {
    const stats = statSync(filePath, { bigint: true });
    if (!stats.isFile()) {
      throw Object.assign(new Error('File tools require a regular file.'), {
        code: stats.isDirectory() ? 'EISDIR' : 'EINVAL',
      });
    }
    return Object.freeze({
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function assertSandboxFileVersion(
  filePath: string,
  expected: SandboxFileVersion | null,
): void {
  const current = getSandboxFileVersion(filePath);
  if (
    current === null
      ? expected !== null
      : expected === null ||
        VERSION_FIELDS.some((key) => current[key] !== expected[key])
  ) {
    throw Object.assign(
      new Error(
        'File changed since it was prepared. Re-read it before retrying.',
      ),
      { code: 'ESTALE' },
    );
  }
}
