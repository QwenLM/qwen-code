import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

describe('core root barrel flat-config integration', () => {
  it('reports a production self-import and ignores tests', async () => {
    const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: 'eslint.config.js' });
    const [production, test] = await eslint.lintText(
      "import value from '../index.js';",
      { filePath: 'packages/core/src/core/fixture-boundary.ts' },
    ).then(async (results) => [
      results,
      eslint.lintText("import value from '../index.js';", {
        filePath: 'packages/core/src/core/fixture-boundary.test.ts',
      }),
    ]);
    expect(
      production[0].messages.some(
        (message) => message.ruleId === 'architecture/no-core-root-barrel-import',
      ),
    ).toBe(true);
    expect(
      (await test).some((result) =>
        result.messages.some((message) => message.ruleId === 'architecture/no-core-root-barrel-import'),
      ),
    ).toBe(false);
  });
});
