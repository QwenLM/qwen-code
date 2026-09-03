/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Plain-Node resolution guard for the core subpath exports map.
//
// cli sources import individual core modules through subpath specifiers
// (e.g. `@qwen-code/qwen-code-core/storage`). Typecheck resolves them via
// tsconfig `paths`, unit tests via the vitest alias list, and the bundle via
// esbuild's paths reading — none of which consults `exports`. The built-
// but-unbundled CLI (`npm start`, `npm run build-and-start`) resolves them
// through `packages/core/package.json` `exports` alone, so a specifier with
// no exports entry crashes at module load with ERR_PACKAGE_PATH_NOT_EXPORTED
// while every gate stays green. This guard resolves each specifier in a real
// child `node` process — no vitest aliases, no tsconfig paths — and fails if
// any exports entry goes missing.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Every core subpath specifier statically imported from packages/cli/src,
// plus long-standing named subpaths as controls.
const specifiers = [
  '@qwen-code/qwen-code-core/storage',
  '@qwen-code/qwen-code-core/atomicFileWrite',
  '@qwen-code/qwen-code-core/debugLogger',
  '@qwen-code/qwen-code-core/noFollowOpen',
  '@qwen-code/qwen-code-core/envVarResolver',
];

function probe(specifier) {
  const script = `
    try {
      console.log('OK ' + import.meta.resolve(${JSON.stringify(specifier)}));
    } catch (error) {
      console.log('FAIL ' + (error.code ?? error.name));
    }
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(root, 'packages', 'cli'),
    encoding: 'utf8',
  }).trim();
}

describe('core subpath specifiers resolve under plain Node', () => {
  it.each(specifiers)('%s resolves', (specifier) => {
    expect(probe(specifier)).toMatch(/^OK /);
  });
});
