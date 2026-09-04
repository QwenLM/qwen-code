/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('scripts/check-build-status.js', () => {
  function createBuildFixture(cwd, { sourceIsNewer }) {
    const cliDir = join(cwd, 'packages', 'cli');
    const distDir = join(cliDir, 'dist');
    const sourceDir = join(cliDir, 'src');
    const buildTimestamp = join(distDir, '.last_build');
    const sourceFile = join(sourceDir, 'fixture.ts');
    const watchedFiles = [
      join(cliDir, 'package.json'),
      join(cliDir, 'tsconfig.json'),
      sourceFile,
    ];

    mkdirSync(distDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(watchedFiles[0], '{}');
    writeFileSync(watchedFiles[1], '{}');
    writeFileSync(sourceFile, 'export const fixture = true;');
    writeFileSync(buildTimestamp, '');

    const buildMtime = new Date(Date.now() - 1_000);
    const oldMtime = new Date(buildMtime.getTime() - 1_000);
    const sourceMtime = sourceIsNewer
      ? new Date(buildMtime.getTime() + 1_000)
      : oldMtime;
    utimesSync(buildTimestamp, buildMtime, buildMtime);
    utimesSync(watchedFiles[0], oldMtime, oldMtime);
    utimesSync(watchedFiles[1], oldMtime, oldMtime);
    utimesSync(sourceFile, sourceMtime, sourceMtime);

    return { warningsFile: join(cwd, 'warnings.txt') };
  }

  function runChecker(cwd, env = process.env) {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [join(root, 'scripts', 'check-build-status.js')],
        { cwd, env },
        (err, stdout, stderr) => {
          // The checker may exit non-zero without a spawn failure; the contract
          // under test is the stream, not the verdict. A SPAWN failure must
          // reject: execFile still hands back an empty-string stdout there, so
          // resolving would let the empty-stdout assertion pass green on a run
          // that never happened. Spawn-level errors (a missing node binary)
          // carry a string code; process exit codes are numbers.
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
    const { stdout } = await runChecker(root, {
      ...process.env,
      QWEN_CODE_WARNINGS_FILE: '',
    });
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
      if (process.platform !== 'win32') {
        expect(statSync(warningsFile).mode & 0o777).toBe(0o600);
      }
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

  it('deletes a stale warnings file when the build is up to date', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-check-build-'));
    const { warningsFile } = createBuildFixture(cwd, {
      sourceIsNewer: false,
    });
    writeFileSync(warningsFile, 'stale warning');
    try {
      await runChecker(cwd, {
        ...process.env,
        QWEN_CODE_WARNINGS_FILE: warningsFile,
      });
      expect(existsSync(warningsFile)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('writes source-newer warnings to the configured file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-check-build-'));
    const { warningsFile } = createBuildFixture(cwd, {
      sourceIsNewer: true,
    });
    try {
      await runChecker(cwd, {
        ...process.env,
        QWEN_CODE_WARNINGS_FILE: warningsFile,
      });
      expect(readFileSync(warningsFile, 'utf8')).toContain(
        'modified since the last build',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
