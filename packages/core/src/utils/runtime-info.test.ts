/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getJsInterpreterCommand,
  isBunRuntime,
  resetJsInterpreterCacheForTests,
} from './runtime-info.js';

describe('isBunRuntime', () => {
  it('reports the current process runtime', () => {
    // The unit suite runs under Node (repo tooling stays on Node this phase).
    expect(isBunRuntime()).toBe(typeof process.versions['bun'] === 'string');
    expect(isBunRuntime()).toBe(false);
  });
});

describe('getJsInterpreterCommand', () => {
  let tempRoot: string;

  const writeExecutable = (filePath: string): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '#!/bin/sh\n');
    chmodSync(filePath, 0o755);
  };

  // A standalone install root: manifest + entry marker + interpreter.
  // With `marker: false` it deliberately omits `lib/cli-entry.js` so the
  // trust-anchor rejection can be observed in isolation.
  const writeStandaloneLayout = (options: {
    manifest: Record<string, unknown>;
    withBun?: boolean;
    withNode?: boolean;
    interpreterTarget?: 'file' | 'directory' | 'non-executable';
    marker?: boolean;
  }): string => {
    const root = mkdtempSync(path.join(tempRoot, 'pkg-'));
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify(options.manifest),
    );
    if (options.withBun) {
      const bunPath = path.join(root, 'bun', 'bin', 'bun');
      mkdirSync(path.dirname(bunPath), { recursive: true });
      writeFileSync(bunPath, '#!/bin/sh\n');
      chmodSync(
        bunPath,
        options.interpreterTarget === 'non-executable' ? 0o644 : 0o755,
      );
    }
    if (options.withNode) {
      writeExecutable(path.join(root, 'node', 'bin', 'node'));
    }
    if (options.marker !== false) {
      mkdirSync(path.join(root, 'lib'), { recursive: true });
      writeFileSync(path.join(root, 'lib', 'cli-entry.js'), 'export {};\n');
    }
    return root;
  };

  const resolvedFor = (root: string, modulePath: string): unknown =>
    getJsInterpreterCommand(pathToFileURL(path.join(root, modulePath)).href);

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'runtime-info-test-'));
    resetJsInterpreterCacheForTests();
  });

  afterEach(() => {
    resetJsInterpreterCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const execPathFallback = (): {
    command: string;
    runtime: 'node' | 'bun';
  } => ({
    command: process.execPath,
    runtime: isBunRuntime() ? 'bun' : 'node',
  });

  it('falls back to process.execPath when no standalone manifest exists', () => {
    const moduleDir = mkdtempSync(path.join(tempRoot, 'plain-'));
    const modulePath = path.join(moduleDir, 'worker.js');
    writeFileSync(modulePath, 'export {};\n');
    expect(resolvedFor(path.dirname(modulePath), 'worker.js')).toEqual(
      execPathFallback(),
    );
  });

  it('resolves the bundled Bun interpreter from a trusted bun-flavor layout', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun' },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual({
      command: path.join(root, 'bun', 'bin', 'bun'),
      runtime: 'bun',
    });
  });

  it('resolves the bundled Node interpreter from a trusted node-flavor layout', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'node' },
      withNode: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual({
      command: path.join(root, 'node', 'bin', 'node'),
      runtime: 'node',
    });
  });

  it('honours an explicit interpreter field relative to the package root', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun', interpreter: './bun/bin/bun' },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual({
      command: path.join(root, 'bun', 'bin', 'bun'),
      runtime: 'bun',
    });
  });

  it('ignores an unrelated ancestor manifest in an npm bundle layout', () => {
    // F1 regression: a real bundled install reads chunks from the npm
    // package root, so the only manifest one level above the bundle dir is
    // `node_modules/@qwen-code/manifest.json` — never a host project's
    // manifest higher up. Place a host manifest that even CLAIMS a valid
    // runtime and interpreter; the host build manifest named in it must
    // never be executed.
    const host = mkdtempSync(path.join(tempRoot, 'host-'));
    const runner = path.join(host, 'custom-runner');
    writeFileSync(runner, '#!/bin/sh\necho UNRELATED_EXECUTABLE_INVOKED\n');
    chmodSync(runner, 0o755);
    writeFileSync(
      path.join(host, 'manifest.json'),
      JSON.stringify({
        name: 'unrelated-sdk-host',
        interpreter: './custom-runner',
      }),
    );
    writeExecutable(
      path.join(
        host,
        'node_modules',
        '@qwen-code',
        'qwen-code',
        'bun',
        'bin',
        'bun',
      ),
    );
    expect(
      resolvedFor(
        path.join(host, 'node_modules', '@qwen-code', 'qwen-code'),
        'chunks/worker.js',
      ),
    ).toEqual(execPathFallback());
  });

  it('ignores an unrelated ancestor manifest for a deep SDK module layout', () => {
    const host = mkdtempSync(path.join(tempRoot, 'sdk-host-'));
    writeFileSync(
      path.join(host, 'manifest.json'),
      JSON.stringify({ runtime: 'bun' }),
    );
    writeExecutable(path.join(host, 'bun', 'bin', 'bun'));
    const packageDir = path.join(
      host,
      'node_modules',
      '@qwen-code',
      'qwen-code-core',
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(path.join(packageDir, 'package.json'), '{"name":"x"}\n');
    expect(
      resolvedFor(
        packageDir,
        path.join('dist', 'src', 'code-mode', 'host-client.js'),
      ),
    ).toEqual(execPathFallback());
  });

  it.each([
    ['object interpreter', { runtime: 'bun', interpreter: { path: 'x' } }],
    ['number interpreter', { runtime: 'bun', interpreter: 42 }],
  ])('falls back on a non-string %s', (_name, manifest) => {
    const root = writeStandaloneLayout({ manifest, withBun: true });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('falls back when the declared interpreter is a directory', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun', interpreter: './bun/bin' },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('falls back when the declared interpreter is not executable', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun' },
      withBun: true,
      interpreterTarget: 'non-executable',
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('falls back when the standard interpreter binary is absent', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun' },
      withBun: false,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('falls back on an unknown runtime even with a valid interpreter', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'deno', interpreter: './bun/bin/bun' },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('falls back when the standalone entry marker is missing', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun' },
      withBun: true,
      marker: false,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('ignores a manifest that is not a JSON object', () => {
    const root = mkdtempSync(path.join(tempRoot, 'scalar-'));
    writeFileSync(path.join(root, 'manifest.json'), '"just-a-string"');
    mkdirSync(path.join(root, 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'lib', 'cli-entry.js'), 'export {};\n');
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it('memoizes the resolution for the process lifetime', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'bun' },
      withBun: true,
    });
    const first = resolvedFor(root, 'lib/worker.js');
    const second = getJsInterpreterCommand(
      pathToFileURL(path.join(tempRoot, 'unrelated.js')).href,
    );
    expect(second).toEqual(first);
  });
});
