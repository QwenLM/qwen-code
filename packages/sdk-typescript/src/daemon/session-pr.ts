/**
 * @license
 * Copyright 2025 Alibaba Group Holding Limited. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0
 */

import type { DaemonSessionPrInfo } from './types.js';

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
 * Runtime guard for a session PR binding received from the daemon. The url
 * is rendered as a link target, so only http(s) URLs are accepted.
 */
export function isDaemonSessionPrInfo(
  value: unknown,
): value is DaemonSessionPrInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    typeof v['url'] === 'string' &&
    v['url'].length <= MAX_SESSION_PR_URL_LENGTH &&
    /^https?:\/\//i.test(v['url']) &&
    // The daemon interpolates the url into a stderr audit line — control
    // characters would forge log lines downstream of this gate.
    !hasControlCharacter(v['url'])
  );
}
