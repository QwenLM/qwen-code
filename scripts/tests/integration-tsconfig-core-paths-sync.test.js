/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsconfigPath = join(root, 'integration-tests', 'tsconfig.json');
const coreDir = join(root, 'packages', 'core');

// integration-tests/tsconfig.json resolves workspace packages from source so
// `tsc -p integration-tests/tsconfig.json` never typechecks against dist
// declarations. Its `@qwen-code/qwen-code-core/*` wildcard substitutes
// ../packages/core/src/<subpath>, which covers every specifier whose source
// file mirrors its name; a named exports key whose target stem differs from
// the key needs an explicit `paths` entry, or resolution silently falls back
// to packages/core/dist (a hard TS2307 on an unbuilt tree). Gate the named
// keys of core's exports map against that paths block the same way
// text-capture-core-loader-sync.test.js gates the harness loader's map.
describe('integration-tests core paths sync', () => {
  // The tsconfig carries `//` comments; drop whole-line comments before
  // parsing (its strings never contain a line comment).
  const tsconfig = JSON.parse(
    readFileSync(tsconfigPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  const paths = tsconfig.compilerOptions.paths;
  const exportsMap = JSON.parse(
    readFileSync(join(coreDir, 'package.json'), 'utf8'),
  ).exports;
  const namedKeys = Object.keys(exportsMap).filter(
    (key) =>
      key.startsWith('./') && !key.includes('*') && key !== './package.json',
  );

  it('has a paths entry for every named exports key whose file it does not mirror', () => {
    expect(namedKeys.length).toBeGreaterThan(0);
    for (const key of namedKeys) {
      const name = key.slice('./'.length);
      const entry = exportsMap[key];
      const importTarget = typeof entry === 'string' ? entry : entry?.import;
      const stem = importTarget
        .replace(/^\.\/dist\/src\//, '')
        .replace(/\.js$/, '');
      // The wildcard covers specifiers that mirror their source file.
      if (stem === name) continue;
      const candidates = [
        `../packages/core/src/${stem}.ts`,
        `../packages/core/src/${stem}.tsx`,
      ];
      const mapped = paths[`@qwen-code/qwen-code-core/${name}`];
      expect(
        mapped,
        `integration-tests/tsconfig.json paths is missing ` +
          `@qwen-code/qwen-code-core/${name} (exports ${key} -> ${importTarget}); ` +
          `the specifier falls through the wildcard to dist or fails outright`,
      ).toBeDefined();
      // Every paths value must stay an array (a string value makes tsc
      // abort before it checks a single file).
      expect(Array.isArray(mapped)).toBe(true);
      expect(mapped).toHaveLength(1);
      expect(
        candidates,
        `paths entry for ${name} must point at the exports target's ` +
          `source file (${importTarget})`,
      ).toContain(mapped[0]);
      expect(
        existsSync(join(root, 'integration-tests', mapped[0])),
        `paths entry for ${name} points at a file that does not exist`,
      ).toBe(true);
    }
  });
});
