/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BRAND_ENV_PREFIX,
  BRAND_FIXED_ENV_PREFIX,
  DEFAULT_BUSINESS_PRODUCT,
  DEFAULT_BUSINESS_TYPE,
  DEFAULT_CLIENT_TYPE,
  DEFAULT_SCENE,
  ENV_AGENT_SDK_ENTRYPOINT,
  ENV_BUSINESS_PRODUCT,
  ENV_BUSINESS_SUB_TASK,
  ENV_BUSINESS_TYPE,
  ENV_CLIENT_TYPE,
  ENV_JB_IDE,
  ENV_SCENE,
  getClientMetadata,
  positiveIntegerFromEnv,
} from './brand.js';


async function importBrandForSite(site: 'global' | 'cn') {
  vi.resetModules();

  vi.stubEnv('BRAND_ENV_PREFIX', site === 'cn' ? 'EXAMPLE_CN_' : 'EXAMPLE_');
  vi.stubEnv('BRAND_FIXED_ENV_PREFIX', 'EXAMPLE_');
  return import('./brand.js');
}

describe('business product configuration', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each(['global', 'cn'] as const)('协议 product 在 %s 优先于环境变量且不可变', async (site) => {
    const brand = await importBrandForSite(site);
    const previous = process.env[brand.ENV_BUSINESS_PRODUCT];
    try {
      process.env[brand.ENV_BUSINESS_PRODUCT] = 'legacy-product';
      expect(brand.getClientMetadata().business_product).toBe('legacy-product');
      brand.configureBusinessProduct('app');
      brand.configureBusinessProduct('app');
      expect(brand.getClientMetadata().business_product).toBe('app');
      expect(() => brand.configureBusinessProduct('other')).toThrow('cannot be changed');
    } finally {
      if (previous === undefined) delete process.env[brand.ENV_BUSINESS_PRODUCT];
      else process.env[brand.ENV_BUSINESS_PRODUCT] = previous;
    }
  });
});

describe('positiveIntegerFromEnv', () => {
  const name = 'TEST_POSITIVE_INTEGER';
  afterEach(() => vi.unstubAllEnvs());

  it('returns a configured positive integer', () => {
    vi.stubEnv(name, '7');
    expect(positiveIntegerFromEnv(name, 50)).toBe(7);
  });

  it.each([undefined, '', '0', '-1', '1.5', '50junk', '9007199254740992'])(
    'falls back for %j',
    (value) => {
      vi.stubEnv(name, value);
      expect(positiveIntegerFromEnv(name, 50)).toBe(50);
    },
  );
});

