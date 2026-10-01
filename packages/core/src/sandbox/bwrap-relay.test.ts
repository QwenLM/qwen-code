/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface RelayReport {
  content: string;
  isDirectory: boolean;
  isFile: boolean;
  chmod: string;
  reopen: string;
}

describe.skipIf(process.platform !== 'linux')('bwrap relay stdin', () => {
  let root: string;
  let fakeBwrap: string;
  let sequence: number;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'bwrap-relay-'));
    fakeBwrap = path.join(root, 'fake-bwrap.mjs');
    sequence = 0;
    writeFileSync(
      fakeBwrap,
      `#!/usr/bin/env node
import {
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';

const errorCode = (error) =>
  error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'unknown';
writeSync(3, JSON.stringify({ 'child-pid': process.pid }) + '\\n');
const input = fstatSync(0);
let chmod = 'allowed';
try {
  fchmodSync(0, 0o600);
} catch (error) {
  chmod = errorCode(error);
}
let reopen = 'allowed';
try {
  closeSync(openSync('/proc/self/fd/0', 'r+'));
} catch (error) {
  reopen = errorCode(error);
}
writeFileSync(
  process.argv.at(-1),
  JSON.stringify({
    content: readFileSync(0, 'utf8'),
    isDirectory: input.isDirectory(),
    isFile: input.isFile(),
    chmod,
    reopen,
  }),
);
writeSync(3, JSON.stringify({ 'exit-code': 0 }) + '\\n');
`,
      { mode: 0o755 },
    );
    chmodSync(fakeBwrap, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runRelay = async (
    stdin: number | 'pipe',
    content?: string,
  ): Promise<RelayReport> => {
    const id = sequence++;
    const statusPath = path.join(root, `status-${id}.json`);
    const envPath = path.join(root, `env-${id}.json`);
    const reportPath = path.join(root, `report-${id}.json`);
    writeFileSync(
      envPath,
      JSON.stringify({ PATH: process.env['PATH'] ?? '/usr/bin:/bin' }),
      { mode: 0o600 },
    );
    const relay = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./bwrap-relay.ts', import.meta.url)),
        String(process.pid),
        statusPath,
        envPath,
        fakeBwrap,
        reportPath,
      ],
      { stdio: [stdin, 'pipe', 'pipe'] },
    );
    const relayStdin = relay.stdin;
    if (stdin === 'pipe') {
      if (!relayStdin) throw new Error('relay stdin pipe is unavailable');
      relayStdin.end(content);
    }
    const [code] = (await once(relay, 'close')) as [number | null];
    if (code !== 0) {
      throw new Error(
        `relay exited ${code}: ${relay.stderr?.read()?.toString() ?? ''}`,
      );
    }
    return JSON.parse(readFileSync(reportPath, 'utf8')) as RelayReport;
  };

  it('copies a host file through a relay-owned pipe', async () => {
    const inputPath = path.join(root, 'input.txt');
    writeFileSync(inputPath, 'regular-file-input', { mode: 0o644 });
    const input = openSync(inputPath, 'r');
    try {
      await expect(runRelay(input)).resolves.toMatchObject({
        content: 'regular-file-input',
        isDirectory: false,
        isFile: false,
        reopen: expect.not.stringMatching('allowed'),
      });
    } finally {
      closeSync(input);
    }
    expect(statSync(inputPath).mode & 0o777).toBe(0o644);
  });

  it('keeps anonymous pipe input streaming', async () => {
    await expect(runRelay('pipe', 'streamed-input')).resolves.toMatchObject({
      content: 'streamed-input',
      isDirectory: false,
      isFile: false,
    });
  });

  it('does not share a host directory descriptor', async () => {
    const inputDirectory = path.join(root, 'input-directory');
    mkdirSync(inputDirectory, { mode: 0o755 });
    const originalMode = statSync(inputDirectory).mode & 0o777;
    const input = openSync(inputDirectory, constants.O_RDONLY);
    try {
      await expect(runRelay(input)).resolves.toMatchObject({
        content: '',
        isDirectory: false,
        isFile: false,
        reopen: expect.not.stringMatching('allowed'),
      });
    } finally {
      closeSync(input);
    }
    expect(statSync(inputDirectory).mode & 0o777).toBe(originalMode);
  });
});
