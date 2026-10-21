import { expect, it } from 'vitest';
import { pierreResources } from '../../pierre-build';

it('redirects only Pierre imports, including development query strings', () => {
  const { resolveId } = pierreResources();
  if (typeof resolveId !== 'function') throw new Error('Missing resolver');
  const resolve = (source: string, importer?: string) =>
    Reflect.apply(resolveId, undefined, [source, importer, {}]);
  for (const suffix of ['', '?v=cold-cache', '?v=cache#fragment']) {
    expect(
      resolve(
        'shiki',
        `/repo/node_modules/@pierre/diffs/dist/index.js${suffix}`,
      ),
    ).toMatch(/pierre-highlighter\.ts$/);
    for (const file of ['shared_highlighter', 'themeResolution']) {
      expect(
        resolve(
          '@pierre/theming/themes',
          `/repo/node_modules/@pierre/diffs/dist/highlighter/${file}.js${suffix}`,
        ),
      ).toMatch(/pierre-themes\.ts$/);
    }
  }
  expect(
    resolve(
      'shiki',
      'C:/repo/node_modules/@pierre/diffs/dist/index.js?v=cache',
    ),
  ).toMatch(/pierre-highlighter\.ts$/);
  // Rollup calls resolveId without an importer for entry modules.
  expect(resolve('shiki')).toBeUndefined();
  expect(resolve('shiki', '/repo/client/code-highlighter.ts')).toBeUndefined();
  for (const subpath of ['wasm', 'core', 'engine/javascript', 'textmate']) {
    expect(
      resolve(
        `shiki/${subpath}`,
        '/repo/node_modules/@pierre/diffs/dist/highlighter/shared_highlighter.js',
      ),
    ).toContain('shiki-files');
    expect(
      resolve(`shiki/${subpath}`, '/repo/client/code-highlighter.ts'),
    ).toBeUndefined();
  }
  expect(
    resolve(
      '@pierre/theming/themes',
      '/repo/node_modules/@pierre/diffs/dist/highlighter/registerCustomTheme.js',
    ),
  ).toBeUndefined();
});

it('counts static and lazy descendants and requires an adapter for Pierre', () => {
  const entry = '/repo/client/components/artifacts/pierre-highlighter.ts';
  const resources = '/repo/client/components/artifacts/pierre-resources.ts';
  const grammar = '/repo/node_modules/shiki-files/langs/typescript.mjs';
  const theme = '/repo/node_modules/shiki-files/themes/github-light.mjs';
  const pierre = '/repo/node_modules/@pierre/diffs/dist/index.js';
  const graph: Record<
    string,
    { importedIds: string[]; dynamicallyImportedIds: string[] }
  > = {
    [entry]: { importedIds: [resources], dynamicallyImportedIds: [] },
    [resources]: { importedIds: [theme], dynamicallyImportedIds: [grammar] },
    [grammar]: { importedIds: [entry], dynamicallyImportedIds: [] },
    [theme]: { importedIds: [], dynamicallyImportedIds: [] },
  };
  const check = (
    ids: string[],
    grammarBytes = 100,
    themeBytes = 100,
    redirectedBytes = 0,
  ) => {
    // resolveId and generateBundle must run on one plugin instance:
    // redirectedModules is populated by resolveId and read by generateBundle.
    const plugin = pierreResources();
    const { resolveId, generateBundle } = plugin;
    if (typeof resolveId !== 'function' || typeof generateBundle !== 'function')
      throw new Error('Missing hooks');
    const modules: Record<string, { renderedLength: number }> = {
      [grammar]: { renderedLength: grammarBytes },
      [theme]: { renderedLength: themeBytes },
    };
    if (redirectedBytes > 0) {
      const redirected = Reflect.apply(resolveId, undefined, [
        'shiki/wasm',
        pierre,
        {},
      ]);
      if (typeof redirected !== 'string') throw new Error('Missing redirect');
      // The redirected id is absent from the graph, so the stub's
      // getModuleInfo returns undefined for it, exercising the
      // module?.importedIds ?? [] tolerance.
      modules[redirected] = { renderedLength: redirectedBytes };
    }
    Reflect.apply(
      generateBundle,
      {
        getModuleIds: () => ids,
        getModuleInfo: (id: string) => graph[id],
        error: (message: string) => {
          throw new Error(message);
        },
        info: () => {},
      },
      [
        {},
        {
          entry: {
            type: 'chunk',
            modules: { [entry]: { renderedLength: 100 } },
          },
          lazy: {
            type: 'chunk',
            modules,
          },
        },
        false,
      ],
    );
  };
  expect(() => check([entry, pierre])).not.toThrow();
  expect(() => check([entry, pierre], 4 * 1024 * 1024)).toThrow('4 MiB budget');
  expect(() => check([entry, pierre], 100, 4 * 1024 * 1024)).toThrow(
    '4 MiB budget',
  );
  expect(() => check([entry, pierre], 100, 100, 100)).not.toThrow();
  expect(() => check([entry, pierre], 100, 100, 4 * 1024 * 1024)).toThrow(
    '4 MiB budget',
  );
  expect(() => check([pierre])).toThrow('no Pierre highlighter resource');
  expect(() => check(['/repo/client/transcript.ts'])).not.toThrow();
});

it('budgets resource modules without counting unrelated shared chunk code', () => {
  const { generateBundle } = pierreResources();
  if (typeof generateBundle !== 'function')
    throw new Error('Missing budget check');
  const entry = '/repo/client/components/artifacts/pierre-highlighter.ts';
  const check = (resourceBytes: number) =>
    Reflect.apply(
      generateBundle,
      {
        getModuleIds: () => [entry],
        getModuleInfo: () => ({ importedIds: [], dynamicallyImportedIds: [] }),
        error: (message: string) => {
          throw new Error(message);
        },
        info: () => {},
      },
      [
        {},
        {
          shared: {
            type: 'chunk',
            code: 'x'.repeat(5 * 1024 * 1024),
            modules: {
              [entry]: { renderedLength: resourceBytes },
              '/repo/client/App.tsx': { renderedLength: 5 * 1024 * 1024 },
            },
          },
          // A real build emits assets next to chunks; they carry no modules.
          'favicon.png': { type: 'asset' },
        },
        false,
      ],
    );
  expect(() => check(100)).not.toThrow();
  expect(() => check(4 * 1024 * 1024 + 1)).toThrow('4 MiB budget');
});
