/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/core';

/** 首次启动与项目重建共用 TUI 的能力开关，必须在 Config 初始化前调用。 */
export async function enableInteractiveConfigFeatures(
  config: Config,
  { localSession }: { localSession: boolean },
): Promise<void> {
  config.enableBuiltinPluginsForTui();
  if (localSession) {
    // Config was loaded before TUI admission. Reload plugins before Skills
    // initialization, both at startup and after a project rebuild.
    await config.reloadPlugins?.();
  }
}
