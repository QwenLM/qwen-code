/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Opts a macOS daemon back into the native Qwen Live Host. */
export const LIVE_NATIVE_HOST_ENV = 'QWEN_LIVE_NATIVE_HOST';

/**
 * Whether the native Qwen Live Host may attach. Live runs through the Web
 * Shell browser endpoint on every platform by default; the native macOS Host
 * (its `/live/host` ingress, `realtime_voice` capability and installer) is
 * opt-in with `QWEN_LIVE_NATIVE_HOST=1`. The caller passes the daemon
 * environment, and still applies the macOS-only rule.
 */
export function resolveLiveNativeHostEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[LIVE_NATIVE_HOST_ENV] === '1';
}
