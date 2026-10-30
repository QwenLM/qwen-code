/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from 'node:timers';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// The product shell owns this child; the test only supplies a release file.
const [directory, token] = process.argv.slice(2);
assert(directory && token && /^[A-Za-z0-9_-]+$/.test(token));
assert(process.env.TMPDIR, 'Controller must supply an isolated TMPDIR');
assert(resolve(directory).startsWith(resolve(process.env.TMPDIR) + sep));
const log = resolve(directory, 'child-events.jsonl');
const release = resolve(directory, 'RELEASE');
const event = (kind, fields = {}) =>
  appendFileSync(
    log,
    JSON.stringify({
      kind,
      token,
      pid: process.pid,
      at: Date.now(),
      ...fields,
    }) + '\n',
  );
let finishing = false;
let tick = 0;
const finish = (reason, code) => {
  if (finishing) return;
  finishing = true;
  clearInterval(poll);
  clearTimeout(deadline);
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  event('exit', { reason, code });
  process.stdout.write(`SHELL_DONE_${token}\n`, () => process.exit(code));
};
const poll = setInterval(() => {
  if (existsSync(release)) finish('owned-release-file', 0);
  else if (++tick % 4 === 0) event('alive', { tick });
}, 250);
const deadline = setTimeout(() => finish('bounded-fixture-deadline', 0), 45000);
process.on('SIGTERM', () => finish('SIGTERM', 143));
process.on('SIGINT', () => finish('SIGINT', 130));
process.on('SIGWINCH', () =>
  event('resize', {
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  }),
);
process.stdin.on('data', (bytes) => {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  event('input', {
    hex: data.toString('hex'),
    base64: data.toString('base64'),
  });
  process.stdout.write(`SHELL_BYTES_${token}:${data.toString('hex')}\n`);
});
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
event('ready', {
  ppid: process.ppid,
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY),
  columns: process.stdout.columns ?? null,
  rows: process.stdout.rows ?? null,
});
process.stdout.write(`SHELL_READY_${token}\n`);
