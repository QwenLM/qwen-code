/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function getDefaultShellPager(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === 'win32' ? undefined : 'cat';
}

export function getShellPagerEnv(
  pager: string | undefined,
  options: {
    includeGitPager?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): NodeJS.ProcessEnv {
  const effectivePager = pager ?? getDefaultShellPager(options.platform);
  if (!effectivePager) {
    return {
      PAGER: undefined,
      ...(options.includeGitPager ? { GIT_PAGER: undefined } : {}),
    };
  }

  return {
    PAGER: effectivePager,
    ...(options.includeGitPager ? { GIT_PAGER: effectivePager } : {}),
  };
}
