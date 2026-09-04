/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Checks that a compiled cli can still reach core by module path.
 *
 * The cli's own sources say `@qwen-code/qwen-code-core/config/storage.js` and
 * the like. Inside the repo those resolve through tsconfig `paths` (for tsc and
 * esbuild) or through vitest aliases (for the suites) — three mechanisms, none
 * of which the published package has. There, the emitted JS keeps the specifier
 * verbatim and Node resolves it against core's `exports`, where a single `./*`
 * entry carries every one of them.
 *
 * Nothing else exercises that entry. Remove it, rename the `dist/src` root, or
 * add a pattern that shadows it, and every suite stays green while `qwen` dies
 * on its first core subpath import. This runs Node's real resolver against the
 * built package so that failure lands in CI instead.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(pathToFileURL(path.join(root, 'package.json')));

// One specifier per shape the cli emits: a class, a plain function, and a
// module under a nested directory.
const PROBES = [
  ['@qwen-code/qwen-code-core/config/storage.js', 'Storage'],
  ['@qwen-code/qwen-code-core/utils/debugLogger.js', 'createDebugLogger'],
  ['@qwen-code/qwen-code-core/utils/errors.js', 'getErrorMessage'],
];

const coreDist = path.join(root, 'packages', 'core', 'dist', 'src');
if (!existsSync(coreDist)) {
  console.error(
    `core is not built (${path.relative(root, coreDist)} is missing) — run "npm run build" first`,
  );
  process.exit(1);
}

let failed = 0;
for (const [specifier, exportName] of PROBES) {
  let resolved;
  try {
    resolved = require.resolve(specifier);
  } catch (error) {
    console.error(`✗ ${specifier}\n    ${error.code ?? ''} ${error.message}`);
    failed++;
    continue;
  }
  const mod = await import(pathToFileURL(resolved).href);
  if (typeof mod[exportName] !== 'function') {
    console.error(
      `✗ ${specifier}\n    resolved to ${path.relative(root, resolved)} but ${exportName} is ${typeof mod[exportName]}`,
    );
    failed++;
    continue;
  }
  console.log(`✓ ${specifier} → ${path.relative(root, resolved)}`);
}

if (failed) {
  console.error(
    `\n${failed} of ${PROBES.length} core subpath specifiers do not resolve through the package exports map.\n` +
      'The published CLI resolves them this way and nothing else does, so this breaks `qwen` at startup\n' +
      'while every in-repo suite stays green. Check the "./*" entry in packages/core/package.json.',
  );
  process.exit(1);
}
console.log(
  `\nAll ${PROBES.length} core subpath specifiers resolve through the package exports map.`,
);
