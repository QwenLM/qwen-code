/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('configured paths in core prompts', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('shows the complete user root in memory prompts', async () => {
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', '/tmp/full-root');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();
    const { renderUserMemory } = await import('./snippets.js');

    const expectedRoot = path.join('/tmp/full-root');
    expect(renderUserMemory('remember this')).toContain(
      `Global (${expectedRoot}/)`,
    );
  });

});
