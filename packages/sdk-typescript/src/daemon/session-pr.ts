/**
 * @license
 * Copyright 2025 Alibaba Group Holding Limited. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0
 */

import type { DaemonSessionIssueInfo, DaemonSessionPrInfo } from './types.js';

/** Upper bound for a bound PR URL; generous for enterprise hosts + long paths. */
export const MAX_SESSION_PR_URL_LENGTH = 2048;

// Mirrors the bridge's hasControlCharacter (ESLint forbids control-char
// regexes).
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/**
 * PR and issue urls are rendered as link targets, so only http(s) URLs are
 * accepted. The daemon interpolates the url into a stderr audit line —
 * control characters would forge log lines downstream of this gate.
 */
function isBindingUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SESSION_PR_URL_LENGTH &&
    /^https?:\/\//i.test(value) &&
    !hasControlCharacter(value)
  );
}

function isDaemonSessionIssueInfo(
  value: unknown,
): value is DaemonSessionIssueInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    isBindingUrl(v['url']) &&
    (v['state'] === undefined ||
      v['state'] === 'open' ||
      v['state'] === 'completed' ||
      v['state'] === 'not_planned')
  );
}

/** Runtime guard for a session PR binding received from the daemon. */
export function isDaemonSessionPrInfo(
  value: unknown,
): value is DaemonSessionPrInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    isBindingUrl(v['url']) &&
    (v['state'] === undefined ||
      v['state'] === 'open' ||
      v['state'] === 'merged' ||
      v['state'] === 'closed') &&
    (v['issues'] === undefined ||
      (Array.isArray(v['issues']) &&
        v['issues'].every(isDaemonSessionIssueInfo)))
  );
}
