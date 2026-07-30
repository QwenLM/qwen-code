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
    ['packages/core/src/core/deep/module.ts', '../../index.js'],
    ['packages/core/src/a/b/c/module.ts', '../../../index.js'],
  ])('rejects root barrel imports at depth %s', (filename, importedPath) => {
    expect(runRule(`import value from '${importedPath}';`, filename)).toHaveLength(1);
  });

  it('rejects export and dynamic root barrel sources', () => {
    expect(runRule("export { value } from '../index.js';", 'packages/core/src/core/client.ts')).toHaveLength(1);
    expect(runRule("export * from '../index.js';", 'packages/core/src/core/client.ts')).toHaveLength(1);
    expect(runRule("import('../index.js');", 'packages/core/src/core/client.ts')).toHaveLength(1);
  });

  it('allows tests, fixtures, and non-core consumers', () => {
    expect(runRule("import value from '../index.js';", 'packages/core/src/core/client.test.ts')).toHaveLength(0);
    expect(runRule("import value from '../../index.js';", 'packages/core/src/fixtures/client.ts')).toHaveLength(0);
    expect(runRule("import value from '@qwen-code/qwen-code-core';", 'packages/cli/src/index.ts')).toHaveLength(0);
  });

  it('allows direct owner imports', () => {
    expect(runRule("import value from '../tools/tools.js';", 'packages/core/src/core/client.ts')).toHaveLength(0);
  });
});