describe('getClientMetadata', () => {
  const originalEnv = {
    ENV_CLIENT_TYPE: process.env[ENV_CLIENT_TYPE],
    ENV_BUSINESS_PRODUCT: process.env[ENV_BUSINESS_PRODUCT],
    ENV_BUSINESS_TYPE: process.env[ENV_BUSINESS_TYPE],
    ENV_SCENE: process.env[ENV_SCENE],
  };

  afterEach(() => {
    for (const [key, value] of [
      [ENV_CLIENT_TYPE, originalEnv.ENV_CLIENT_TYPE],
      [ENV_BUSINESS_PRODUCT, originalEnv.ENV_BUSINESS_PRODUCT],
      [ENV_BUSINESS_TYPE, originalEnv.ENV_BUSINESS_TYPE],
      [ENV_SCENE, originalEnv.ENV_SCENE],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('returns the documented defaults when no env vars are set', () => {
    delete process.env[ENV_CLIENT_TYPE];
    delete process.env[ENV_BUSINESS_PRODUCT];
    delete process.env[ENV_BUSINESS_TYPE];
    delete process.env[ENV_SCENE];

    expect(getClientMetadata()).toEqual({
      client_type: DEFAULT_CLIENT_TYPE,
      business_product: DEFAULT_BUSINESS_PRODUCT,
      business_type: DEFAULT_BUSINESS_TYPE,
      scene: DEFAULT_SCENE,
    });
  });

  it('returns env overrides when set', () => {
    process.env[ENV_CLIENT_TYPE] = '99';
    process.env[ENV_BUSINESS_PRODUCT] = 'work';
    process.env[ENV_BUSINESS_TYPE] = 'chat';
    process.env[ENV_SCENE] = 'assistant';

    expect(getClientMetadata()).toEqual({
      client_type: '99',
      business_product: 'work',
      business_type: 'chat',
      scene: 'assistant',
    });
  });

  it('uses default for any field whose env var is not set', () => {
    delete process.env[ENV_CLIENT_TYPE];
    delete process.env[ENV_BUSINESS_PRODUCT];
    delete process.env[ENV_BUSINESS_TYPE];
    process.env[ENV_SCENE] = 'assistant';

    expect(getClientMetadata()).toEqual({
      client_type: DEFAULT_CLIENT_TYPE,
      business_product: DEFAULT_BUSINESS_PRODUCT,
      business_type: DEFAULT_BUSINESS_TYPE,
      scene: 'assistant',
    });
  });

  it('uses client identity env var names without GEMINI legacy aliases', () => {
    expect(ENV_CLIENT_TYPE).toBe(`${BRAND_ENV_PREFIX}CLIENT_TYPE`);
    expect(ENV_BUSINESS_PRODUCT).toBe(`${BRAND_ENV_PREFIX}BUSINESS_PRODUCT`);
    expect(ENV_BUSINESS_TYPE).toBe(`${BRAND_ENV_PREFIX}BUSINESS_TYPE`);
    expect(ENV_BUSINESS_SUB_TASK).toBe(
      `${BRAND_FIXED_ENV_PREFIX}BUSINESS_SUB_TASK`,
    );
    expect(ENV_SCENE).toBe(`${BRAND_ENV_PREFIX}SCENE`);
  });

  it('uses the site-independent namespace for host integration env vars', () => {
    expect(ENV_AGENT_SDK_ENTRYPOINT).toBe(
      `${BRAND_FIXED_ENV_PREFIX}AGENT_SDK_ENTRYPOINT`,
    );
    expect(ENV_JB_IDE).toBe('JB_IDE');
  });
});

describe('config directory environment names', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['global', 'EXAMPLE_CONFIG_DIR_NAME'],
    ['cn', 'EXAMPLE_CN_CONFIG_DIR_NAME'],
  ] as const)('exports the %s site variable', async (site, expected) => {
    const brand = await importBrandForSite(site);

    expect(brand.ENV_CONFIG_DIR_NAME).toBe(expected);
  });
});

describe('dispatcher brand contracts', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ['global', { envPrefix: 'EXAMPLE_' }],
    ['cn', { envPrefix: 'EXAMPLE_CN_' }],
  ] as const)('exports the %s config identity', async (site, expected) => {
    const brand = await importBrandForSite(site);

    expect(brand.BRAND_ENV_PREFIX).toBe(expected.envPrefix);
  });
});

describe.each(['global', 'cn'] as const)('HOME override (%s)', (site) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses only the current brand home override and ignores the removed alias', async () => {
    const brand = await importBrandForSite(site);
    const {
      homedir,
      getConfigHomeDir,
      getUserConfigDisplayPath,
      _resetConfigHomeDirCache,
    } = await import('../utils/paths.js');
    const os = await import('node:os');
    const path = await import('node:path');
    vi.stubEnv(brand.ENV_CLI_HOME, undefined);
    vi.stubEnv(brand.ENV_CONFIG_DIR, undefined);
    vi.stubEnv('GEMINI_CLI_HOME', path.resolve('legacy home'));
    expect(homedir()).toBe(os.homedir());
    expect(getUserConfigDisplayPath()).toMatch(/^~/);
    const home = path.resolve('中文 home');
    vi.stubEnv(brand.ENV_CLI_HOME, home);
    _resetConfigHomeDirCache();
    expect(homedir()).toBe(home);
    expect(getConfigHomeDir()).toContain(home);
    expect(getUserConfigDisplayPath()).toContain(home);
  });
});
