/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Readable } from 'node:stream';
import { parseLandlockStatus } from './landlock-status.js';
import { MAX_STATUS_BYTES } from './sandbox-status.js';

const [parentPid, statusPath, payloadEnvPath, inputBridge, runner, ...args] =
  process.argv.slice(2);
if (process.ppid !== Number(parentPid)) process.exit(1);
const parentWatch = setInterval(() => {
  if (process.ppid !== Number(parentPid)) process.exit(1);
}, 100);
parentWatch.unref();
const fd = openSync(
  statusPath,
  constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW,
  0o600,
);
const envFd = openSync(
  payloadEnvPath,
  constants.O_RDONLY | constants.O_NOFOLLOW,
);
let parsedEnv: unknown;
try {
  parsedEnv = JSON.parse(readFileSync(envFd, 'utf8'));
} finally {
  closeSync(envFd);
  unlinkSync(payloadEnvPath);
}
if (!parsedEnv || typeof parsedEnv !== 'object' || Array.isArray(parsedEnv))
  process.exit(1);
const env = Object.fromEntries(
  Object.entries(parsedEnv).map(([key, value]) => {
    if (typeof value !== 'string') process.exit(1);
    return [key, value];
  }),
);
const input = fstatSync(0);
let shareInput = input.isSocket() || input.isCharacterDevice();
if (input.isFIFO()) {
  try {
    shareInput = readlinkSync('/proc/self/fd/0').startsWith('pipe:');
  } catch {
    shareInput = false;
  }
}
if (!shareInput && !inputBridge) {
  writeFileSync(
    fd,
    JSON.stringify({ state: 'unconfirmed', payloadExitObserved: false }),
  );
  closeSync(fd);
  process.stderr.write(
    'Host-backed stdin requires the Linux x64/arm64 input helper.\n',
  );
  process.exit(125);
}
// Initialize Node's shared output descriptors before the helper restores blocking
// mode; lazy initialization after spawn would race and re-enable O_NONBLOCK.
void process.stdout;
void process.stderr;
const child = spawn(
  shareInput ? runner : inputBridge,
  shareInput ? args : ['--relay-stdin', runner, ...args],
  {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    env,
  },
);
let wire = '';
let bytes = 0;
let failed = false;
// A backend or input-helper spawn error proves the payload never ran. A status-stream
// transport error or a wire overflow can happen after the payload has
// executed, so those must stay unattested (PR #12067 review, round 2).
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
  // A spawn failure of the backend or input helper means the payload never ran —
  // attest that explicitly so the finalizer can clean up instead of
  // retaining the dirs for inspection. Every other failure mode leaves the
  // field absent: absence of evidence is not evidence of absence.
  const status = signal
    ? { state: 'interrupted' }
    : failed
      ? spawnFailed
        ? { state: 'unconfirmed', payloadExitObserved: false }
        : { state: 'unconfirmed' }
      : parseLandlockStatus(wire, code);
  writeFileSync(fd, JSON.stringify(status));
  closeSync(fd);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
