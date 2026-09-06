/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  spawnMock,
  platformMock,
  existsSyncMock,
  readFileSyncMock,
  writeFileSyncMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn() })),
  platformMock: vi.fn(() => 'darwin'),
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
  writeFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    platform: platformMock,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

vi.mock('node:fs', () => ({
  writeFileSync: writeFileSyncMock,
  mkdtempSync: vi.fn(() => '/tmp/qwen-dev-test'),
  rmSync: vi.fn(),
  existsSync: existsSyncMock,
  symlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: readFileSyncMock,
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/dev.js launcher', () => {
  const originalArgv = process.argv;
  const execPathDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'execPath',
  );

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ['node', 'scripts/dev.js'];
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (execPathDescriptor) {
      Object.defineProperty(process, 'execPath', execPathDescriptor);
    }
  });

  it('spawns Node without a shell on Windows when local tsx cli.mjs exists', async () => {
    platformMock.mockReturnValue('win32');
    existsSyncMock.mockImplementation((filePath) =>
      normalizePath(filePath).endsWith('node_modules/tsx/dist/cli.mjs'),
    );
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: 'C:\\Program Files\\nodejs\\node.exe',
    });
    process.argv = ['node', 'scripts/dev.js', '--help'];

    await import('../dev.js?direct-node');

    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(args.map(normalizePath)).toEqual([
      expect.stringContaining('node_modules/tsx/dist/cli.mjs'),
      expect.stringContaining('packages/cli/index.ts'),
      '--help',
    ]);
    expect(options).toEqual(expect.objectContaining({ shell: false }));
  });

  it('keeps shell fallback for Windows tsx.cmd resolution', async () => {
    platformMock.mockReturnValue('win32');
    existsSyncMock.mockImplementation((filePath) =>
      normalizePath(filePath).endsWith('node_modules/.bin/tsx.cmd'),
    );

    await import('../dev.js?cmd-fallback');

    const [command, args, options] = spawnMock.mock.calls[0];
    expect(normalizePath(command)).toContain('tsx.cmd');
    expect(args.map(normalizePath)).toEqual([
      expect.stringContaining('packages/cli/index.ts'),
    ]);
    expect(options).toEqual(expect.objectContaining({ shell: true }));
  });

  it('re-raises a child signal instead of exiting 0 — close(null, SIGKILL) is not success', async () => {
    // `code ?? 0` read a signal-killed child as green. This launcher is a
    // QWEN_CODE_CLI entry now: an OOM-killed review gate command must not come
    // back as a passing exit.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await import('../dev.js?signal-close');
      const child = spawnMock.mock.results[0].value;
      const close = child.on.mock.calls.find(([ev]) => ev === 'close')[1];
      close(null, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  it('stamps QWEN_CODE_CLI with its own path, overriding an inherited one', async () => {
    // A dev CLI started from inside another qwen session's shell inherits that
    // session's QWEN_CODE_CLI. Honouring it points every `qwen …` subprocess of
    // THIS session at the OUTER session's build — the exact version skew the
    // variable exists to prevent, one level up and silent. Each entry stamps
    // itself; nested sessions each call their own build.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../dev.js?stamps-own-cli');

      const [, , options] = spawnMock.mock.calls[0];
      expect(normalizePath(options.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/dev\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the dev entry executable for QWEN_CODE_CLI subprocesses',
    async () => {
      const fs = await vi.importActual('node:fs');
      expect(() =>
        fs.accessSync(new URL('../dev.js', import.meta.url), fs.constants.X_OK),
      ).not.toThrow();
    },
  );

  it('resolves core subpaths to packages/core/src, not the exports map dist', async () => {
    // Intercepting only the package root leaves a named subpath to Node's
    // `exports` map, which resolves into packages/core/dist while the root
    // loads packages/core/src — one dev process holding two instances of the
    // same module. Config binds the debug session on the src copy, so the dist
    // copy's REMOTE_INPUT logger reads an empty session and every
    // debugLogger(...) call in RemoteInputWatcher silently no-ops.
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const coreDir = join(repoRoot, 'packages', 'core');
    const corePackageJson = await readFile(
      join(coreDir, 'package.json'),
      'utf-8',
    );
    const existsOnDisk = async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    };

    // Ground truth independent of the implementation's derivation rule.
    const expectedSources = {
      '@qwen-code/qwen-code-core': 'packages/core/index.ts',
      '@qwen-code/qwen-code-core/debugLogger':
        'packages/core/src/utils/debugLogger.ts',
      '@qwen-code/qwen-code-core/storage':
        'packages/core/src/config/storage.ts',
      '@qwen-code/qwen-code-core/atomicFileWrite':
        'packages/core/src/utils/atomicFileWrite.ts',
      '@qwen-code/qwen-code-core/utils/debugLogger.js':
        'packages/core/src/utils/debugLogger.ts',
    };

    // Every named subpath the exports map publishes, so the interception
    // cannot silently fall behind as subpaths are added.
    const namedSubpaths = [];
    for (const [subpath, conditions] of Object.entries(
      JSON.parse(corePackageJson).exports ?? {},
    )) {
      const distEntry = conditions?.import;
      if (subpath === '.' || typeof distEntry !== 'string') continue;
      if (!distEntry.startsWith('./dist/')) continue;
      const sourcePath = join(
        coreDir,
        distEntry.slice('./dist/'.length).replace(/\.js$/, '.ts'),
      );
      if (await existsOnDisk(sourcePath)) {
        namedSubpaths.push(`@qwen-code/qwen-code-core/${subpath.slice(2)}`);
      }
    }
    expect(namedSubpaths.length).toBeGreaterThan(0);

    const defaultRead = readFileSyncMock.getMockImplementation();
    const defaultExists = existsSyncMock.getMockImplementation();
    try {
      readFileSyncMock.mockImplementation((filePath, ...rest) =>
        normalizePath(filePath).endsWith('packages/core/package.json')
          ? corePackageJson
          : defaultRead(filePath, ...rest),
      );
      // The launcher only probes the source files it is about to map, so answer
      // from the real tree: a mapping whose source is missing must be dropped
      // rather than emitted.
      existsSyncMock.mockImplementation((filePath) => {
        const normalized = normalizePath(filePath);
        return (
          normalized.includes('/packages/core/') &&
          (Object.values(expectedSources).some((s) => normalized.endsWith(s)) ||
            namedSubpaths.some((specifier) => {
              const sub = specifier.slice('@qwen-code/qwen-code-core/'.length);
              const distEntry =
                JSON.parse(corePackageJson).exports[`./${sub}`]?.import;
              return normalized.endsWith(
                distEntry.slice('./dist/'.length).replace(/\.js$/, '.ts'),
              );
            }))
        );
      });

      await import('../dev.js?subpath-source-map');

      const loaderCall = writeFileSyncMock.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith('loader.mjs'),
      );
      expect(loaderCall).toBeDefined();
      // Execute the hook the launcher actually generates instead of asserting
      // on its source text.
      const loader = await import(
        `data:text/javascript;base64,${Buffer.from(loaderCall[1]).toString('base64')}`
      );
      const nextResolve = (specifier) => ({
        url: `fallthrough:${specifier}`,
        format: 'module',
        shortCircuit: false,
      });

      for (const [specifier, expected] of Object.entries(expectedSources)) {
        const resolved = loader.resolve(specifier, {}, nextResolve);
        expect(resolved.shortCircuit, specifier).toBe(true);
        const resolvedPath = normalizePath(fileURLToPath(resolved.url));
        expect(resolvedPath, specifier).toContain(expected);
        expect(resolvedPath, specifier).not.toContain('/dist/');
      }

      // Completeness: no published named subpath may fall through to Node,
      // which is the lane that reaches dist.
      for (const specifier of namedSubpaths) {
        const resolved = loader.resolve(specifier, {}, nextResolve);
        expect(resolved.shortCircuit, specifier).toBe(true);
        expect(resolved.url, specifier).not.toContain('fallthrough:');
        expect(normalizePath(fileURLToPath(resolved.url)), specifier).toContain(
          '/packages/core/src/',
        );
      }

      // Unrelated specifiers still reach Node's resolver.
      expect(loader.resolve('node:fs', {}, nextResolve).url).toBe(
        'fallthrough:node:fs',
      );
    } finally {
      readFileSyncMock.mockImplementation(defaultRead);
      existsSyncMock.mockImplementation(defaultExists);
    }
  });
});
