/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR_NAME, ENV_CONFIG_DIR } from "./brand.js";

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('BRAND_ENV_PREFIX', undefined);
  vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', undefined);
  vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', undefined);
  for (const name of [
    'QWEN_CONFIG_DIR_NAME',
    'QWEN_CONFIG_DIR',
    ENV_CONFIG_DIR_NAME,
    'QODERCN_CONFIG_DIR_NAME',
    ENV_CONFIG_DIR,
    'QODERCN_CONFIG_DIR',
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('QODERCLI_SITE', 'global');
});

describe('brand config directory defaults', () => {
  it.each(['global', 'cn'])(
    'defaults to .qwen without initialization (%s)',
    async (site) => {
      vi.stubEnv('QODERCLI_SITE', site);
      const paths = await import('../utils/paths.js');
      expect(paths.CONFIG_DIR).toBe('.qwen');
      expect(paths.GLOBAL_CONFIG_DIR).toBe('.qwen');
    },
  );

  it('uses the brand defaults in path constants and their consumers', async () => {
    vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', '.product-cn');
    vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', '.product');
    const paths = await import('../utils/paths.js');
    const { isSettingsPath } = await import('./settingsPathDetector.js');
    const { getCronFilePath } = await import('../cron/cron-tasks.js');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('.product-cn');
    expect(paths.CONFIG_DIR).toBe('.product');
    expect(
      isSettingsPath(path.resolve('workspace', '.product', 'settings.json')),
    ).toBe(true);
    expect(
      isSettingsPath(path.resolve('workspace', '.qwen', 'settings.json')),
    ).toBe(false);
    expect(getCronFilePath('workspace')).toBe(
      path.join('workspace', '.product', 'scheduled_tasks.json'),
    );
  });

  it('keeps environment directory names above the brand defaults', async () => {
    vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', '.product-cn');
    vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', '.product');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', '中文 config');
    const paths = await import('../utils/paths.js');
    expect(paths.GLOBAL_CONFIG_DIR).toBe('中文 config');
    expect(paths.CONFIG_DIR).toBe('中文 config');
  });
});
