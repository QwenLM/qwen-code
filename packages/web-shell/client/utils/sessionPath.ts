/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build the pathname for a standalone session URL while preserving any base
 * path the app is deployed under (e.g. `/app/session/<id>` stays under
 * `/app` instead of being reset to `/session/<id>`). With no session id,
 * returns the base path (or `/` at the root).
 */
export function buildSessionPathname(
  currentPathname: string,
  sessionId: string | undefined,
): string {
  const sessionPath = currentPathname.match(/^(.*)\/session\/[^/]+\/?$/);
  const basePath = sessionPath?.[1] ?? currentPathname.replace(/\/$/, '');
  return sessionId
    ? `${basePath}/session/${encodeURIComponent(sessionId)}`
    : basePath || '/';
}

/**
 * Extract the session id from a standalone pathname. Anchored to the last
 * `/session/<id>` segment so it agrees with `buildSessionPathname`'s greedy
 * writer; a first-match parse would read the literal `session` segment when
 * the base path itself ends in `/session` (e.g. `/app/session/session/<id>`).
 */
export function parseSessionId(pathname: string): string | undefined {
  const match = pathname.match(/\/session\/([^/]+)\/?$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}
