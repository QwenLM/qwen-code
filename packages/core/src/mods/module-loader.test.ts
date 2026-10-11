/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileModModules } from './module-loader.js';
import { ModRuntime } from './runtime.js';
import { loadModSource } from './discovery.js';

describe('confined Mod module graphs', () => {
  let root: string;
  const write = async (file: string, source: string) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), source);
  };
  const input = (source: string, entry = 'entry.ts') => ({
    root,
    entry: path.join(root, entry),
    source,
  });
  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-mod-graph-')),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves extensionless, index, extension substitution and re-exports in CC order', async () => {
    await write('helper.ts', 'export const value = 1;');
    await write('helper.js', 'export const value = 2;');
    await write('dir/index.ts', 'export { value } from "../helper.js";');
    await write('substitute.ts', 'export const extra = 3;');
    await write('pick/index.ts', 'export const pick = 4;');
    await write('pick.js', 'throw new Error("WRONG_PRECEDENCE");');
    await write('index.ts', 'export const value = 0;');
    const indexGraph = await compileModModules(
      input('export { value } from ".";'),
    );
    expect(indexGraph.imports.get(path.join(root, 'entry.ts'))?.get('.')).toBe(
      path.join(root, 'index.ts'),
    );
    const graph = await compileModModules(
      input(
        'import { value } from "./helper"; export { value as indexed } from "./dir"; export { extra } from "./substitute.js"; export { pick } from "./pick"; export { value };',
      ),
    );
    expect(graph.imports.get(path.join(root, 'entry.ts'))).toEqual(
      new Map([
        ['./helper', path.join(root, 'helper.ts')],
        ['./dir', path.join(root, 'dir/index.ts')],
        ['./substitute.js', path.join(root, 'substitute.ts')],
        ['./pick', path.join(root, 'pick/index.ts')],
      ]),
    );
    expect(
      graph.imports.get(path.join(root, 'dir/index.ts'))?.get('../helper.js'),
    ).toBe(path.join(root, 'helper.js'));
    expect([...graph.modules.values()].join('\n')).not.toContain(
      'WRONG_PRECEDENCE',
    );
  });

  it('erases type-only imports without reading them or author build configuration', async () => {
    const probe = vi.spyOn(fs, 'lstat');
    const graph = await compileModModules(
      input(
        'import type { On } from "claude-code"; import type { Missing } from "./missing.js"; export function register(on: On) {}',
      ),
    );
    expect(graph.modules.size).toBe(1);
    expect([...graph.modules.values()][0]).not.toContain('import');
    expect(probe).not.toHaveBeenCalled();
  });

  it('shares canonical entry and import identities on case-insensitive filesystems', async ({
    skip,
  }) => {
    await write('hooks/hooks.json', '{"modules":["./ENTRY.js"]}');
    await write(
      'hooks/state.js',
      'let count = 0; export function next() { return ++count; }',
    );
    await write(
      'hooks/entry.js',
      `import { next as lower } from './state.js';
      import { next as upper } from './STATE.js';
      import { marker as self } from './entry.js';
      export const marker = 'entry';
      export function register(on) {
        on('session.start', async ($, e, next) => { await $.command.register({name:'hello',description:'identity'}); return next(e); });
        on('command.run', {command:'hello'}, () => ({text: lower() + ',' + upper() + ':' + self}));
      }`,
    );
    if (!(await fs.stat(path.join(root, 'hooks/ENTRY.js')).catch(() => false)))
      skip();
    const source = (await loadModSource(root))!;
    expect(source.entry).toBe(path.join(root, 'hooks/entry.js'));
    expect((await compileModModules(source)).modules.size).toBe(2);
    const runtime = await ModRuntime.create(
      source,
      root,
      () => {},
      new AbortController().signal,
    );
    try {
      expect(
        await runtime.runCommand('hello', '', new AbortController().signal),
      ).toBe('1,2:entry');
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])(
    'runs %s as ESM with shared imported state and source cycles inside QuickJS',
    async (suffix) => {
      await write(
        'state.ts',
        'import { marker } from "./cycle.js"; let count: number = 0; export function next() { return marker() + ++count; }',
      );
      await write(
        'cycle.ts',
        'export { next } from "./state.js"; export function marker() { return "call:"; }',
      );
      const source = input(
        `import { next } from './state.js'; import * as again from './state.js'; export function register(on) {
      on('session.start', async ($, e, next) => { await $.command.register({name:'hello',description:'graph'}); return next(e); });
      on('command.run',{command:'hello'}, () => ({text: next() + ',' + again.next() + ':' + typeof process}));
    }`,
        `entry${suffix}`,
      );
      const runtime = await ModRuntime.create(
        source,
        root,
        () => {},
        new AbortController().signal,
      );
      try {
        expect(
          await runtime.runCommand('hello', '', new AbortController().signal),
        ).toBe('call:1,call:2:undefined');
        expect(
          await runtime.runCommand('hello', '', new AbortController().signal),
        ).toBe('call:3,call:4:undefined');
      } finally {
        await runtime.dispose();
      }
    },
  );

  it.each([
    ['import "node:fs";', /relative static/],
    ['import "claude-code";', /relative static/],
    ['import "https://example.invalid/a.js";', /relative static/],
    ['const p = import("./a.js");', /Dynamic import/],
    ['const p = require("fs");', /require/],
    ['import p = require("./a.js");', /require/],
    ['import "./a.json";', /extension/],
    ['import "./a.tsx";', /extension/],
    ['import "../outside.js";', /inside/],
    ['export const broken: =;', /Invalid Mod TypeScript/],
  ])(
    'rejects unsupported code before guest execution: %s',
    async (source, error) => {
      await expect(compileModModules(input(source))).rejects.toThrow(error);
    },
  );

  it('rejects symlinked imports and imported top-level await', async () => {
    await write('real.ts', 'export const value = 1;');
    await fs.symlink(path.join(root, 'real.ts'), path.join(root, 'link.ts'));
    await expect(compileModModules(input('import "./link";'))).rejects.toThrow(
      /symbolic links/,
    );
    await write('async.ts', 'await Promise.resolve(); export const value = 1;');
    await expect(compileModModules(input('import "./async";'))).rejects.toThrow(
      /Top-level await/,
    );
  });

  it.each([
    "export const C = class { [await Promise.resolve('ok')]() {} };",
    "export const value = { [await Promise.resolve('ok')]() {} };",
    'export const C = class extends (await Promise.resolve(Object)) {};',
  ])(
    'rejects imported await evaluated outside a function body: %s',
    async (source) => {
      await write('async.js', source);
      await expect(
        compileModModules(input('import "./async.js";')),
      ).rejects.toThrow(/Top-level await/);
    },
  );

  it('rejects imported top-level await introduced by TypeScript compilation', async () => {
    await write(
      'resource.ts',
      'await using resource = null; export const value = 7;',
    );
    await expect(
      compileModModules(input('import "./resource.js";')),
    ).rejects.toThrow(/Top-level await/);
  });

  it('bounds individual sources, aggregate bytes and graph file count', async () => {
    await write('large.js', ' '.repeat(262_145));
    await expect(
      compileModModules(input('import "./large.js";')),
    ).rejects.toThrow(/256 KiB/);
    await expect(compileModModules(input(' '.repeat(262_145)))).rejects.toThrow(
      /byte limit/,
    );
    for (let i = 0; i < 64; i++)
      await write(`${i}.js`, i === 63 ? '' : `import './${i + 1}.js';`);
    await expect(compileModModules(input('import "./0.js";'))).rejects.toThrow(
      /file or byte limit/,
    );
    for (let i = 0; i < 5; i++)
      await write(`bytes${i}.js`, `/*${' '.repeat(220_000)}*/`);
    await expect(
      compileModModules(
        input(
          Array.from({ length: 5 }, (_, i) => `import './bytes${i}.js';`).join(
            '\n',
          ),
        ),
      ),
    ).rejects.toThrow(/file or byte limit/);
  });

  it('bounds compiled expansion independently of original source bytes', async () => {
    const source =
      'export enum Values {' +
      Array.from({ length: 30_000 }, (_, i) => 'M' + i).join(',') +
      '}';
    expect(Buffer.byteLength(source)).toBeLessThan(262_144);
    await expect(compileModModules(input(source))).rejects.toThrow(
      /Compiled Mod graph/,
    );
  });
});
