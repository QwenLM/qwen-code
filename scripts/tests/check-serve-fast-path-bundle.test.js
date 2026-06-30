/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  checkServeFastPathBundle,
  findServeFastPathBundleOffenders,
  formatServeFastPathBundleOffenders,
  normalizeMetafilePath,
} from '../check-serve-fast-path-bundle.js';

const SERVE_ROOT_INPUTS = {
  'packages/cli/src/serve/fast-path.ts': { bytesInOutput: 1 },
  'packages/cli/src/serve/fast-path-settings.ts': { bytesInOutput: 1 },
  'packages/cli/src/serve/run-qwen-serve.ts': { bytesInOutput: 1 },
};

function output({ inputs = {}, imports = [], bytes = 10 } = {}) {
  return { inputs, imports, bytes };
}

function metafile(outputs) {
  return { outputs };
}

describe('check-serve-fast-path-bundle', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes metafile paths to slash-separated relative paths', () => {
    expect(normalizeMetafilePath('.\\dist\\chunk.js')).toBe('dist/chunk.js');
  });

  it('accepts a clean serve fast-path static closure', () => {
    const offenders = findServeFastPathBundleOffenders(
      metafile({
        'dist/serve-fast-path.js': output({ inputs: SERVE_ROOT_INPUTS }),
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('reports forbidden source files in the static closure', () => {
    const offenders = findServeFastPathBundleOffenders(
      metafile({
        'dist/serve-fast-path.js': output({
          inputs: SERVE_ROOT_INPUTS,
          imports: [{ path: 'dist/chunk.js', kind: 'import-statement' }],
        }),
        'dist/chunk.js': output({
          inputs: {
            'packages/core/src/tools/shell.ts': { bytesInOutput: 1 },
          },
          bytes: 42,
        }),
      }),
    );

    expect(offenders).toMatchObject([
      {
        label: 'Core shell tool runtime',
        matchedInput: 'packages/core/src/tools/shell.ts',
        outputPath: 'dist/chunk.js',
        bytes: 42,
        importPath: ['dist/serve-fast-path.js', 'dist/chunk.js'],
      },
    ]);
  });

  it('reports forbidden vendor packages pulled in transitively', () => {
    const offenders = findServeFastPathBundleOffenders(
      metafile({
        'dist/serve-fast-path.js': output({
          inputs: SERVE_ROOT_INPUTS,
          imports: [{ path: 'dist/a.js', kind: 'import-statement' }],
        }),
        'dist/a.js': output({
          imports: [{ path: 'dist/b.js', kind: 'import-statement' }],
        }),
        'dist/b.js': output({
          inputs: {
            'node_modules/glob/dist/esm/index.js': { bytesInOutput: 1 },
          },
        }),
      }),
    );

    expect(offenders).toMatchObject([
      {
        label: 'glob vendor package',
        matchedInput: 'node_modules/glob/dist/esm/index.js',
        outputPath: 'dist/b.js',
        importPath: ['dist/serve-fast-path.js', 'dist/a.js', 'dist/b.js'],
      },
    ]);
  });

  it('ignores forbidden modules behind dynamic imports', () => {
    const offenders = findServeFastPathBundleOffenders(
      metafile({
        'dist/serve-fast-path.js': output({
          inputs: SERVE_ROOT_INPUTS,
          imports: [{ path: 'dist/lazy.js', kind: 'dynamic-import' }],
        }),
        'dist/lazy.js': output({
          inputs: {
            'packages/acp-bridge/src/bridge.ts': { bytesInOutput: 1 },
          },
        }),
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('throws a descriptive error when serve pre-listen roots are missing', () => {
    expect(() => findServeFastPathBundleOffenders(metafile({}))).toThrow(
      /Could not find bundled outputs for serve pre-listen roots/,
    );
  });

  it('formats offenders with the matched input, output, and static path', () => {
    const formatted = formatServeFastPathBundleOffenders([
      {
        label: 'Core shell tool runtime',
        matchedInput: 'packages/core/src/tools/shell.ts',
        outputPath: 'dist/chunk.js',
        bytes: 42,
        importPath: ['dist/serve-fast-path.js', 'dist/chunk.js'],
      },
    ]);

    expect(formatted).toContain('- Core shell tool runtime');
    expect(formatted).toContain('input: packages/core/src/tools/shell.ts');
    expect(formatted).toContain('output: dist/chunk.js (42 bytes)');
    expect(formatted).toContain(
      'static path: dist/serve-fast-path.js -> dist/chunk.js',
    );
  });

  it('checks a metafile from disk', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qwen-code-metafile-'));
    tempDirs.push(tempDir);
    const metafilePath = join(tempDir, 'esbuild.json');
    writeFileSync(
      metafilePath,
      JSON.stringify(
        metafile({
          'dist/serve-fast-path.js': output({ inputs: SERVE_ROOT_INPUTS }),
        }),
      ),
    );

    expect(checkServeFastPathBundle({ metafilePath })).toEqual({
      ok: true,
      offenders: [],
    });
  });

  it('throws a descriptive error for invalid JSON metafiles', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qwen-code-bad-meta-'));
    tempDirs.push(tempDir);
    const metafilePath = join(tempDir, 'esbuild.json');
    writeFileSync(metafilePath, 'not json');

    expect(() => checkServeFastPathBundle({ metafilePath })).toThrow(
      /Invalid esbuild metafile.*Run `npm run build -- --cli-only && cross-env DEV=true npm run bundle` to regenerate it\./s,
    );
  });
});
