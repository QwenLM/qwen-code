/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkAcpImportBoundary,
  checkServeFastPathBundle,
  findAcpImportBoundaryOffenders,
  findServeFastPathBundleOffenders,
  formatServeFastPathBundleOffenders,
  normalizeMetafilePath,
} from '../check-serve-fast-path-bundle.js';

const checkScriptPath = fileURLToPath(
  new URL('../check-serve-fast-path-bundle.js', import.meta.url),
);

function makeMetafile(outputs) {
  return {
    outputs: {
      'dist/chunks/fast-path.js': output({
        inputs: ['packages/cli/src/serve/fast-path.ts'],
      }),
      'dist/chunks/fast-path-settings.js': output({
        inputs: ['packages/cli/src/serve/fast-path-settings.ts'],
      }),
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
      }),
      'dist/chunks/acp-agent.js': output({
        inputs: ['packages/cli/src/acp-integration/acpAgent.ts'],
      }),
      ...outputs,
    },
  };
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

function writeMetafile(tempDir, metafile) {
  mkdirSync(join(tempDir, 'dist'));
  const metafilePath = join(tempDir, 'dist', 'esbuild.json');
  writeFileSync(metafilePath, JSON.stringify(metafile));
  return metafilePath;
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

  it('keeps the ACP startup profiler out of the pre-listen closure', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: [
          'packages/cli/src/serve/run-qwen-serve.ts',
          'packages/cli/src/utils/acp-startup-profiler.ts',
        ],
      }),
    });

    expect(findServeFastPathBundleOffenders(metafile)).toEqual([
      expect.objectContaining({ label: 'ACP startup profiler' }),
    ]);
  });

  it('keeps the Gemini and ACP runtimes out of the pre-listen closure', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: [
          'packages/cli/src/serve/run-qwen-serve.ts',
          'packages/cli/src/gemini.tsx',
          'packages/cli/src/acp-integration/acpAgent.ts',
        ],
      }),
    });

    expect(findServeFastPathBundleOffenders(metafile)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Gemini runtime' }),
        expect.objectContaining({ label: 'ACP agent runtime' }),
      ]),
    );
  });

  it('reports forbidden built package files reached through static imports', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/dist/src/serve/run-qwen-serve.js'],
        imports: [staticImport('dist/chunks/acp-runtime.js')],
      }),
      'dist/chunks/acp-runtime.js': output({
        inputs: ['packages/acp-bridge/dist/bridge.js'],
      }),
    });

    expect(findServeFastPathBundleOffenders(metafile)).toEqual([
      expect.objectContaining({
        label: 'ACP bridge runtime',
        matchedInput: 'packages/acp-bridge/dist/bridge.js',
      }),
    ]);
  });

  it('checks fast-path modules that run before runQwenServe listens', () => {
    const metafile = makeMetafile({
      'dist/chunks/fast-path.js': output({
        inputs: ['packages/cli/src/serve/fast-path.ts'],
        imports: [staticImport('dist/chunks/core-runtime.js')],
      }),
      'dist/chunks/core-runtime.js': output({
        inputs: ['packages/core/dist/src/tools/shell.js'],
      }),
    });

    const offenders = findServeFastPathBundleOffenders(metafile);

    expect(offenders).toEqual([
      expect.objectContaining({
        label: 'Core shell tool runtime',
        matchedInput: 'packages/core/dist/src/tools/shell.js',
        importPath: ['dist/chunks/fast-path.js', 'dist/chunks/core-runtime.js'],
      }),
    ]);
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

  it('ignores external imports in the static closure', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
        imports: [
          {
            path: 'dist/chunks/acp-runtime.js',
            kind: 'import-statement',
            external: true,
          },
        ],
      }),
      'dist/chunks/acp-runtime.js': output({
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
          'node_modules/.pnpm/@iarna+toml@2.2.5/node_modules/@iarna/toml/toml.js',
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

  it('throws when serve pre-listen roots are missing', () => {
    const metafile = {
      outputs: {
        'dist/chunks/unrelated.js': output({
          inputs: ['packages/cli/src/unrelated.ts'],
        }),
      },
    };

    expect(() => findServeFastPathBundleOffenders(metafile)).toThrow(
      /Could not find bundled outputs for serve pre-listen roots/,
    );
    expect(() => findServeFastPathBundleOffenders(metafile)).toThrow(
      /node scripts\/clean-package-build-artifacts\.js && npm run build -- --cli-only && cross-env DEV=true npm run bundle/,
    );
  });

  it('reports each matched input for the same forbidden label and output', () => {
    const metafile = makeMetafile({
      'dist/chunks/run-qwen-serve.js': output({
        inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
        imports: [staticImport('dist/chunks/acp-runtime.js')],
      }),
      'dist/chunks/acp-runtime.js': output({
        inputs: [
          'packages/acp-bridge/src/bridge.ts',
          'packages/acp-bridge/dist/bridge.js',
        ],
      }),
    });

    const offenders = findServeFastPathBundleOffenders(metafile);

    expect(offenders).toEqual([
      expect.objectContaining({
        label: 'ACP bridge runtime',
        matchedInput: 'packages/acp-bridge/src/bridge.ts',
      }),
      expect.objectContaining({
        label: 'ACP bridge runtime',
        matchedInput: 'packages/acp-bridge/dist/bridge.js',
      }),
    ]);
  });

  it('reads a metafile path and returns bundle offenders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'serve-fast-path-bundle-'));
    try {
      const metafilePath = writeMetafile(
        tempDir,
        makeMetafile({
          'dist/chunks/run-qwen-serve.js': output({
            inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
            imports: [staticImport('dist/chunks/acp-runtime.js')],
          }),
          'dist/chunks/acp-runtime.js': output({
            inputs: ['packages/acp-bridge/src/bridge.ts'],
          }),
        }),
      );

      expect(checkServeFastPathBundle({ metafilePath })).toEqual({
        ok: false,
        offenders: [
          expect.objectContaining({
            label: 'ACP bridge runtime',
            matchedInput: 'packages/acp-bridge/src/bridge.ts',
          }),
        ],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws when the checked metafile path is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'serve-fast-path-bundle-'));
    try {
      expect(() =>
        checkServeFastPathBundle({
          metafilePath: join(tempDir, 'dist', 'esbuild.json'),
        }),
      ).toThrow(/Missing esbuild metafile/);
      expect(() =>
        checkServeFastPathBundle({
          metafilePath: join(tempDir, 'dist', 'esbuild.json'),
        }),
      ).toThrow(
        /node scripts\/clean-package-build-artifacts\.js && npm run build -- --cli-only && cross-env DEV=true npm run bundle/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws with context when the metafile is invalid JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'serve-fast-path-bundle-'));
    try {
      mkdirSync(join(tempDir, 'dist'));
      const metafilePath = join(tempDir, 'dist', 'esbuild.json');
      writeFileSync(metafilePath, '{');

      expect(() => checkServeFastPathBundle({ metafilePath })).toThrow(
        /Invalid esbuild metafile at .*dist[/\\]esbuild\.json/,
      );
      expect(() => checkServeFastPathBundle({ metafilePath })).toThrow(
        /Run `node scripts\/clean-package-build-artifacts\.js && npm run build -- --cli-only && cross-env DEV=true npm run bundle` to regenerate it/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero with CLI diagnostics for bundle offenders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'serve-fast-path-bundle-'));
    try {
      writeMetafile(
        tempDir,
        makeMetafile({
          'dist/chunks/run-qwen-serve.js': output({
            inputs: ['packages/cli/src/serve/run-qwen-serve.ts'],
            imports: [staticImport('dist/chunks/acp-runtime.js')],
          }),
          'dist/chunks/acp-runtime.js': output({
            bytes: 179_129,
            inputs: ['packages/acp-bridge/src/bridge.ts'],
          }),
        }),
      );

      expect(() =>
        execFileSync(process.execPath, [checkScriptPath], {
          cwd: tempDir,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow(/Serve fast-path bundle closure includes pre-listen runtime/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the metafile is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'serve-fast-path-bundle-'));
    try {
      expect(() =>
        execFileSync(process.execPath, [checkScriptPath], {
          cwd: tempDir,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow(/Missing esbuild metafile/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('ACP import boundary check', () => {
  it('reports TUI packages reached through static imports', () => {
    const metafile = makeMetafile({
      'dist/chunks/acp-agent.js': output({
        inputs: ['packages/cli/src/acp-integration/acpAgent.ts'],
        imports: [staticImport('dist/chunks/tui.js')],
      }),
      'dist/chunks/tui.js': output({
        bytes: 250_000,
        inputs: [
          'node_modules/ink/build/index.js',
          'node_modules/react/index.js',
          'node_modules/react-reconciler/index.js',
          'node_modules/yoga-layout/dist/src/index.js',
        ],
      }),
    });

    expect(findAcpImportBoundaryOffenders(metafile)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Ink TUI runtime' }),
        expect.objectContaining({ label: 'React runtime' }),
        expect.objectContaining({ label: 'React reconciler runtime' }),
        expect.objectContaining({ label: 'Yoga layout runtime' }),
      ]),
    );
  });

  it('allows TUI packages behind dynamic imports', () => {
    const metafile = makeMetafile({
      'dist/chunks/acp-agent.js': output({
        inputs: ['packages/cli/src/acp-integration/acpAgent.ts'],
        imports: [dynamicImport('dist/chunks/tui.js')],
      }),
      'dist/chunks/tui.js': output({
        inputs: ['node_modules/ink/build/index.js'],
      }),
    });

    expect(findAcpImportBoundaryOffenders(metafile)).toEqual([]);
  });

  it('reads a metafile path and returns ACP boundary offenders', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'acp-import-boundary-'));
    try {
      const metafilePath = writeMetafile(
        tempDir,
        makeMetafile({
          'dist/chunks/acp-agent.js': output({
            inputs: [
              'packages/cli/src/acp-integration/acpAgent.ts',
              'node_modules/ink/build/index.js',
            ],
          }),
        }),
      );

      expect(checkAcpImportBoundary({ metafilePath })).toEqual({
        ok: false,
        offenders: [
          expect.objectContaining({
            label: 'Ink TUI runtime',
            matchedInput: 'node_modules/ink/build/index.js',
          }),
        ],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
