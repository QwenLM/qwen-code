import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import rule from '../../eslint-rules/no-core-root-barrel-import.js';

function runRule(code, filename) {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('architecture/no-core-root-barrel-import', rule);
  return linter.verify(
    code,
    {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      rules: { 'architecture/no-core-root-barrel-import': 'error' },
    },
    { filename },
  );
}

describe('no-core-root-barrel-import', () => {
  it.each([
    ['packages/core/src/core/client.ts', '../index.js'],
    ['packages/core/src/a/b/c/module.ts', '../../../index.js'],
    // depth-0: src-root module importing the barrel from the same directory
    ['packages/core/src/index.ts', './index.js'],
    // package-level barrel (packages/core/index.js) via an extra directory hop
    ['packages/core/src/core/client.ts', '../../index.js'],
    // .ts spelling of the src barrel
    ['packages/core/src/core/client.ts', '../index.ts'],
    // nested checkout: a parent directory also contains the marker, so the
    // rule must anchor on the LAST occurrence to derive the correct source root
    [
      '/tmp/packages/core/src/checkout/repo/packages/core/src/core/client.ts',
      '../index.js',
    ],
    // exports-map subpaths that reach the same root barrel
    [
      'packages/core/src/core/client.ts',
      '@qwen-code/qwen-code-core/src/index.js',
    ],
    [
      'packages/core/src/core/client.ts',
      '@qwen-code/qwen-code-core/dist/index.js',
    ],
    ['packages/core/src/core/client.ts', '@qwen-code/qwen-code-core/index.js'],
    // .ts spelling of the exports-map src subpath
    [
      'packages/core/src/core/client.ts',
      '@qwen-code/qwen-code-core/src/index.ts',
    ],
    // relative import of the compiled barrel
    ['packages/core/src/core/client.ts', '../../dist/index.js'],
  ])('rejects root barrel imports from %s', (filename, importedPath) => {
    expect(
      runRule(`import value from '${importedPath}';`, filename),
    ).toHaveLength(1);
  });

  it('rejects export and dynamic root barrel sources', () => {
    expect(
      runRule(
        "export { value } from '../index.js';",
        'packages/core/src/core/client.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule(
        "export * from '../index.js';",
        'packages/core/src/core/client.ts',
      ),
    ).toHaveLength(1);
    expect(
      runRule("import('../index.js');", 'packages/core/src/core/client.ts'),
    ).toHaveLength(1);
  });

  it('rejects package-specifier barrel imports from core production', () => {
    expect(
      runRule(
        "import value from '@qwen-code/qwen-code-core';",
        'packages/core/src/core/client.ts',
      ),
    ).toHaveLength(1);
  });

  it('rejects static template-literal dynamic barrel imports', () => {
    expect(
      runRule('import(`../index.js`);', 'packages/core/src/core/client.ts'),
    ).toHaveLength(1);
  });

  it('allows tests, fixtures, __tests__, and non-core consumers', () => {
    expect(
      runRule(
        "import value from '../index.js';",
        'packages/core/src/core/client.test.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../index.js';",
        'packages/core/src/core/client.spec.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../index.js';",
        'packages/core/src/fixtures/client.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../index.js';",
        'packages/core/src/__tests__/helper.ts',
      ),
    ).toHaveLength(0);
    // non-core consumers can import the package specifier freely
    expect(
      runRule(
        "import value from '@qwen-code/qwen-code-core';",
        'packages/cli/src/index.ts',
      ),
    ).toHaveLength(0);
    // non-barrel package subpaths stay allowed even inside core production
    expect(
      runRule(
        "import { memoryScopes } from '@qwen-code/qwen-code-core/memoryScopes';",
        'packages/core/src/core/client.ts',
      ),
    ).toHaveLength(0);
  });

  it('allows direct owner imports', () => {
    expect(
      runRule(
        "import value from '../tools/tools.js';",
        'packages/core/src/core/client.ts',
      ),
    ).toHaveLength(0);
  });
});
