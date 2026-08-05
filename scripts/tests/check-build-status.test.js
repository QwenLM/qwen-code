/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scripts/check-build-status.js', () => {
  function runChecker(cwd, env = process.env) {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [join(root, 'scripts', 'check-build-status.js')],
        { cwd, env },
        (err, stdout, stderr) => {
          if (err && typeof err.code === 'string') reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });
  }

  it('writes nothing to stdout — start.js runs it in front of piped review JSON', async () => {
    // `scripts/start.js` executes this checker with `stdio: 'inherit'` before
    // every spawn, and start.js is a QWEN_CODE_CLI entry whose stdout callers
    // consume: `… review parse-args --stdin | tee plan.json` must produce a file
    // whose first line is JSON. One `console.log` here — the shape this pins
    // against — puts "Checking build status..." at the top of that file. Status
    // and warnings belong on stderr, whatever build state the checker finds.
    const { stdout } = await runChecker(root);
    expect(stdout).toBe('');
  });

  it('writes missing-build warnings to the configured file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-check-build-'));
    const warningsFile = join(cwd, 'warnings.txt');
    try {
      await runChecker(cwd, {
        ...process.env,
        QWEN_CODE_WARNINGS_FILE: warningsFile,
      });
      expect(readFileSync(warningsFile, 'utf8')).toContain(
        'Build timestamp file',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not create a warnings file when the variable is unset', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-check-build-'));
    const warningsFile = join(cwd, 'warnings.txt');
    const env = { ...process.env, TMPDIR: cwd, TMP: cwd, TEMP: cwd };
    delete env.QWEN_CODE_WARNINGS_FILE;
    try {
      await runChecker(cwd, env);
      expect(() => readFileSync(warningsFile)).toThrow();
      expect(existsSync(join(cwd, 'qwen-code-warnings.txt'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
