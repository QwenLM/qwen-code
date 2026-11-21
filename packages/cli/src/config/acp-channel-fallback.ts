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
 * (`packages/desktop/src-tauri/src/runtime.rs`) and daemon children
 * inherit the marker; those sessions report `channel=desktop`, the same
 * client identity the Electron desktop passes explicitly.
 *
 * The Managed Agent's session host is the Hosted Harness daemon
 * (`qwen serve --profile hosted-harness`). It stamps
 * `QWEN_CODE_MANAGED_RUNTIME=1` into its own environment at boot (see
 * `cli/src/serve/run-qwen-serve.ts`), so both its in-process Hosted turns
 * and any `qwen --acp` child it spawns report `channel=managed` instead of
 * `daemon`. The marker is also resolved by `loadCliConfig` for the
 * synthesized per-turn argv the Hosted loop builds, which never passes
 * through `parseArguments`.
 *
 * A `qwen --acp` child cannot otherwise tell it was daemon-spawned: direct
 * ACP integrations (VS Code companion, Electron desktop, third parties)
 * spawn the same command line.
 */

export const QWEN_CODE_SERVE_ENV = 'QWEN_CODE_SERVE';
export const QWEN_CODE_DESKTOP_ENV = 'QWEN_CODE_DESKTOP';
export const QWEN_CODE_MANAGED_RUNTIME_ENV = 'QWEN_CODE_MANAGED_RUNTIME';

export function resolveAcpChannelFallback(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // The Managed marker wins: the Hosted Harness is a daemon too, but the
  // Managed Agent deployment is the finer-grained identity.
  if (env[QWEN_CODE_MANAGED_RUNTIME_ENV] === '1') {
    return 'managed';
  }
  // The desktop marker wins over the serve marker: Tauri sessions are
  // daemon-spawned too, but the launcher identity is the finer-grained
  // signal.
  if (env[QWEN_CODE_DESKTOP_ENV] === '1') {
    return 'desktop';
  }
  if (env[QWEN_CODE_SERVE_ENV] === '1') {
    return 'daemon';
  }
  return 'ACP';
}
