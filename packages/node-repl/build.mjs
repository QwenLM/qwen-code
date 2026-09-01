/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build script for @qwen-code/node-repl-mcp.
 *
 * tsc compiles src/**.ts -> dist, but does NOT copy the runtime .mjs assets or
 * the tree-sitter JavaScript grammar wasm. This package ships its own copies
 * (it does not depend on qwen-code core's asset-copy pipeline), so we copy them
 * into dist/runtime/ here. resolveKernelPath() and the wasm loader probe
 * ./runtime/ relative to the compiled module, so this layout works in dist.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const distRuntime = path.join(here, 'dist', 'runtime');

// 0. Clean dist AND the incremental build info together. Removing dist alone
//    would leave tsc's buildinfo claiming everything is up to date, so
//    `tsc --build` would emit nothing and produce an empty dist.
rmSync(path.join(here, 'dist'), { recursive: true, force: true });
rmSync(path.join(here, 'tsconfig.build.tsbuildinfo'), { force: true });

// 1. Compile TypeScript (tsconfig.build.json excludes *.test.ts from dist).
//    Resolve tsc through node rather than `npx` so this also works on Windows,
//    where execFileSync cannot resolve `npx.cmd` without a shell.
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--build', 'tsconfig.build.json'],
  { cwd: here, stdio: 'inherit' },
);

// 2. Copy the runtime .mjs kernel + module loader into dist/runtime.
rmSync(distRuntime, { recursive: true, force: true });
mkdirSync(distRuntime, { recursive: true });
for (const asset of ['kernel.mjs', 'module-loader.mjs']) {
  cpSync(
    path.join(here, 'src', 'runtime', asset),
    path.join(distRuntime, asset),
  );
}

// 3. Copy the tree-sitter JavaScript grammar wasm from node_modules.
const grammarRelative = path.join(
  'tree-sitter-wasms',
  'out',
  'tree-sitter-javascript.wasm',
);
const grammarSource = [
  path.join(here, 'node_modules', grammarRelative),
  path.join(here, '..', '..', 'node_modules', grammarRelative),
].find(existsSync);
if (!grammarSource) {
  throw new Error(
    'node_repl JavaScript grammar asset (tree-sitter-javascript.wasm) was not found',
  );
}
cpSync(grammarSource, path.join(distRuntime, 'tree-sitter-javascript.wasm'));

// 4. Sanity-check the emit. A stale buildinfo or a misconfigured tsconfig can
//    make `tsc --build` silently emit nothing, leaving a dist that only has the
//    copied assets — which then fails at runtime instead of at build time.
for (const required of [
  'index.js',
  'programmatic.js',
  'kernel-manager.js',
  'mcp-server.js',
]) {
  const emitted = path.join(here, 'dist', required);
  if (!existsSync(emitted)) {
    throw new Error(
      `build produced no dist/${required} — tsc emitted nothing (stale tsconfig.build.tsbuildinfo?)`,
    );
  }
}

console.log(`node-repl-mcp: runtime assets copied to ${distRuntime}`);
