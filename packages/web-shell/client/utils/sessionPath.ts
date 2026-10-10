/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isWebShellPage } from './navigationUrl';

export function inferStandaloneBasePath(pathname: string): string {
  const sessionPath = pathname.match(/^(.*)\/session\/[^/]+\/?$/);
  if (sessionPath) return sessionPath[1];
  const path = pathname.replace(/\/$/, '');
  const lastSlash = path.lastIndexOf('/');
  return isWebShellPage(path.slice(lastSlash + 1))
    ? path.slice(0, lastSlash)
    : path;
}

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
  const basePath = inferStandaloneBasePath(currentPathname);
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
