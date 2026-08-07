/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stable runtime and client attribution for the default usage-statistics
 * payload (see `qwen-logger.ts`).
 *
 * - `runtime` identifies the execution runtime owning the process:
 *   `cli` (interactive/headless), `acp` (direct `--acp` launch), or
 *   `daemon` (child spawned by `qwen serve`).
 * - `client` identifies the originating first-party client when one is
 *   known, and is otherwise omitted.
 *
 * Both dimensions are deliberately separate from `properties.channel`
 * (the `--channel` flag value, e.g. `VSCode`/`desktop`/`ACP`) and
 * `app.channel` (the installation source from `source.json`).
 *
 * Daemon detection relies on the `QWEN_CODE_SERVE` marker that the daemon
 * sets on every child it spawns (see `acp-bridge/src/spawnChannel.ts` and
 * `cli/src/serve/channel-worker-supervisor.ts`). A `qwen --acp` child
 * cannot otherwise tell it was daemon-spawned: direct ACP integrations
 * (VS Code companion, Electron desktop, third parties) spawn the same
 * command line.
 */

export const QWEN_CODE_SERVE_ENV = 'QWEN_CODE_SERVE';
export const QWEN_CODE_DESKTOP_ENV = 'QWEN_CODE_DESKTOP';

export type TelemetryRuntimeKind = 'cli' | 'acp' | 'daemon';

/**
 * Resolve the runtime dimension. The daemon marker wins over the channel
 * heuristic: daemon-spawned ACP children fall back to channel `ACP`, which
 * is indistinguishable from a direct third-party ACP launch otherwise.
 */
export function resolveTelemetryRuntime(
  channel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryRuntimeKind {
  if (env[QWEN_CODE_SERVE_ENV]) {
    return 'daemon';
  }
  if (channel) {
    return 'acp';
  }
  return 'cli';
}

/**
 * Resolve the first-party client dimension from the `--channel` value and
 * launcher-provided env markers. Returns `undefined` when no first-party
 * client is identifiable (direct CLI use or an unknown/third-party ACP
 * integration); callers should omit the property in that case.
 */
export function resolveTelemetryClient(
  channel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (channel === 'VSCode') {
    return 'vscode';
  }
  if (channel === 'desktop') {
    return 'desktop';
  }
  // The Tauri desktop shell launches `qwen serve` with QWEN_CODE_DESKTOP=1
  // (packages/desktop-shell/src-tauri/src/runtime.rs); daemon children
  // inherit the marker.
  if (env[QWEN_CODE_DESKTOP_ENV]) {
    return 'desktop-shell';
  }
  return undefined;
}
