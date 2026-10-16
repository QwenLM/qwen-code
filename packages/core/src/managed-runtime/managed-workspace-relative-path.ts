/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const WORKSPACE_ROOT = '.';
const MAXIMUM_CWD_CODE_POINTS = 1024;

export class InvalidWorkspaceRelativePathError extends Error {
  readonly code = 'invalid_cwd';

  constructor() {
    super('cwdRelative is not a valid Workspace-relative directory.');
    this.name = 'InvalidWorkspaceRelativePathError';
  }
}

/**
 * Returns the normal form of a Workspace-relative directory: empty and `.`
 * segments are dropped and nothing else changes. The check is lexical; the
 * Runtime still verifies the directory on disk.
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_CWD_CODE_POINTS * 2 ||
    !isWellFormed(value)
  ) {
    throw new InvalidWorkspaceRelativePathError();
  }
  const codePoints = [...value].length;
  if (
    codePoints < 1 ||
    codePoints > MAXIMUM_CWD_CODE_POINTS ||
    hasControlCharacter(value) ||
    value.includes('\\') ||
    value.startsWith('/')
  ) {
    throw new InvalidWorkspaceRelativePathError();
  }
  const kept: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '..') {
      throw new InvalidWorkspaceRelativePathError();
    }
    if (segment !== '' && segment !== '.') {
      kept.push(segment);
    }
  }
  const normalized = kept.length === 0 ? WORKSPACE_ROOT : kept.join('/');
  // Checked on the normal form: dropping a leading "." segment would
  // otherwise turn ./C:x into the drive path C:x.
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new InvalidWorkspaceRelativePathError();
  }
  return normalized;
}

function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

// Unicode category Cc: C0 controls, DEL and C1 controls.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}
