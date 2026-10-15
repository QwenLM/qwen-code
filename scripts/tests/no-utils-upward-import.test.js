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
    ['packages/cli/src/utils/foo.ts', 'src/config/settings.js'],
    [
      'packages/cli/src/utils/foo.ts',
      '../nonInteractive/nonInteractiveHelpers.js',
    ],
    // nested checkout: the marker appears twice, so the utils root must be
    // anchored on the LAST one — an indexOf anchor would resolve the import
    // inside the outer utils root and report nothing
    [
      '/tmp/packages/cli/src/utils/nested/packages/cli/src/utils/foo.ts',
      '../config/settings.js',
    ],
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
    // a zero-specifier re-export is a runtime edge (`export {} from` survives
    // emission), not a vacuous `[].every(...)` type-only exemption
    expect(
      runRule("export {} from '../config/settings.js';", file),
    ).toHaveLength(1);
    expect(
      runRule("export * from '../config/settings.js';", file),
    ).toHaveLength(1);
    expect(runRule("import('../config/settings.js');", file)).toHaveLength(1);
    expect(runRule('import(`../config/settings.js`);', file)).toHaveLength(1);
    expect(runRule("import('src/config/settings.js');", file)).toHaveLength(1);
  });

  it('fails closed on computed dynamic sources with a local known prefix', () => {
    const file = 'packages/cli/src/utils/foo.ts';
    // A multi-segment template: interpolation can contribute a `../` step,
    // and a leading `../` cannot be undone, so the import cannot be proven
    // to stay inside utils/ — reported even though part is interpolated.
    expect(runRule('import(`../i18n/${locale}.js`);', file)).toHaveLength(1);
    // A `+` concatenation with a relative leftmost literal, same reasoning.
    expect(runRule("import('../config/' + name + '.js');", file)).toHaveLength(
      1,
    );
    // A relative `./` prefix is also unprovable (interpolation could still
    // climb), so it is reported too.
    expect(runRule('import(`./sub/${name}.js`);', file)).toHaveLength(1);
    expect(runRule('import(`src/config/${name}.js`);', file)).toHaveLength(1);
  });

  it('drops computed dynamic sources with no statically known local prefix', () => {
    const file = 'packages/cli/src/utils/foo.ts';
    // A bare identifier or a package-like prefix is the same boundary the
    // static check applies to non-relative specifiers — not reported.
    expect(runRule('import(moduleName);', file)).toHaveLength(0);
    expect(runRule('import(`${pkg}/entry.js`);', file)).toHaveLength(0);
  });

  it('allows imports that stay within utils', () => {
    expect(
      runRule('import(`./sibling.js`);', 'packages/cli/src/utils/foo.ts'),
    ).toHaveLength(0);
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
    expect(
      runRule(
        "import value from 'src/utils/sibling.js';",
        'packages/cli/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    // same doubly-nested shape as the reject case: a sibling import stays
    // inside the LAST marker's utils root
    expect(
      runRule(
        "import value from './sibling.js';",
        '/tmp/packages/cli/src/utils/nested/packages/cli/src/utils/foo.ts',
      ),
    ).toHaveLength(0);
    expect(
      runRule(
        "import value from 'src/utils/sibling.js';",
        '/tmp/packages/cli/src/utils/nested/packages/cli/src/utils/foo.ts',
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
