/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('plugin directories with a configured directory name', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the selected default user config directory', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', undefined);
    vi.stubEnv('EXAMPLE_CLI_HOME', '/tmp/test-plugin-home');
    vi.stubEnv('EXAMPLE_PLUGIN_CACHE_DIR', undefined);
    vi.resetModules();

    const { getPluginsDirectory } = await import('./pluginDirectories.js');

    expect(getPluginsDirectory()).toBe(
      path.join('/tmp/test-plugin-home', 'abc', 'plugins'),
    );
  });

  it('preserves the complete user config root override', async () => {

    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', '/tmp/test-full-root');
    vi.stubEnv('EXAMPLE_PLUGIN_CACHE_DIR', undefined);
    vi.resetModules();

    const { getPluginsDirectory } = await import('./pluginDirectories.js');

    expect(getPluginsDirectory()).toBe(
      path.join('/tmp/test-full-root', 'plugins'),
    );
  });
});
