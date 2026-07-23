/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build, type Metafile, type Plugin } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock('web-tree-sitter');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function wasmBinaryPlugin(): Plugin {
  return {
    name: 'wasm-binary-test',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
        const specifier = args.path.replace(/\?binary$/, '');
        const localRequire = createRequire(
          path.resolve(args.resolveDir || repoRoot, '_dummy_.js'),
        );
        return {
          path: localRequire.resolve(specifier),
          namespace: 'wasm-binary',
        };
      });
      pluginBuild.onLoad(
        { filter: /.*/, namespace: 'wasm-binary' },
        (args) => ({
          contents: readFileSync(args.path),
          loader: 'binary',
        }),
      );
    },
  };
}

function staticClosure(metafile: Metafile, entry: string): Set<string> {
  const closure = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const outputPath = pending.pop()!;
    if (closure.has(outputPath)) continue;
    const output = metafile.outputs[outputPath];
    if (!output) throw new Error(`Missing metafile output: ${outputPath}`);
    closure.add(outputPath);
    for (const imported of output.imports) {
      if (!imported.external && imported.kind !== 'dynamic-import') {
        pending.push(imported.path);
      }
    }
  }
  return closure;
}

function expectDeferredInput(
  metafile: Metafile,
  closure: Set<string>,
  inputFragment: string,
): void {
  const owningOutputs = Object.entries(metafile.outputs).filter(([, output]) =>
    Object.keys(output.inputs).some((input) =>
      input.replaceAll('\\', '/').includes(inputFragment),
    ),
  );
  expect(owningOutputs.length).toBeGreaterThan(0);
  expect(owningOutputs.every(([outputPath]) => !closure.has(outputPath))).toBe(
    true,
  );
}

