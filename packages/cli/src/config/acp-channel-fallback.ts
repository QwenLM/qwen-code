/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Channel fallback for `--acp` launches without an explicit `--channel`.
 *
 * The daemon marks every child it spawns with `QWEN_CODE_SERVE=1` (see
 * `acp-bridge/src/spawnChannel.ts` and
 * `cli/src/serve/channel-worker-supervisor.ts`), so a daemon-spawned
 * `qwen --acp` child reports `channel=daemon` instead of the generic `ACP`.
 * The Tauri desktop shell launches `qwen serve` with `QWEN_CODE_DESKTOP=1`
 * (`packages/desktop-shell/src-tauri/src/runtime.rs`) and daemon children
 * inherit the marker; those sessions report `channel=desktop`, the same
 * client identity the Electron desktop passes explicitly.
 *
 * A `qwen --acp` child cannot otherwise tell it was daemon-spawned: direct
 * ACP integrations (VS Code companion, Electron desktop, third parties)
 * spawn the same command line.
 */

export const QWEN_CODE_SERVE_ENV = 'QWEN_CODE_SERVE';
export const QWEN_CODE_DESKTOP_ENV = 'QWEN_CODE_DESKTOP';

export function resolveAcpChannelFallback(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // The desktop marker wins: Tauri sessions are daemon-spawned too, but the
  // launcher identity is the finer-grained signal.
  if (env[QWEN_CODE_DESKTOP_ENV] === '1') {
    return 'desktop';
  }
  if (env[QWEN_CODE_SERVE_ENV] === '1') {
    return 'daemon';
  }
  return 'ACP';
}
