import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

describe('core root barrel flat-config integration', () => {
  it('reports production self-imports (static, type-only, and dynamic), ignores tests', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [prodStatic, prodTypeOnly, prodDynamic, prodToolsStatic, testStatic] =
      await Promise.all([
        eslint.lintText("import value from '../index.js';", {
          filePath: 'packages/core/src/core/fixture-boundary.ts',
        }),
        eslint.lintText("import type { Value } from '../index.js';", {
          filePath: 'packages/core/src/core/fixture-boundary.ts',
        }),
        eslint.lintText("import('../index.js');", {
          filePath: 'packages/core/src/core/fixture-boundary.ts',
        }),
        eslint.lintText("import value from '../index.js';", {
          filePath: 'packages/core/src/tools/foo.ts',
        }),
        eslint.lintText("import value from '../index.js';", {
          filePath: 'packages/core/src/core/fixture-boundary.test.ts',
        }),
      ]);

    const hasViolation = (results) =>
      results.some((r) =>
        r.messages.some(
          (m) => m.ruleId === 'architecture/no-core-root-barrel-import',
        ),
      );

    // production files: all import kinds are caught
    expect(hasViolation(prodStatic)).toBe(true);
    expect(hasViolation(prodTypeOnly)).toBe(true);
    expect(hasViolation(prodDynamic)).toBe(true);
    expect(hasViolation(prodToolsStatic)).toBe(true);
    // test files are exempt at the flat-config level
    expect(hasViolation(testStatic)).toBe(false);
  });
});