describe('shellAstParser lazy runtime', () => {
  it('loads web-tree-sitter on first use and deduplicates initialization', async () => {
    const runtimeLoaded = vi.fn();
    const init = vi.fn(async () => undefined);
    let releaseLanguage!: () => void;
    const languageReady = new Promise<void>((resolve) => {
      releaseLanguage = resolve;
    });
    const constructed = vi.fn();
    const loadLanguage = vi.fn(async () => {
      await languageReady;
      return {};
    });

    class ParserMock {
      static init = init;
      static Language = { load: loadLanguage };

      constructor() {
        constructed();
      }

      setLanguage = vi.fn();
    }

    vi.doMock('web-tree-sitter', () => {
      runtimeLoaded();
      return { default: ParserMock };
    });

    const parser = await import('./shellAstParser.js');
    expect(runtimeLoaded).not.toHaveBeenCalled();
    const first = parser.initParser();
    await vi.waitFor(() => expect(loadLanguage).toHaveBeenCalledTimes(1));
    expect(constructed).not.toHaveBeenCalled();

    let secondResolved = false;
    const second = parser.initParser().then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    releaseLanguage();
    await Promise.all([first, second]);
    expect(runtimeLoaded).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(loadLanguage).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveBeenCalledTimes(1);
  });

  it('latches a language load failure', async () => {
    const languageLoads = vi.fn(async () => {
      throw new Error('bash language unavailable');
    });

    class ParserMock {
      static init = vi.fn(async () => undefined);
      static Language = { load: languageLoads };

      setLanguage = vi.fn();
    }

    vi.doMock('web-tree-sitter', () => ({ default: ParserMock }));
    const parser = await import('./shellAstParser.js');

    expect(await parser.classifyShellCommandSafety('git status')).toBe(
      'unknown',
    );
    expect(await parser.isShellCommandReadOnlyAST('git status')).toBe(true);
    expect(await parser.isShellCommandReadOnlyAST('rm -rf temp')).toBe(false);
    await expect(parser.initParser()).rejects.toThrow(
      'tree-sitter WASM failed to initialise',
    );
    expect(languageLoads).toHaveBeenCalledTimes(1);
  });

  it('maps parser runtime exceptions without changing the legacy fallback', async () => {
    const init = vi.fn(async () => undefined);
    const deleteParser = vi.fn();
    const parse = vi.fn(() => {
      throw new Error('parser runtime failure');
    });
    const setLanguage = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('cannot configure replacement');
      });
    const constructed = vi.fn();

    class ParserMock {
      static init = init;
      static Language = { load: vi.fn(async () => ({})) };

      constructor() {
        constructed();
      }

      delete = deleteParser;
      parse = parse;
      setLanguage = setLanguage;
    }

    vi.doMock('web-tree-sitter', () => ({ default: ParserMock }));
    const parser = await import('./shellAstParser.js');

    expect(await parser.classifyShellCommandSafety('git status')).toBe(
      'unknown',
    );
    expect(await parser.isShellCommandReadOnlyAST('git status')).toBe(true);
    await expect(parser.initParser()).rejects.toThrow(
      'tree-sitter WASM failed to initialise',
    );
    expect(init).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(constructed).toHaveBeenCalledTimes(3);
    expect(setLanguage).toHaveBeenCalledTimes(3);
    expect(deleteParser).toHaveBeenCalledTimes(3);
  });

  it('releases each parsed tree exactly once', async () => {
    const deleteTree = vi.fn();
    const parse = vi
      .fn()
      .mockReturnValueOnce({
        rootNode: { namedChildCount: 0, hasError: false, namedChildren: [] },
        delete: deleteTree,
      })
      .mockReturnValueOnce({
        get rootNode() {
          throw new Error('tree evaluation failure');
        },
        delete: deleteTree,
      });

    class ParserMock {
      static init = vi.fn(async () => undefined);
      static Language = { load: vi.fn(async () => ({})) };

      parse = parse;
      setLanguage = vi.fn();
    }

    vi.doMock('web-tree-sitter', () => ({ default: ParserMock }));
    const parser = await import('./shellAstParser.js');

    expect(await parser.classifyShellCommandSafety('git status')).toBe(
      'unknown',
    );
    expect(await parser.classifyShellCommandSafety('git status')).toBe(
      'unknown',
    );
    expect(deleteTree).toHaveBeenCalledTimes(2);
  });

  it('keeps the packaged runtime deferred and parses from emitted chunks', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-shell-ast-parser-'));
    tempDirs.push(tempDir);
    const entryPath = path.join(tempDir, 'entry.ts');
    writeFileSync(
      entryPath,
      `export { _resetParser, classifyShellCommandSafety, isShellCommandReadOnlyAST, parseShellCommand } from ${JSON.stringify(
        path.join(repoRoot, 'packages/core/src/utils/shellAstParser.ts'),
      )};\n`,
    );

    const result = await build({
      absWorkingDir: tempDir,
      entryPoints: { entry: entryPath },
      bundle: true,
      outdir: 'dist',
      entryNames: '[name]',
      chunkNames: 'chunks/[name]-[hash]',
      splitting: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      metafile: true,
      inject: [path.join(repoRoot, 'scripts/esbuild-shims.js')],
      define: {
        __dirname: '__qwen_dirname',
        __filename: '__qwen_filename',
        global: 'globalThis',
      },
      plugins: [wasmBinaryPlugin()],
      logLevel: 'silent',
    });
    writeFileSync(
      path.join(tempDir, 'dist/package.json'),
      JSON.stringify({ type: 'module' }),
    );

    const closure = staticClosure(result.metafile, 'dist/entry.js');
    for (const inputFragment of [
      'node_modules/web-tree-sitter/tree-sitter.js',
      'node_modules/web-tree-sitter/tree-sitter.wasm',
      'node_modules/tree-sitter-wasms/out/tree-sitter-bash.wasm',
    ]) {
      expectDeferredInput(result.metafile, closure, inputFragment);
    }

    const packagedParser = (await import(
      /* @vite-ignore */ `${
        pathToFileURL(path.join(tempDir, 'dist/entry.js')).href
      }?test=${Date.now()}`
    )) as {
      _resetParser(): void;
      classifyShellCommandSafety(
        command: string,
      ): Promise<'read-only' | 'write' | 'unknown'>;
      isShellCommandReadOnlyAST(command: string): Promise<boolean>;
      parseShellCommand(command: string): Promise<{
        rootNode: { type: string };
        delete(): void;
      }>;
    };
    const [treeA, treeB] = await Promise.all([
      packagedParser.parseShellCommand('git status --short'),
      packagedParser.parseShellCommand('echo ready | grep ready'),
    ]);
    expect(treeA.rootNode.type).toBe('program');
    expect(treeB.rootNode.type).toBe('program');
    treeA.delete();
    treeB.delete();
    expect(await packagedParser.isShellCommandReadOnlyAST('git status')).toBe(
      true,
    );
    expect(await packagedParser.isShellCommandReadOnlyAST('rm -rf temp')).toBe(
      false,
    );
    expect(await packagedParser.classifyShellCommandSafety('rm -rf temp')).toBe(
      'write',
    );
    await packagedParser.classifyShellCommandSafety(
      'case x in x) rm target;; esac',
    );
    expect(await packagedParser.classifyShellCommandSafety('git status')).toBe(
      'read-only',
    );

    packagedParser._resetParser();
    const recoveredTree = await packagedParser.parseShellCommand('pwd');
    expect(recoveredTree.rootNode.type).toBe('program');
    recoveredTree.delete();
  }, 20_000);
});
