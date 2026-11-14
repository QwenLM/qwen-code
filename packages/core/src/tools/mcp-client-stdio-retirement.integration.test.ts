/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// /proc identifies the exact owned fixture and distinguishes an exited orphan
// (not yet reaped by the container's init) from a still-running server.
async function fixtureIsRunning(
  pid: number,
  fixture: string,
): Promise<boolean> {
  try {
    const [status, command] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]);
    return (
      command.split('\0').includes(fixture) && !/^State:\s+Z/m.test(status)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const fixtureSource = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [events, pidFile, mode] = process.argv.slice(2);
const record = (event) => appendFileSync(events, event + '\n');
writeFileSync(pidFile, String(process.pid));
process.on('SIGTERM', () => record('sigterm-ignored'));
process.stdin.on('end', () => {
  record('stdin-end');
  if (mode === 'cooperative') process.exit(0);
});
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: '2025-03-26', capabilities: {},
        serverInfo: { name: 'stdio-retirement-fixture', version: '1' },
      },
    }) + '\n');
  }
});
// Last-resort cleanup even if the test runner itself is interrupted.
setTimeout(() => process.exit(1), 90_000);
`;

async function runOwner(mode: 'stubborn' | 'cooperative'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-stdio-retirement-'));
  const fixture = join(directory, 'server.mjs');
  const eventsFile = join(directory, 'events');
  const pidFile = join(directory, 'server.pid');
  const resultFile = join(directory, 'result.json');
  await writeFile(fixture, fixtureSource);
  const clientModule = new URL('./mcp-client.ts', import.meta.url).href;
  const owner = spawn(
    process.execPath,
    [
      '--import=tsx/esm',
      '--input-type=module',
      '--eval',
      `
import { ChildProcess } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { McpClient } from ${JSON.stringify(clientModule)};
const [fixture, events, pidFile, resultFile, mode] = process.argv.slice(1);
const record = (event) => appendFileSync(events, event + '\\n');
const client = new McpClient(
  'stdio-retirement',
  { command: process.execPath, args: [fixture, events, pidFile, mode], timeout: 15_000 },
  {}, {}, { getDirectories: () => [] }, false,
);
await client.connect();
const pid = client.getTransportPid();
// Observe real signals without replacing the SDK transport or its close path.
const kill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal) {
  const sent = kill.call(this, signal);
  if (this.pid === pid && sent) record('signal:' + signal);
  return sent;
};
let disconnectError;
try {
  await client.disconnect();
} catch (error) {
  disconnectError = String(error);
}
record('disconnect-settled');
writeFileSync(resultFile, JSON.stringify({ pid, disconnectError }));
// Do not give an abandoned transport.close() time to finish in the background.
process.exit(0);
`,
      fixture,
      eventsFile,
      pidFile,
      resultFile,
      mode,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QWEN_RUNTIME_DIR: directory },
    },
  );
  let output = '';
  owner.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  owner.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    owner.once('exit', resolve);
    owner.once('error', reject);
  });
  const deadline = setTimeout(() => owner.kill('SIGKILL'), 60_000);
  try {
    const exitCode = await exited;
    if (exitCode !== 0) {
      throw new Error(`MCP owner exited with ${exitCode}: ${output}`);
    }
    const result: { pid: number; disconnectError?: string } = JSON.parse(
      await readFile(resultFile, 'utf8'),
    );
    expect(result.pid).toBe(Number(await readFile(pidFile, 'utf8')));
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n');
    expect.soft(result.disconnectError).toBeUndefined();
    expect(events).toContain('stdin-end');
    if (mode === 'stubborn') {
      expect(events).toContain('sigterm-ignored');
      expect
        .soft(events.indexOf('signal:SIGKILL'))
        .toBeGreaterThan(events.indexOf('sigterm-ignored'));
      expect(events.indexOf('signal:SIGKILL')).toBeLessThan(
        events.indexOf('disconnect-settled'),
      );
    } else {
      expect(events.filter((event) => event.startsWith('signal:'))).toEqual([]);
    }
    await expect
      .poll(() => fixtureIsRunning(result.pid, fixture), { timeout: 5_000 })
      .toBe(false);
  } finally {
    clearTimeout(deadline);
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill('SIGKILL');
      await exited;
    }
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (pid > 0 && (await fixtureIsRunning(pid, fixture))) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
      await expect
        .poll(() => fixtureIsRunning(pid, fixture), { timeout: 5_000 })
        .toBe(false);
    }
    owner.stdout.destroy();
    owner.stderr.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')(
  'McpClient real stdio retirement',
  () => {
    it('finishes SIGKILL escalation before its caller can exit', async () => {
      await runOwner('stubborn');
    }, 75_000);

    it('lets a cooperative server exit on EOF without sending signals', async () => {
      await runOwner('cooperative');
    }, 75_000);
  },
);
