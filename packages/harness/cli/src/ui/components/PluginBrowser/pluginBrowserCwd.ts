/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/core';

/** 项目插件的适用范围始终以原项目目录为准。 */
export function getPluginBrowserCwd(
  config: Pick<Config, 'getSessionArtifactProjectRoot'> | null | undefined,
): string {
  return config?.getSessionArtifactProjectRoot() ?? process.cwd();
}
