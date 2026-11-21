/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { build as buildBundle } from 'esbuild';
import nodeModule from 'node:module';
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
    vi.restoreAllMocks();
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
    '--experimental-loader=custom-loader.mjs',
    '--require=./preload.cjs',
    '-r ./preload.cjs',
  ])('leaves a custom Node loader in %s alone', (options) => {
    vi.stubEnv('NODE_OPTIONS', options);
    installBundledChunkResolver(entryUrl);
    expect(registerHooks).not.toHaveBeenCalled();
  });

  it('leaves command-line Node loaders alone', () => {
    const original = process.execArgv;
    try {
      process.execArgv = ['--import=custom-loader.mjs'];
      installBundledChunkResolver(entryUrl);
      expect(registerHooks).not.toHaveBeenCalled();
    } finally {
      process.execArgv = original;
    }
  });

  it('supports runtimes without synchronous hooks', () => {
    const original = nodeModule.registerHooks;
    try {
      Object.defineProperty(nodeModule, 'registerHooks', {
        value: undefined,
        configurable: true,
      });
      expect(() => installBundledChunkResolver(entryUrl)).not.toThrow();
      expect(registerHooks).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(nodeModule, 'registerHooks', {
        value: original,
        configurable: true,
      });
    }
  });

  it('pins the generated chunk layout to the production build', async () => {
    const build = fs.readFileSync(
      new URL('../../../../esbuild.config.js', import.meta.url),
      'utf8',
    );
    const chunkDirectory = build.match(
      /const BUNDLE_CHUNK_DIR = '([^']+)'/u,
    )?.[1];
    const chunkTemplate = build.match(/chunkNames: `([^`]+)`/u)?.[1];
    expect(chunkDirectory).toBe('chunks');
    expect(chunkTemplate).toBe('${BUNDLE_CHUNK_DIR}/[name]-[hash]');
    fs.writeFileSync(
      path.join(directory, 'entry.js'),
      'export const load = () => import("./lazy.js");',
    );
    fs.writeFileSync(
      path.join(directory, 'lazy.js'),
      'export const value = 1;',
    );
    const output = await buildBundle({
      entryPoints: [path.join(directory, 'entry.js')],
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      outdir: path.join(directory, 'built'),
      chunkNames: chunkTemplate!.replace(
        '${BUNDLE_CHUNK_DIR}',
        chunkDirectory!,
      ),
      metafile: true,
    });
    const builtEntryUrl = pathToFileURL(
      path.join(directory, 'built', 'entry.js'),
    ).href;
    installBundledChunkResolver(builtEntryUrl);
    expect(registerHooks).toHaveBeenCalledOnce();
    const { resolve } = registerHooks.mock.calls[0]![0];
    const chunks = Object.keys(output.metafile!.outputs).filter((file) =>
      file.includes('/chunks/'),
    );
    expect(chunks.length).toBeGreaterThan(0);
    const fallback = vi.fn();
    for (const chunk of chunks) {
      expect(
        resolve(
          './chunks/' + path.basename(chunk),
          context(builtEntryUrl),
          fallback,
        ),
      ).toMatchObject({ shortCircuit: true });
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('leaves unpackaged CLI entries alone', () => {
    installBundledChunkResolver(new URL('./src/cli.js', entryUrl).href);
    expect(registerHooks).not.toHaveBeenCalled();
  });
});
