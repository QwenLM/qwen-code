#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_KILL_AFTER_MS = 10_000;
const TIMEOUT_EXIT_CODE = 124;

function killProcessTree(child, signal) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }
  child.kill(signal);
}

export async function runQwenReviewCommand({
  command,
  args,
  logPath,
  timeoutMs,
  killAfterMs = DEFAULT_KILL_AFTER_MS,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  await mkdir(dirname(logPath), { recursive: true });

  return await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let killTimer;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!child) return;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(
        () => killProcessTree(child, 'SIGKILL'),
        killAfterMs,
      );
    }, timeoutMs);

    const finish = (callback) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      logStream.end(callback);
    };

    const logStream = createWriteStream(logPath, { flags: 'w' });
    logStream.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (child) killProcessTree(child, 'SIGTERM');
      finish(() => reject(error));
    });

    child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.write(chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      finish(() => reject(error));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const status = timedOut
        ? TIMEOUT_EXIT_CODE
        : typeof code === 'number'
          ? code
          : 1;
      finish(() => resolve({ status, timedOut }));
    });
  });
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function parseCliArgs(argv) {
  let logPath;
  let timeoutMinutes;
  let killAfterSeconds = 10;
  const commandSeparator = argv.indexOf('--');

  if (commandSeparator < 0) {
    throw new Error('Missing command separator: --');
  }

  for (let i = 0; i < commandSeparator; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--log-path') {
      logPath = value;
      i += 1;
    } else if (arg === '--timeout-minutes') {
      timeoutMinutes = parsePositiveInteger(value ?? '', 'timeout-minutes');
      i += 1;
    } else if (arg === '--kill-after-seconds') {
      killAfterSeconds = parsePositiveInteger(
        value ?? '',
        'kill-after-seconds',
      );
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const command = argv[commandSeparator + 1];
  const args = argv.slice(commandSeparator + 2);
  if (!logPath) throw new Error('Missing --log-path');
  if (!timeoutMinutes) throw new Error('Missing --timeout-minutes');
  if (!command) throw new Error('Missing command after --');

  return {
    command,
    args,
    logPath,
    timeoutMs: timeoutMinutes * 60_000,
    killAfterMs: killAfterSeconds * 1_000,
  };
}

async function main() {
  try {
    const result = await runQwenReviewCommand(
      parseCliArgs(process.argv.slice(2)),
    );
    if (result.timedOut) {
      console.error('Qwen review command timed out.');
    }
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
