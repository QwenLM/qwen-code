/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from './config.js';

vi.mock('../plugins/pluginDirectories.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugins/pluginDirectories.js')>()),
  getPluginDataDir: () => '/data/demo',
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ['Qwen', 'global', 'QWEN_', 'QWEN_'],
  ['Example', 'global', 'EXAMPLE_', 'EXAMPLE_'],
  ['ExampleCN', 'cn', 'EXAMPLE_CN_', 'EXAMPLE_'],
])(
  'uses %s protocol names for substitution and subprocess environments',
  async (_product, _site, sitePrefix, prefix) => {

    vi.stubEnv('BRAND_ENV_PREFIX', sitePrefix);
    vi.stubEnv('BRAND_FIXED_ENV_PREFIX', prefix);
    vi.resetModules();
    const brand = await import('./brand.js');
    const { substitutePluginVariables } = await import(
      '../plugins/configuration/pluginOptionsStorage.js'
    );
    const { substituteSkillBody } = await import(
      '../utils/argumentSubstitution.js'
    );
    const { getPluginEnvironment } = await import(
      '../mcp/connector/transport/support.js'
    );
    const { HookRunner } = await import('../hooks/hookRunner.js');
    const variable = (suffix: string) => '${' + prefix + suffix + '}';

    expect([
      brand.ENV_PROJECT_DIR,
      brand.ENV_PLUGIN_ROOT,
      brand.ENV_PLUGIN_DATA,
      brand.ENV_SKILL_DIR,
      brand.ENV_SKILL_SESSION_ID,
      brand.ENV_SKILL_CONFIG_DIR,
      brand.ENV_SKILL_USER_CONFIG_DIR,
    ]).toEqual(
      [
        'PROJECT_DIR',
        'PLUGIN_ROOT',
        'PLUGIN_DATA',
        'SKILL_DIR',
        'SESSION_ID',
        'CONFIG_DIR',
        'USER_CONFIG_DIR',
      ].map((name) => prefix + name),
    );
    expect(
      substitutePluginVariables(
        variable('PLUGIN_ROOT') + ' ' + variable('PLUGIN_DATA'),
        { path: '/plugins/demo', pluginId: 'demo' },
      ),
    ).toBe('/plugins/demo /data/demo');
    expect(
      substituteSkillBody(
        { body: variable('SKILL_DIR') + '/script ' + variable('SESSION_ID') },
        { skillDir: '/skills/demo', sessionId: 'session-demo' },
      ),
    ).toBe('/skills/demo/script session-demo');
    const env = getPluginEnvironment({
      name: 'demo',
      id: 'demo',
      path: '/plugins/demo',
    });
    expect(env[brand.ENV_PLUGIN_ROOT]).toBe('/plugins/demo');
    expect(env[brand.ENV_PLUGIN_DATA]).toBe('/data/demo');
    class ProbeRunner extends HookRunner {
      readEnvironment() {
        return this.prepareEnv('/project/demo');
      }
    }
    const runner = new ProbeRunner({
      sanitizationConfig: { enableEnvironmentVariableRedaction: false },
    } as Config);
    expect((await runner.readEnvironment())[brand.ENV_PROJECT_DIR]).toBe(
      '/project/demo',
    );

    const other =
      prefix === 'QWEN_' ? '${EXAMPLE_PLUGIN_ROOT}' : '${QWEN_PLUGIN_ROOT}';
    expect(substitutePluginVariables(other, { path: '/plugins/demo' })).toBe(
      other,
    );
  },
);
