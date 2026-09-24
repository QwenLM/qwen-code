/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';

/**
 * esbuild options for the published `qwen-serve-mcp` bin.
 *
 * Deliberately no hashbang `banner`: esbuild already carries the entry point's
 * own `#!/usr/bin/env node` into the output, so a banner emits a SECOND one on
 * line 2 — which esbuild accepts and node rejects with a `SyntaxError`, through
 * both `node <file>` and the shebang.
 *
 * Shared with `test/unit/serve-bridge-bin.test.ts`, which builds with these
 * exact options and pins the emitted bytes. That keeps the regression covered
 * by the test suite and not only by the build-time `assertExecutableBin` guard,
 * which a future edit could weaken with every suite still green.
 *
 * @param {string} rootDir Package root (the directory holding `src`).
 * @param {string} outfile Absolute path to write the bundle to.
 * @returns {import('esbuild').BuildOptions}
 */
export function serveBridgeBinBuildOptions(rootDir, outfile) {
  return {
    entryPoints: [join(rootDir, 'src', 'daemon-mcp', 'serve-bridge', 'bin.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    external: ['@modelcontextprotocol/sdk'],
    sourcemap: false,
  };
}
