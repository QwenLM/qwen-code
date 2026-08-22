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
    // type-only imports are erased at compile time and stay allowed
    expect(hasViolation(prodTypeOnly)).toBe(false);
    expect(hasViolation(prodExportTypeOnly)).toBe(false);
    expect(hasViolation(prodInlineType)).toBe(false);
    // test files stay exempt via the rule's own test/fixture exemption
    expect(hasViolation(testStatic)).toBe(false);
  });
});
