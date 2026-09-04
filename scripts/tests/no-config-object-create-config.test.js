/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

describe('no-config-object-create flat-config integration', () => {
  it('reports Object.create Config derivation in production paths, ignores tests and config.ts', async () => {
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: 'eslint.config.js',
    });
    const snippet =
      "import { Config } from '../config/config.js';\n" +
      'const child = Object.create(base);\n';
    const [prodObjectCreate, testObjectCreate, configTsObjectCreate] =
      await Promise.all([
        eslint.lintText(snippet, {
          filePath: 'packages/core/src/foo/bar.ts',
        }),
        eslint.lintText(snippet, {
          filePath: 'packages/core/src/foo/bar.test.ts',
        }),
        eslint.lintText(snippet, {
          filePath: 'packages/core/src/config/config.ts',
        }),
      ]);

    const hasViolation = (results) =>
      results.some((r) =>
        r.messages.some(
          (m) => m.ruleId === 'qwen-code/no-config-object-create',
        ),
      );

    // production file: prototype derivation of Config is caught
    expect(hasViolation(prodObjectCreate)).toBe(true);
    // test files and the canonical factory module stay exempt via the
    // flat-config `ignores` list
    expect(hasViolation(testObjectCreate)).toBe(false);
    expect(hasViolation(configTsObjectCreate)).toBe(false);
  });
});
