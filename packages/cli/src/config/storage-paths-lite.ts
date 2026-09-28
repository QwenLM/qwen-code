/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';

// Keep this literal in sync with core's QWEN_DIR. This lite module must not
// import @qwen-code/qwen-code-core because it runs before serve listener ready.
export const SETTINGS_DIRECTORY_NAME = '.qwen';

export function resolveConfigPathLite(dir: string, cwd?: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd || process.cwd(), resolved);
  }
  return resolved;
}

export function getGlobalQwenDirLite(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const envDir = env['QWEN_HOME'];
  if (envDir) {
    return resolveConfigPathLite(envDir);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), SETTINGS_DIRECTORY_NAME);
  }
  return path.join(homeDir, SETTINGS_DIRECTORY_NAME);
}

export function getSystemSettingsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (env['QWEN_CODE_SYSTEM_SETTINGS_PATH']) {
    return env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  }
  if (os.platform() === 'darwin') {
    return '/Library/Application Support/QwenCode/settings.json';
  }
  if (os.platform() === 'win32') {
    return 'C:\\ProgramData\\qwen-code\\settings.json';
  }
  return '/etc/qwen-code/settings.json';
}

export function getSystemDefaultsPath(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']) {
    return env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];
  }
  return path.join(
    path.dirname(getSystemSettingsPath(env)),
    'system-defaults.json',
  );
}
