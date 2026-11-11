/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Special device paths — targets that accept writes without touching the real
 * filesystem, so a redirect to one is not a write for permission purposes.
 *
 * Lives in utils rather than with the permission checks because shell command
 * parsing needs it too, and the two used to import each other.
 */

const SPECIAL_DEVICE_PATHS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/tty',
]);

/**
 * Whether a resolved path or raw redirection target points at a special device.
 * Redirects to these bypass workspace boundary checks, dangerous path detection
 * and write validation.
 */
export function isSpecialDeviceTarget(target: string): boolean {
  if (!target) {
    return false;
  }
  if (SPECIAL_DEVICE_PATHS.has(target)) {
    return true;
  }
  // /dev/fd/N
  if (/^\/dev\/fd\/\d+$/.test(target)) {
    return true;
  }
  // Windows NUL, case-insensitive, including drive and backslash forms.
  const upper = target.toUpperCase();
  if (upper === 'NUL' || upper.endsWith('\\NUL') || upper === '/DEV/NULL') {
    return true;
  }
  return false;
}
