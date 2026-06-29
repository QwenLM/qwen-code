/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  findServeFastPathBundleOffenders,
  formatServeFastPathBundleOffenders,
  normalizeMetafilePath,
} from '../check-serve-fast-path-bundle.js';

function makeMetafile(outputs) {
  return { outputs };
}

function output({ inputs = [], imports = [], bytes = 1 } = {}) {
  return {
    bytes,
    inputs: Object.fromEntries(
      inputs.map((input) => [input, { bytesInOutput: 1 }]),
    ),
    imports,
  };
}

function staticImport(path) {
  return { path, kind: 'import-statement' };
}

function dynamicImport(path) {
  return { path, kind: 'dynamic-import' };
}

describe('serve fast-path bundle check', () => {
  it('reports forbidden source files reached through static imports', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
        imports: [staticImport('dist/chunks/acp-runtime.js')],
      }),
      'dist/chunks/acp-runtime.js': output({
        bytes: 179_129,
        inputs: ['packages/acp-bridge/src/bridgeClient.ts'],
      }),
    });

    const offenders = findServeFastPathBundleOffenders(metafile);
    const diagnostic = formatServeFastPathBundleOffenders(offenders);

    expect(offenders).toEqual([
      expect.objectContaining({
        label: 'ACP bridge client runtime',
        matchedInput: 'packages/acp-bridge/src/bridgeClient.ts',
        outputPath: 'dist/chunks/acp-runtime.js',
        bytes: 179_129,
        importPath: [
          'dist/chunks/run-qwen-serve.js',
          'dist/chunks/acp-runtime.js',
        ],
      }),
    ]);
    expect(diagnostic).toContain('- ACP bridge client runtime');
    expect(diagnostic).toContain(
      'output: dist/chunks/acp-runtime.js (179129 bytes)',
    );
    expect(diagnostic).toContain(
      'static path: dist/chunks/run-qwen-serve.js -> dist/chunks/acp-runtime.js',
    );
  });

  it('allows forbidden runtime files behind dynamic imports', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
        imports: [dynamicImport('dist/chunks/bridge.js')],
      }),
      'dist/chunks/bridge.js': output({
        inputs: ['packages/acp-bridge/src/bridge.ts'],
      }),
    });

    expect(findServeFastPathBundleOffenders(metafile)).toEqual([]);
  });

  it('reports vendor packages reached through the core runtime chunk', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
        imports: [staticImport('dist/chunks/core-runtime.js')],
      }),
      'dist/chunks/core-runtime.js': output({
        bytes: 6_015_919,
        inputs: [
          'packages/core/src/tools/shell.ts',
          'node_modules/.pnpm/glob@10.5.0/node_modules/glob/dist/esm/index.js',
          'node_modules/@iarna/toml/toml.js',
          'node_modules/chokidar/esm/index.js',
          'node_modules/fzf/dist/fzf.es.js',
        ],
      }),
    });

    const offenders = findServeFastPathBundleOffenders(metafile);

    expect(offenders.map((offender) => offender.label)).toEqual([
      'Core shell tool runtime',
      'glob vendor package',
      '@iarna/toml vendor package',
      'chokidar vendor package',
      'fzf vendor package',
    ]);
    expect(offenders[0].importPath).toEqual([
      'dist/chunks/run-qwen-serve.js',
      'dist/chunks/core-runtime.js',
    ]);
  });

  it('matches normalized source suffixes without accepting partial names', () => {
    const metafile = makeMetafile({
      'dist\\chunks\\run-qwen-serve.js': output({
        inputs: ['..\\..\\packages\\cli\\src\\serve\\run-qwen-serve.ts'],
        imports: [staticImport('dist\\chunks\\false-positive.js')],
      }),
      'dist\\chunks\\false-positive.js': output({
        inputs: ['packages/acp-bridge/src/not-bridge.ts'],
      }),
    });

    expect(normalizeMetafilePath('dist\\chunks\\run-qwen-serve.js')).toBe(
      'dist/chunks/run-qwen-serve.js',
    );
    expect(findServeFastPathBundleOffenders(metafile)).toEqual([]);
  });
});
