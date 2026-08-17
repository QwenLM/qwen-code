/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// Node realpaths the ESM main entry but not process.argv[1]; these runs prove
// the scripts still execute (identically) when launched through a symlinked
// path, instead of silently exiting 0.
const runViaSymlink = (script, args, env = {}) => {
  const realScript = path.join(packageRoot, script);
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-main-entry-'));
  const linkedScript = path.join(workDir, path.basename(script));
  try {
    symlinkSync(realScript, linkedScript);
    const options = {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    };
    const direct = spawnSync(process.execPath, [realScript, ...args], options);
    const symlinked = spawnSync(
      process.execPath,
      [linkedScript, ...args],
      options,
    );
    return { direct, symlinked };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

const expectSameRun = (direct, symlinked) => {
  expect(symlinked.status).toBe(direct.status);
  expect(symlinked.stdout).toBe(direct.stdout);
  expect(symlinked.stderr).toBe(direct.stderr);
};

describe.skipIf(process.platform === 'win32')(
  'script main-entry guards under symlinked paths',
  () => {
    it('runs artifact-scan through a symlinked path', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-scan-root-'));
      try {
        mkdirSync(path.join(root, 'background'));
        writeFileSync(
          path.join(root, 'background/service-worker.js'),
          'console.log("qwen bridge");',
        );
        const { direct, symlinked } = runViaSymlink(
          'scripts/artifact-scan.js',
          [root],
        );
        expect(direct.status).toBe(0);
        expect(direct.stdout).toContain('ARTIFACT-SCAN: PASS');
        expectSameRun(direct, symlinked);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);

    it('runs sync-extension through a symlinked path', () => {
      const outDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-sync-out-'));
      try {
        const { direct, symlinked } = runViaSymlink(
          'scripts/sync-extension.js',
          [],
          { EXTENSION_OUT_DIR: outDir },
        );
        expect(direct.status).toBe(0);
        expect(direct.stdout).toContain('Static assets synced');
        expectSameRun(direct, symlinked);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }, 30_000);

    it('runs package-extension through a symlinked path', () => {
      const { direct, symlinked } = runViaSymlink(
        'scripts/package-extension.js',
        [],
      );
      // Packaging needs a built dist/extension plus the zip binary, which
      // unit-test runs may lack, so success is not guaranteed; require an
      // observable run instead of a silent exit 0.
      expect(direct.status === 0 || direct.stderr.length > 0).toBe(true);
      expectSameRun(direct, symlinked);
    }, 30_000);
  },
);
