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
