/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** `codeMode.mode`: `off` hides the tool, `on` keeps direct tools, `only` routes supported tools through scripts. */
export type CodeModeSetting = 'off' | 'on' | 'only';
export type CodeModeExposure = Exclude<CodeModeSetting, 'off'>;

// Match the desktop/server targets shipped by Node and Bun. HarmonyOS uses a
// separate runtime and remains excluded until its Worker/WASM path is supported.
export function isCodeModeSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    ['darwin', 'linux', 'win32'].includes(platform) &&
    ['x64', 'arm64'].includes(arch) &&
    // Keep this literal read: release builds inline the OHOS flag via define.
    process.env['CLI_OHOS_BUILD'] !== 'true'
  );
}

export function resolveCodeModeExposure(
  settings: unknown,
  defaultMode: CodeModeSetting = 'off',
): CodeModeExposure | undefined {
  const mode =
    settings && typeof settings === 'object' && 'mode' in settings
      ? settings.mode
      : undefined;
  const effectiveMode = mode === undefined ? defaultMode : mode;
  return effectiveMode === 'on' || effectiveMode === 'only' ? effectiveMode : undefined;
}
