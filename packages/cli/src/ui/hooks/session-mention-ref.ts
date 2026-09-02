/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
  const remainder = pathName.slice(SESSION_MENTION_PREFIX.length).trim();
  if (remainder.length === 0) return null;
  return isSessionId(remainder) ? { id: remainder } : { title: remainder };
}

export function buildSessionRef(idOrTitle: string): string {
  return `${SESSION_MENTION_PREFIX}${idOrTitle}`;
}
