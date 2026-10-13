/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  const writeLayout = (options: {
    runtime: string;
    withBun?: boolean;
    withNode?: boolean;
    interpreterField?: string;
  }): string => {
    const root = mkdtempSync(path.join(tempRoot, 'pkg-'));
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify(
        options.interpreterField
          ? { runtime: options.runtime, interpreter: options.interpreterField }
          : { runtime: options.runtime },
      ),
    );
    if (options.withBun) {
      mkdirSync(path.join(root, 'bun', 'bin'), { recursive: true });
      writeFileSync(path.join(root, 'bun', 'bin', 'bun'), '#!/bin/sh\n');
      chmodSync(path.join(root, 'bun', 'bin', 'bun'), 0o755);
    }
    if (options.withNode) {
      mkdirSync(path.join(root, 'node', 'bin'), { recursive: true });
      writeFileSync(path.join(root, 'node', 'bin', 'node'), '#!/bin/sh\n');
      chmodSync(path.join(root, 'node', 'bin', 'node'), 0o755);
    }
    mkdirSync(path.join(root, 'lib'), { recursive: true });
    writeFileSync(path.join(root, 'lib', 'worker.js'), 'export {};\n');
    return root;
  };

  const interpreterFor = (root: string): string =>
    path.join(root, 'bun', 'bin', 'bun');

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'runtime-info-test-'));
    resetJsInterpreterCacheForTests();
  });

  afterEach(() => {
    resetJsInterpreterCacheForTests();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to process.execPath when no standalone manifest exists', () => {
    const moduleDir = mkdtempSync(path.join(tempRoot, 'plain-'));
    const modulePath = path.join(moduleDir, 'worker.js');
    writeFileSync(modulePath, 'export {};\n');
    const resolved = getJsInterpreterCommand(pathToFileURL(modulePath).href);
    expect(resolved).toEqual({
      command: process.execPath,
      runtime: isBunRuntime() ? 'bun' : 'node',
    });
  });

  it('resolves the bundled Bun interpreter from a bun-flavor manifest', () => {
    const root = writeLayout({ runtime: 'bun', withBun: true });
    const resolved = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    expect(resolved).toEqual({ command: interpreterFor(root), runtime: 'bun' });
  });

  it('resolves the bundled Node interpreter from a node-flavor manifest', () => {
    const root = writeLayout({ runtime: 'node', withNode: true });
    const resolved = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    expect(resolved).toEqual({
      command: path.join(root, 'node', 'bin', 'node'),
      runtime: 'node',
    });
  });

  it('honours an explicit interpreter field relative to the package root', () => {
    const root = writeLayout({
      runtime: 'bun',
      withBun: true,
      interpreterField: './bun/bin/bun',
    });
    const resolved = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    expect(resolved).toEqual({ command: interpreterFor(root), runtime: 'bun' });
  });

  it('falls back to process.execPath when the declared interpreter is absent', () => {
    const root = writeLayout({ runtime: 'bun', withBun: false });
    const resolved = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    expect(resolved).toEqual({
      command: process.execPath,
      runtime: isBunRuntime() ? 'bun' : 'node',
    });
  });

  it('falls back to process.execPath for an unrecognised runtime value', () => {
    const root = writeLayout({ runtime: 'wat' });
    const resolved = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    expect(resolved.command).toBe(process.execPath);
  });

  it('memoizes the resolution for the process lifetime', () => {
    const root = writeLayout({ runtime: 'bun', withBun: true });
    const first = getJsInterpreterCommand(
      pathToFileURL(path.join(root, 'lib', 'worker.js')).href,
    );
    const second = getJsInterpreterCommand(
      pathToFileURL(path.join(tempRoot, 'unrelated.js')).href,
    );
    expect(second).toEqual(first);
  });
});
