/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const keys = [
  'BRAND_NAME',
  'BRAND_CLI_NAME',
  'BRAND_CLI_BIN',
  'BRAND_CLI_SLUG',
  'BRAND_NPM_PACKAGE',
  'BRAND_NPM_PACKAGES',
  'BRAND_HOMEBREW_TOKEN',
  'BRAND_ENV_PREFIX',
  'BRAND_FIXED_ENV_PREFIX',
  'BRAND_EVENT_NAMESPACE',
  'BRAND_IGNORE_FILE',
  'BRAND_PLUGIN_META_DIR',
  'BRAND_KEYCHAIN_PREFIX',
  'BRAND_MCP_CLIENT_NAME',
  'BRAND_OAUTH_SERVICE',
  'BRAND_CLI_IDENTIFICATION_ENV_VAR',
];

beforeEach(() => {
  vi.resetModules();
  for (const key of keys) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('defaults to Qwen Code without launch brand fields', async () => {
  const brand = await import('./brand.js');
  expect('BRAND_IS_CN' in brand).toBe(false);
  expect([
    brand.BRAND_NAME,
    brand.BRAND_CLI_NAME,
    brand.BRAND_CLI_BIN,
    brand.BRAND_CLI_SLUG,
  ]).toEqual(['Qwen Code', 'Qwen Code', 'qwen', 'qwen-code']);
  expect(brand.BRAND_NPM_PACKAGES).toEqual(['@qwen-code/qwen-code']);
  expect(brand.BRAND_NPM_PACKAGE).toBe('@qwen-code/qwen-code');
  expect(brand.BRAND_HOMEBREW_TOKEN).toBe('qwen-code');
  expect(brand.BRAND_PLUGIN_META_DIR).toBe('.qwen-plugin');
  expect([
    brand.BRAND_EVENT_NAMESPACE,
    brand.BRAND_EVENT_PREFIX,
    brand.BRAND_IGNORE_FILE,
    brand.BRAND_KEYCHAIN_PREFIX,
    brand.BRAND_MCP_CLIENT_NAME,
    brand.BRAND_OAUTH_SERVICE,
    brand.BRAND_CLI_IDENTIFICATION_ENV_VAR,
  ]).toEqual([
    'qwen',
    'qwen_',
    '.qwenignore',
    'qwen-code',
    'qwen-code',
    'qwen-code-oauth',
    'QWEN_CODE',
  ]);
});

it.each(['.qwen-plugin', '.example-plugin'])(
  'uses the injected plugin metadata directory %s',
  async (metaDir) => {
    vi.stubEnv('BRAND_PLUGIN_META_DIR', metaDir);
    const { BRAND_PLUGIN_META_DIR } = await import('./brand.js');
    expect(BRAND_PLUGIN_META_DIR).toBe(metaDir);
  },
);

it.each([undefined, ''])(
  'defaults to QWEN_ when no prefix is supplied (%j)',
  async (prefix) => {
    vi.stubEnv('BRAND_ENV_PREFIX', prefix);

    const brand = await import('./brand.js');
    expect(brand.BRAND_ENV_PREFIX).toBe('QWEN_');
    expect(brand.BRAND_FIXED_ENV_PREFIX).toBe('QWEN_');
    expect(brand.ENV_PLUGIN_ROOT).toBe('QWEN_PLUGIN_ROOT');
    expect(brand.ENV_PROJECT_DIR).toBe('QWEN_PROJECT_DIR');
    expect(brand.ENV_SKILL_SESSION_ID).toBe('QWEN_SESSION_ID');
    expect(brand.ENV_PROFILING).toBe('QWEN_PROFILING');
    expect(brand.ENV_PROFILE_DIR).toBe('QWEN_PROFILE_DIR');
    expect(brand.ENV_MODEL).toBe('QWEN_MODEL');
    expect(brand.ENV_MCP_INIT_BUDGET_MS).toBe('QWEN_MCP_INIT_BUDGET_MS');
    expect(brand.ENV_WORKER_CWD).toBe('QWEN_WORKER_CWD');
    expect(brand.ENV_PID).toBe('QWEN_PID');
    expect(brand.ENV_CONFIG_DIR).toBe('QWEN_CONFIG_DIR');
    expect(brand.ENV_CLI_HOME).toBe('QWEN_CLI_HOME');
    expect(brand.ENV_FORCE_FILE_STORAGE).toBe('QWEN_FORCE_FILE_STORAGE');
    expect(brand.ENV_INTEGRATION_TEST).toBe('QWEN_CLI_INTEGRATION_TEST');
  },
);

it.each([
  ['global', 'EXAMPLE_'],
  ['cn', 'EXAMPLE_CN_'],
])('uses the injected %s product prefix', async (_site, prefix) => {

  vi.stubEnv('BRAND_ENV_PREFIX', prefix);
  vi.stubEnv('BRAND_FIXED_ENV_PREFIX', 'EXAMPLE_');
  const brand = await import('./brand.js');
  expect(brand.BRAND_ENV_PREFIX).toBe(prefix);
  expect(brand.ENV_MODEL).toBe(`${prefix}MODEL`);
  expect(brand.ENV_MCP_INIT_BUDGET_MS).toBe(`${prefix}MCP_INIT_BUDGET_MS`);
  expect(brand.ENV_WORKER_CWD).toBe(`${prefix}WORKER_CWD`);
  expect(brand.ENV_PLUGIN_ROOT).toBe('EXAMPLE_PLUGIN_ROOT');
  expect(brand.ENV_PROJECT_DIR).toBe('EXAMPLE_PROJECT_DIR');
  expect(brand.ENV_SKILL_SESSION_ID).toBe('EXAMPLE_SESSION_ID');
  expect(brand.ENV_PROFILING).toBe('EXAMPLE_PROFILING');
  expect(brand.ENV_PROFILE_DIR).toBe('EXAMPLE_PROFILE_DIR');
  expect(brand.ENV_PROFILE_LOG_INTERVAL_MS).toBe('EXAMPLE_PROFILE_LOG_INTERVAL_MS');
  expect(brand.ENV_STARTUP_TRACE).toBe('EXAMPLE_STARTUP_TRACE');
  expect(brand.ENV_FAKE_STREAM_DELAY_MS).toBe('EXAMPLE_FAKE_STREAM_DELAY_MS');
  expect(brand.ENV_AGENT_SDK_ENTRYPOINT).toBe('EXAMPLE_AGENT_SDK_ENTRYPOINT');
  expect(brand.ENV_SECURITY_SCAN_SETTINGS_JSON).toBe(
    'EXAMPLE_SECURITY_SCAN_SETTINGS_JSON',
  );
  expect(brand.ENV_SECURITY_SCAN_RULES_FILE).toBe('EXAMPLE_SECURITY_SCAN_RULES_FILE');
  expect(brand.ENV_BUSINESS_SUB_TASK).toBe('EXAMPLE_BUSINESS_SUB_TASK');
  expect(brand.ENV_PID).toBe(`${prefix}PID`);
});

it('keeps the site-independent namespace separate from the site prefix', async () => {
  vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
  const brand = await import('./brand.js');
  expect(brand.BRAND_ENV_PREFIX).toBe('EXAMPLE_');
  expect(brand.ENV_MODEL).toBe('EXAMPLE_MODEL');
  expect(brand.ENV_CONFIG_DIR).toBe('EXAMPLE_CONFIG_DIR');
  expect(brand.ENV_CLI_HOME).toBe('EXAMPLE_CLI_HOME');
  expect(brand.ENV_SHELL_PREFIX).toBe('EXAMPLE_SHELL_PREFIX');
});

it('reads product identity and installation identities before composing prompts', async () => {
  for (const [name, value] of Object.entries({
    BRAND_NAME: '示例产品',
    BRAND_CLI_NAME: 'Example CLI',
    BRAND_CLI_BIN: 'example',
    BRAND_CLI_SLUG: 'example-cli',
    BRAND_NPM_PACKAGE: '@example/cli',
    BRAND_NPM_PACKAGES: '@example/cli,@example-cn/cli',
    BRAND_HOMEBREW_TOKEN: 'example-cli',
    BRAND_EVENT_NAMESPACE: 'example',
    BRAND_IGNORE_FILE: '.exampleignore',
    BRAND_KEYCHAIN_PREFIX: 'example-cli',
    BRAND_MCP_CLIENT_NAME: 'example',
    BRAND_OAUTH_SERVICE: 'example-cli-oauth',
    BRAND_CLI_IDENTIFICATION_ENV_VAR: 'EXAMPLE_CLI',
  })) {
    vi.stubEnv(name, value);
  }
  const brand = await import('./brand.js');
  const { renderMainMandatoryPrefix } = await import(
    '../prompts/mandatory-prefix.js'
  );
  expect([
    brand.BRAND_NAME,
    brand.BRAND_CLI_NAME,
    brand.BRAND_CLI_BIN,
    brand.BRAND_CLI_SLUG,
  ]).toEqual(['示例产品', 'Example CLI', 'example', 'example-cli']);
  expect(brand.BRAND_NPM_PACKAGES).toEqual(['@example/cli', '@example-cn/cli']);
  expect(brand.BRAND_NPM_PACKAGE).toBe('@example/cli');
  expect(brand.BRAND_HOMEBREW_TOKEN).toBe('example-cli');
  expect([
    brand.BRAND_EVENT_NAMESPACE,
    brand.BRAND_EVENT_PREFIX,
    brand.BRAND_IGNORE_FILE,
    brand.BRAND_KEYCHAIN_PREFIX,
    brand.BRAND_MCP_CLIENT_NAME,
    brand.BRAND_OAUTH_SERVICE,
    brand.BRAND_CLI_IDENTIFICATION_ENV_VAR,
  ]).toEqual([
    'example',
    'example_',
    '.exampleignore',
    'example-cli',
    'example',
    'example-cli-oauth',
    'EXAMPLE_CLI',
  ]);
  expect(renderMainMandatoryPrefix()).toContain('You are 示例产品.');
});

it('keeps constants unchanged when the launch environment changes after import', async () => {
  const brand = await import('./brand.js');
  vi.stubEnv('BRAND_NAME', 'Changed');
  vi.stubEnv('BRAND_CLI_SLUG', 'changed');
  vi.stubEnv('BRAND_ENV_PREFIX', 'CHANGED_');
  vi.stubEnv('BRAND_FIXED_ENV_PREFIX', 'CHANGED_');
  expect(brand.BRAND_NAME).toBe('Qwen Code');
  expect(brand.BRAND_CLI_SLUG).toBe('qwen-code');
  expect(brand.BRAND_ENV_PREFIX).not.toBe('CHANGED_');
  expect(brand.ENV_PROFILING).toBe('QWEN_PROFILING');
});

it('reads launch brand fields when running unbundled source', async () => {
  for (const key of keys) vi.stubEnv(key, 'wrong-product');
  vi.stubEnv('CLI_BRAND_NAME', 'Old Qwen');
  vi.stubEnv('CLI_BRAND_ENV_PREFIX', 'OLD_EXAMPLE_');
  const brand = await import('./brand.js');
  expect(brand.BRAND_NAME).toBe('wrong-product');
  expect(brand.BRAND_ENV_PREFIX).toBe('wrong-product');
  expect(brand.BRAND_KEYCHAIN_PREFIX).toBe('wrong-product');
  expect(brand.BRAND_IGNORE_FILE).toBe('wrong-product');
});

it('freezes the derived package list before the launch environment changes', async () => {
  vi.stubEnv('BRAND_NPM_PACKAGES', '@example/cli');
  const brand = await import('./brand.js');
  vi.stubEnv('BRAND_NPM_PACKAGES', '@other/cli');
  expect(brand.BRAND_NPM_PACKAGES).toEqual(['@example/cli']);
  expect(Object.isFrozen(brand.BRAND_NPM_PACKAGES)).toBe(true);
});

it('uses the product name when no separate CLI name is supplied', async () => {
  vi.stubEnv('BRAND_NAME', 'Example');
  expect((await import('./brand.js')).BRAND_CLI_NAME).toBe('Example');
});
