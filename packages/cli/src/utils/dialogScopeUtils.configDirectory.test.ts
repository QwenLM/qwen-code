/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('dialog scope config directory display', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shows the physical user root and selected project directory', async () => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();

    const { SettingScope } = await import('../config/settings.js');
    const { SCOPE_DESCRIPTIONS } = await import('./dialogScopeUtils.js');

    expect(SCOPE_DESCRIPTIONS[SettingScope.User]).toContain(
      path.join('/tmp/full-root', 'settings.json'),
    );
    expect(SCOPE_DESCRIPTIONS[SettingScope.User]).not.toContain('~/abc');
    expect(SCOPE_DESCRIPTIONS[SettingScope.Project]).toContain(
      './abc/settings.json',
    );
  });
});
