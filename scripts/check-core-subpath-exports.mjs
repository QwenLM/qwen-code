/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Checks that a compiled cli can still reach core by module path.
 *
 * The cli's own sources — and the workspace packages its runtime graph pulls in
 * (acp-bridge, sdk-typescript) — say
 * `@qwen-code/qwen-code-core/config/storage.js` and the like. Inside the repo
 * those resolve through tsconfig `paths` (for tsc and esbuild) or through
 * vitest aliases (for the suites) — three mechanisms, none of which the
 * published package has. There, the emitted JS keeps the specifier verbatim
 * and Node resolves it against core's `exports` map.
 *
 * Nothing else exercises that entry. Remove it, rename the `dist/src` root, or
 * add a pattern that shadows it, and every suite stays green while `qwen` dies
 * on its first core subpath import. This runs Node's real resolver against the
 * built package so that failure lands in CI instead. It also rejects targets
 * outside core's published `dist/`, so a specifier the `./src/*` exports entry
 * routes to an in-repo file that never ships cannot pass the gate either.
 */

import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_PROBES = new Map([
  ['@qwen-code/qwen-code-core/config/storage.js', 'Storage'],
  ['@qwen-code/qwen-code-core/utils/debugLogger.js', 'createDebugLogger'],
  ['@qwen-code/qwen-code-core/utils/errors.js', 'getErrorMessage'],
  ['@qwen-code/qwen-code-core/noFollowOpen', 'openSyncNoFollow'],
]);
const specifiers = new Set(EXPORT_PROBES.keys());
// acp-bridge and sdk-typescript are runtime dependencies of the cli, and their
// compiled dist keeps core subpath specifiers verbatim just like the cli's own
// dist. Scanning them too gates entries that only a dependency names (e.g.
// ./goalWire, ./transcriptRecords, ./subSessionConstants); without this, those
// exports entries could be deleted while every gate stays green.
const scannedSources = [
  path.join(root, 'packages', 'cli', 'src'),
  path.join(root, 'packages', 'acp-bridge', 'src'),
  path.join(root, 'packages', 'sdk-typescript', 'src'),
];
const coreSpecifier = /['"](@qwen-code\/qwen-code-core\/[^'"]+)['"]/g;
for (const sourceDir of scannedSources) {
  for (const relativePath of globSync('**/*.{ts,tsx}', { cwd: sourceDir })) {
    const source = readFileSync(path.join(sourceDir, relativePath), 'utf8');
    for (const match of source.matchAll(coreSpecifier)) {
      specifiers.add(match[1]);
    }
  }
}

const coreDist = path.join(root, 'packages', 'core', 'dist', 'src');
if (!existsSync(coreDist)) {
  console.error(
    `core is not built (${path.relative(root, coreDist)} is missing) — run "npm run build" first`,
  );
  process.exit(1);
}

// core's package.json publishes only dist, vendor and scripts/postinstall.js
// ("files"), but its exports map also carries "./src/*": "./src/*". A
// specifier routed through that entry resolves to a real in-repo
// packages/core/src/... file, so a bare existsSync passes while the published
// artifact ships nothing and the installed CLI dies with ERR_MODULE_NOT_FOUND.
// Legitimate runtime specifiers all resolve under dist/, so require exactly
// that instead of trusting the repo tree. The one exception is core's own
// package.json, which the exports map deliberately publishes
// ("./package.json": "./package.json") and npm ships regardless of "files".
const publishedDist = path.join(root, 'packages', 'core', 'dist') + path.sep;
const corePackageJson = path.join(root, 'packages', 'core', 'package.json');

let failed = 0;
for (const specifier of specifiers) {
  const exportName = EXPORT_PROBES.get(specifier);
  let resolved;
  try {
    resolved = fileURLToPath(import.meta.resolve(specifier));
  } catch (error) {
    console.error(`✗ ${specifier}\n    ${error.code ?? ''} ${error.message}`);
    failed++;
    continue;
  }
  if (!existsSync(resolved)) {
    console.error(
      `✗ ${specifier}\n    resolved target does not exist: ${resolved}`,
    );
    failed++;
    continue;
  }
  if (!resolved.startsWith(publishedDist) && resolved !== corePackageJson) {
    console.error(
      `✗ ${specifier}\n    resolved target is not published: ${resolved} lies outside ${path.relative(root, publishedDist)} (core ships "files": dist, vendor, scripts/postinstall.js)`,
    );
    failed++;
    continue;
  }
  const mod = exportName && (await import(pathToFileURL(resolved).href));
  if (exportName && typeof mod[exportName] !== 'function') {
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
    `\n${failed} of ${specifiers.size} core subpath specifiers do not resolve through the package exports map.\n` +
      'The published CLI resolves them this way and nothing else does, so this breaks `qwen` at startup\n' +
      'while every in-repo suite stays green. Check the exports map in packages/core/package.json.',
  );
  process.exit(1);
}
console.log(
  `\nAll ${specifiers.size} core subpath specifiers resolve through the package exports map.`,
);
