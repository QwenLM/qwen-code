#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI sources import the vendored Ink engine as 'ink'. The tsconfig paths,
// Vitest aliases and Bun build config resolve that to src/ink/index.ts, but
// plain Node would look for a package named "ink" in node_modules. Rewrite
// the compiled specifiers in dist/ to relative paths so unbundled Node loads
// the vendored copy without any workspace package named "ink".

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, '..');

const bareInkSpecifier =
  /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])ink\2/gm;

export function rewriteInkSpecifiers(source, specifier) {
  return source.replace(
    bareInkSpecifier,
    (_match, prefix, quote) => `${prefix}${quote}${specifier}${quote}`,
  );
}

export function inkSpecifierFor(file, inkEntry) {
  const relative = path
    .relative(path.dirname(file), inkEntry)
    .split(path.sep)
    .join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

export function rewriteDistInkImports(distDir) {
  const inkEntry = path.join(distDir, 'src/ink/index.js');
  if (!existsSync(inkEntry)) {
    throw new Error(`Vendored Ink entry not found: ${inkEntry}`);
  }
  let rewritten = 0;
  for (const relative of readdirSync(distDir, { recursive: true })) {
    if (!/\.(?:js|d\.ts)$/.test(relative)) continue;
    const file = path.join(distDir, relative);
    const source = readFileSync(file, 'utf8');
    const next = rewriteInkSpecifiers(source, inkSpecifierFor(file, inkEntry));
    if (next !== source) {
      writeFileSync(file, next);
      rewritten++;
    }
  }
  return rewritten;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const count = rewriteDistInkImports(path.join(cliRoot, 'dist'));
  process.stdout.write(`Rewrote vendored Ink imports in ${count} files.\n`);
}
