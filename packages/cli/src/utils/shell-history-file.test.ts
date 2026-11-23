/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendShellHistoryFile,
  readShellHistoryFile,
} from './shell-history-file.js';

const execFileAsync = promisify(execFile);

describe('shell-history-file', () => {
  let scratch: string;
  let historyPath: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-shell-history-'));
    historyPath = path.join(scratch, 'shell_history');
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('round-trips the TUI oldest-first JSON format', async () => {
    await fs.writeFile(historyPath, JSON.stringify(['ls', 'git status']));
    expect(await readShellHistoryFile(historyPath)).toEqual([
      'ls',
      'git status',
    ]);
    expect(await appendShellHistoryFile(historyPath, 'npm test')).toEqual([
      'ls',
      'git status',
      'npm test',
    ]);
    expect(JSON.parse(await fs.readFile(historyPath, 'utf8'))).toEqual([
      'ls',
      'git status',
      'npm test',
    ]);
  });

  it('preserves legacy line-based history and odd-backslash continuations', async () => {
    const original = 'echo start\nprintf "a\\\nb"\n';
    await fs.writeFile(historyPath, original);
    expect(await readShellHistoryFile(historyPath)).toEqual([
      'echo start',
      'printf "a b"',
    ]);
    await appendShellHistoryFile(historyPath, 'npm test');
    expect(await readShellHistoryFile(historyPath)).toEqual([
      'echo start',
      'printf "a b"',
      'npm test',
    ]);
  });

  it('keeps or tightens history permissions to owner-only', async () => {
    await fs.writeFile(historyPath, JSON.stringify(['old']), { mode: 0o644 });
    await appendShellHistoryFile(historyPath, 'new');
    if (process.platform !== 'win32') {
      expect((await fs.stat(historyPath)).mode & 0o777).toBe(0o600);
    }
    const content = await fs.readFile(historyPath, 'utf8');
    expect(content).toContain('"old"');
    expect(content).toContain('"new"');
  });

  it('retains every append across real independent processes', async () => {
    const moduleUrl = pathToFileURL(
      path.resolve('src/utils/shell-history-file.ts'),
    ).href;
    const childScript = `
      const { appendShellHistoryFile } = await import(${JSON.stringify(moduleUrl)});
      const historyPath = process.argv[1];
      const entry = process.argv[2];
      await appendShellHistoryFile(historyPath, entry);
    `;
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        execFileAsync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            historyPath,
            `child-${String(index).padStart(2, '0')}`,
          ],
          { timeout: 10_000 },
        ),
      ),
    );

    const entries = await readShellHistoryFile(historyPath);
    expect(entries).toHaveLength(40);
    expect(new Set(entries)).toEqual(
      new Set(
        Array.from(
          { length: 40 },
          (_, index) => `child-${String(index).padStart(2, '0')}`,
        ),
      ),
    );
  }, 20_000);

  it('yields while contending for the lock and rereads before writing', async () => {
    const release = await lockfile.lock(historyPath, {
      realpath: false,
      stale: 10_000,
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const pending = appendShellHistoryFile(historyPath, 'from-web-shell');
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(ticks).toBeGreaterThan(0);

      // A different producer replaced its state while this append waited.
      await fs.writeFile(historyPath, JSON.stringify(['from-tui']));
      await release();
      await pending;
      expect(await readShellHistoryFile(historyPath)).toEqual([
        'from-tui',
        'from-web-shell',
      ]);
    } finally {
      clearInterval(timer);
      await release().catch(() => {});
    }
  });

  it('reclaims a genuinely stale lock directory', async () => {
    const lockDir = `${historyPath}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 11_000);
    await fs.utimes(lockDir, staleTime, staleTime);

    await appendShellHistoryFile(historyPath, 'recovered');
    expect(await readShellHistoryFile(historyPath)).toEqual(['recovered']);
  });

  it('moves a repeated command to the newest position without duplicates', async () => {
    await fs.writeFile(
      historyPath,
      JSON.stringify(['first', 'middle', 'last']),
    );
    await appendShellHistoryFile(historyPath, 'first');
    expect(await readShellHistoryFile(historyPath)).toEqual([
      'middle',
      'last',
      'first',
    ]);
    expect(await fs.readFile(historyPath, 'utf8')).toContain('"last"');
  });
});
