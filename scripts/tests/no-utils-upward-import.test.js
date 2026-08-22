/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import rule from '../../eslint-rules/no-utils-upward-import.js';

function runRule(code, filename) {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('architecture/no-utils-upward-import', rule);
  return linter.verify(
    code,
    {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      rules: { 'architecture/no-utils-upward-import': 'error' },
    },
    { filename },
  );
}

describe('no-utils-upward-import', () => {
  it.each([
    ['packages/cli/src/utils/deepMerge.ts', '../config/settings.js'],
    [
      'packages/cli/src/utils/housekeeping/cleanup.ts',
      '../../config/settings.js',
    ],
    ['packages/cli/src/utils/foo.ts', '../ui/commands/types.js'],
    ['packages/cli/src/utils/foo.ts', '../i18n/index.js'],
    [
      'packages/cli/src/utils/foo.ts',
      '../nonInteractive/nonInteractiveHelpers.js',
    ],
    // nested checkout: anchor on the LAST marker to derive the utils root
    ['/tmp/checkout/packages/cli/src/utils/foo.ts', '../config/settings.js'],
  ])('rejects upward imports from %s', (filename, importedPath) => {
    expect(
      runRule(`import value from '${importedPath}';`, filename),
    ).toHaveLength(1);
  });

  it('rejects export and dynamic upward sources', () => {
    const file = 'packages/cli/src/utils/foo.ts';
    expect(
      runRule("export { value } from '../config/settings.js';", file),
    ).toHaveLength(1);
    expect(
      runRule("export * from '../config/settings.js';", file),
    ).toHaveLength(1);
    expect(runRule("import('../config/settings.js');", file)).toHaveLength(1);
    expect(runRule('import(`../config/settings.js`);', file)).toHaveLength(1);
  });

  it('allows imports that stay within utils', () => {
    expect(
      runRule(
        "import value from './sibling.js';",
        'packages/cli/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../cleanup.js';",
        'packages/cli/src/utils/housekeeping/cleanup.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../../utils/sibling.js';",
        'packages/cli/src/utils/housekeeping/cleanup.ts',
      ),
    ).toHaveLength(0);
  });

  it('allows package and builtin imports', () => {
    const file = 'packages/cli/src/utils/foo.ts';
    expect(runRule("import fs from 'node:fs';", file)).toHaveLength(0);
    expect(
      runRule("import value from '@qwen-code/qwen-code-core';", file),
    ).toHaveLength(0);
  });

  it('ignores tests, fixtures, __tests__, and non-utils consumers', () => {
    expect(
      runRule(
        "import value from '../config/settings.js';",
        'packages/cli/src/utils/foo.test.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../config/settings.js';",
        'packages/cli/src/utils/foo.spec.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../config/settings.js';",
        'packages/cli/src/utils/__tests__/helper.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from '../config/settings.js';",
        'packages/cli/src/utils/fixtures/helper.ts',
      ),
    ).toHaveLength(0);
    // non-utils consumers may import utils freely
    expect(
      runRule(
        "import value from '../utils/sibling.js';",
        'packages/cli/src/config/foo.ts',
      ),
    ).toHaveLength(0);
  });
});
