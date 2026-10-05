/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build script for @qwen-code/qwen-live.
 *
 * Cleans dist plus the incremental build info together (removing dist alone
 * leaves tsc's buildinfo claiming everything is up to date, so `tsc --build`
 * would emit nothing), compiles TypeScript, and sanity-checks the emit.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

rmSync(path.join(here, 'dist'), { recursive: true, force: true });
rmSync(path.join(here, 'tsconfig.build.tsbuildinfo'), { force: true });

// Resolve tsc through node rather than `npx` so this also works on Windows,
// where execFileSync cannot resolve `npx.cmd` without a shell.
execFileSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '--build', 'tsconfig.build.json'],
  { cwd: here, stdio: 'inherit' },
);

for (const required of ['index.js', 'daemon.js']) {
  const emitted = path.join(here, 'dist', required);
  if (!existsSync(emitted)) {
    throw new Error(
      `build produced no dist/${required} — tsc emitted nothing (stale tsconfig.build.tsbuildinfo?)`,
    );
  }
}
