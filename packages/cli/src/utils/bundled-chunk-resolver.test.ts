/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import type { ResolveHook, ResolveHookContext } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBundledChunkResolver } from './bundled-chunk-resolver.js';

const registerHooks = vi.hoisted(() =>
  vi.fn<({ resolve }: { resolve: ResolveHook }) => void>(),
);
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    default: { ...actual, registerHooks },
  };
});

describe('installBundledChunkResolver', () => {
  let directory: string;
  let entryUrl: string;
  const first = 'serve-ABCDEFGH.js';
  const second = 'runtime-01234567.js';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-chunk-index-'));
    entryUrl = pathToFileURL(path.join(directory, 'cli.js')).href;
    fs.mkdirSync(path.join(directory, 'chunks'));
    for (const name of [first, second]) {
      fs.writeFileSync(path.join(directory, 'chunks', name), '');
    }
    registerHooks.mockClear();
    vi.stubEnv('NODE_OPTIONS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function context(parentURL: string): ResolveHookContext {
    return {
      parentURL,
      conditions: [],
      importAttributes: {},
    };
  }

  it('uses the ordinary file URL for packaged entry and sibling imports', () => {
    installBundledChunkResolver(entryUrl);

    const { resolve } = registerHooks.mock.calls[0]![0];
    const fallback = vi.fn();
    const firstUrl = new URL('./chunks/' + first, entryUrl).href;
    const secondUrl = new URL('./chunks/' + second, entryUrl).href;
    expect(resolve('./chunks/' + first, context(entryUrl), fallback)).toEqual({
      url: firstUrl,
      format: 'module',
      shortCircuit: true,
    });
    expect(resolve('./' + second, context(firstUrl), fallback)).toEqual({
      url: secondUrl,
      format: 'module',
      shortCircuit: true,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('delegates external importers, unknown filenames and URL decoration', () => {
    installBundledChunkResolver(entryUrl);

    const { resolve } = registerHooks.mock.calls[0]![0];
    const fallbackResult = { url: 'file:///resolved.js' };
    const fallback = vi.fn(() => fallbackResult);
    const firstUrl = new URL('./chunks/' + first, entryUrl).href;
    const requests = [
      ['./chunks/' + first, 'file:///extension/cli.js'],
      ['./' + second, new URL('./chunks/nested/code.js', entryUrl).href],
      ['./missing-ABCDEFGH.js', firstUrl],
      ['./' + second + '?debug', firstUrl],
      ['node:fs', firstUrl],
    ] as const;
    for (const [specifier, parent] of requests) {
      const importer = context(parent);
      expect(resolve(specifier, importer, fallback)).toBe(fallbackResult);
      expect(fallback).toHaveBeenLastCalledWith(specifier, importer);
    }
  });

  it('delegates symlinked layouts to Node', () => {
    const linkRoot = path.join(directory, 'linked');
    fs.mkdirSync(linkRoot);
    fs.symlinkSync(
      path.join(directory, 'chunks'),
      path.join(linkRoot, 'chunks'),
      'junction',
    );

    installBundledChunkResolver(
      pathToFileURL(path.join(linkRoot, 'cli.js')).href,
    );
    expect(registerHooks).not.toHaveBeenCalled();
  });

  it.each([
    '--import=custom-loader.mjs',
    '"--import=custom-loader.mjs"',
    '--im"port"=custom-loader.mjs',
    '--im"p\\ort"=custom-loader.mjs',
    '--experimental_loader=custom-loader.mjs',
    '-r ./preload.cjs',
  ])('leaves a custom Node loader in %s alone', (options) => {
    vi.stubEnv('NODE_OPTIONS', options);
    installBundledChunkResolver(entryUrl);
    expect(registerHooks).not.toHaveBeenCalled();
  });

  it('leaves unpackaged CLI entries alone', () => {
    installBundledChunkResolver(new URL('./src/cli.js', entryUrl).href);
    expect(registerHooks).not.toHaveBeenCalled();
  });
});
