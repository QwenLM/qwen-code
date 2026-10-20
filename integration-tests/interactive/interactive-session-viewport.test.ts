/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveSession } from './interactive-session.js';

describe('InteractiveSession visible evidence', () => {
  let session: InteractiveSession | undefined;

  afterEach(async () => {
    try {
      await session?.close();
    } finally {
      session = undefined;
      vi.unstubAllEnvs();
    }
  });

  it('distinguishes visible rows from scrollback and preserves raw ANSI', async () => {
    session = await InteractiveSession.start({
      rows: 5,
      cols: 30,
      command: {
        bin: process.execPath,
        args: [
          '-e',
          `console.log('SCROLLBACK_ONLY');
for (let i = 0; i < 8; i++) console.log('line ' + i);
console.log('\\x1b[31mType your message\\x1b[0m');
setInterval(() => {}, 1000);`,
        ],
      },
    });
    await session.idle(300);
    expect(await session.screen()).toContain('SCROLLBACK_ONLY');
    const viewport = await session.viewport();
    expect(viewport).not.toContain('SCROLLBACK_ONLY');
    expect(viewport).toContain('Type your message');
    expect(viewport.split('\n')).toHaveLength(5);
    expect(session.output()).toContain('\x1b[31m');
  });

  it('resizes both the child PTY and the emulated viewport', async () => {
    session = await InteractiveSession.start({
      rows: 12,
      cols: 80,
      command: {
        bin: process.execPath,
        args: [
          '-e',
          `console.log('Type your message');
process.stdout.on('resize', () => {
  console.log('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows);
});
setInterval(() => {}, 1000);`,
        ],
      },
    });
    session.resize(40, 6);
    await session.waitFor('SIZE:40x6', 5000);
    expect((await session.viewport()).split('\n')).toHaveLength(6);
    session.resize(80, 12);
    await session.waitFor('SIZE:80x12', 5000);
    expect((await session.viewport()).split('\n')).toHaveLength(12);
  });

  it('can isolate child configuration without losing the pinned renderer', async () => {
    vi.stubEnv('QWEN_E2E_PRIVATE_SENTINEL', 'must-not-leak');
    vi.stubEnv('QWEN_E2E_RENDERER', 'ink');
    session = await InteractiveSession.start({
      inheritEnv: false,
      env: { TERM: 'xterm-256color', QWEN_TUI_RENDERER: 'opentui' },
      command: {
        bin: process.execPath,
        args: [
          '-e',
          `console.log('Type your message');
console.log('PRIVATE:' + (process.env.QWEN_E2E_PRIVATE_SENTINEL ?? 'absent'));
console.log('RENDERER:' + process.env.QWEN_TUI_RENDERER);
setInterval(() => {}, 1000);`,
        ],
      },
    });
    await session.idle(300);
    expect(session.output()).toContain('PRIVATE:absent');
    expect(session.output()).toContain('RENDERER:ink');
    expect(session.output()).not.toContain('must-not-leak');
  });

  it('uses modern emoji widths for explicitly positioned terminal cells', async () => {
    session = await InteractiveSession.start({
      command: {
        bin: process.execPath,
        args: [
          '-e',
          `console.log('Type your message');
process.stdout.write('\\x1b[2;1H甲乙🙂\\x1b[2;7H_DONE');
setInterval(() => {}, 1000);`,
        ],
      },
    });
    await session.idle(300);
    expect(await session.viewport()).toContain('甲乙🙂_DONE');
  });

  it('excludes retained offscreen columns after narrowing the alternate screen', async () => {
    session = await InteractiveSession.start({
      cols: 100,
      rows: 12,
      command: {
        bin: process.execPath,
        args: [
          '-e',
          `console.log('Type your message');
process.stdout.write('\\x1b[?1049h\\x1b[1;1HVISIBLE\\x1b[1;60HOFFSCREEN');
setInterval(() => {}, 1000);`,
        ],
      },
    });
    await session.idle(300);
    expect(await session.viewport()).toContain('OFFSCREEN');
    session.resize(40, 12);
    await session.idle(300);
    expect(await session.viewport()).toContain('VISIBLE');
    expect(await session.viewport()).not.toContain('OFFSCREEN');
  });

  it.skipIf(process.platform === 'win32').each([150, 5_100])(
    'waits for the child to finish writing after %i ms before removing its directory',
    async (delay) => {
      const scratch = mkdtempSync(join(tmpdir(), 'qwen-pty-close-'));
      const marker = join(scratch, 'exited.txt');
      try {
        session = await InteractiveSession.start({
          command: {
            bin: process.execPath,
            args: [
              '-e',
              `process.on('SIGHUP', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished');
  process.exit(0);
}, ${delay}));
console.log('Type your message');
setInterval(() => {}, 1000);`,
            ],
          },
        });
        await session.close();
        expect(readFileSync(marker, 'utf8')).toBe('finished');
        expect(session.exitResult()?.exitCode).toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reaps a HUP-ignoring PTY group and still reports the forced cleanup',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'qwen-pty-close-'));
      const pidFile = join(scratch, 'pids.json');
      let pids: number[] = [];
      try {
        session = await InteractiveSession.start({
          inheritEnv: false,
          command: {
            bin: process.execPath,
            args: [
              '-e',
              `process.on('SIGHUP', () => {});
const child = require('node:child_process').spawn(process.execPath, ['-e',
  "process.on('SIGHUP', () => {}); process.send('ready'); setInterval(() => {}, 1000);"
], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', () => {
  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
  console.log('Type your message');
});
setInterval(() => {}, 1000);`,
            ],
          },
        });
        pids = JSON.parse(readFileSync(pidFile, 'utf8')) as number[];
        const started = Date.now();
        await expect(session.close()).rejects.toThrow(
          'PTY exceeded its close grace period',
        );
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(session.exitResult()?.signal).toBe(9);
        for (const pid of pids) {
          await expect
            .poll(
              () => {
                try {
                  process.kill(pid, 0);
                  return true;
                } catch {
                  return false;
                }
              },
              { timeout: 2_000 },
            )
            .toBe(false);
        }
      } finally {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The assertions above, before this fallback, prove cleanup.
          }
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});
