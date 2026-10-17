/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeAll, expect, it, vi } from 'vitest';

const { buildOptions } = vi.hoisted(() => ({ buildOptions: [] }));

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      context: async (options) => {
        buildOptions.push(options);
        return { rebuild: async () => {}, dispose: async () => {} };
      },
    },
  };
});

const packageDir = fileURLToPath(new URL('../', import.meta.url));

beforeAll(async () => {
  await import('../esbuild.js');
  await vi.waitFor(() => expect(buildOptions).toHaveLength(2));
});

it('loads bundled schemas without reading the extension host navigator', async () => {
  const options = buildOptions.find(({ platform }) => platform === 'node');
  const result = await build({
    stdin: {
      contents: `
        import { z } from 'zod/v4';
        export const parsed = z.object({ name: z.string() }).parse({ name: 'qwen' });
        export const probes = [typeof navigator, typeof globalThis.navigator];
      `,
      resolveDir: packageDir,
    },
    bundle: true,
    format: 'cjs',
    platform: options.platform,
    define: options.define,
    write: false,
    logLevel: 'silent',
  });
  const navigatorGetter = vi.fn(() => {
    throw new Error(
      'PendingMigrationError: navigator is now a global in nodejs',
    );
  });
  const sandbox = { module: { exports: {} } };
  Object.defineProperty(sandbox, 'navigator', { get: navigatorGetter });

  runInNewContext(result.outputFiles[0].text, sandbox);

  expect(navigatorGetter).not.toHaveBeenCalled();
  expect(sandbox.module.exports.parsed).toEqual({ name: 'qwen' });
  expect(sandbox.module.exports.probes).toEqual(['undefined', 'undefined']);
  expect(Object.getOwnPropertyDescriptor(sandbox, 'navigator').get).toBe(
    navigatorGetter,
  );
});

it('preserves the browser navigator language fallback in the webview', async () => {
  const options = buildOptions.find(({ platform }) => platform === 'browser');
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: ['src/webview/strings.ts'],
    bundle: true,
    format: 'cjs',
    platform: options.platform,
    define: options.define,
    write: false,
    logLevel: 'silent',
  });
  const sandbox = {
    module: { exports: {} },
    document: { documentElement: { lang: '' } },
    navigator: { language: 'zh-CN' },
  };

  runInNewContext(result.outputFiles[0].text, sandbox);

  expect(sandbox.module.exports.readLanguage()).toBe('zh-CN');
});
