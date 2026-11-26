/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import type { Config } from '@qwen-code/core';
import { createCorePluginManager } from '@qwen-code/core/plugin-management';
import type { LoadedSettings } from '../../../config/settings.js';
import { getPluginBrowserCwd } from './pluginBrowserCwd.js';

export function usePluginManager(
  config: Config | null | undefined,
  settings: LoadedSettings,
) {
  const cwd = getPluginBrowserCwd(config);
  return useMemo(
    () =>
      createCorePluginManager(settings, {
        cwd,
        factory: config?.getPluginManagerFactory?.(),
      }),
    [config, settings, cwd],
  );
}
