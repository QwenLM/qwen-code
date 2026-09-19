/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { parseLandlockStatus } from './landlock-status.js';
import { MAX_STATUS_BYTES } from './sandbox-status.js';

const [parentPid, statusPath, runner, ...args] = process.argv.slice(2);
if (process.ppid !== Number(parentPid)) process.exit(1);
const parentWatch = setInterval(() => {
  if (process.ppid !== Number(parentPid)) process.exit(1);
}, 100);
parentWatch.unref();
const receiptFd = openSync(
  statusPath,
  constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW,
  0o600,
);
const child = spawn(runner, args, {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
  env: process.env,
});
let wire = '';
let bytes = 0;
let failed = false;
let spawnFailed = false;
const statusStream = child.stdio[3] as Readable;
statusStream.on('data', (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes <= MAX_STATUS_BYTES) wire += chunk.toString('utf8');
  else failed = true;
});
statusStream.on('error', () => {
  failed = true;
});
child.on('error', () => {
  failed = true;
  spawnFailed = true;
});
child.on('close', (code, signal) => {
  clearInterval(parentWatch);
  const status = signal
    ? { state: 'interrupted' }
    : spawnFailed
      ? { state: 'unconfirmed', payloadExitObserved: false }
      : failed
        ? { state: 'unconfirmed' }
        : parseLandlockStatus(wire, code);
  writeFileSync(receiptFd, JSON.stringify(status));
  closeSync(receiptFd);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
