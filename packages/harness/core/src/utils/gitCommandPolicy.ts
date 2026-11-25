/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Per-command policy for internal Git operations, never persistent config. */
export function internalGitConfig(
  options: { inspectHooksPath?: boolean } = {},
): string[] {
  return [
    'core.fsmonitor=false',
    // Hook installation must discover the real active path without executing hooks.
    ...(options.inspectHooksPath
      ? []
      : [
          `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        ]),
    'protocol.ext.allow=never',
  ];
}

export function internalGitArgs(
  options: { inspectHooksPath?: boolean } = {},
): string[] {
  return internalGitConfig(options).flatMap((value) => ['-c', value]);
}

/** Avoid background index refreshes; this does not suppress required writes. */
export function internalGitEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...source, GIT_OPTIONAL_LOCKS: '0' };
}
