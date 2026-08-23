/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

describe('utils upward-import flat-config integration', () => {
  it('reports value imports but allows type-only upward imports', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const [
      prodStatic,
      prodTypeOnly,
      prodExportTypeOnly,
      prodInlineType,
      prodMixedSpecifiers,
      prodTypeQuery,
      prodDynamic,
      testStatic,
    ] = await Promise.all([
      eslint.lintText("import value from '../config/settings.js';", {
        filePath: 'packages/cli/src/utils/fixture-boundary.ts',
      }),
      eslint.lintText(
        "import type { Settings } from '../config/settings.js';",
        {
          filePath: 'packages/cli/src/utils/fixture-boundary.ts',
        },
      ),
      eslint.lintText(
        "export type { Settings } from '../config/settings.js';",
        {
          filePath: 'packages/cli/src/utils/fixture-boundary.ts',
        },
      ),
      eslint.lintText(
        "import { type Settings } from '../config/settings.js';",
        {
          filePath: 'packages/cli/src/utils/fixture-boundary.ts',
        },
      ),
      eslint.lintText(
        "import { type Settings, loadSettings } from '../config/settings.js';",
        {
          filePath: 'packages/cli/src/utils/fixture-boundary.ts',
        },
      ),
      eslint.lintText(
        "type Settings = import('../config/settings.js').Settings;",
        {
          filePath: 'packages/cli/src/utils/fixture-boundary.ts',
        },
      ),
      eslint.lintText("import('../config/settings.js');", {
        filePath: 'packages/cli/src/utils/fixture-boundary.ts',
      }),
      eslint.lintText("import value from '../config/settings.js';", {
        filePath: 'packages/cli/src/utils/fixture-boundary.test.ts',
      }),
    ]);

    const hasViolation = (results) =>
      results.some((r) =>
        r.messages.some(
          (m) => m.ruleId === 'architecture/no-utils-upward-import',
        ),
      );

    // value imports (static and dynamic) are caught
    expect(hasViolation(prodStatic)).toBe(true);
    expect(hasViolation(prodDynamic)).toBe(true);
    // statement-level type-only imports are erased at compile time and stay
    // allowed
    expect(hasViolation(prodTypeOnly)).toBe(false);
    expect(hasViolation(prodExportTypeOnly)).toBe(false);
    expect(hasViolation(prodTypeQuery)).toBe(false);
    // inline type specifiers are NOT erased under this repo's
    // `verbatimModuleSyntax`: tsc emits `import {} from ...`, a runtime edge
    // that evaluates the target module, so the rule reports them
    expect(hasViolation(prodInlineType)).toBe(true);
    // a mixed value+type specifier list keeps the value edge, so it is
    // reported too (guards an exemption that tested only the type specifiers)
    expect(hasViolation(prodMixedSpecifiers)).toBe(true);
    // test files stay exempt via the rule's own test/fixture exemption
    expect(hasViolation(testStatic)).toBe(false);
  });
});
