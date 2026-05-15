/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The set of `--hostname` values that are treated as loopback. Both the
 * runner (boot-time auth-required check) and the request middleware (Host
 * header allowlist) consult this; keeping the set in one place prevents the
 * two from drifting apart.
 *
 * IPv6 loopback is included so users who prefer `::1`/`[::1]` don't have to
 * configure a token. We compare against the raw hostname string the operator
 * typed, not the resolved interface — both must be loopback for the bind to
 * be auth-free.
 */
export const LOOPBACK_BINDS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

export function isLoopbackBind(hostname: string): boolean {
  // Lowercase the operator-supplied hostname so `--hostname Localhost`
  // / `--hostname LOCALHOST` are treated identically to `localhost`.
  // The Host-header allowlist (auth.ts) already lowercases the
  // request-side string before comparing; this aligns boot-time
  // detection with the runtime check so a valid loopback bind isn't
  // forced to require a token just because the operator typed a
  // capital. All entries in `LOOPBACK_BINDS` are already lowercase.
  return LOOPBACK_BINDS.has(hostname.toLowerCase());
}
