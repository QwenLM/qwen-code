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
  existsSync,
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

import { resolveLandlockRunner } from './landlock-runner-path.js';
import type { SandboxStatus } from './sandbox-status.js';

interface RelayReport {
  content: string;
  isDirectory: boolean;
  isFile: boolean;
  isFIFO: boolean;
  isSocket: boolean;
  chmod: string;
  reopen: string;
}

describe.skipIf(process.platform !== 'linux').each(['bwrap', 'landlock'])(
  '%s relay stdin',
  (backend) => {
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
writeSync(3, JSON.stringify(${JSON.stringify(backend)} === 'bwrap' ? { 'child-pid': process.pid } : { state: 'prepared', abi: 3 }) + '\\n');
const input = fstatSync(0);
let chmod = 'allowed';
try {
  fchmodSync(0, 0o600);
} catch (error) {
  chmod = errorCode(error);
}
let reopen;
try {
  const reopened = openSync('/proc/self/fd/0', 'r+');
  try {
    reopen = fstatSync(reopened).isFIFO() ? 'pipe' : 'host-backed';
  } finally {
    closeSync(reopened);
  }
} catch (error) {
  reopen = errorCode(error);
}
writeFileSync(
  process.argv.at(-1),
  JSON.stringify({
    content: readFileSync(0, 'utf8'),
    isDirectory: input.isDirectory(),
    isFile: input.isFile(),
    isFIFO: input.isFIFO(),
    isSocket: input.isSocket(),
    chmod,
    reopen,
  }),
);
if (${JSON.stringify(backend)} === 'bwrap') writeSync(3, JSON.stringify({ 'exit-code': 0 }) + '\\n');
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
      bridge = resolveLandlockRunner(),
    ): Promise<{
      code: number | null;
      stderr: string;
      status: SandboxStatus;
      report?: RelayReport;
    }> => {
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
          fileURLToPath(new URL(`./${backend}-relay.ts`, import.meta.url)),
          String(process.pid),
          statusPath,
          envPath,
          bridge,
          fakeBwrap,
          reportPath,
        ],
        { stdio: [stdin, 'pipe', 'pipe'] },
      );
      let stderr = '';
      relay.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      relay.stdout?.resume();
      const relayStdin = relay.stdin;
      if (stdin === 'pipe') {
        if (!relayStdin) throw new Error('relay stdin pipe is unavailable');
        relayStdin.end(content);
      }
      const [code] = (await once(relay, 'close')) as [number | null];
      return {
        code,
        stderr,
        status: JSON.parse(readFileSync(statusPath, 'utf8')) as SandboxStatus,
        ...(existsSync(reportPath)
          ? {
              report: JSON.parse(
                readFileSync(reportPath, 'utf8'),
              ) as RelayReport,
            }
          : {}),
      };
    };

    it('copies a host file through a read-only relay socket', async () => {
      const inputPath = path.join(root, 'input.txt');
      writeFileSync(inputPath, 'regular-file-input', { mode: 0o644 });
      const input = openSync(inputPath, 'r');
      try {
        await expect(runRelay(input)).resolves.toMatchObject({
          code: 0,
          status: { state: 'confirmed', exitCode: 0 },
          report: {
            content: 'regular-file-input',
            isDirectory: false,
            isFile: false,
            isFIFO: false,
            isSocket: true,
            reopen: 'ENXIO',
          },
        });
      } finally {
        closeSync(input);
      }
      expect(statSync(inputPath).mode & 0o777).toBe(0o644);
      expect(readFileSync(inputPath, 'utf8')).toBe('regular-file-input');
    });

    it('keeps anonymous pipe input streaming', async () => {
      await expect(
        runRelay('pipe', 'streamed-input', ''),
      ).resolves.toMatchObject({
        code: 0,
        status: { state: 'confirmed', exitCode: 0 },
        report: {
          content: 'streamed-input',
          isDirectory: false,
          isFile: false,
        },
      });
    });

    it('does not share a host directory descriptor', async () => {
      const inputDirectory = path.join(root, 'input-directory');
      mkdirSync(inputDirectory, { mode: 0o755 });
      const originalMode = statSync(inputDirectory).mode & 0o777;
      const input = openSync(inputDirectory, constants.O_RDONLY);
      try {
        await expect(runRelay(input)).resolves.toMatchObject({
          code: 0,
          status: { state: 'confirmed', exitCode: 0 },
          report: {
            content: '',
            isDirectory: false,
            isFile: false,
            isFIFO: false,
            isSocket: true,
            reopen: 'ENXIO',
          },
        });
      } finally {
        closeSync(input);
      }
      expect(statSync(inputDirectory).mode & 0o777).toBe(originalMode);
    });
    it('refuses host-backed stdin without a bridge before backend execution', async () => {
      const inputPath = path.join(root, 'input.txt');
      writeFileSync(inputPath, 'untouched');
      const input = openSync(inputPath, 'r');
      try {
        const result = await runRelay(input, undefined, '');
        expect(result).toMatchObject({
          code: 125,
          status: { state: 'unconfirmed', payloadExitObserved: false },
        });
        expect(result.stderr).toContain('Host-backed stdin requires');
        expect(result.report).toBeUndefined();
        expect(readFileSync(input, 'utf8')).toBe('untouched');
      } finally {
        closeSync(input);
      }
    });

    it('attests an explicit bridge exec failure without consuming input', async () => {
      chmodSync(fakeBwrap, 0o644);
      const inputPath = path.join(root, 'input.txt');
      writeFileSync(inputPath, 'untouched');
      const input = openSync(inputPath, 'r');
      try {
        const result = await runRelay(input);
        expect(result).toMatchObject({
          code: 125,
          status: { state: 'unconfirmed', payloadExitObserved: false },
        });
        expect(result.stderr).toContain('qwen-landlock-run: exec failed:');
        expect(result.report).toBeUndefined();
        expect(readFileSync(input, 'utf8')).toBe('untouched');
      } finally {
        closeSync(input);
      }
    });

    it('keeps post-exec bridge failure unknown even after a side effect', async () => {
      const bridge = path.join(root, 'post-exec-failure.mjs');
      writeFileSync(
        bridge,
        `#!/usr/bin/env node
import { writeFileSync, writeSync } from 'node:fs';
writeFileSync(process.argv.at(-1), JSON.stringify({ content: 'payload-ran' }));
writeSync(3, '{"state":"stdio-failed"}\\n');
process.exit(125);
`,
        { mode: 0o755 },
      );
      chmodSync(bridge, 0o755);
      const inputPath = path.join(root, 'input.txt');
      writeFileSync(inputPath, 'untouched');
      const input = openSync(inputPath, 'r');
      try {
        const result = await runRelay(input, undefined, bridge);
        expect(result).toMatchObject({
          code: 125,
          status: { state: 'unconfirmed' },
          report: { content: 'payload-ran' },
        });
        expect(result.status).not.toHaveProperty('payloadExitObserved');
      } finally {
        closeSync(input);
      }
    });
  },
);
