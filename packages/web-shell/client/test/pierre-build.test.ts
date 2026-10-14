import { expect, it } from 'vitest';
import { pierreResources } from '../../pierre-build';

it('redirects only Pierre imports, including development query strings', () => {
  const { resolveId } = pierreResources();
  if (typeof resolveId !== 'function') throw new Error('Missing resolver');
  const resolve = (source: string, importer: string) =>
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
  expect(resolve('shiki', '/repo/client/code-highlighter.ts')).toBeUndefined();
  expect(
    resolve(
      '@pierre/theming/themes',
      '/repo/node_modules/@pierre/diffs/dist/highlighter/registerCustomTheme.js',
    ),
  ).toBeUndefined();
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
        },
        false,
      ],
    );
  expect(() => check(100)).not.toThrow();
  expect(() => check(4 * 1024 * 1024 + 1)).toThrow('4 MiB budget');
});
