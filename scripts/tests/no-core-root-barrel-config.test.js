import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { legacyCoreBarrelImports } from '../../eslint.legacy-core-barrel-imports.mjs';

describe('core root barrel flat-config integration', () => {
  it('reports production self-imports (static, type-only, inline-type, and dynamic), ignores tests', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [
      prodStatic,
      prodTypeOnly,
      prodInlineType,
      prodDynamic,
      prodToolsStatic,
      testStatic,
    ] = await Promise.all([
      eslint.lintText("import value from '../index.js';", {
        filePath: 'packages/core/src/core/fixture-boundary.ts',
      }),
      eslint.lintText("import type { Value } from '../index.js';", {
        filePath: 'packages/core/src/core/fixture-boundary.ts',
      }),
      eslint.lintText("type Value = import('../index.js').Value;", {
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
    expect(hasViolation(prodInlineType)).toBe(true);
    expect(hasViolation(prodDynamic)).toBe(true);
    expect(hasViolation(prodToolsStatic)).toBe(true);
    // test files stay exempt via the rule's own test/fixture exemption
    expect(hasViolation(testStatic)).toBe(false);
  });

  it('reports cli production value imports from the core root, except type-only, tests, and legacy entries', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const cliFile = 'packages/cli/src/ui/fixture-boundary.ts';
    const [
      valueImport,
      reExport,
      indexSubpath,
      typeOnly,
      inlineTypeOnly,
      ownerModule,
      testFile,
      legacyFile,
    ] = await Promise.all([
      eslint.lintText("import { Storage } from '@qwen-code/qwen-code-core';", {
        filePath: cliFile,
      }),
      eslint.lintText("export { Storage } from '@qwen-code/qwen-code-core';", {
        filePath: cliFile,
      }),
      eslint.lintText(
        "import { Storage } from '@qwen-code/qwen-code-core/index.js';",
        { filePath: cliFile },
      ),
      eslint.lintText(
        "import type { Config } from '@qwen-code/qwen-code-core';",
        { filePath: cliFile },
      ),
      eslint.lintText(
        "import { type Config } from '@qwen-code/qwen-code-core';",
        { filePath: cliFile },
      ),
      eslint.lintText(
        "import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';",
        { filePath: cliFile },
      ),
      eslint.lintText("import { Storage } from '@qwen-code/qwen-code-core';", {
        filePath: 'packages/cli/src/ui/fixture-boundary.test.ts',
      }),
      eslint.lintText("import { Storage } from '@qwen-code/qwen-code-core';", {
        filePath: legacyCoreBarrelImports[0],
      }),
    ]);

    const hasViolation = (results) =>
      results.some((r) =>
        r.messages.some(
          (m) => m.ruleId === '@typescript-eslint/no-restricted-imports',
        ),
      );

    expect(hasViolation(valueImport)).toBe(true);
    expect(hasViolation(reExport)).toBe(true);
    expect(hasViolation(indexSubpath)).toBe(true);
    expect(hasViolation(typeOnly)).toBe(false);
    expect(hasViolation(inlineTypeOnly)).toBe(false);
    expect(hasViolation(ownerModule)).toBe(false);
    expect(hasViolation(testFile)).toBe(false);
    expect(hasViolation(legacyFile)).toBe(false);
  });

  it('lists only cli files that still exist', () => {
    const missing = legacyCoreBarrelImports.filter((file) => !existsSync(file));
    expect(missing).toEqual([]);
  });
});
