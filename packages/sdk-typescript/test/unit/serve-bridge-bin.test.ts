/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
// @ts-expect-error - build script helper, not part of the typed `src` surface.
import { serveBridgeBinBuildOptions } from '../../scripts/serve-bridge-bin-build-options.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Derived from the manifest rather than restated: against a stale hardcoded
// path, `existsSync` below would read relocation of the bin output as a
// clean tree and silently skip the `dist/` case forever.
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
};
const shippedBinPath = join(rootDir, pkg.bin['qwen-serve-mcp']);

/**
 * `qwen-serve-mcp` shipped unstartable in `@qwen-code/sdk@0.1.8`: an esbuild
 * `banner` stacked a second `#!/usr/bin/env node` onto line 2 of the bundle on
 * top of the one the entry point already carries. node strips only the first
 * hashbang line, so the bin died with `SyntaxError: Invalid or unexpected
 * token` through both `node <file>` and the shebang.
 *
 * `scripts/build.js` guards it at build time, but a guard is only as good as
 * its own survival: neutralize it (swallow the error, warn instead of throw,
 * drop the call) and every suite in this repo stays green while the next
 * banner regression publishes. So pin the bytes here instead — build the bin
 * with the build script's own options and assert on the output, which reds on
 * a banner regression whatever happens to `assertExecutableBin`.
 */
describe('serve-bridge bin artifact', () => {
  const readLines = (filePath: string) =>
    readFileSync(filePath, 'utf8').split('\n');

  it('emits exactly one hashbang, on line 1, and parses', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'serve-bridge-bin-'));
    // The bundle is ESM but must keep the shipped name `bin.js`
    // (`bin.qwen-serve-mcp` maps to a `.js` file), and nothing above
    // os.tmpdir() declares a module goal, so `node --check` below would lean
    // on module-syntax detection — default-enabled only from Node 22.7, while
    // the package supports >=22.0.0. Declare the goal instead.
    writeFileSync(join(outDir, 'package.json'), '{"type": "module"}\n');
    const outfile = join(outDir, 'bin.js');
    try {
      await esbuild.build(serveBridgeBinBuildOptions(rootDir, outfile));

      const lines = readLines(outfile);
      expect(lines[0]).toBe('#!/usr/bin/env node');
      expect(lines[1]?.startsWith('#!')).toBe(false);
      expect(() =>
        execFileSync('node', ['--check', outfile], { stdio: 'pipe' }),
      ).not.toThrow();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  // Second line of defence, covering a banner added at the call site rather
  // than in the shared options. `npm ci` builds every workspace through the
  // root `prepare` script, so this runs in CI; it is skipped rather than
  // failed on a tree whose `dist/` was cleaned, or installed with
  // `QWEN_SKIP_PREPARE`.
  it.skipIf(!existsSync(shippedBinPath))(
    'ships that same shape in dist/',
    () => {
      const lines = readLines(shippedBinPath);
      expect(lines[0]).toBe('#!/usr/bin/env node');
      expect(lines[1]?.startsWith('#!')).toBe(false);
      expect(() =>
        execFileSync('node', ['--check', shippedBinPath], { stdio: 'pipe' }),
      ).not.toThrow();
    },
  );
});
