/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { unescapeShellSpecials } from '@qwen-code/qwen-code-core/utils/paths.js';

export const SESSION_MENTION_PREFIX = 'session:';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRef {
  id?: string;
  title?: string;
}

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function parseSessionRef(pathName: string): SessionRef | null {
  if (!pathName.startsWith(SESSION_MENTION_PREFIX)) return null;
  // parseAllAtCommands has already unescaped POSIX tokens. On Windows,
  // unescapePath preserves backslashes because they are path separators, so
  // session mentions need the shared shell-special unescaper here instead.
  const rawRemainder = pathName.slice(SESSION_MENTION_PREFIX.length).trim();
  const remainder =
    process.platform === 'win32'
      ? unescapeShellSpecials(rawRemainder)
      : rawRemainder;
  if (remainder.length === 0) return null;
  return isSessionId(remainder) ? { id: remainder } : { title: remainder };
}

export function buildSessionRef(idOrTitle: string): string {
  return `${SESSION_MENTION_PREFIX}${idOrTitle}`;
}
