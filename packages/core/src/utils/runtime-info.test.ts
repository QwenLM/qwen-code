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

  const interpreterPath = (root: string, runtime: 'bun' | 'node'): string =>
    process.platform === 'win32'
      ? path.join(root, runtime, `${runtime}.exe`)
      : path.join(root, runtime, 'bin', runtime);

  const writeExecutable = (filePath: string, executable = true): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '#!/bin/sh\n');
    chmodSync(filePath, executable ? 0o755 : 0o644);
  };

  // A standalone install root: manifest + entry marker + interpreter.
  // With `marker: false` it deliberately omits `lib/cli-entry.js` so the
  // trust-anchor rejection can be observed in isolation.
  const writeStandaloneLayout = (options: {
    manifest: Record<string, unknown>;
    withBun?: boolean;
    withNode?: boolean;
    interpreterTarget?: 'non-executable';
    marker?: boolean;
  }): string => {
    const root = mkdtempSync(path.join(tempRoot, 'pkg-'));
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify(options.manifest),
    );
    for (const runtime of ['bun', 'node'] as const) {
      if (runtime === 'bun' ? options.withBun : options.withNode) {
        writeExecutable(
          interpreterPath(root, runtime),
          options.interpreterTarget !== 'non-executable',
        );
      }
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
      command: interpreterPath(root, 'bun'),
      runtime: 'bun',
    });
  });

  it('resolves the bundled Node interpreter from a trusted node-flavor layout', () => {
    const root = writeStandaloneLayout({
      manifest: { runtime: 'node' },
      withNode: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual({
      command: interpreterPath(root, 'node'),
      runtime: 'node',
    });
  });

  it('honours an explicit interpreter field relative to the package root', () => {
    const root = writeStandaloneLayout({
      manifest: {
        runtime: 'bun',
        interpreter:
          process.platform === 'win32' ? './bun/bun.exe' : './bun/bin/bun',
      },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual({
      command: interpreterPath(root, 'bun'),
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
    mkdirSync(path.join(host, 'lib'), { recursive: true });
    writeFileSync(path.join(host, 'lib', 'cli-entry.js'), 'export {};\n');
    writeFileSync(
      path.join(host, 'manifest.json'),
      JSON.stringify({
        runtime: 'bun',
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
    writeExecutable(interpreterPath(host, 'bun'));
    mkdirSync(path.join(host, 'lib'), { recursive: true });
    writeFileSync(path.join(host, 'lib', 'cli-entry.js'), 'export {};\n');
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
      manifest: {
        runtime: 'bun',
        interpreter: process.platform === 'win32' ? './bun' : './bun/bin',
      },
      withBun: true,
    });
    expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
  });

  it.each(['bun', 'node'] as const)(
    'falls back when the declared %s interpreter is not executable',
    { skip: process.platform === 'win32' },
    (runtime) => {
      const root = writeStandaloneLayout({
        manifest: { runtime },
        withBun: true,
        withNode: true,
        interpreterTarget: 'non-executable',
      });
      expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
    },
  );

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

  it.each(['{', '{"runtime":"bun",', ''])(
    'falls back on malformed manifest %j',
    (contents) => {
      const root = writeStandaloneLayout({
        manifest: { runtime: 'bun' },
        withBun: true,
      });
      writeFileSync(path.join(root, 'manifest.json'), contents);
      expect(() => resolvedFor(root, 'lib/worker.js')).not.toThrow();
      expect(resolvedFor(root, 'lib/worker.js')).toEqual(execPathFallback());
    },
  );

  it.each(['bun', 'node'] as const)(
    'resolves %s from a standalone lib/chunks entry',
    (runtime) => {
      const root = writeStandaloneLayout({
        manifest: { runtime },
        withBun: true,
        withNode: true,
      });
      expect(resolvedFor(root, 'lib/chunks/worker.js')).toEqual({
        command: interpreterPath(root, runtime),
        runtime,
      });
    },
  );

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
