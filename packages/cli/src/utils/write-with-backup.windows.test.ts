/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { writeWithBackupSync } from './write-with-backup.js';

describe.skipIf(process.platform !== 'win32')(
  'native Windows publication',
  () => {
    it('never exposes missing or incomplete policy to a concurrent reader', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-reader-'));
      const target = path.join(root, 'settings.json');
      const ready = path.join(root, 'ready');
      const policy = { filesystem: 'read-only', network: 'closed' };
      let published = JSON.stringify({ tools: { executionSandbox: policy } });
      fs.writeFileSync(target, published);
      const reader = spawn(
        process.execPath,
        [
          '-e',
          `const fs = require('node:fs');
const [target, ready] = process.argv.slice(1);
const failures = [];
let reads = 0;
const timer = setInterval(() => {
  try {
    const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    const policy = settings.tools?.executionSandbox;
    if (policy?.filesystem !== 'read-only' || policy?.network !== 'closed') failures.push('policy missing');
    reads++;
  } catch (error) { failures.push(String(error)); }
}, 1);
process.stdin.once('data', () => {
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ reads, failures }));
  process.stdin.destroy();
});
fs.writeFileSync(ready, 'ready');`,
          target,
          ready,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const closed = once(reader, 'close');
      let output = '';
      let stderr = '';
      reader.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      reader.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(ready)) {
          if (reader.exitCode !== null || Date.now() >= deadline)
            throw new Error(
              `Concurrent reader did not become ready (exit ${reader.exitCode}, signal ${reader.signalCode}): ${stderr}`,
            );
          await delay(20);
        }
        let successfulWrites = 0;
        for (let index = 0; index < 400; index++) {
          const content = JSON.stringify({
            index,
            tools: { executionSandbox: policy },
          });
          try {
            writeWithBackupSync(target, content);
            published = content;
            successfulWrites++;
          } catch (error) {
            expect(error).toMatchObject({ code: 'EPERM' });
            expect(fs.readFileSync(target)).toEqual(Buffer.from(published));
          }
          if (index % 10 === 0) await delay(5);
        }
        expect(successfulWrites).toBeGreaterThan(0);
        reader.stdin.end('\n');
        const [code] = await closed;
        expect(code).toBe(0);
        const report = JSON.parse(output) as {
          reads: number;
          failures: string[];
        };
        expect(report.reads).toBeGreaterThan(0);
        expect(report.failures).toEqual([]);
        expect(fs.readdirSync(root).sort()).toEqual(['ready', 'settings.json']);
      } finally {
        if (reader.exitCode === null && reader.signalCode === null) {
          reader.kill('SIGKILL');
          await closed;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 15_000);

    it.each(['before', 'after'] as const)(
      'keeps a complete target after terminating a writer %s publication',
      async (phase) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-crash-'));
        const target = path.join(root, 'settings.json');
        const ready = path.join(root, 'ready');
        const oldContent = JSON.stringify({ tools: { sandbox: 'docker' } });
        const newContent = JSON.stringify({ tools: { sandbox: 'podman' } });
        fs.writeFileSync(target, oldContent);
        const writer = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [target, ready, phase, content, module] = process.argv.slice(1);
const rename = fs.renameSync;
fs.renameSync = (...args) => {
  if (phase === 'after') rename(...args);
  fs.writeFileSync(ready, 'ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
syncBuiltinESMExports();
const { writeWithBackupSync } = await import(module);
writeWithBackupSync(target, content);`,
            target,
            ready,
            phase,
            newContent,
            new URL('./write-with-backup.ts', import.meta.url).href,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const closed = once(writer, 'close');
        let stderr = '';
        writer.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        try {
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(ready)) {
            if (writer.exitCode !== null || Date.now() >= deadline)
              throw new Error(`Writer failed to reach publication: ${stderr}`);
            await delay(20);
          }
          writer.kill('SIGKILL');
          await closed;
          expect(fs.readFileSync(target, 'utf8')).toBe(
            phase === 'before' ? oldContent : newContent,
          );
          const staging = fs
            .readdirSync(root)
            .find((name) => name.startsWith('settings.json.write-'))!;
          expect(
            fs.readFileSync(
              path.join(root, staging, 'settings.json.orig'),
              'utf8',
            ),
          ).toBe(oldContent);
          writeWithBackupSync(target, newContent);
          expect(fs.readFileSync(target, 'utf8')).toBe(newContent);
        } finally {
          if (writer.exitCode === null && writer.signalCode === null) {
            writer.kill('SIGKILL');
            await closed;
          }
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
      15_000,
    );

    it('preserves settings when an open handle denies replacement, then replaces after close', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ntfs-'));
      const target = path.join(root, 'settings.json');
      const oldContent = JSON.stringify({
        tools: {
          executionSandbox: { filesystem: 'read-only', network: 'closed' },
        },
      });
      const newContent = JSON.stringify({
        tools: {
          executionSandbox: { filesystem: 'workspace-write', network: 'open' },
        },
      });
      fs.writeFileSync(target, oldContent);
      const holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$file = [System.IO.File]::Open($env:QWEN_TEST_SETTINGS_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::Out.WriteLine("READY"); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }',
        ],
        {
          env: { ...process.env, QWEN_TEST_SETTINGS_PATH: target },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const closed = once(holder, 'close');
      let stderr = '';
      holder.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('File holder readiness timed out')),
            10_000,
          );
          let output = '';
          holder.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes('READY')) {
              clearTimeout(timeout);
              resolve();
            }
          });
          holder.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          holder.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`File holder exited ${code}: ${stderr}`));
          });
        });
        expect(() => writeWithBackupSync(target, newContent)).toThrow();
        expect(fs.readFileSync(target, 'utf8')).toBe(oldContent);
        expect(fs.readdirSync(root)).toEqual(['settings.json']);
        holder.stdin.end('\n');
        const [code] = await closed;
        expect(code).toBe(0);
        writeWithBackupSync(target, newContent);
        expect(fs.readFileSync(target, 'utf8')).toBe(newContent);
        expect(fs.readdirSync(root)).toEqual(['settings.json']);
      } finally {
        holder.stdin.end('\n');
        if (holder.exitCode === null) {
          holder.kill();
          await closed;
        }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 20_000);
  },
);
