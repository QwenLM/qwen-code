/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const brand = vi.hoisted(() => ({ prefix: 'QWEN_' }));
vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/core')>()),
  get BRAND_FIXED_ENV_PREFIX() {
    return brand.prefix;
  },
}));

async function readPolicy(prefix: string, env: NodeJS.ProcessEnv) {
  brand.prefix = prefix;
  // The environment variable name is derived once when the module is loaded.
  vi.resetModules();
  const { readPrintBackgroundWindDownPolicy } = await import(
    './backgroundWindDownPolicy.js'
  );
  return readPrintBackgroundWindDownPolicy(env);
}

afterEach(() => vi.resetModules());

describe.each([
  ['QWEN_', 'QWENCLI_PRINT_BG_WAIT_CEILING_MS', 'EXAMPLECLI_PRINT_BG_WAIT_CEILING_MS'],
  ['EXAMPLE_', 'EXAMPLECLI_PRINT_BG_WAIT_CEILING_MS', 'QWENCLI_PRINT_BG_WAIT_CEILING_MS'],
])('print background wait policy for %s', (prefix, envName, otherBrandEnvName) => {
  it.each([undefined, '', '10s', '-1', '1.5', ' 30000 ', '99999999999999999999'])(
    'retains the default hard bound for unset or invalid value %j',
    async (raw) => {
      expect(await readPolicy(prefix, { [envName]: raw })).toEqual({
        waitCeilingMs: 600_000,
        boundMs: 10_000,
      });
    },
  );

  it.each([
    ['0', 0],
    ['1500', 1500],
    ['30000', 30_000],
    ['1800000', 1_800_000],
  ])('uses explicit value %s without the default hard bound', async (raw, expected) => {
    expect(await readPolicy(prefix, { [envName]: raw })).toEqual({
      waitCeilingMs: expected,
    });
  });

  it('ignores the other brand variable', async () => {
    expect(await readPolicy(prefix, { [otherBrandEnvName]: '30000' })).toEqual({
      waitCeilingMs: 600_000,
      boundMs: 10_000,
    });
  });
});
